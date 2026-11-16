import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, first_name TEXT, last_name TEXT, company TEXT, title TEXT,
  website TEXT, phone TEXT, linkedin TEXT, country TEXT, timezone TEXT, source TEXT, source_date TEXT,
  tags TEXT NOT NULL DEFAULT '[]', custom TEXT NOT NULL DEFAULT '{}', flags TEXT NOT NULL DEFAULT '[]',
  verification_status TEXT NOT NULL DEFAULT 'unverified', verification_confidence REAL,
  verification_checked_at TEXT, verification_detail TEXT, import_id INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS leads_company ON leads(company);
CREATE TABLE IF NOT EXISTS custom_fields (key TEXT PRIMARY KEY, label TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY, filename TEXT, source TEXT, status TEXT NOT NULL, total INTEGER, importable INTEGER,
  rejected INTEGER, report TEXT, staged TEXT, created_at TEXT NOT NULL, committed_at TEXT
);
CREATE TABLE IF NOT EXISTS suppressions (
  id INTEGER PRIMARY KEY, value TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, reason TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS domains (
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, dkim_selectors TEXT NOT NULL DEFAULT '',
  score INTEGER, status TEXT NOT NULL DEFAULT 'unchecked', last_checked_at TEXT, last_result TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS domain_checks (id INTEGER PRIMARY KEY, domain_id INTEGER NOT NULL, checked_at TEXT NOT NULL, score INTEGER, status TEXT, result TEXT);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY, severity TEXT NOT NULL, entity_type TEXT, entity_id INTEGER, message TEXT NOT NULL,
  created_at TEXT NOT NULL, resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, from_name TEXT, provider TEXT NOT NULL,
  smtp_host TEXT, smtp_port INTEGER, smtp_secure INTEGER, imap_host TEXT, imap_port INTEGER, username TEXT,
  secret_enc TEXT, oauth_enc TEXT,
  daily_limit INTEGER NOT NULL DEFAULT 30, warmup_enabled INTEGER NOT NULL DEFAULT 0,
  warmup_start INTEGER NOT NULL DEFAULT 5, warmup_increment INTEGER NOT NULL DEFAULT 3, warmup_started_at TEXT,
  status TEXT NOT NULL DEFAULT 'unchecked', paused INTEGER NOT NULL DEFAULT 0, last_check TEXT, last_checked_at TEXT,
  next_available_at TEXT, imap_last_uid INTEGER NOT NULL DEFAULT 0, imap_synced_at TEXT, signature TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', timezone TEXT NOT NULL DEFAULT 'UTC',
  window_start TEXT NOT NULL DEFAULT '09:00', window_end TEXT NOT NULL DEFAULT '17:00', days TEXT NOT NULL DEFAULT '1,2,3,4,5',
  daily_limit INTEGER NOT NULL DEFAULT 50, min_interval INTEGER NOT NULL DEFAULT 180, max_interval INTEGER NOT NULL DEFAULT 600,
  verification_threshold TEXT NOT NULL DEFAULT 'valid', track_clicks INTEGER NOT NULL DEFAULT 1,
  stop_on_reply INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, launched_at TEXT
);
CREATE TABLE IF NOT EXISTS campaign_accounts (campaign_id INTEGER NOT NULL, account_id INTEGER NOT NULL, PRIMARY KEY (campaign_id, account_id));
CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL, position INTEGER NOT NULL, delay_days INTEGER NOT NULL DEFAULT 0,
  condition TEXT NOT NULL DEFAULT '{"type":"always"}'
);
CREATE TABLE IF NOT EXISTS variants (
  id INTEGER PRIMARY KEY, step_id INTEGER NOT NULL, label TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
  weight INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS campaign_leads (
  id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL, lead_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  current_step INTEGER NOT NULL DEFAULT 0, next_send_at TEXT, account_id INTEGER, skip_reason TEXT, added_at TEXT NOT NULL,
  UNIQUE (campaign_id, lead_id)
);
CREATE INDEX IF NOT EXISTS cl_due ON campaign_leads(status, next_send_at);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, direction TEXT NOT NULL, campaign_id INTEGER, lead_id INTEGER, campaign_lead_id INTEGER,
  step_id INTEGER, variant_id INTEGER, account_id INTEGER, rfc_id TEXT, in_reply_to TEXT,
  from_addr TEXT, to_addr TEXT, subject TEXT, body_text TEXT, status TEXT NOT NULL, error TEXT, simulated INTEGER NOT NULL DEFAULT 0,
  classification TEXT, classification_source TEXT, is_read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS msg_rfc ON messages(rfc_id);
CREATE INDEX IF NOT EXISTS msg_lead ON messages(lead_id);
CREATE TABLE IF NOT EXISTS links (token TEXT PRIMARY KEY, message_id INTEGER NOT NULL, url TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS unsub_tokens (token TEXT PRIMARY KEY, lead_id INTEGER NOT NULL, campaign_id INTEGER, message_id INTEGER);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL, campaign_id INTEGER, lead_id INTEGER, account_id INTEGER, message_id INTEGER,
  step_id INTEGER, variant_id INTEGER, domain TEXT, meta TEXT, simulated INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ev_type ON events(type, created_at);
CREATE INDEX IF NOT EXISTS ev_campaign ON events(campaign_id, type);

CREATE TABLE IF NOT EXISTS ai_drafts (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, lead_id INTEGER, variant_id INTEGER, content TEXT NOT NULL, sources TEXT,
  model TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, decided_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY, actor TEXT, action TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL);
`;

let _db;
export function openDb(file) {
  const target = file ?? path.join(config.dataDir, 'outbound.db');
  if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true });
  const d = new DatabaseSync(target);
  d.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  d.exec(SCHEMA);
  return d;
}
export function db() { return (_db ??= openDb()); }
/** Tests swap in an in-memory database. */
export function setDb(d) { _db = d; }

export const now = () => new Date().toISOString();
export const all = (sql, ...p) => db().prepare(sql).all(...p);
export const get = (sql, ...p) => db().prepare(sql).get(...p);
export const run = (sql, ...p) => db().prepare(sql).run(...p);
export function tx(fn) {
  db().exec('BEGIN IMMEDIATE');
  try { const r = fn(); db().exec('COMMIT'); return r; }
  catch (err) { db().exec('ROLLBACK'); throw err; }
}
export const j = (s, fallback = null) => { try { return s == null ? fallback : JSON.parse(s); } catch { return fallback; } };
export function audit(action, detail, actor = 'system') {
  run('INSERT INTO audit_log (actor, action, detail, created_at) VALUES (?,?,?,?)', actor, action, typeof detail === 'string' ? detail : JSON.stringify(detail ?? null), now());
}
export function logEvent(type, f = {}) {
  run(`INSERT INTO events (type, campaign_id, lead_id, account_id, message_id, step_id, variant_id, domain, meta, simulated, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    type, f.campaign_id ?? null, f.lead_id ?? null, f.account_id ?? null, f.message_id ?? null, f.step_id ?? null,
    f.variant_id ?? null, f.domain ?? null, f.meta ? JSON.stringify(f.meta) : null, f.simulated ? 1 : 0, f.at ?? now());
}
export function raiseAlert(severity, entity_type, entity_id, message) {
  const open = get('SELECT id FROM alerts WHERE entity_type IS ? AND entity_id IS ? AND message = ? AND resolved_at IS NULL', entity_type, entity_id, message);
  if (!open) run('INSERT INTO alerts (severity, entity_type, entity_id, message, created_at) VALUES (?,?,?,?,?)', severity, entity_type, entity_id, message, now());
}
