// Reply & bounce ingestion. processInbound() is transport-agnostic so it can be
// exercised by tests and by the sandbox simulator; syncAccount() feeds it from IMAP.
import { simpleParser } from 'mailparser';
import { all, get, run, now, logEvent } from '../db.js';
import { imapClient, domainOf } from '../accounts/service.js';
import { aiEnabled, classifyReplyAI } from '../ai/assistant.js';

const P = (list) => new RegExp(list.join('|'), 'i');
const RX = {
  unsubscribe: P(['\\bunsubscribe\\b', 'remove me', 'take me off', 'stop (emailing|contacting|sending)', 'do not (contact|email)', "don'?t (contact|email) me", 'opt.?out', 'no more emails']),
  auto: P(['out of (the )?office', 'automatic reply', 'auto.?reply', 'autoreply', 'on (annual |parental |maternity )?leave', 'i am away', "i'm away", 'currently away', 'limited access to (my )?e?mail', 'will respond (when|upon) i return']),
  negative: P(['not interested', 'no thanks', 'no thank you', 'not a (good )?fit', 'not (right )?now', "we'?re (all )?set", 'already (have|use|using|work)', 'please stop', 'not relevant', 'no need', 'pass on this']),
  positive: P(['\\binterested\\b', "let'?s (talk|chat|connect|set up)", 'sounds (good|great|interesting)', 'tell me more', 'send (me |us |over |across )*(more |some |the )?(info|information|details)', 'book (a )?(call|time|meeting)', 'schedule (a )?(call|time|meeting)', 'happy to (chat|talk|connect)', 'free (on|next|this|tomorrow)', 'what(\'?s| is) (the|your) (pricing|price|cost)', 'calendar', 'love to (learn|hear|chat)']),
  wrong: P(['wrong person', 'not the right person', 'no longer (with|at|work)', 'left the company', 'reach out to', 'better person', 'please contact']),
};
/** Keyword classifier. Order matters: explicit opt-outs win over everything. */
export function classifyHeuristic(text, { auto = false } = {}) {
  const t = String(text || '').split(/\n(?:On .{5,80} wrote:|-----Original Message-----|From: .+\nSent: )/)[0].replace(/^>.*$/gm, '');
  if (RX.unsubscribe.test(t)) return 'unsubscribe_request';
  if (auto || RX.auto.test(t)) return 'auto_reply';
  if (RX.negative.test(t)) return 'not_interested';
  if (RX.wrong.test(t)) return 'wrong_person';
  if (RX.positive.test(t)) return 'interested';
  if (/\?/.test(t)) return 'question';
  return 'other';
}
export const suppress = (value, reason, note) => run('INSERT OR IGNORE INTO suppressions (value, kind, reason, note, created_at) VALUES (?,?,?,?,?)', String(value).toLowerCase(), value.includes('@') ? 'email' : 'domain', reason, note ?? null, now());
export function stopSequences(leadId, status, reason, campaignId = null) {
  run(`UPDATE campaign_leads SET status = ?, skip_reason = ?, next_send_at = NULL WHERE lead_id = ? AND status IN ('pending','active') ${campaignId ? 'AND campaign_id = ' + Number(campaignId) : ''}`, status, reason, leadId);
}

/**
 * Handle one inbound message. Returns { kind: 'bounce'|'reply'|'ignored', ... }.
 * msg: { from, subject, text, rfcId, inReplyTo, references[], auto, bounce: {recipient,status,diagnostic}|null, raw, date, simulated }
 */
export async function processInbound(account, msg) {
  if (msg.rfcId && get("SELECT 1 x FROM messages WHERE rfc_id = ? AND direction = 'in'", msg.rfcId)) return { kind: 'ignored', reason: 'duplicate' };
  const refs = [msg.inReplyTo, ...(msg.references || [])].filter(Boolean);
  const idsInRaw = [...String(msg.raw || '').matchAll(/<[0-9a-f-]{36}@[^>\s]+>/gi)].map((m) => m[0]);
  let original = null;
  for (const id of [...refs, ...idsInRaw]) { original = get("SELECT * FROM messages WHERE rfc_id = ? AND direction = 'out'", id); if (original) break; }
  const at = msg.date || now();
  const sim = msg.simulated ? 1 : 0;

  if (msg.bounce) {
    const recipient = (msg.bounce.recipient || original?.to_addr || '').toLowerCase();
    original ??= recipient && get("SELECT * FROM messages WHERE to_addr = ? AND direction = 'out' AND account_id = ? ORDER BY id DESC LIMIT 1", recipient, account.id);
    if (!original) return { kind: 'ignored', reason: 'bounce for unknown message' };
    const hard = /^5/.test(msg.bounce.status || '') || (!msg.bounce.status && /user unknown|no such user|does not exist|invalid recipient|address rejected|unknown recipient|mailbox not found/i.test(msg.bounce.diagnostic || msg.text || ''));
    const type = hard ? 'bounce_hard' : 'bounce_soft';
    if (get('SELECT 1 x FROM events WHERE message_id = ? AND type = ?', original.id, type)) return { kind: 'ignored', reason: 'bounce already recorded' };
    logEvent(type, { campaign_id: original.campaign_id, lead_id: original.lead_id, account_id: account.id, message_id: original.id, step_id: original.step_id, variant_id: original.variant_id, domain: domainOf(account.email), simulated: sim, at, meta: { status: msg.bounce.status, diagnostic: String(msg.bounce.diagnostic || '').slice(0, 300) } });
    if (hard) {
      suppress(original.to_addr, 'bounce', msg.bounce.diagnostic || msg.bounce.status);
      stopSequences(original.lead_id, 'bounced', `hard bounce ${msg.bounce.status || ''}`.trim());
      run("UPDATE leads SET verification_status = 'invalid', verification_confidence = 0.99, verification_checked_at = ?, verification_detail = ?, updated_at = ? WHERE id = ?", at, JSON.stringify({ checks: { bounce: 'hard' }, reasons: [`Hard bounce: ${msg.bounce.diagnostic || msg.bounce.status || 'rejected by recipient server'}`] }), at, original.lead_id);
    }
    return { kind: 'bounce', hard, message_id: original.id };
  }

  const fromAddr = String(msg.from || '').toLowerCase();
  let lead = original ? get('SELECT * FROM leads WHERE id = ?', original.lead_id) : null;
  if (!original) {
    lead = get('SELECT * FROM leads WHERE email = ?', fromAddr);
    original = lead && get("SELECT * FROM messages WHERE lead_id = ? AND direction = 'out' AND account_id = ? ORDER BY id DESC LIMIT 1", lead.id, account.id);
  }
  if (!original || !lead) return { kind: 'ignored', reason: 'not a reply to a tracked email' }; // unrelated mail is never stored

  let label = classifyHeuristic(msg.text, { auto: msg.auto }), source = 'heuristic';
  if (aiEnabled() && label !== 'auto_reply') {
    try { label = (await classifyReplyAI(msg.text)).label; source = 'ai'; } catch { /* keep heuristic */ }
  }
  const id = Number(run(`INSERT INTO messages (direction, campaign_id, lead_id, campaign_lead_id, step_id, variant_id, account_id, rfc_id, in_reply_to, from_addr, to_addr, subject, body_text, status, simulated, classification, classification_source, created_at)
    VALUES ('in',?,?,?,?,?,?,?,?,?,?,?,?,'received',?,?,?,?)`, original.campaign_id, lead.id, original.campaign_lead_id, original.step_id, original.variant_id, account.id, msg.rfcId ?? null, original.rfc_id, fromAddr || lead.email, account.email, msg.subject ?? '', String(msg.text ?? '').slice(0, 50000), sim, label, source, at).lastInsertRowid);
  const ev = { campaign_id: original.campaign_id, lead_id: lead.id, account_id: account.id, message_id: id, step_id: original.step_id, variant_id: original.variant_id, domain: domainOf(account.email), simulated: sim, at };
  if (label === 'auto_reply') { logEvent('auto_reply', ev); return { kind: 'reply', label, id }; }
  logEvent('reply', { ...ev, meta: { label, source } });
  if (label === 'unsubscribe_request') {
    suppress(lead.email, 'unsubscribe', 'requested by reply');
    stopSequences(lead.id, 'unsubscribed', 'unsubscribe requested by reply');
    logEvent('unsubscribe', { ...ev, meta: { via: 'reply' } });
  } else {
    const camp = original.campaign_id && get('SELECT stop_on_reply FROM campaigns WHERE id = ?', original.campaign_id);
    if (!camp || camp.stop_on_reply) stopSequences(lead.id, 'replied', 'reply received', original.campaign_id);
  }
  return { kind: 'reply', label, source, id };
}

/** Extract DSN details from a parsed message, if it is a bounce report. */
export function parseBounce(parsed) {
  const from = parsed.from?.value?.[0]?.address?.toLowerCase() || '';
  const ctype = parsed.headers.get('content-type');
  const isReport = ctype?.params?.['report-type'] === 'delivery-status' || /mailer-daemon|postmaster/i.test(from) || /undeliver|delivery status notification|returned mail|delivery fail/i.test(parsed.subject || '');
  if (!isReport) return null;
  const dsn = parsed.attachments?.find((a) => a.contentType === 'message/delivery-status');
  const blob = `${dsn ? dsn.content.toString('utf8') : ''}\n${parsed.text || ''}`;
  return {
    recipient: blob.match(/(?:Final|Original)-Recipient:\s*(?:rfc822;)?\s*<?([^\s<>;]+@[^\s<>;]+)>?/i)?.[1],
    status: blob.match(/^Status:\s*(\d\.\d+\.\d+)/im)?.[1] ?? blob.match(/\b([45]\.\d\.\d{1,3})\b/)?.[1],
    diagnostic: blob.match(/Diagnostic-Code:\s*(?:smtp;)?\s*([^\n]+(?:\n\s+[^\n]+)*)/i)?.[1]?.replace(/\s+/g, ' ').trim(),
  };
}

export async function syncAccount(account) {
  if (account.provider === 'sandbox' || !account.imap_host) return { skipped: true };
  const client = await imapClient(account);
  const out = { fetched: 0, replies: 0, bounces: 0 };
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      // First sync looks back 14 days; afterwards only messages newer than the last seen UID.
      const query = account.imap_last_uid ? { uid: `${account.imap_last_uid + 1}:*` } : { since: new Date(Date.now() - 14 * 864e5) };
      let maxUid = account.imap_last_uid;
      for await (const m of client.fetch(query, { uid: true, source: true }, { uid: true })) {
        if (m.uid <= account.imap_last_uid) continue;
        maxUid = Math.max(maxUid, m.uid); out.fetched++;
        const parsed = await simpleParser(m.source);
        const refs = [].concat(parsed.references || []);
        const res = await processInbound(account, {
          from: parsed.from?.value?.[0]?.address, subject: parsed.subject, text: parsed.text || '', rfcId: parsed.messageId,
          inReplyTo: parsed.inReplyTo, references: refs, raw: m.source.toString('latin1').slice(0, 200000), date: (parsed.date || new Date()).toISOString(),
          auto: /auto-(replied|generated)/i.test(String(parsed.headers.get('auto-submitted') || '')) || parsed.headers.has('x-autoreply'),
          bounce: parseBounce(parsed),
        });
        if (res.kind === 'reply') out.replies++; else if (res.kind === 'bounce') out.bounces++;
      }
      run('UPDATE accounts SET imap_last_uid = ?, imap_synced_at = ? WHERE id = ?', maxUid, now(), account.id);
    } finally { lock.release(); }
  } finally { await client.logout().catch(() => {}); }
  return out;
}
export async function syncAll() {
  const results = [];
  for (const a of all("SELECT * FROM accounts WHERE provider != 'sandbox' AND imap_host IS NOT NULL AND paused = 0 AND status NOT IN ('failing')")) {
    try { results.push({ account: a.email, ...(await syncAccount(a)) }); }
    catch (err) { results.push({ account: a.email, error: String(err.message).slice(0, 200) }); }
  }
  return results;
}
