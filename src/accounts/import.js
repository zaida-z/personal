// Bulk-connect mailboxes from a CSV/XLSX export (Instantly's "CSV file" layout works as-is).
// This module only turns rows into account bodies; it never logs or returns passwords.
import { checkSyntax } from '../verify/engine.js';

export const MAX_ACCOUNT_ROWS = 200;
const norm = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ALIASES = {
  email: ['email', 'emailaddress', 'mailbox'],
  first_name: ['firstname', 'first'], last_name: ['lastname', 'last'], from_name: ['fromname', 'name', 'sendername'],
  smtp_username: ['smtpusername', 'username', 'smtpuser', 'user'], smtp_password: ['smtppassword', 'password', 'apppassword', 'smtppass'],
  imap_username: ['imapusername', 'imapuser'], imap_password: ['imappassword', 'imappass'],
  smtp_host: ['smtphost', 'smtpserver'], smtp_port: ['smtpport'], imap_host: ['imaphost', 'imapserver'], imap_port: ['imapport'],
  daily_limit: ['dailylimit', 'sendinglimit', 'dailysendlimit'],
};
const pick = (row, field) => {
  const want = new Set(ALIASES[field]);
  const key = Object.keys(row).find((k) => want.has(norm(k)));
  const v = key == null ? '' : row[key];
  return v == null ? '' : String(v).trim();
};

/** Header names (never values) that were recognised, so the UI can show what was understood. */
export function recognisedColumns(headers) {
  const all = Object.values(ALIASES).flat();
  return headers.filter((h) => all.includes(norm(h)));
}

/**
 * rows: array of objects keyed by header.
 * Returns one entry per row: { line, email, body } ready for POST /accounts logic, or { line, email, error }.
 * Provider is always "smtp" (custom host); port 465 implies implicit TLS. Instantly's warm-up columns are
 * deliberately ignored: this app's ramp is a volume ramp, not a warm-up network, so nothing is silently
 * turned on that behaves differently from what the column name suggests.
 */
export function rowsToAccounts(rows) {
  const seen = new Set();
  return rows.map((row, i) => {
    const line = i + 2; // header is line 1
    const s = checkSyntax(pick(row, 'email'));
    if (!s.ok) return { line, email: pick(row, 'email') || null, error: `Invalid email: ${s.reason}` };
    if (seen.has(s.email)) return { line, email: s.email, error: 'Duplicate row in this file' };
    seen.add(s.email);
    const password = pick(row, 'smtp_password') || pick(row, 'imap_password');
    if (!password) return { line, email: s.email, error: 'No password in the file' };
    const smtp_host = pick(row, 'smtp_host'), imap_host = pick(row, 'imap_host') || smtp_host.replace(/^smtp\./i, 'imap.');
    const smtp_port = Number(pick(row, 'smtp_port')) || 587, imap_port = Number(pick(row, 'imap_port')) || 993;
    if (!smtp_host) return { line, email: s.email, error: 'No SMTP host in the file' };
    if (!imap_host) return { line, email: s.email, error: 'No IMAP host in the file' };
    const limit = Number(pick(row, 'daily_limit'));
    const name = pick(row, 'from_name') || [pick(row, 'first_name'), pick(row, 'last_name')].filter(Boolean).join(' ');
    return { line, email: s.email, body: {
      provider: 'smtp', email: s.email, from_name: name || null, username: pick(row, 'smtp_username') || s.email, password,
      smtp_host, smtp_port, smtp_secure: smtp_port === 465, imap_host, imap_port,
      daily_limit: Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 30, warmup_enabled: false,
    } };
  });
}

export const TEMPLATE_CSV = 'Email,First Name,Last Name,SMTP Username,SMTP Password,SMTP Host,SMTP Port,IMAP Host,IMAP Port,Daily Limit\n'
  + 'sender@yourdomain.com,Sam,Sender,sender@yourdomain.com,,smtp.yourprovider.com,465,imap.yourprovider.com,993,20\n';
