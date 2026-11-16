// Two-phase import: stage() parses + validates and stores a report; nothing touches
// the leads table until commit() is called on a reviewed import.
import { parse } from 'csv-parse/sync';
import readXlsx from 'read-excel-file/node';
import { all, get, run, tx, now, j } from '../db.js';
import { checkSyntax, isRole, isDisposable, lookupMail } from '../verify/engine.js';
import { DOMAIN_TYPOS } from '../verify/lists.js';

export const CORE_FIELDS = ['email', 'first_name', 'last_name', 'company', 'title', 'website', 'phone', 'linkedin', 'country', 'timezone', 'source_date'];
const ALIASES = {
  email: ['email', 'e-mail', 'email address', 'work email', 'mail'],
  first_name: ['first name', 'firstname', 'first', 'given name'],
  last_name: ['last name', 'lastname', 'last', 'surname', 'family name'],
  company: ['company', 'company name', 'organization', 'organisation', 'account', 'employer'],
  title: ['title', 'job title', 'position', 'role'],
  website: ['website', 'url', 'company website', 'domain', 'company domain'],
  phone: ['phone', 'phone number', 'mobile', 'telephone'],
  linkedin: ['linkedin', 'linkedin url', 'person linkedin url', 'linkedin profile'],
  country: ['country'], timezone: ['timezone', 'time zone', 'tz'],
  source_date: ['source date', 'last updated', 'updated at', 'last verified', 'date collected'],
};
const slug = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export async function parseFile(buffer, filename = '') {
  if (/\.xlsx$/i.test(filename)) {
    const sheets = await readXlsx(buffer);
    const rows = (Array.isArray(sheets?.[0]?.data) ? sheets[0].data : sheets).map((r) => r.map((c) => (c == null ? '' : c instanceof Date ? c.toISOString().slice(0, 10) : String(c))));
    if (!rows.length) return [];
    const [head, ...rest] = rows;
    return rest.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
  }
  if (/\.xls$/i.test(filename)) throw new Error('Legacy .xls is not supported; save the sheet as .xlsx or .csv');
  return parse(buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true });
}

/** Guess header -> field mapping; unknown headers become custom fields. */
export function guessMapping(headers) {
  const map = {};
  for (const h of headers) {
    const key = String(h).trim().toLowerCase();
    const core = Object.keys(ALIASES).find((f) => ALIASES[f].includes(key) || slug(key) === f);
    map[h] = core ?? (slug(h) ? `custom:${slug(h)}` : null);
  }
  return map;
}

const STALE_DAYS = 365;
/** Validate one mapped record. Returns { errors: [...blocking], flags: [...non-blocking] }. */
export function validateRecord(rec, required = ['email']) {
  const errors = [], flags = [];
  for (const f of required) if (!String(rec[f] ?? '').trim()) errors.push(`missing required field: ${f}`);
  const syn = checkSyntax(rec.email);
  if (rec.email && !syn.ok) errors.push(`invalid email syntax: ${syn.reason}`);
  if (syn.ok) {
    rec.email = syn.email;
    if (isDisposable(syn.domain)) flags.push('disposable');
    if (isRole(syn.local)) flags.push('role_based');
    if (DOMAIN_TYPOS[syn.domain]) flags.push(`domain_typo:${DOMAIN_TYPOS[syn.domain]}`);
  }
  const c = String(rec.company ?? '').trim();
  if (c) {
    if (c.length < 2 || c.length > 120 || /^[^A-Za-z0-9\p{L}]+$/u.test(c) || /^(n\/?a|none|null|unknown|test|-+|\?+|x+)$/i.test(c) || /@|https?:\/\//i.test(c)) flags.push('malformed_company');
  }
  if (rec.website) {
    const w = String(rec.website).trim();
    try { const u = new URL(/^https?:\/\//i.test(w) ? w : `https://${w}`); if (!u.hostname.includes('.')) throw 0; rec.website = u.origin + (u.pathname === '/' ? '' : u.pathname); }
    catch { flags.push('malformed_website'); }
  }
  if (rec.source_date) {
    const t = Date.parse(rec.source_date);
    if (Number.isNaN(t)) flags.push('unparseable_source_date');
    else { rec.source_date = new Date(t).toISOString().slice(0, 10); if ((Date.now() - t) / 864e5 > STALE_DAYS) flags.push('possibly_outdated'); }
  }
  return { errors, flags };
}

/**
 * Stage an import. rows: array of objects keyed by header. mapping: header -> field | custom:key | null.
 * Performs syntax/role/disposable checks and a DNS check per unique domain.
 */
export async function stageImport({ rows, mapping, filename, source, tags = [], required = ['email'], checkDomains = true }) {
  const records = [];
  const seen = new Map();
  const counts = { total: rows.length, importable: 0, rejected: 0, invalid_or_incomplete: 0, duplicate_in_file: 0, duplicate_existing: 0, suppressed: 0, invalid_domain: 0, flagged: 0, domain_unchecked: 0 };
  const domainState = new Map();
  if (checkDomains) {
    const domains = new Set();
    for (const row of rows) { const h = Object.keys(mapping).find((k) => mapping[k] === 'email'); const s = checkSyntax(row[h]); if (s.ok) domains.add(s.domain); }
    const list = [...domains];
    for (let i = 0; i < list.length; i += 20) {
      await Promise.all(list.slice(i, i + 20).map(async (d) => domainState.set(d, (await lookupMail(d)).state)));
    }
  }
  rows.forEach((row, idx) => {
    const rec = { custom: {} };
    for (const [header, field] of Object.entries(mapping)) {
      const val = String(row[header] ?? '').trim();
      if (!field || !val) continue;
      if (field.startsWith('custom:')) rec.custom[field.slice(7)] = val; else rec[field] = val;
    }
    const { errors, flags } = validateRecord(rec, required);
    const email = rec.email;
    // Each rejected row is counted under exactly one reason (the first that applies), so the report adds up.
    if (errors.length) counts.invalid_or_incomplete++;
    else {
      const dom = email.split('@')[1];
      const st = domainState.get(dom);
      if (seen.has(email)) { errors.push(`duplicate of row ${seen.get(email)} in this file`); counts.duplicate_in_file++; }
      else {
        seen.set(email, idx + 2);
        if (get('SELECT 1 x FROM leads WHERE email = ?', email)) { errors.push('duplicate: lead already exists'); counts.duplicate_existing++; }
        else if (get('SELECT 1 x FROM suppressions WHERE value IN (?, ?)', email, dom)) { errors.push('suppressed: address or domain is on the suppression list'); counts.suppressed++; }
        else if (st === 'none' || st === 'null_mx') { errors.push('invalid domain: no mail server (MX/A) found'); counts.invalid_domain++; }
        else if (st === 'error' || st === undefined) { flags.push('domain_unchecked'); counts.domain_unchecked++; }
      }
    }
    if (errors.length) counts.rejected++; else { counts.importable++; if (flags.length) counts.flagged++; }
    records.push({ row: idx + 2, record: rec, errors, flags });
  });
  const report = { counts, mapping, required, tags, domain_check: checkDomains ? 'performed' : 'skipped' };
  const r = run('INSERT INTO imports (filename, source, status, total, importable, rejected, report, staged, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    filename ?? null, source ?? 'import', 'staged', counts.total, counts.importable, counts.rejected, JSON.stringify(report), JSON.stringify(records), now());
  return { id: Number(r.lastInsertRowid), report, records };
}

export function insertLead(rec, { source, tags = [], flags = [], import_id = null } = {}) {
  const t = now();
  for (const key of Object.keys(rec.custom ?? {})) run('INSERT OR IGNORE INTO custom_fields (key, label, created_at) VALUES (?,?,?)', key, key.replace(/_/g, ' '), t);
  const r = run(`INSERT INTO leads (email, first_name, last_name, company, title, website, phone, linkedin, country, timezone, source, source_date, tags, custom, flags, import_id, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    rec.email, rec.first_name ?? null, rec.last_name ?? null, rec.company ?? null, rec.title ?? null, rec.website ?? null, rec.phone ?? null,
    rec.linkedin ?? null, rec.country ?? null, rec.timezone ?? null, source ?? 'manual', rec.source_date ?? null,
    JSON.stringify(tags), JSON.stringify(rec.custom ?? {}), JSON.stringify(flags), import_id, t, t);
  return Number(r.lastInsertRowid);
}

/** Commit a staged import: only rows without blocking errors are inserted. Re-checks duplicates at commit time. */
export function commitImport(id) {
  const imp = get('SELECT * FROM imports WHERE id = ?', id);
  if (!imp) throw new Error('Import not found');
  if (imp.status !== 'staged') throw new Error(`Import is already ${imp.status}`);
  const report = j(imp.report, {});
  let inserted = 0, skipped = 0;
  tx(() => {
    for (const item of j(imp.staged, [])) {
      if (item.errors.length) continue;
      if (get('SELECT 1 x FROM leads WHERE email = ?', item.record.email)) { skipped++; continue; }
      insertLead(item.record, { source: imp.source, tags: report.tags ?? [], flags: item.flags, import_id: id });
      inserted++;
    }
    report.committed = { inserted, skipped_duplicates_at_commit: skipped };
    run("UPDATE imports SET status = 'committed', committed_at = ?, report = ? WHERE id = ?", now(), JSON.stringify(report), id);
  });
  return { inserted, skipped };
}
export function discardImport(id) {
  run("UPDATE imports SET status = 'discarded', staged = NULL WHERE id = ? AND status = 'staged'", id);
}
export const listImports = () => all('SELECT id, filename, source, status, total, importable, rejected, report, created_at, committed_at FROM imports ORDER BY id DESC LIMIT 100').map((i) => ({ ...i, report: j(i.report) }));
