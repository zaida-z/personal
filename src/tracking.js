// Public endpoints hit by recipients: click redirects and unsubscribe. No auth, no cookies.
import express from 'express';
import { get, run, logEvent } from './db.js';
import { suppress, stopSequences } from './inbox/sync.js';

export const tracking = express.Router();
const BOT_UA = /bot|crawl|spider|scan|proofpoint|mimecast|barracuda|symantec|urldefense|safelinks|preview|headless|python|curl|wget|go-http|java\/|okhttp|slack|whatsapp|facebookexternalhit/i;

/** Click redirect. Security scanners follow every link, so each click is tagged measured-human vs suspected-bot. */
tracking.all('/c/:token', (req, res) => {
  const link = get('SELECT l.url, m.* FROM links l JOIN messages m ON m.id = l.message_id WHERE l.token = ?', req.params.token);
  if (!link) return res.status(404).type('text').send('Link not found');
  const ua = String(req.headers['user-agent'] || '');
  const ageSec = (Date.now() - Date.parse(link.created_at)) / 1000;
  const reasons = [req.method !== 'GET' && 'non-GET request', (!ua || BOT_UA.test(ua)) && 'automated user agent', ageSec < 30 && 'clicked within 30s of sending'].filter(Boolean);
  logEvent('click', { campaign_id: link.campaign_id, lead_id: link.lead_id, account_id: link.account_id, message_id: link.id, step_id: link.step_id, variant_id: link.variant_id,
    simulated: link.simulated, meta: { url: link.url, bot: reasons.length ? 1 : 0, bot_reasons: reasons } });
  res.redirect(302, link.url);
});

const page = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:440px;margin:15vh auto;padding:0 20px;color:#222"><h1 style="font-size:22px">${title}</h1>${body}</body>`;
function unsubscribe(token) {
  const t = get('SELECT u.*, l.email FROM unsub_tokens u JOIN leads l ON l.id = u.lead_id WHERE u.token = ?', token);
  if (!t) return null;
  if (!get("SELECT 1 x FROM suppressions WHERE value = ? AND reason = 'unsubscribe'", t.email)) {
    const m = t.message_id ? get('SELECT account_id, simulated, step_id, variant_id FROM messages WHERE id = ?', t.message_id) : null;
    run('DELETE FROM suppressions WHERE value = ?', t.email);
    suppress(t.email, 'unsubscribe', 'unsubscribe link');
    stopSequences(t.lead_id, 'unsubscribed', 'unsubscribe link');
    logEvent('unsubscribe', { campaign_id: t.campaign_id, lead_id: t.lead_id, account_id: m?.account_id, message_id: t.message_id, step_id: m?.step_id, variant_id: m?.variant_id, simulated: m?.simulated, meta: { via: 'link' } });
  }
  return t;
}
// GET shows a confirm button (link scanners issue GETs and must not unsubscribe people by accident).
tracking.get('/u/:token', (req, res) => {
  const ok = get('SELECT 1 x FROM unsub_tokens WHERE token = ?', req.params.token);
  if (!ok) return res.status(404).send(page('Link not found', '<p>This unsubscribe link is not valid.</p>'));
  res.send(page('Unsubscribe', `<p>Confirm you no longer want to receive emails from this sender.</p><form method="post"><button style="font:inherit;padding:10px 18px;border-radius:6px;border:0;background:#222;color:#fff;cursor:pointer">Unsubscribe me</button></form>`));
});
// POST = confirmation click, and RFC 8058 one-click from mailbox providers.
tracking.post('/u/:token', (req, res) => {
  const t = unsubscribe(req.params.token);
  if (!t) return res.status(404).send(page('Link not found', '<p>This unsubscribe link is not valid.</p>'));
  res.send(page('You are unsubscribed', '<p>You will not receive further emails from this sender.</p>'));
});
