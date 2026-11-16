// Email verification engine.
//
// Honesty rule: a status of "valid" is only ever produced when a mailbox-level check
// (SMTP RCPT) actually completed against a server that gives meaningful answers.
// When only syntax + DNS could be checked the result is "unknown" with the completed
// checks listed, never "valid".
import net from 'node:net';
import { domainToASCII } from 'node:url';
import crypto from 'node:crypto';
import { resolve, DnsError } from '../lib/dns.js';
import { config } from '../config.js';
import { DISPOSABLE_DOMAINS, ROLE_LOCAL_PARTS, ACCEPT_ALL_PROVIDERS, DOMAIN_TYPOS } from './lists.js';
import { get, run, now, j } from '../db.js';

export const STATUSES = ['valid', 'invalid', 'risky', 'unknown', 'catch_all', 'disposable', 'role_based'];

const LOCAL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeEmail(raw) { return String(raw ?? '').trim().toLowerCase(); }

/** Pure syntax check (RFC 5321 limits, dot-atom local part, LDH domain with a TLD). */
export function checkSyntax(raw) {
  const email = normalizeEmail(raw);
  if (!email) return { ok: false, reason: 'empty' };
  if (email.length > 254) return { ok: false, reason: 'longer than 254 characters' };
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1 || email.indexOf('@') !== at) return { ok: false, reason: 'must contain exactly one @' };
  const local = email.slice(0, at);
  const domain = domainToASCII(email.slice(at + 1));
  if (local.length > 64) return { ok: false, reason: 'local part longer than 64 characters' };
  if (!LOCAL_RE.test(local)) return { ok: false, reason: 'invalid characters or dots in local part' };
  if (!domain) return { ok: false, reason: 'invalid domain' };
  const labels = domain.split('.');
  if (labels.length < 2) return { ok: false, reason: 'domain has no TLD' };
  if (!labels.every((l) => LABEL_RE.test(l))) return { ok: false, reason: 'invalid domain label' };
  if (/^\d+$/.test(labels.at(-1))) return { ok: false, reason: 'numeric TLD' };
  return { ok: true, email: `${local}@${domain}`, local, domain };
}
export const isRole = (local) => ROLE_LOCAL_PARTS.has(local.split('+')[0]);
export function isDisposable(domain) {
  const extra = j(get("SELECT value FROM settings WHERE key = 'extra_disposable'")?.value, []);
  const parts = domain.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const d = parts.slice(i).join('.');
    if (DISPOSABLE_DOMAINS.has(d) || extra.includes(d)) return true;
  }
  return false;
}

/** MX lookup with RFC 5321 implicit-MX fallback and RFC 7505 null-MX handling. */
export async function lookupMail(domain) {
  try {
    const mx = await resolve(domain, 'MX');
    if (mx.length === 1 && (mx[0].exchange === '' || mx[0].exchange === '.')) return { state: 'null_mx', hosts: [] };
    if (mx.length) return { state: 'mx', hosts: mx.map((m) => m.exchange) };
    const a = await resolve(domain, 'A');
    if (a.length) return { state: 'implicit_mx', hosts: [domain] };
    return { state: 'none', hosts: [] };
  } catch (err) {
    if (err instanceof DnsError) return { state: 'error', hosts: [], error: err.message };
    throw err;
  }
}

/** One SMTP conversation: RCPT TO the target and a random sibling (catch-all test). Never sends DATA. */
export function smtpProbe(host, email, domain, { timeout = 12000, connect = net.connect } = {}) {
  return new Promise((done) => {
    const random = `${crypto.randomBytes(9).toString('hex')}-nonexistent@${domain}`;
    const helo = config.smtpProbeHelo || 'verify.localhost';
    const from = config.smtpProbeFrom || '';
    const script = [`EHLO ${helo}`, `MAIL FROM:<${from}>`, `RCPT TO:<${email}>`, `RCPT TO:<${random}>`, 'QUIT'];
    const replies = [];
    let step = -1, buf = '', finished = false;
    const sock = connect({ host, port: 25 });
    const finish = (extra = {}) => {
      if (finished) return; finished = true; sock.destroy();
      done({ host, completed: replies.length >= 4, banner: replies[0], target: replies[3], random: replies[4], ...extra });
    };
    sock.setTimeout(timeout, () => finish({ error: 'timeout' }));
    sock.on('error', (err) => finish({ error: err.code || err.message }));
    sock.on('close', () => finish());
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      let m;
      while ((m = buf.match(/^(?:\d{3}-[^\n]*\n)*(\d{3}) ([^\n]*)\n/))) {
        buf = buf.slice(m[0].length);
        const code = Number(m[1]);
        replies.push({ code, text: m[2].trim().slice(0, 200) });
        step++;
        // Abort on a rejected greeting/EHLO/MAIL, or once both RCPTs are answered.
        if ((step <= 2 && code >= 400) || step >= script.length - 1) return finish();
        if (step === 3 && code >= 400 && code < 500) { sock.write('QUIT\r\n'); return finish(); }
        sock.write(script[step] + '\r\n');
      }
    });
  });
}

/**
 * Verify one address. Returns { email, status, confidence, checks, reasons, checked_at }.
 * `checks` records exactly which stages ran and what they returned.
 */
export async function verifyEmail(raw, opts = {}) {
  const probe = opts.probe ?? (config.smtpProbe ? smtpProbe : null);
  const checked_at = now();
  const checks = { syntax: 'not_run', dns: 'not_run', mx: 'not_run', disposable: 'not_run', role: 'not_run', smtp: 'not_run', catch_all: 'not_run' };
  const out = (status, confidence, reasons) => ({ email: syn.email ?? normalizeEmail(raw), status, confidence, checks, reasons, checked_at });

  const syn = checkSyntax(raw);
  if (!syn.ok) { checks.syntax = 'fail'; return out('invalid', 0.99, [`Syntax: ${syn.reason}`]); }
  checks.syntax = 'pass';
  const reasons = [];
  if (DOMAIN_TYPOS[syn.domain]) reasons.push(`Domain looks like a typo of ${DOMAIN_TYPOS[syn.domain]}`);

  const disposable = isDisposable(syn.domain);
  checks.disposable = disposable ? 'fail' : 'pass';
  const role = isRole(syn.local);
  checks.role = role ? 'flagged' : 'pass';

  const mail = await lookupMail(syn.domain);
  if (mail.state === 'error') {
    checks.dns = 'error';
    return out(disposable ? 'disposable' : 'unknown', disposable ? 0.9 : 0.2, [...reasons, `DNS lookup failed (${mail.error}); domain could not be checked`]);
  }
  checks.dns = 'pass';
  if (mail.state === 'none') { checks.dns = 'fail'; checks.mx = 'fail'; return out('invalid', 0.95, [...reasons, 'Domain has no MX or A record and cannot receive mail']); }
  if (mail.state === 'null_mx') { checks.mx = 'fail'; return out('invalid', 0.98, [...reasons, 'Domain publishes a null MX (accepts no mail)']); }
  checks.mx = mail.state === 'mx' ? 'pass' : 'implicit';
  if (mail.state === 'implicit_mx') reasons.push('No MX record; relying on the A record (unusual for a real mailbox domain)');
  if (disposable) return out('disposable', 0.95, [...reasons, 'Disposable / temporary mailbox provider']);
  if (DOMAIN_TYPOS[syn.domain]) return out('risky', 0.6, reasons);

  if (!probe) {
    checks.smtp = 'skipped'; checks.catch_all = 'skipped';
    reasons.push('Mailbox not confirmed: SMTP probing is disabled or unavailable, so only syntax and DNS were checked');
    if (role) return out('role_based', 0.9, [...reasons, 'Role-based address (shared inbox)']);
    return out('unknown', 0.5, reasons);
  }

  const acceptAll = ACCEPT_ALL_PROVIDERS.some((re) => mail.hosts.some((h) => re.test(h)));
  let res;
  for (const host of mail.hosts.slice(0, 2)) { res = await probe(host, syn.email, syn.domain); if (res.completed || res.target) break; }
  const t = res?.target, r = res?.random;
  if (!t) {
    checks.smtp = 'incomplete'; checks.catch_all = 'not_run';
    reasons.push(`SMTP conversation did not complete (${res?.error || `server replied ${res?.banner?.code ?? 'nothing'}`})`);
    if (role) return out('role_based', 0.9, [...reasons, 'Role-based address (shared inbox)']);
    return out('unknown', 0.5, reasons);
  }
  if (t.code >= 500) {
    const mailboxFull = /full|quota|over.?limit/i.test(t.text) || t.code === 552;
    const policy = /spam|block|denied|policy|blacklist|reputation|access/i.test(t.text) && !/user|mailbox|recipient|address/i.test(t.text);
    if (mailboxFull) { checks.smtp = 'mailbox_full'; return out('risky', 0.7, [...reasons, `Mailbox exists but is full (${t.code} ${t.text})`]); }
    if (policy) { checks.smtp = 'blocked'; return out('unknown', 0.4, [...reasons, `Server refused our probe for policy reasons (${t.code} ${t.text})`]); }
    checks.smtp = 'rejected';
    return out('invalid', 0.95, [...reasons, `Mail server rejected the recipient (${t.code} ${t.text})`]);
  }
  if (t.code >= 400) { checks.smtp = 'deferred'; return out('unknown', 0.4, [...reasons, `Server deferred the check (${t.code} ${t.text}); greylisting or rate limiting`]); }
  checks.smtp = 'accepted';
  if (!r) { checks.catch_all = 'incomplete'; return out('unknown', 0.6, [...reasons, 'Recipient accepted, but the catch-all test did not complete']); }
  if (r.code < 300) { checks.catch_all = 'detected'; return out('catch_all', 0.9, [...reasons, 'Domain accepts mail for any address; this mailbox cannot be confirmed']); }
  checks.catch_all = 'not_detected';
  if (acceptAll) return out('risky', 0.6, [...reasons, 'Provider is known to accept recipients at SMTP time and bounce later']);
  if (role) return out('role_based', 0.95, [...reasons, 'Mailbox exists; role-based address (shared inbox)']);
  return out('valid', 0.95, [...reasons, 'Mail server accepted this recipient and rejected a random one']);
}

/** Verify a stored lead and persist the result with its timestamp. */
export async function verifyLead(lead, opts) {
  const res = await verifyEmail(lead.email, opts);
  run('UPDATE leads SET verification_status=?, verification_confidence=?, verification_checked_at=?, verification_detail=?, updated_at=? WHERE id=?',
    res.status, res.confidence, res.checked_at, JSON.stringify({ checks: res.checks, reasons: res.reasons }), now(), lead.id);
  return res;
}

/** Statuses a campaign may send to for each configured threshold. */
export const THRESHOLDS = {
  valid: ['valid'],
  valid_catchall: ['valid', 'catch_all'],
  valid_catchall_role: ['valid', 'catch_all', 'role_based'],
  dns_verified: ['valid', 'catch_all', 'role_based', 'unknown'],
};
export const VERIFICATION_MAX_AGE_DAYS = 90;
export function meetsThreshold(lead, threshold) {
  const allowed = THRESHOLDS[threshold] ?? THRESHOLDS.valid;
  if (!lead.verification_checked_at) return { ok: false, reason: 'never verified' };
  if (!allowed.includes(lead.verification_status)) return { ok: false, reason: `status is ${lead.verification_status}` };
  if (lead.verification_status === 'unknown') {
    const d = j(lead.verification_detail, {});
    if (d?.checks?.mx !== 'pass' && d?.checks?.mx !== 'implicit') return { ok: false, reason: 'DNS check did not pass' };
  }
  const age = (Date.now() - Date.parse(lead.verification_checked_at)) / 864e5;
  if (age > VERIFICATION_MAX_AGE_DAYS) return { ok: false, reason: `verification is ${Math.floor(age)} days old` };
  return { ok: true };
}
