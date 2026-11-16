import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { get, run, now, j, logEvent, raiseAlert } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';
import { config } from '../config.js';
import { ensureDomain, runDomainCheck } from '../domains/health.js';

export const PROVIDERS = {
  google: { label: 'Google Workspace / Gmail', smtp_host: 'smtp.gmail.com', smtp_port: 465, smtp_secure: 1, imap_host: 'imap.gmail.com', imap_port: 993, safe_daily: 50 },
  microsoft: { label: 'Microsoft 365 / Outlook', smtp_host: 'smtp.office365.com', smtp_port: 587, smtp_secure: 0, imap_host: 'outlook.office365.com', imap_port: 993, safe_daily: 50 },
  smtp: { label: 'Custom SMTP / IMAP', safe_daily: 100 },
  sandbox: { label: 'Sandbox (simulated, sends nothing)', safe_daily: 1000 },
};
export const OAUTH = {
  google: { auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', scope: 'https://mail.google.com/ email', creds: () => config.google },
  microsoft: { auth: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', scope: 'https://outlook.office.com/SMTP.Send https://outlook.office.com/IMAP.AccessAsUser.All offline_access email openid', creds: () => config.microsoft },
};
export const oauthConfigured = (p) => Boolean(OAUTH[p]?.creds().clientId && OAUTH[p]?.creds().clientSecret);
export const domainOf = (email) => String(email).split('@')[1]?.toLowerCase();

/** Exchange/refresh OAuth tokens. Returns a valid access token, persisting refreshed values. */
export async function accessToken(account) {
  const o = j(decrypt(account.oauth_enc), null);
  if (!o) return null;
  if (o.access_token && o.expires_at > Date.now() + 60_000) return o.access_token;
  const p = OAUTH[account.provider], c = p.creds();
  const res = await fetch(p.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'refresh_token', refresh_token: o.refresh_token }) });
  const body = await res.json();
  if (!res.ok || !body.access_token) throw Object.assign(new Error(`OAuth refresh failed: ${body.error_description || body.error || res.status}`), { code: 'EAUTH' });
  const next = { ...o, access_token: body.access_token, expires_at: Date.now() + (body.expires_in || 3600) * 1000, refresh_token: body.refresh_token || o.refresh_token };
  run('UPDATE accounts SET oauth_enc = ? WHERE id = ?', encrypt(JSON.stringify(next)), account.id);
  return next.access_token;
}

export async function buildTransport(account) {
  const token = await accessToken(account);
  return nodemailer.createTransport({
    host: account.smtp_host, port: account.smtp_port, secure: Boolean(account.smtp_secure), requireTLS: !account.smtp_secure,
    auth: token ? { type: 'OAuth2', user: account.username || account.email, accessToken: token } : { user: account.username || account.email, pass: decrypt(account.secret_enc) },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
  });
}
export async function imapClient(account) {
  const token = await accessToken(account);
  return new ImapFlow({
    host: account.imap_host, port: account.imap_port || 993, secure: true, logger: false, socketTimeout: 30000,
    auth: token ? { user: account.username || account.email, accessToken: token } : { user: account.username || account.email, pass: decrypt(account.secret_enc) },
  });
}

const c = (key, label, status, critical, detail, fix = null) => ({ key, label, status, critical, detail, fix });
const authErr = (err) => err?.code === 'EAUTH' || err?.authenticationFailed || /auth|credential|535|invalid login/i.test(err?.message || '');

/** Default network testers; tests inject fakes. */
export const testers = {
  async smtp(account) { const t = await buildTransport(account); try { await t.verify(); } finally { t.close(); } },
  async imap(account) { const cl = await imapClient(account); await cl.connect(); try { const lock = await cl.getMailboxLock('INBOX'); lock.release(); } finally { await cl.logout().catch(() => {}); } },
};

/** Warm-up ramp: start + increment per day since warm-up began, capped by the configured limit. */
export function effectiveDailyLimit(account, at = Date.now()) {
  if (!account.warmup_enabled || !account.warmup_started_at) return account.daily_limit;
  const days = Math.max(0, Math.floor((at - Date.parse(account.warmup_started_at)) / 864e5));
  return Math.min(account.daily_limit, account.warmup_start + account.warmup_increment * days);
}
export function sentToday(accountId, at = new Date()) {
  const start = new Date(at); start.setUTCHours(0, 0, 0, 0);
  return get("SELECT COUNT(*) n FROM messages WHERE account_id = ? AND direction = 'out' AND status = 'sent' AND created_at >= ?", accountId, start.toISOString()).n;
}

/**
 * Run every connection + authentication check. An account is "healthy" only when
 * every critical check passed; anything unverified keeps it out of "healthy".
 */
export async function checkAccount(id, { refreshDomain = true } = {}) {
  const a = get('SELECT * FROM accounts WHERE id = ?', id);
  if (!a) throw new Error('Account not found');
  const checks = [];
  if (a.provider === 'sandbox') {
    checks.push(c('sandbox', 'Sandbox account', 'pass', false, 'Simulated account: nothing is sent and no network checks apply. All activity is flagged as simulated.'));
    return persist(a, checks, 'sandbox');
  }
  const hasAuth = Boolean(a.secret_enc || a.oauth_enc);
  if (!hasAuth) checks.push(c('credentials', a.oauth_enc ? 'OAuth' : 'Credentials', 'fail', true, 'No credentials stored.', 'Reconnect the account.'));
  for (const kind of ['smtp', 'imap']) {
    const label = kind.toUpperCase() + ' connection';
    if (!hasAuth) { checks.push(c(kind, label, 'unknown', kind === 'smtp', 'Skipped: no credentials.')); continue; }
    if (kind === 'imap' && !a.imap_host) { checks.push(c('imap', label, 'warn', false, 'No IMAP host configured: replies and bounces cannot be synchronised for this account.', 'Add IMAP settings to enable the unified inbox and bounce detection.')); continue; }
    try { await testers[kind](a); checks.push(c(kind, label, 'pass', kind === 'smtp', `Authenticated to ${a[kind + '_host']}${a.oauth_enc ? ' with OAuth2' : ''}.`)); }
    catch (err) {
      const isAuth = authErr(err);
      if (isAuth) logEvent('auth_failure', { account_id: a.id, domain: domainOf(a.email), meta: { kind, error: String(err.message).slice(0, 200) } });
      checks.push(c(kind, label, 'fail', true, `${isAuth ? 'Authentication rejected' : 'Connection failed'}: ${String(err.message).slice(0, 200)}`,
        isAuth ? (a.provider === 'google' ? 'Use a Google app password (2-Step Verification required) or reconnect with OAuth; make sure IMAP is enabled.' : a.provider === 'microsoft' ? 'Enable "Authenticated SMTP" for the mailbox in the Microsoft 365 admin centre, or reconnect with OAuth.' : 'Check the username and password.') : 'Check host, port and firewall rules.'));
    }
  }
  const domain = domainOf(a.email);
  const userDomain = domainOf(a.username || a.email);
  checks.push(userDomain && userDomain !== domain
    ? c('alignment', 'Domain alignment', 'warn', false, `Login identity is @${userDomain} but mail is sent From @${domain}. SPF/DKIM must align with @${domain} or DMARC will fail.`, 'Send from the same domain you authenticate with, or confirm the provider signs DKIM for the From domain.')
    : c('alignment', 'Domain alignment', 'pass', false, `From address and login identity share @${domain}.`));
  let d = ensureDomain(domain);
  let res = j(d.last_result);
  if (refreshDomain || !res) { try { res = await runDomainCheck(d.id); } catch (err) { res = null; } }
  for (const key of ['spf', 'dkim', 'dmarc']) {
    const dc = res?.checks?.find((x) => x.key === key);
    checks.push(dc ? c(key, dc.label, dc.status, true, dc.detail, dc.fix) : c(key, key.toUpperCase(), 'unknown', true, 'Domain check has not completed.'));
  }
  const limit = effectiveDailyLimit(a);
  const safe = PROVIDERS[a.provider]?.safe_daily ?? 50;
  checks.push(a.daily_limit > safe
    ? c('limits', 'Sending limits', 'warn', false, `Daily limit ${a.daily_limit} is above the ~${safe}/day commonly considered safe for cold email on ${PROVIDERS[a.provider].label}.`, `Lower the limit to ${safe} or less and add more inboxes instead.`)
    : c('limits', 'Sending limits', 'pass', false, `Daily limit ${a.daily_limit}${a.warmup_enabled ? ` (ramp-up active: ${limit} today)` : ''}.`));
  const fails = checks.filter((x) => x.critical && x.status === 'fail');
  const unknown = checks.filter((x) => x.critical && x.status === 'unknown');
  const status = fails.length ? 'failing' : unknown.length ? 'unverified' : checks.some((x) => x.status === 'warn') ? 'warning' : 'healthy';
  return persist(a, checks, status);
}
function persist(a, checks, status) {
  const t = now();
  run('UPDATE accounts SET status = ?, last_check = ?, last_checked_at = ? WHERE id = ?', status, JSON.stringify(checks), t, a.id);
  if (status === 'failing') raiseAlert('critical', 'account', a.id, `${a.email} is failing: ${checks.filter((x) => x.critical && x.status === 'fail').map((x) => x.label).join(', ')}`);
  else run("UPDATE alerts SET resolved_at = ? WHERE entity_type = 'account' AND entity_id = ? AND resolved_at IS NULL", t, a.id);
  return { id: a.id, status, checks, checked_at: t };
}
/** Accounts allowed to send: fully healthy, healthy-with-warnings, or sandbox. Never failing/unverified/paused. */
export const canSend = (a) => !a.paused && ['healthy', 'warning', 'sandbox'].includes(a.status);

export function publicAccount(a) {
  const { secret_enc, oauth_enc, last_check, ...rest } = a;
  return { ...rest, auth: oauth_enc ? 'oauth' : secret_enc ? 'password' : 'none', checks: j(last_check, []), effective_limit: effectiveDailyLimit(a), sent_today: sentToday(a.id) };
}
