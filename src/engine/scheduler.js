// Sending engine. One tick = for each active campaign, send at most one email per
// available inbox, after re-validating the recipient, account and content.
import crypto from 'node:crypto';
import { all, get, run, tx, now, j, logEvent, raiseAlert, audit } from '../db.js';
import { token } from '../crypto.js';
import { config } from '../config.js';
import { loadCampaign, isSuppressed, readiness } from '../campaigns/readiness.js';
import { leadContext, render, composeBodies, pickVariant } from '../campaigns/render.js';
import { meetsThreshold } from '../verify/engine.js';
import { canSend, effectiveDailyLimit, sentToday, domainOf } from '../accounts/service.js';
import { transport } from './transport.js';

/** Wall-clock parts in a time zone. */
export function localParts(date, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map((x) => [x.type, x.value]));
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), hm: `${p.hour}:${p.minute}` };
}
export function inWindow(c, date = new Date()) {
  const { day, hm } = localParts(date, c.timezone);
  return String(c.days).split(',').map(Number).includes(day) && hm >= c.window_start && hm < c.window_end;
}
const randInt = (a, b) => a + crypto.randomInt(Math.max(1, b - a + 1));

function conditionMet(step, cl) {
  const cond = step.condition || { type: 'always' };
  if (cond.type === 'always') return true;
  const clicked = get("SELECT 1 x FROM events WHERE type = 'click' AND campaign_id = ? AND lead_id = ? LIMIT 1", cl.campaign_id, cl.lead_id);
  if (cond.type === 'if_clicked') return Boolean(clicked);
  if (cond.type === 'if_not_clicked') return !clicked;
  if (cond.type === 'if_field') { const lead = get('SELECT * FROM leads WHERE id = ?', cl.lead_id); return Boolean(String(leadContext(lead)[cond.field] ?? '').trim()); }
  return true;
}
function advance(cl, campaign, fromIndex, at) {
  const next = campaign.steps[fromIndex + 1];
  if (!next) return run("UPDATE campaign_leads SET status = 'completed', current_step = ?, next_send_at = NULL WHERE id = ?", fromIndex + 1, cl.id);
  run("UPDATE campaign_leads SET status = 'active', current_step = ?, next_send_at = ? WHERE id = ?", fromIndex + 1, new Date(at.getTime() + next.delay_days * 864e5).toISOString(), cl.id);
}
const halt = (cl, status, reason) => run('UPDATE campaign_leads SET status = ?, skip_reason = ?, next_send_at = NULL WHERE id = ?', status, reason, cl.id);

function pickAccount(campaign, cl, at) {
  const usable = campaign.accounts.filter((a) => canSend(a) && (!a.next_available_at || Date.parse(a.next_available_at) <= at.getTime()))
    .map((a) => ({ a, sent: sentToday(a.id, at) })).filter((x) => x.sent < effectiveDailyLimit(x.a, at.getTime()));
  if (!usable.length) return null;
  // Keep a lead on the inbox that first emailed them so follow-ups thread. If that inbox is only
  // busy, wait for it; if it can no longer send at all, fall back to the least-used inbox.
  const sticky = campaign.accounts.find((a) => a.id === cl.account_id);
  if (sticky && canSend(sticky)) return usable.find((x) => x.a.id === sticky.id)?.a ?? null;
  return usable.sort((x, y) => x.sent - y.sent)[0].a;
}

/** Circuit breaker: pause a campaign whose measured hard-bounce rate shows the list is bad. */
export function bounceBreaker(campaign) {
  const c = Object.fromEntries(all("SELECT type, COUNT(*) n FROM events WHERE campaign_id = ? AND type IN ('sent','bounce_hard') GROUP BY type", campaign.id).map((r) => [r.type, r.n]));
  if ((c.sent || 0) >= 20 && (c.bounce_hard || 0) / c.sent > 0.08) {
    run("UPDATE campaigns SET status = 'paused' WHERE id = ?", campaign.id);
    raiseAlert('critical', 'campaign', campaign.id, `"${campaign.name}" was paused automatically: hard bounce rate ${(c.bounce_hard / c.sent * 100).toFixed(1)}% (${c.bounce_hard}/${c.sent}) exceeds 8%. Re-verify the list before resuming.`);
    return true;
  }
  return false;
}

/** Send the due step for one campaign lead. Returns a short outcome string. */
export async function sendOne(campaign, cl, account, at = new Date()) {
  const lead = get('SELECT * FROM leads WHERE id = ?', cl.lead_id);
  if (!lead) { halt(cl, 'skipped', 'lead deleted'); return 'skipped'; }
  // --- pre-send gate: nothing leaves without passing these again ---
  const sup = isSuppressed(lead.email);
  if (sup) { halt(cl, sup.reason === 'unsubscribe' ? 'unsubscribed' : 'skipped', `suppressed: ${sup.reason}`); logEvent('blocked', { campaign_id: campaign.id, lead_id: lead.id, meta: { reason: `suppressed:${sup.reason}` }, simulated: account.provider === 'sandbox' }); return 'blocked'; }
  const ver = meetsThreshold(lead, campaign.verification_threshold);
  if (!ver.ok) { halt(cl, 'skipped', `verification: ${ver.reason}`); logEvent('blocked', { campaign_id: campaign.id, lead_id: lead.id, meta: { reason: `verification:${ver.reason}` }, simulated: account.provider === 'sandbox' }); return 'blocked'; }
  if (campaign.stop_on_reply && get("SELECT 1 x FROM messages WHERE direction = 'in' AND lead_id = ? AND campaign_id = ? AND classification NOT IN ('auto_reply') LIMIT 1", lead.id, campaign.id)) { halt(cl, 'replied', 'reply received'); return 'replied'; }

  let index = cl.current_step;
  while (campaign.steps[index] && !conditionMet(campaign.steps[index], cl)) index++;
  const step = campaign.steps[index];
  if (!step) { run("UPDATE campaign_leads SET status = 'completed', next_send_at = NULL WHERE id = ?", cl.id); return 'completed'; }
  const variant = pickVariant(step.variants, lead.id);
  const ctx = leadContext(lead, account);
  const first = get("SELECT * FROM messages WHERE campaign_lead_id = ? AND direction = 'out' AND status = 'sent' ORDER BY id LIMIT 1", cl.id);
  const prev = get("SELECT * FROM messages WHERE campaign_lead_id = ? AND direction = 'out' AND status = 'sent' ORDER BY id DESC LIMIT 1", cl.id);
  const subj = render(variant.subject.trim() || (first ? `Re: ${first.subject}` : ''), ctx);
  const body = render(variant.body, ctx);
  const missing = [...new Set([...subj.missing, ...body.missing])];
  if (missing.length || !subj.text.trim() || !body.text.trim()) {
    halt(cl, 'skipped', `personalisation: ${missing.length ? 'missing ' + missing.join(', ') : 'empty subject or body'}`);
    logEvent('blocked', { campaign_id: campaign.id, lead_id: lead.id, meta: { reason: 'personalisation', missing }, simulated: account.provider === 'sandbox' });
    return 'blocked';
  }

  const simulated = account.provider === 'sandbox';
  const rfcId = `<${crypto.randomUUID()}@${domainOf(account.email)}>`;
  const unsub = token(16);
  const msgId = Number(run(`INSERT INTO messages (direction, campaign_id, lead_id, campaign_lead_id, step_id, variant_id, account_id, rfc_id, in_reply_to, from_addr, to_addr, subject, body_text, status, simulated, is_read, created_at)
    VALUES ('out',?,?,?,?,?,?,?,?,?,?,?,?,'sending',?,1,?)`, campaign.id, lead.id, cl.id, step.id, variant.id, account.id, rfcId, prev?.rfc_id ?? null, account.email, lead.email, subj.text, body.text, simulated ? 1 : 0, at.toISOString()).lastInsertRowid);
  run('INSERT INTO unsub_tokens (token, lead_id, campaign_id, message_id) VALUES (?,?,?,?)', unsub, lead.id, campaign.id, msgId);
  const parts = composeBodies({ bodyText: body.text, account, unsubToken: unsub, messageId: msgId, trackClicks: Boolean(campaign.track_clicks) });
  const mail = {
    from: account.from_name ? { name: account.from_name, address: account.email } : account.email, to: lead.email, subject: subj.text,
    text: parts.text, html: parts.html, messageId: rfcId,
    headers: { 'List-Unsubscribe': `<${parts.unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    ...(prev ? { inReplyTo: prev.rfc_id, references: [first.rfc_id, prev.rfc_id].filter((v, i, arr) => arr.indexOf(v) === i) } : {}),
  };
  const ev = { campaign_id: campaign.id, lead_id: lead.id, account_id: account.id, message_id: msgId, step_id: step.id, variant_id: variant.id, domain: domainOf(account.email), simulated, at: at.toISOString() };
  const gap = randInt(campaign.min_interval, campaign.max_interval);
  try {
    await transport.deliver(account, mail);
    tx(() => {
      run("UPDATE messages SET status = 'sent' WHERE id = ?", msgId);
      run('UPDATE campaign_leads SET account_id = ? WHERE id = ?', account.id, cl.id);
      run('UPDATE accounts SET next_available_at = ? WHERE id = ?', new Date(at.getTime() + gap * 1000).toISOString(), account.id);
      logEvent('sent', ev);
      advance(cl, campaign, index, at);
    });
    return 'sent';
  } catch (err) {
    const msg = String(err.message || err).slice(0, 300);
    const code = err.responseCode;
    const isAuth = err.code === 'EAUTH' || code === 535;
    run("UPDATE messages SET status = 'failed', error = ? WHERE id = ?", msg, msgId);
    logEvent('send_failed', { ...ev, meta: { error: msg, code } });
    if (isAuth) {
      run("UPDATE accounts SET status = 'failing' WHERE id = ?", account.id);
      logEvent('auth_failure', { account_id: account.id, domain: ev.domain, meta: { error: msg } });
      raiseAlert('critical', 'account', account.id, `${account.email} was rejected by its SMTP server (authentication); sending from it is stopped`);
    } else if (code >= 500 && code < 600 && /recipient|user|mailbox|address/i.test(msg)) {
      // Rejected at SMTP time: a measured hard bounce.
      run('INSERT OR IGNORE INTO suppressions (value, kind, reason, note, created_at) VALUES (?,?,?,?,?)', lead.email, 'email', 'bounce', msg, now());
      halt(cl, 'bounced', msg); logEvent('bounce_hard', { ...ev, meta: { error: msg, at: 'smtp' } });
    } else {
      // Transient: retry in 30 minutes, give up after 3 failures for this step.
      const fails = get("SELECT COUNT(*) n FROM messages WHERE campaign_lead_id = ? AND step_id = ? AND status = 'failed'", cl.id, step.id).n;
      if (fails >= 3) halt(cl, 'failed', `3 failed attempts: ${msg}`);
      else run('UPDATE campaign_leads SET next_send_at = ? WHERE id = ?', new Date(at.getTime() + 30 * 60e3).toISOString(), cl.id);
      run('UPDATE accounts SET next_available_at = ? WHERE id = ?', new Date(at.getTime() + gap * 1000).toISOString(), account.id);
    }
    return 'failed';
  }
}

/** Activate: runs the readiness gate, refuses if anything blocks, then queues every pending lead. */
export function launchCampaign(id, actor = 'user') {
  const r = readiness(id);
  if (!r.ready) { const e = new Error('Campaign is not ready to launch'); e.status = 422; e.readiness = r; throw e; }
  const t = now();
  tx(() => {
    run("UPDATE campaigns SET status = 'active', launched_at = COALESCE(launched_at, ?) WHERE id = ?", t, id);
    run("UPDATE campaign_leads SET status = 'active', next_send_at = COALESCE(next_send_at, ?) WHERE campaign_id = ? AND status IN ('pending','active')", t, id);
  });
  audit('campaign.launch', { id, warnings: r.warnings }, actor);
  return r;
}

let running = false;
export async function tick(at = new Date()) {
  if (running) return { skipped: true };
  running = true;
  const outcome = { sent: 0, blocked: 0, failed: 0 };
  try {
    for (const row of all("SELECT id FROM campaigns WHERE status = 'active'")) {
      const campaign = loadCampaign(row.id);
      if (!inWindow(campaign, at) || bounceBreaker(campaign)) continue;
      const dayStart = new Date(at); dayStart.setUTCHours(0, 0, 0, 0);
      let sentToday_ = get("SELECT COUNT(*) n FROM messages WHERE campaign_id = ? AND direction = 'out' AND status = 'sent' AND created_at >= ?", campaign.id, dayStart.toISOString()).n;
      const due = all("SELECT * FROM campaign_leads WHERE campaign_id = ? AND status = 'active' AND next_send_at <= ? ORDER BY current_step DESC, next_send_at LIMIT 200", campaign.id, at.toISOString());
      for (const cl of due) {
        if (sentToday_ >= campaign.daily_limit) break;
        campaign.accounts = all('SELECT a.* FROM accounts a JOIN campaign_accounts ca ON ca.account_id = a.id WHERE ca.campaign_id = ?', campaign.id);
        const account = pickAccount(campaign, cl, at);
        if (!account) { if (!campaign.accounts.some((a) => canSend(a))) break; continue; }
        const res = await sendOne(campaign, cl, account, at);
        if (res === 'sent') { outcome.sent++; sentToday_++; } else if (res === 'blocked') outcome.blocked++; else if (res === 'failed') outcome.failed++;
      }
      if (!campaign.accounts.some((a) => canSend(a))) {
        run("UPDATE campaigns SET status = 'paused' WHERE id = ?", campaign.id);
        raiseAlert('critical', 'campaign', campaign.id, `"${campaign.name}" was paused automatically: no healthy sending account is available`);
      } else if (!get("SELECT 1 x FROM campaign_leads WHERE campaign_id = ? AND status IN ('pending','active') LIMIT 1", campaign.id)) {
        run("UPDATE campaigns SET status = 'completed' WHERE id = ?", campaign.id);
      }
    }
  } finally { running = false; }
  return outcome;
}
