import express from 'express';
import crypto from 'node:crypto';
import { all, get, run, tx, now, j, audit, logEvent } from './db.js';
import { bad, int, str } from './http.js';
import { config } from './config.js';
import { loadCampaign, readiness, validTimezone, isSuppressed } from './campaigns/readiness.js';
import { render, leadContext, composeBodies, pickVariant, LEAD_VARS, SENDER_VARS } from './campaigns/render.js';
import { launchCampaign, tick } from './engine/scheduler.js';
import { transport } from './engine/transport.js';
import { THRESHOLDS } from './verify/engine.js';
import { lintEmail } from './ai/lint.js';
import * as assistant from './ai/assistant.js';
import { processInbound, syncAll, suppress, stopSequences } from './inbox/sync.js';
import { canSend, domainOf } from './accounts/service.js';
import { summary, breakdown, timeseries, campaignProgress, exportRows, toCsv } from './analytics/metrics.js';

export const api = express.Router();
const knownVars = () => [...LEAD_VARS, ...SENDER_VARS, ...all('SELECT key FROM custom_fields').map((r) => r.key)];

// ---------- campaigns ----------
const campaignOut = (c) => ({ ...c, accounts: c.accounts.map((a) => ({ id: a.id, email: a.email, status: a.status, provider: a.provider, paused: a.paused })),
  lead_counts: Object.fromEntries(all('SELECT status, COUNT(*) n FROM campaign_leads WHERE campaign_id = ? GROUP BY status', c.id).map((r) => [r.status, r.n])) });
api.get('/campaigns', (req, res) => res.json(campaignProgress(null)));
api.post('/campaigns', (req, res) => {
  const name = str(req.body?.name, 120);
  if (!name) throw bad(422, 'Give the campaign a name');
  const tz = str(req.body?.timezone) ?? 'UTC';
  if (!validTimezone(tz)) throw bad(422, 'Unknown time zone');
  const id = Number(run('INSERT INTO campaigns (name, timezone, created_at) VALUES (?,?,?)', name, tz, now()).lastInsertRowid);
  const step = Number(run('INSERT INTO steps (campaign_id, position, delay_days) VALUES (?,0,0)', id).lastInsertRowid);
  run("INSERT INTO variants (step_id, label, subject, body) VALUES (?, 'A', '', '')", step);
  res.status(201).json(campaignOut(loadCampaign(id)));
});
api.get('/campaigns/:id', (req, res) => { const c = loadCampaign(int(req.params.id)); if (!c) throw bad(404, 'Campaign not found'); res.json(campaignOut(c)); });

/** Save settings, accounts and the whole sequence in one transaction. Content edits on a live campaign pause it for re-validation. */
api.put('/campaigns/:id', (req, res) => {
  const id = int(req.params.id), b = req.body || {};
  const c = loadCampaign(id);
  if (!c) throw bad(404, 'Campaign not found');
  if (b.verification_threshold && !THRESHOLDS[b.verification_threshold]) throw bad(422, 'Unknown verification threshold');
  const n = (v, d) => (v == null || v === '' ? d : Math.floor(Number(v)));
  const next = { name: str(b.name, 120) ?? c.name, timezone: str(b.timezone) ?? c.timezone, window_start: str(b.window_start) ?? c.window_start, window_end: str(b.window_end) ?? c.window_end,
    days: Array.isArray(b.days) ? b.days.map(Number).filter((d) => d >= 0 && d <= 6).join(',') : c.days, daily_limit: n(b.daily_limit, c.daily_limit), min_interval: n(b.min_interval, c.min_interval),
    max_interval: n(b.max_interval, c.max_interval), verification_threshold: b.verification_threshold ?? c.verification_threshold,
    track_clicks: 'track_clicks' in b ? (b.track_clicks ? 1 : 0) : c.track_clicks, stop_on_reply: 'stop_on_reply' in b ? (b.stop_on_reply ? 1 : 0) : c.stop_on_reply };
  if ([next.daily_limit, next.min_interval, next.max_interval].some((x) => !Number.isFinite(x))) throw bad(422, 'Limits and intervals must be numbers');
  let paused = false;
  tx(() => {
    run(`UPDATE campaigns SET name=?, timezone=?, window_start=?, window_end=?, days=?, daily_limit=?, min_interval=?, max_interval=?, verification_threshold=?, track_clicks=?, stop_on_reply=? WHERE id=?`,
      next.name, next.timezone, next.window_start, next.window_end, next.days, next.daily_limit, next.min_interval, next.max_interval, next.verification_threshold, next.track_clicks, next.stop_on_reply, id);
    if (Array.isArray(b.account_ids)) {
      run('DELETE FROM campaign_accounts WHERE campaign_id = ?', id);
      for (const aid of [...new Set(b.account_ids.map(int))]) { if (!get('SELECT 1 x FROM accounts WHERE id = ?', aid)) throw bad(422, 'Unknown sending account'); run('INSERT INTO campaign_accounts (campaign_id, account_id) VALUES (?,?)', id, aid); }
    }
    if (Array.isArray(b.steps)) {
      if (b.steps.length > 12) throw bad(422, 'A sequence can have at most 12 steps');
      // Steps/variants keep their ids when edited so historical analytics stay attached.
      const keepSteps = new Set(), keepVariants = new Set();
      b.steps.forEach((s, pos) => {
        const cond = ['always', 'if_clicked', 'if_not_clicked', 'if_field'].includes(s.condition?.type) ? { type: s.condition.type, ...(s.condition.type === 'if_field' ? { field: String(s.condition.field || '').replace(/[^\w]/g, '') } : {}) } : { type: 'always' };
        const delay = pos === 0 ? 0 : Math.max(0, Math.floor(Number(s.delay_days) || 0));
        let sid = s.id && c.steps.some((x) => x.id === s.id) ? s.id : null;
        if (sid) run('UPDATE steps SET position = ?, delay_days = ?, condition = ? WHERE id = ?', pos, delay, JSON.stringify(cond), sid);
        else sid = Number(run('INSERT INTO steps (campaign_id, position, delay_days, condition) VALUES (?,?,?,?)', id, pos, delay, JSON.stringify(cond)).lastInsertRowid);
        keepSteps.add(sid);
        (s.variants || []).slice(0, 5).forEach((v, vi) => {
          const label = String.fromCharCode(65 + vi), subject = String(v.subject ?? '').slice(0, 300), body = String(v.body ?? '').slice(0, 20000), weight = Math.max(0, Math.floor(Number(v.weight ?? 1)));
          const old = v.id && get('SELECT * FROM variants WHERE id = ? AND step_id = ?', v.id, sid);
          if (old) { if (c.status === 'active' && (old.subject !== subject || old.body !== body)) paused = true; run('UPDATE variants SET label=?, subject=?, body=?, weight=? WHERE id=?', label, subject, body, weight, old.id); keepVariants.add(old.id); }
          else { if (c.status === 'active') paused = true; keepVariants.add(Number(run('INSERT INTO variants (step_id, label, subject, body, weight) VALUES (?,?,?,?,?)', sid, label, subject, body, weight).lastInsertRowid)); }
        });
      });
      for (const s of c.steps) {
        for (const v of s.variants) if (!keepVariants.has(v.id)) run('DELETE FROM variants WHERE id = ?', v.id);
        if (!keepSteps.has(s.id)) { run('DELETE FROM variants WHERE step_id = ?', s.id); run('DELETE FROM steps WHERE id = ?', s.id); if (c.status === 'active') paused = true; }
      }
    }
    if (paused) run("UPDATE campaigns SET status = 'paused' WHERE id = ?", id);
  });
  res.json({ ...campaignOut(loadCampaign(id)), paused_for_revalidation: paused });
});
api.delete('/campaigns/:id', (req, res) => {
  const id = int(req.params.id), c = get('SELECT * FROM campaigns WHERE id = ?', id);
  if (!c) throw bad(404, 'Campaign not found');
  if (c.status === 'active') throw bad(409, 'Pause the campaign before deleting it');
  tx(() => { run('DELETE FROM variants WHERE step_id IN (SELECT id FROM steps WHERE campaign_id = ?)', id); for (const t of ['steps', 'campaign_accounts', 'campaign_leads']) run(`DELETE FROM ${t} WHERE campaign_id = ?`, id); run('DELETE FROM campaigns WHERE id = ?', id); });
  audit('campaign.delete', { id, name: c.name }, req.user.email); res.json({ ok: true });
});
api.post('/campaigns/:id/duplicate', (req, res) => {
  const c = loadCampaign(int(req.params.id));
  if (!c) throw bad(404, 'Campaign not found');
  const id = tx(() => {
    const nid = Number(run(`INSERT INTO campaigns (name, timezone, window_start, window_end, days, daily_limit, min_interval, max_interval, verification_threshold, track_clicks, stop_on_reply, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      `${c.name} (copy)`, c.timezone, c.window_start, c.window_end, c.days, c.daily_limit, c.min_interval, c.max_interval, c.verification_threshold, c.track_clicks, c.stop_on_reply, now()).lastInsertRowid);
    for (const a of c.accounts) run('INSERT INTO campaign_accounts (campaign_id, account_id) VALUES (?,?)', nid, a.id);
    for (const s of c.steps) { const sid = Number(run('INSERT INTO steps (campaign_id, position, delay_days, condition) VALUES (?,?,?,?)', nid, s.position, s.delay_days, JSON.stringify(s.condition)).lastInsertRowid); for (const v of s.variants) run('INSERT INTO variants (step_id, label, subject, body, weight) VALUES (?,?,?,?,?)', sid, v.label, v.subject, v.body, v.weight); }
    return nid;
  }); // Leads are deliberately not copied: the same people must not receive the sequence twice.
  res.status(201).json(campaignOut(loadCampaign(id)));
});
api.get('/campaigns/:id/leads', (req, res) => res.json(all(`SELECT cl.id, cl.status, cl.current_step, cl.next_send_at, cl.skip_reason, l.id lead_id, l.email, l.first_name, l.last_name, l.company, l.verification_status, l.verification_checked_at
  FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE cl.campaign_id = ? ORDER BY cl.id LIMIT 5000`, int(req.params.id))));
/** Add leads. Duplicates (already in this campaign) and suppressed contacts are refused and reported, never silently added. */
api.post('/campaigns/:id/leads', (req, res) => {
  const id = int(req.params.id);
  const c = get('SELECT * FROM campaigns WHERE id = ?', id);
  if (!c) throw bad(404, 'Campaign not found');
  const ids = (req.body?.lead_ids || []).map(int);
  if (!ids.length) throw bad(400, 'No leads selected');
  const out = { added: 0, already_in_campaign: 0, suppressed: 0, missing: 0 };
  tx(() => { for (const lid of ids) {
    const l = get('SELECT * FROM leads WHERE id = ?', lid);
    if (!l) { out.missing++; continue; }
    if (isSuppressed(l.email)) { out.suppressed++; continue; }
    if (get('SELECT 1 x FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?', id, lid)) { out.already_in_campaign++; continue; }
    run('INSERT INTO campaign_leads (campaign_id, lead_id, status, next_send_at, added_at) VALUES (?,?,?,?,?)', id, lid, c.status === 'active' ? 'active' : 'pending', c.status === 'active' ? now() : null, now());
    out.added++;
  } });
  res.json(out);
});
api.post('/campaigns/:id/leads/remove', (req, res) => {
  const id = int(req.params.id), ids = (req.body?.lead_ids || []).map(int);
  if (!ids.length) throw bad(400, 'No leads selected');
  const r = run(`DELETE FROM campaign_leads WHERE campaign_id = ? AND status IN ('pending','active','skipped') AND lead_id IN (${ids.map(() => '?').join(',')})`, id, ...ids);
  res.json({ removed: Number(r.changes) });
});
api.get('/campaigns/:id/readiness', (req, res) => res.json(readiness(int(req.params.id))));
api.post('/campaigns/:id/launch', (req, res) => {
  try { res.json({ launched: true, readiness: launchCampaign(int(req.params.id), req.user.email) }); }
  catch (err) { if (err.readiness) return res.status(422).json({ error: err.message, readiness: err.readiness }); throw err; }
});
api.post('/campaigns/:id/pause', (req, res) => { run("UPDATE campaigns SET status = 'paused' WHERE id = ? AND status = 'active'", int(req.params.id)); audit('campaign.pause', { id: req.params.id }, req.user.email); res.json({ ok: true }); });
/** Preview exactly what one lead would receive for a step. */
api.post('/campaigns/:id/preview', (req, res) => {
  const c = loadCampaign(int(req.params.id));
  if (!c) throw bad(404, 'Campaign not found');
  const step = c.steps[Number(req.body?.step ?? 0)];
  if (!step?.variants.length) throw bad(422, 'That step has no email yet');
  const lead = req.body?.lead_id ? get('SELECT * FROM leads WHERE id = ?', int(req.body.lead_id)) : get('SELECT l.* FROM leads l JOIN campaign_leads cl ON cl.lead_id = l.id WHERE cl.campaign_id = ? ORDER BY cl.id LIMIT 1', c.id);
  if (!lead) throw bad(422, 'Add a lead to the campaign to preview');
  const variant = step.variants.find((v) => v.id === req.body?.variant_id) ?? pickVariant(step.variants, lead.id);
  const acct = c.accounts[0] ?? { email: 'you@example.com', from_name: '' };
  const ctx = leadContext(lead, acct);
  const s = render(variant.subject || (step.position ? 'Re: (first email subject)' : ''), ctx), b = render(variant.body, ctx);
  const parts = composeBodies({ bodyText: b.text, account: acct, unsubToken: 'preview', messageId: null, trackClicks: false });
  res.json({ to: lead.email, from: acct.email, variant: variant.label, subject: s.text, text: parts.text, missing: [...new Set([...s.missing, ...b.missing])] });
});

// ---------- AI + lint ----------
api.post('/ai/lint', (req, res) => res.json(lintEmail({ subject: String(req.body?.subject ?? ''), body: String(req.body?.body ?? '') }, knownVars())));
api.post('/ai/opening-line', async (req, res) => {
  const lead = get('SELECT * FROM leads WHERE id = ?', int(req.body?.lead_id));
  if (!lead) throw bad(404, 'Lead not found');
  res.json(await assistant.draftOpeningLine(lead));
});
const emailIn = (b) => ({ subject: String(b?.subject ?? '').slice(0, 300), body: String(b?.body ?? '').slice(0, 20000) });
const needBody = (e) => { if (!e.body.trim()) throw bad(422, 'Write a draft first'); return e; };
api.post('/ai/variations', async (req, res) => res.json({ review_required: true, variations: await assistant.generateVariations({ ...needBody(emailIn(req.body)), count: Number(req.body?.count) || 2, variables: knownVars() }) }));
api.post('/ai/rewrite', async (req, res) => res.json({ review_required: true, ...(await assistant.rewriteTone({ ...needBody(emailIn(req.body)), tone: str(req.body?.tone, 60) ?? 'friendly and direct', variables: knownVars() })) }));
api.post('/ai/subjects', async (req, res) => res.json({ review_required: true, subjects: await assistant.suggestSubjects({ body: needBody(emailIn(req.body)).body }) }));
api.post('/ai/review', async (req, res) => {
  const lead = req.body?.lead_id ? get('SELECT * FROM leads WHERE id = ?', int(req.body.lead_id)) : null;
  res.json(await assistant.reviewEmail({ ...needBody(emailIn(req.body)), leadFacts: lead ? leadContext(lead) : {} }));
});
api.get('/ai/drafts', (req, res) => res.json(all(`SELECT d.*, l.email, l.company, l.website FROM ai_drafts d LEFT JOIN leads l ON l.id = d.lead_id WHERE d.status = ? ORDER BY d.id DESC LIMIT 300`, ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending').map((d) => ({ ...d, sources: j(d.sources) }))));
api.post('/ai/drafts/:id/decision', (req, res) => {
  if (!['approve', 'reject'].includes(req.body?.decision)) throw bad(400, 'Decision must be approve or reject');
  if (req.body.content != null) { const c = str(req.body.content, 600); if (!c) throw bad(422, 'Draft cannot be empty'); run("UPDATE ai_drafts SET content = ? WHERE id = ? AND status = 'pending'", c, int(req.params.id)); }
  const d = assistant.decideDraft(int(req.params.id), req.body.decision); audit(`ai_draft.${req.body.decision}`, { id: d.id }, req.user.email); res.json(d);
});

// ---------- unified inbox ----------
api.get('/inbox/threads', (req, res) => {
  const q = req.query, cond = ["m.direction = 'in'"], args = [];
  if (q.mode === 'sandbox') cond.push('m.simulated = 1'); else cond.push('m.simulated = 0');
  if (q.label) { cond.push('m.classification = ?'); args.push(q.label); } else if (q.include_auto !== '1') cond.push("m.classification != 'auto_reply'");
  if (q.account_id) { cond.push('m.account_id = ?'); args.push(Number(q.account_id)); }
  if (q.campaign_id) { cond.push('m.campaign_id = ?'); args.push(Number(q.campaign_id)); }
  if (q.unread === '1') cond.push('m.is_read = 0');
  if (q.q) { cond.push('(l.email LIKE ? OR l.company LIKE ? OR m.body_text LIKE ?)'); args.push(...Array(3).fill(`%${String(q.q).replace(/[%_]/g, '')}%`)); }
  res.json(all(`SELECT m.lead_id, l.email, l.first_name, l.last_name, l.company, MAX(m.id) last_id, COUNT(*) inbound, SUM(m.is_read = 0) unread,
      (SELECT x.classification FROM messages x WHERE x.lead_id = m.lead_id AND x.direction = 'in' ORDER BY x.id DESC LIMIT 1) label,
      (SELECT x.classification_source FROM messages x WHERE x.lead_id = m.lead_id AND x.direction = 'in' ORDER BY x.id DESC LIMIT 1) label_source,
      (SELECT substr(x.body_text, 1, 140) FROM messages x WHERE x.lead_id = m.lead_id AND x.direction = 'in' ORDER BY x.id DESC LIMIT 1) snippet,
      (SELECT x.created_at FROM messages x WHERE x.lead_id = m.lead_id ORDER BY x.id DESC LIMIT 1) last_at,
      (SELECT c.name FROM campaigns c WHERE c.id = m.campaign_id) campaign, (SELECT a.email FROM accounts a WHERE a.id = m.account_id) account,
      EXISTS (SELECT 1 FROM events e WHERE e.lead_id = m.lead_id AND e.type = 'meeting_booked') meeting
    FROM messages m JOIN leads l ON l.id = m.lead_id WHERE ${cond.join(' AND ')} GROUP BY m.lead_id ORDER BY last_id DESC LIMIT 300`, ...args));
});
api.get('/inbox/threads/:leadId', (req, res) => {
  const id = int(req.params.leadId), lead = get('SELECT * FROM leads WHERE id = ?', id);
  if (!lead) throw bad(404, 'Lead not found');
  run("UPDATE messages SET is_read = 1 WHERE lead_id = ? AND direction = 'in'", id);
  res.json({ lead: { ...lead, tags: j(lead.tags, []), custom: j(lead.custom, {}) }, suppressed: isSuppressed(lead.email)?.reason ?? null,
    meeting: Boolean(get("SELECT 1 x FROM events WHERE lead_id = ? AND type = 'meeting_booked'", id)),
    messages: all(`SELECT m.id, m.direction, m.subject, m.body_text, m.from_addr, m.to_addr, m.status, m.error, m.simulated, m.classification, m.classification_source, m.created_at, m.campaign_id, m.account_id,
      (SELECT name FROM campaigns c WHERE c.id = m.campaign_id) campaign FROM messages m WHERE m.lead_id = ? AND m.status != 'sending' ORDER BY m.id`, id) });
});
const LABELS = ['interested', 'not_interested', 'question', 'unsubscribe_request', 'auto_reply', 'wrong_person', 'other'];
api.patch('/inbox/messages/:id', (req, res) => {
  const m = get("SELECT * FROM messages WHERE id = ? AND direction = 'in'", int(req.params.id));
  if (!m) throw bad(404, 'Message not found');
  if (req.body?.classification) {
    if (!LABELS.includes(req.body.classification)) throw bad(422, 'Unknown label');
    run("UPDATE messages SET classification = ?, classification_source = 'manual' WHERE id = ?", req.body.classification, m.id);
    if (req.body.classification === 'unsubscribe_request') { suppress(m.from_addr, 'unsubscribe', 'labelled in inbox'); stopSequences(m.lead_id, 'unsubscribed', 'unsubscribe labelled in inbox'); logEvent('unsubscribe', { campaign_id: m.campaign_id, lead_id: m.lead_id, account_id: m.account_id, simulated: m.simulated, meta: { via: 'manual_label' } }); }
  }
  if ('is_read' in (req.body || {})) run('UPDATE messages SET is_read = ? WHERE id = ?', req.body.is_read ? 1 : 0, m.id);
  res.json(get('SELECT * FROM messages WHERE id = ?', m.id));
});
api.post('/inbox/threads/:leadId/meeting', (req, res) => {
  const id = int(req.params.leadId);
  const last = get("SELECT * FROM messages WHERE lead_id = ? ORDER BY id DESC LIMIT 1", id);
  if (!last) throw bad(404, 'No conversation with this lead');
  if (req.body?.booked === false) run("DELETE FROM events WHERE lead_id = ? AND type = 'meeting_booked'", id);
  else if (!get("SELECT 1 x FROM events WHERE lead_id = ? AND type = 'meeting_booked'", id)) logEvent('meeting_booked', { campaign_id: last.campaign_id, lead_id: id, account_id: last.account_id, domain: domainOf(last.direction === 'in' ? last.to_addr : last.from_addr), simulated: last.simulated, meta: { marked_by: req.user.email } });
  res.json({ ok: true });
});
/** Manual reply from the inbox, threaded onto the conversation and sent from the same inbox. */
api.post('/inbox/threads/:leadId/reply', async (req, res) => {
  const id = int(req.params.leadId), body = String(req.body?.body ?? '').trim();
  if (!body) throw bad(422, 'Write a reply first');
  const lead = get('SELECT * FROM leads WHERE id = ?', id);
  const last = get('SELECT * FROM messages WHERE lead_id = ? ORDER BY id DESC LIMIT 1', id);
  if (!lead || !last) throw bad(404, 'No conversation with this lead');
  const sup = isSuppressed(lead.email);
  if (sup && req.body?.override_suppression !== true) throw bad(409, `${lead.email} is suppressed (${sup.reason}). Replying is blocked unless you confirm they asked you a direct question.`, { needs_confirm: 'override_suppression' });
  const account = get('SELECT * FROM accounts WHERE id = ?', last.account_id);
  if (!account || !canSend(account)) throw bad(409, `The inbox this conversation belongs to (${account?.email ?? 'deleted'}) cannot send right now (${account?.status ?? 'missing'}).`);
  const lastIn = get("SELECT * FROM messages WHERE lead_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1", id);
  const firstOut = get("SELECT * FROM messages WHERE lead_id = ? AND direction = 'out' ORDER BY id LIMIT 1", id);
  const subject = /^re:/i.test(lastIn?.subject || '') ? lastIn.subject : `Re: ${lastIn?.subject || firstOut?.subject || ''}`.trim();
  const rfcId = `<${crypto.randomUUID()}@${domainOf(account.email)}>`;
  const text = [body, account.signature?.trim()].filter(Boolean).join('\n\n');
  const mid = Number(run(`INSERT INTO messages (direction, campaign_id, lead_id, campaign_lead_id, account_id, rfc_id, in_reply_to, from_addr, to_addr, subject, body_text, status, simulated, is_read, created_at) VALUES ('out',?,?,?,?,?,?,?,?,?,?,'sending',?,1,?)`,
    last.campaign_id, id, last.campaign_lead_id, account.id, rfcId, lastIn?.rfc_id ?? last.rfc_id, account.email, lead.email, subject, text, account.provider === 'sandbox' ? 1 : 0, now()).lastInsertRowid);
  try {
    await transport.deliver(account, { from: account.from_name ? { name: account.from_name, address: account.email } : account.email, to: lead.email, subject, text, messageId: rfcId, inReplyTo: lastIn?.rfc_id ?? last.rfc_id, references: [firstOut?.rfc_id, lastIn?.rfc_id].filter(Boolean) });
    run("UPDATE messages SET status = 'sent' WHERE id = ?", mid);
    logEvent('manual_reply', { campaign_id: last.campaign_id, lead_id: id, account_id: account.id, message_id: mid, domain: domainOf(account.email), simulated: account.provider === 'sandbox' });
    res.status(201).json({ id: mid, simulated: account.provider === 'sandbox' });
  } catch (err) { run("UPDATE messages SET status = 'failed', error = ? WHERE id = ?", String(err.message).slice(0, 300), mid); throw bad(502, `The reply was not sent: ${String(err.message).slice(0, 200)}`); }
});
api.post('/inbox/sync', async (req, res) => res.json(await syncAll()));

/** Sandbox-only: inject a reply or bounce so workflows can be rehearsed without real mail. Always flagged simulated. */
api.post('/sandbox/inbound', async (req, res) => {
  const m = get("SELECT m.*, a.provider FROM messages m JOIN accounts a ON a.id = m.account_id WHERE m.id = ? AND m.direction = 'out'", int(req.body?.message_id));
  if (!m) throw bad(404, 'Outbound message not found');
  if (m.provider !== 'sandbox') throw bad(403, 'Simulated replies can only be attached to sandbox accounts, so real metrics are never polluted.');
  const account = get('SELECT * FROM accounts WHERE id = ?', m.account_id);
  res.json(await processInbound(account, req.body.kind === 'bounce'
    ? { simulated: true, inReplyTo: m.rfc_id, bounce: { recipient: m.to_addr, status: req.body.soft ? '4.2.2' : '5.1.1', diagnostic: req.body.soft ? '452 4.2.2 Mailbox full (simulated)' : '550 5.1.1 User unknown (simulated)' } }
    : { simulated: true, from: m.to_addr, subject: `Re: ${m.subject}`, text: String(req.body?.text || 'Sounds interesting, tell me more.'), rfcId: `<${crypto.randomUUID()}@sandbox.invalid>`, inReplyTo: m.rfc_id }));
});
api.post('/engine/tick', async (req, res) => res.json(await tick(req.body?.at ? new Date(req.body.at) : new Date())));
api.post('/events/complaint', (req, res) => {
  const lead = get('SELECT * FROM leads WHERE email = ?', String(req.body?.email || '').toLowerCase());
  if (!lead) throw bad(404, 'No lead with that address');
  const last = get("SELECT * FROM messages WHERE lead_id = ? AND direction = 'out' ORDER BY id DESC LIMIT 1", lead.id);
  suppress(lead.email, 'complaint', 'spam complaint recorded manually'); stopSequences(lead.id, 'unsubscribed', 'spam complaint');
  logEvent('complaint', { campaign_id: last?.campaign_id, lead_id: lead.id, account_id: last?.account_id, domain: last ? domainOf(last.from_addr) : null, simulated: last?.simulated, meta: { recorded_by: req.user.email } });
  res.status(201).json({ ok: true });
});

// ---------- analytics ----------
const filt = (q) => ({ mode: q.mode === 'sandbox' ? 'sandbox' : 'real', campaign_id: q.campaign_id || null, account_id: q.account_id || null, from: q.from || null, to: q.to || null });
api.get('/analytics/summary', (req, res) => res.json({ mode: filt(req.query).mode, ...summary(filt(req.query)) }));
api.get('/analytics/breakdown', (req, res) => res.json(breakdown(filt(req.query), String(req.query.by || 'campaign'))));
api.get('/analytics/timeseries', (req, res) => res.json(timeseries(filt(req.query), Math.min(180, Math.max(7, Number(req.query.days) || 30)))));
api.get('/analytics/export.csv', (req, res) => { const by = String(req.query.by || 'campaign'); res.type('text/csv').attachment(`analytics-by-${by}-${filt(req.query).mode}.csv`).send(toCsv(exportRows(filt(req.query), by))); });
api.get('/dashboard', (req, res) => {
  const f = filt(req.query), prevFrom = new Date(Date.now() - 60 * 864e5).toISOString(), mid = new Date(Date.now() - 30 * 864e5).toISOString();
  res.json({
    mode: f.mode, has_sandbox_data: Boolean(get('SELECT 1 x FROM events WHERE simulated = 1 LIMIT 1')), has_real_data: Boolean(get('SELECT 1 x FROM events WHERE simulated = 0 LIMIT 1')),
    last_30: summary({ ...f, from: mid }), previous_30: summary({ ...f, from: prevFrom, to: mid }), series: timeseries(f, 30), campaigns: campaignProgress(f.mode),
    alerts: all('SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY id DESC LIMIT 20'),
    accounts: all('SELECT id, email, status, paused, provider FROM accounts'), domains: all('SELECT id, name, status, score, last_checked_at FROM domains'),
    leads: { total: get('SELECT COUNT(*) n FROM leads').n, by_status: all('SELECT verification_status value, COUNT(*) n FROM leads GROUP BY 1') },
    pending_ai_drafts: get("SELECT COUNT(*) n FROM ai_drafts WHERE status = 'pending'").n, unread_replies: get("SELECT COUNT(*) n FROM messages WHERE direction = 'in' AND is_read = 0 AND simulated = ? AND classification != 'auto_reply'", f.mode === 'sandbox' ? 1 : 0).n,
  });
});
