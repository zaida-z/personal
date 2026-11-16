import express from 'express';
import { all, get, run, tx, now, j, audit } from './db.js';
import { bad, int, str, startJob, getJob } from './http.js';
import { encrypt, token } from './crypto.js';
import { config } from './config.js';
import { verifyEmail, verifyLead, checkSyntax, STATUSES, THRESHOLDS } from './verify/engine.js';
import { parseFile, guessMapping, stageImport, commitImport, discardImport, listImports, insertLead, validateRecord, CORE_FIELDS } from './leads/import.js';
import { ensureDomain, runDomainCheck, domainHistory } from './domains/health.js';
import { PROVIDERS, OAUTH, oauthConfigured, checkAccount, publicAccount, domainOf } from './accounts/service.js';
import { toCsv } from './analytics/metrics.js';
import { rowsToAccounts, recognisedColumns, MAX_ACCOUNT_ROWS, TEMPLATE_CSV } from './accounts/import.js';
import { suppress, stopSequences } from './inbox/sync.js';
import { aiEnabled } from './ai/assistant.js';

export const core = express.Router();
const leadOut = (l) => ({ ...l, tags: j(l.tags, []), custom: j(l.custom, {}), flags: j(l.flags, []), verification_detail: j(l.verification_detail) });

// ---------- system ----------
core.get('/system', (req, res) => res.json({
  ai: { enabled: aiEnabled(), model: config.aiModel }, smtp_probe: config.smtpProbe, public_url: config.publicUrl,
  public_url_reachable: !/localhost|127\.0\.0\.1/.test(config.publicUrl), postal_address: Boolean(config.postalAddress), dns_mode: config.dnsMode,
  oauth: { google: oauthConfigured('google'), microsoft: oauthConfigured('microsoft') }, scheduler: config.scheduler,
  providers: PROVIDERS, verification_statuses: STATUSES, thresholds: THRESHOLDS, core_fields: CORE_FIELDS,
  custom_fields: all('SELECT key, label FROM custom_fields ORDER BY key'),
}));
core.get('/jobs/:id', (req, res) => { const job = getJob(req.params.id); if (!job) throw bad(404, 'Job not found'); res.json(job); });
core.get('/alerts', (req, res) => res.json(all('SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY id DESC LIMIT 100')));
core.post('/alerts/:id/resolve', (req, res) => { run('UPDATE alerts SET resolved_at = ? WHERE id = ?', now(), int(req.params.id)); res.json({ ok: true }); });

// ---------- leads ----------
function leadFilter(q) {
  const cond = ['1=1'], args = [];
  if (q.q) { cond.push('(l.email LIKE ? OR l.first_name LIKE ? OR l.last_name LIKE ? OR l.company LIKE ? OR l.title LIKE ?)'); args.push(...Array(5).fill(`%${String(q.q).replace(/[%_]/g, '')}%`)); }
  if (q.status) { cond.push('l.verification_status = ?'); args.push(q.status); }
  if (q.source) { cond.push('l.source = ?'); args.push(q.source); }
  if (q.tag) { cond.push('EXISTS (SELECT 1 FROM json_each(l.tags) WHERE value = ?)'); args.push(q.tag); }
  if (q.flag) { cond.push('EXISTS (SELECT 1 FROM json_each(l.flags) WHERE value LIKE ?)'); args.push(`${q.flag}%`); }
  if (q.campaign_id) { cond.push('l.id IN (SELECT lead_id FROM campaign_leads WHERE campaign_id = ?)'); args.push(Number(q.campaign_id)); }
  if (q.not_in_campaign) { cond.push('l.id NOT IN (SELECT lead_id FROM campaign_leads WHERE campaign_id = ?)'); args.push(Number(q.not_in_campaign)); }
  if (q.custom_key) { cond.push("json_extract(l.custom, '$.' || ?) LIKE ?"); args.push(String(q.custom_key).replace(/[^\w]/g, ''), `%${q.custom_value ?? ''}%`); }
  if (q.suppressed === '1') cond.push('l.email IN (SELECT value FROM suppressions)');
  return { sql: cond.join(' AND '), args };
}
core.get('/leads', (req, res) => {
  const f = leadFilter(req.query);
  const size = Math.min(200, Number(req.query.size) || 50), page = Math.max(1, Number(req.query.page) || 1);
  const sort = { email: 'l.email', company: 'l.company', created: 'l.id', verified: 'l.verification_checked_at' }[req.query.sort] ?? 'l.id';
  const total = get(`SELECT COUNT(*) n FROM leads l WHERE ${f.sql}`, ...f.args).n;
  const rows = all(`SELECT l.*, (SELECT reason FROM suppressions s WHERE s.value = l.email) suppressed FROM leads l WHERE ${f.sql} ORDER BY ${sort} ${req.query.dir === 'asc' ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`, ...f.args, size, (page - 1) * size);
  res.json({ total, page, size, leads: rows.map(leadOut) });
});
core.get('/leads/facets', (req, res) => res.json({
  statuses: all('SELECT verification_status value, COUNT(*) n FROM leads GROUP BY 1'),
  sources: all('SELECT source value, COUNT(*) n FROM leads GROUP BY 1'),
  tags: all('SELECT value, COUNT(*) n FROM leads, json_each(leads.tags) GROUP BY value ORDER BY n DESC LIMIT 100'),
  total: get('SELECT COUNT(*) n FROM leads').n,
}));
core.get('/leads/export.csv', (req, res) => {
  const f = leadFilter(req.query);
  const rows = all(`SELECT l.* FROM leads l WHERE ${f.sql} ORDER BY l.id`, ...f.args).map((l) => ({ email: l.email, first_name: l.first_name, last_name: l.last_name, company: l.company, title: l.title, website: l.website,
    source: l.source, tags: j(l.tags, []).join('|'), verification_status: l.verification_status, verification_confidence: l.verification_confidence, verification_checked_at: l.verification_checked_at, ...j(l.custom, {}) }));
  res.type('text/csv').attachment('leads.csv').send(toCsv(rows));
});
core.post('/leads', (req, res) => {
  const b = req.body || {};
  const rec = { custom: {} };
  for (const k of CORE_FIELDS) if (b[k]) rec[k] = String(b[k]).trim();
  for (const [k, v] of Object.entries(b.custom || {})) if (String(v).trim()) rec.custom[k.toLowerCase().replace(/[^a-z0-9]+/g, '_')] = String(v).trim();
  const { errors, flags } = validateRecord(rec);
  if (errors.length) throw bad(422, errors.join('; '));
  if (get('SELECT 1 x FROM leads WHERE email = ?', rec.email)) throw bad(409, `A lead with ${rec.email} already exists`);
  const id = insertLead(rec, { source: str(b.source) ?? 'manual', tags: Array.isArray(b.tags) ? b.tags.map(String) : [], flags });
  res.status(201).json(leadOut(get('SELECT * FROM leads WHERE id = ?', id)));
});
core.patch('/leads/:id', (req, res) => {
  const id = int(req.params.id), b = req.body || {};
  const l = get('SELECT * FROM leads WHERE id = ?', id);
  if (!l) throw bad(404, 'Lead not found');
  const next = { ...l };
  for (const k of CORE_FIELDS) if (k in b) next[k] = str(b[k]);
  if ('email' in b) {
    const s = checkSyntax(b.email);
    if (!s.ok) throw bad(422, `Invalid email: ${s.reason}`);
    if (s.email !== l.email) {
      if (get('SELECT 1 x FROM leads WHERE email = ? AND id != ?', s.email, id)) throw bad(409, 'Another lead already uses that email');
      // A changed address invalidates the previous verification result.
      Object.assign(next, { email: s.email, verification_status: 'unverified', verification_confidence: null, verification_checked_at: null, verification_detail: null });
    }
  }
  const custom = 'custom' in b ? Object.fromEntries(Object.entries(b.custom || {}).filter(([, v]) => String(v ?? '').trim() !== '')) : j(l.custom, {});
  for (const key of Object.keys(custom)) run('INSERT OR IGNORE INTO custom_fields (key, label, created_at) VALUES (?,?,?)', key, key.replace(/_/g, ' '), now());
  const tags = Array.isArray(b.tags) ? [...new Set(b.tags.map((t) => String(t).trim()).filter(Boolean))] : j(l.tags, []);
  run(`UPDATE leads SET email=?, first_name=?, last_name=?, company=?, title=?, website=?, phone=?, linkedin=?, country=?, timezone=?, source_date=?, tags=?, custom=?,
       verification_status=?, verification_confidence=?, verification_checked_at=?, verification_detail=?, updated_at=? WHERE id=?`,
    next.email, next.first_name, next.last_name, next.company, next.title, next.website, next.phone, next.linkedin, next.country, next.timezone, next.source_date,
    JSON.stringify(tags), JSON.stringify(custom), next.verification_status, next.verification_confidence, next.verification_checked_at, next.verification_detail, now(), id);
  res.json(leadOut(get('SELECT * FROM leads WHERE id = ?', id)));
});
function deleteLeads(ids) {
  const ph = ids.map(() => '?').join(',');
  tx(() => { run(`DELETE FROM campaign_leads WHERE lead_id IN (${ph})`, ...ids); run(`DELETE FROM leads WHERE id IN (${ph})`, ...ids); });
}
core.delete('/leads/:id', (req, res) => { deleteLeads([int(req.params.id)]); res.json({ ok: true }); });

/** Bulk actions over explicit ids or over everything matching a filter. */
core.post('/leads/bulk', (req, res) => {
  const b = req.body || {};
  let ids = Array.isArray(b.ids) ? b.ids.map(int) : null;
  if (!ids && b.filter) { const f = leadFilter(b.filter); ids = all(`SELECT l.id FROM leads l WHERE ${f.sql}`, ...f.args).map((r) => r.id); }
  if (!ids?.length) throw bad(400, 'No leads selected');
  if (ids.length > 20000) throw bad(400, 'Select at most 20,000 leads per action');
  const each = (fn) => tx(() => { for (const id of ids) { const l = get('SELECT * FROM leads WHERE id = ?', id); if (l) fn(l); } });
  switch (b.action) {
    case 'delete': deleteLeads(ids); audit('leads.bulk_delete', { count: ids.length }, req.user.email); return res.json({ affected: ids.length });
    case 'add_tags': case 'remove_tags': {
      const tags = (b.tags || []).map((t) => String(t).trim()).filter(Boolean);
      if (!tags.length) throw bad(400, 'Provide at least one tag');
      each((l) => { const cur = new Set(j(l.tags, [])); for (const t of tags) b.action === 'add_tags' ? cur.add(t) : cur.delete(t); run('UPDATE leads SET tags = ?, updated_at = ? WHERE id = ?', JSON.stringify([...cur]), now(), l.id); });
      return res.json({ affected: ids.length });
    }
    case 'set_field': {
      const field = String(b.field || '');
      if (field === 'email') throw bad(400, 'Email cannot be bulk-edited');
      if (CORE_FIELDS.includes(field)) each((l) => run(`UPDATE leads SET ${field} = ?, updated_at = ? WHERE id = ?`, str(b.value), now(), l.id));
      else {
        const key = field.replace(/^custom:/, '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
        if (!key) throw bad(400, 'Unknown field');
        run('INSERT OR IGNORE INTO custom_fields (key, label, created_at) VALUES (?,?,?)', key, key.replace(/_/g, ' '), now());
        each((l) => { const c = j(l.custom, {}); if (str(b.value)) c[key] = str(b.value); else delete c[key]; run('UPDATE leads SET custom = ?, updated_at = ? WHERE id = ?', JSON.stringify(c), now(), l.id); });
      }
      return res.json({ affected: ids.length });
    }
    case 'suppress': each((l) => { suppress(l.email, 'manual', str(b.note)); stopSequences(l.id, 'skipped', 'manually suppressed'); }); return res.json({ affected: ids.length });
    case 'verify': {
      const job = startJob('verify', ids.length, async (job) => {
        const tally = {};
        for (let i = 0; i < ids.length; i += 5) {
          await Promise.all(ids.slice(i, i + 5).map(async (id) => {
            const l = get('SELECT * FROM leads WHERE id = ?', id);
            if (l) { const r = await verifyLead(l); tally[r.status] = (tally[r.status] || 0) + 1; }
            job.done++;
          }));
        }
        return tally;
      });
      return res.status(202).json(job);
    }
    default: throw bad(400, 'Unknown bulk action');
  }
});
core.post('/verify', async (req, res) => res.json(await verifyEmail(req.body?.email)));

// ---------- imports ----------
const upload = express.raw({ type: () => true, limit: '25mb' });
core.post('/imports/parse', upload, async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad(400, 'Upload a CSV or XLSX file');
  let rows;
  try { rows = await parseFile(req.body, String(req.query.filename || '')); } catch (err) { throw bad(422, `Could not read the file: ${err.message}`); }
  if (!rows.length) throw bad(422, 'The file has no data rows');
  const headers = Object.keys(rows[0]);
  res.json({ rows: rows.length, headers, mapping: guessMapping(headers), sample: rows.slice(0, 5) });
});
core.post('/imports/stage', upload, async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad(400, 'Upload a CSV or XLSX file');
  const opts = j(req.query.options, {});
  const rows = await parseFile(req.body, String(req.query.filename || ''));
  if (rows.length > 50000) throw bad(422, 'Import at most 50,000 rows per file');
  if (!Object.values(opts.mapping || {}).includes('email')) throw bad(422, 'Map one column to "email"');
  const out = await stageImport({ rows, mapping: opts.mapping, filename: str(req.query.filename, 200), source: str(opts.source) ?? `import:${str(req.query.filename, 80)}`,
    tags: (opts.tags || []).map(String), required: ['email', ...(opts.required || []).filter((f) => CORE_FIELDS.includes(f) && f !== 'email')] });
  res.status(201).json({ id: out.id, report: out.report, rejected: out.records.filter((r) => r.errors.length).slice(0, 200), flagged: out.records.filter((r) => !r.errors.length && r.flags.length).slice(0, 200) });
});
core.get('/imports', (req, res) => res.json(listImports()));
core.get('/imports/:id/errors.csv', (req, res) => {
  const imp = get('SELECT staged FROM imports WHERE id = ?', int(req.params.id));
  if (!imp) throw bad(404, 'Import not found');
  const rows = j(imp.staged, []).filter((r) => r.errors.length || r.flags.length).map((r) => ({ row: r.row, email: r.record.email ?? '', outcome: r.errors.length ? 'rejected' : 'imported_with_flags', errors: r.errors.join(' | '), flags: r.flags.join(' | ') }));
  res.type('text/csv').attachment(`import-${req.params.id}-report.csv`).send(toCsv(rows));
});
core.post('/imports/:id/commit', (req, res) => { try { const r = commitImport(int(req.params.id)); audit('import.commit', { id: req.params.id, ...r }, req.user.email); res.json(r); } catch (e) { throw bad(409, e.message); } });
core.post('/imports/:id/discard', (req, res) => { discardImport(int(req.params.id)); res.json({ ok: true }); });

// ---------- suppressions ----------
core.get('/suppressions', (req, res) => res.json(all('SELECT * FROM suppressions ORDER BY id DESC LIMIT 2000')));
core.post('/suppressions', (req, res) => {
  const values = String(req.body?.values || '').split(/[\s,;]+/).map((v) => v.toLowerCase().trim()).filter(Boolean);
  const invalid = values.filter((v) => !(v.includes('@') ? checkSyntax(v).ok : /^[a-z0-9.-]+\.[a-z]{2,}$/.test(v)));
  if (!values.length || invalid.length) throw bad(422, invalid.length ? `Not a valid email or domain: ${invalid.slice(0, 5).join(', ')}` : 'Enter emails or domains');
  for (const v of values) { suppress(v, 'manual', str(req.body.note)); for (const l of all(v.includes('@') ? 'SELECT id FROM leads WHERE email = ?' : "SELECT id FROM leads WHERE email LIKE '%@' || ?", v)) stopSequences(l.id, 'skipped', 'manually suppressed'); }
  res.status(201).json({ added: values.length });
});
core.delete('/suppressions/:id', (req, res) => {
  const s = get('SELECT * FROM suppressions WHERE id = ?', int(req.params.id));
  if (s && s.reason !== 'manual' && req.query.confirm !== s.reason) throw bad(409, `This entry was added automatically (${s.reason}). Removing it lets you email someone who opted out or bounced.`, { needs_confirm: s.reason });
  run('DELETE FROM suppressions WHERE id = ?', int(req.params.id)); audit('suppression.remove', s, req.user.email); res.json({ ok: true });
});

// ---------- domains ----------
const domainOut = (d) => ({ ...d, last_result: j(d.last_result), accounts: all("SELECT email FROM accounts WHERE email LIKE '%@' || ?", d.name).map((a) => a.email) });
core.get('/domains', (req, res) => res.json(all('SELECT * FROM domains ORDER BY name').map(domainOut)));
core.post('/domains', async (req, res) => {
  const name = String(req.body?.name || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(name)) throw bad(422, 'Enter a valid domain name, e.g. example.com');
  const d = ensureDomain(name);
  if (req.body.dkim_selectors != null) run('UPDATE domains SET dkim_selectors = ? WHERE id = ?', String(req.body.dkim_selectors).replace(/[^\w.,-]/g, ''), d.id);
  await runDomainCheck(d.id);
  res.status(201).json(domainOut(get('SELECT * FROM domains WHERE id = ?', d.id)));
});
core.patch('/domains/:id', async (req, res) => {
  const id = int(req.params.id);
  run('UPDATE domains SET dkim_selectors = ? WHERE id = ?', String(req.body?.dkim_selectors ?? '').replace(/[^\w.,-]/g, ''), id);
  await runDomainCheck(id); res.json(domainOut(get('SELECT * FROM domains WHERE id = ?', id)));
});
core.post('/domains/:id/check', async (req, res) => { await runDomainCheck(int(req.params.id)); res.json(domainOut(get('SELECT * FROM domains WHERE id = ?', int(req.params.id)))); });
core.get('/domains/:id/history', (req, res) => res.json(domainHistory(int(req.params.id))));
core.delete('/domains/:id', (req, res) => {
  const d = get('SELECT * FROM domains WHERE id = ?', int(req.params.id));
  if (d && get("SELECT 1 x FROM accounts WHERE email LIKE '%@' || ?", d.name)) throw bad(409, 'A sending account still uses this domain');
  run('DELETE FROM domain_checks WHERE domain_id = ?', int(req.params.id)); run('DELETE FROM domains WHERE id = ?', int(req.params.id)); res.json({ ok: true });
});

// ---------- accounts ----------
core.get('/accounts', (req, res) => res.json(all('SELECT * FROM accounts ORDER BY id').map(publicAccount)));
function accountFields(b, existing = {}) {
  const provider = existing.provider ?? b.provider;
  if (!PROVIDERS[provider]) throw bad(422, 'Choose a provider');
  const preset = PROVIDERS[provider];
  const f = {
    provider, from_name: str(b.from_name ?? existing.from_name, 120), username: str(b.username ?? existing.username, 200),
    smtp_host: str(preset.smtp_host ?? b.smtp_host ?? existing.smtp_host, 200), smtp_port: Number(preset.smtp_port ?? b.smtp_port ?? existing.smtp_port) || null,
    smtp_secure: Number(preset.smtp_secure ?? (b.smtp_secure ?? existing.smtp_secure ? 1 : 0)),
    imap_host: str(preset.imap_host ?? b.imap_host ?? existing.imap_host, 200), imap_port: Number(preset.imap_port ?? b.imap_port ?? existing.imap_port) || 993,
    daily_limit: Math.floor(Number(b.daily_limit ?? existing.daily_limit ?? 30)), warmup_enabled: (b.warmup_enabled ?? existing.warmup_enabled) ? 1 : 0,
    warmup_start: Math.floor(Number(b.warmup_start ?? existing.warmup_start ?? 5)), warmup_increment: Math.floor(Number(b.warmup_increment ?? existing.warmup_increment ?? 3)),
    signature: str(b.signature ?? existing.signature, 2000),
  };
  if (!(f.daily_limit >= 1 && f.daily_limit <= 2000)) throw bad(422, 'Daily limit must be between 1 and 2000');
  if (!(f.warmup_start >= 1) || !(f.warmup_increment >= 0)) throw bad(422, 'Ramp-up start must be at least 1 and the increment cannot be negative');
  if (provider !== 'sandbox' && (!f.smtp_host || !f.smtp_port)) throw bad(422, 'SMTP host and port are required');
  return f;
}
/** Shared by single connect and CSV import. Throws bad(...) on validation problems; never echoes the password. */
function insertAccount(b, userEmail) {
  const s = checkSyntax(b.email);
  if (!s.ok) throw bad(422, `Invalid email: ${s.reason}`);
  if (get('SELECT 1 x FROM accounts WHERE email = ?', s.email)) throw bad(409, 'This account is already connected');
  const f = accountFields(b);
  if (f.provider !== 'sandbox' && !b.password) throw bad(422, 'A password or app password is required (or connect with OAuth)');
  const id = Number(run(`INSERT INTO accounts (email, from_name, provider, smtp_host, smtp_port, smtp_secure, imap_host, imap_port, username, secret_enc, daily_limit, warmup_enabled, warmup_start, warmup_increment, warmup_started_at, signature, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, s.email, f.from_name, f.provider, f.smtp_host, f.smtp_port, f.smtp_secure, f.imap_host, f.imap_port, f.username, encrypt(b.password),
    f.daily_limit, f.warmup_enabled, f.warmup_start, f.warmup_increment, f.warmup_enabled ? now() : null, f.signature, now()).lastInsertRowid);
  audit('account.create', { email: s.email, provider: f.provider }, userEmail);
  return id;
}
core.post('/accounts', async (req, res) => {
  const id = insertAccount(req.body || {}, req.user.email);
  await checkAccount(id);
  res.status(201).json(publicAccount(get('SELECT * FROM accounts WHERE id = ?', id)));
});
// Bulk connect from CSV/XLSX. Per-row outcomes; one bad row never blocks the others. Passwords are never returned or logged.
core.get('/accounts/import/template.csv', (req, res) => { res.type('text/csv').set('Content-Disposition', 'attachment; filename="email-accounts-template.csv"').send(TEMPLATE_CSV); });
async function readAccountRows(req) {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad(400, 'Upload a CSV or XLSX file');
  let rows;
  try { rows = await parseFile(req.body, String(req.query.filename || '')); } catch (err) { throw bad(422, `Could not read the file: ${err.message}`); }
  if (!rows.length) throw bad(422, 'The file has no data rows');
  if (rows.length > MAX_ACCOUNT_ROWS) throw bad(422, `Import at most ${MAX_ACCOUNT_ROWS} accounts per file`);
  return rows;
}
core.post('/accounts/import/preview', upload, async (req, res) => {
  const rows = await readAccountRows(req);
  const items = rowsToAccounts(rows);
  res.json({ rows: rows.length, recognised_columns: recognisedColumns(Object.keys(rows[0])),
    accounts: items.map((x) => ({ line: x.line, email: x.email, error: x.error ?? (get('SELECT 1 x FROM accounts WHERE email = ?', x.email) ? 'Already connected' : null),
      smtp: x.body ? `${x.body.smtp_host}:${x.body.smtp_port}` : null, imap: x.body ? `${x.body.imap_host}:${x.body.imap_port}` : null, daily_limit: x.body?.daily_limit ?? null })) });
});
core.post('/accounts/import', upload, async (req, res) => {
  const items = rowsToAccounts(await readAccountRows(req));
  const results = items.map((x) => ({ line: x.line, email: x.email, id: null, status: null, error: x.error ?? null }));
  const created = [];
  items.forEach((x, i) => {
    if (x.error) return;
    try { results[i].id = insertAccount(x.body, req.user.email); created.push(i); } catch (err) { results[i].error = err.status ? err.message : 'Could not save this account'; }
  });
  // Connection checks run a few at a time so a big file does not open dozens of SMTP/IMAP sessions at once.
  for (let k = 0; k < created.length; k += 4) {
    await Promise.all(created.slice(k, k + 4).map(async (i) => {
      try { results[i].status = (await checkAccount(results[i].id)).status; } catch { results[i].status = 'unverified'; results[i].error = 'Saved, but the connection check could not run'; }
    }));
  }
  audit('account.import', { rows: items.length, created: created.length }, req.user.email);
  res.status(201).json({ total: items.length, created: created.length, failed: items.length - created.length, results });
});
core.patch('/accounts/:id', async (req, res) => {
  const id = int(req.params.id), b = req.body || {};
  const a = get('SELECT * FROM accounts WHERE id = ?', id);
  if (!a) throw bad(404, 'Account not found');
  const f = accountFields(b, a);
  run(`UPDATE accounts SET from_name=?, smtp_host=?, smtp_port=?, smtp_secure=?, imap_host=?, imap_port=?, username=?, daily_limit=?, warmup_enabled=?, warmup_start=?, warmup_increment=?,
       warmup_started_at=?, signature=?, paused=?, secret_enc=? WHERE id=?`, f.from_name, f.smtp_host, f.smtp_port, f.smtp_secure, f.imap_host, f.imap_port, f.username, f.daily_limit, f.warmup_enabled,
    f.warmup_start, f.warmup_increment, f.warmup_enabled ? (a.warmup_started_at ?? now()) : null, f.signature, 'paused' in b ? (b.paused ? 1 : 0) : a.paused, b.password ? encrypt(b.password) : a.secret_enc, id);
  const connectionChanged = b.password || ['smtp_host', 'smtp_port', 'imap_host', 'username'].some((k) => k in b && String(b[k] ?? '') !== String(a[k] ?? ''));
  if (connectionChanged) await checkAccount(id, { refreshDomain: false });
  res.json(publicAccount(get('SELECT * FROM accounts WHERE id = ?', id)));
});
core.post('/accounts/:id/check', async (req, res) => { await checkAccount(int(req.params.id)); res.json(publicAccount(get('SELECT * FROM accounts WHERE id = ?', int(req.params.id)))); });
core.delete('/accounts/:id', (req, res) => {
  const id = int(req.params.id);
  const active = get("SELECT c.name FROM campaigns c JOIN campaign_accounts ca ON ca.campaign_id = c.id WHERE ca.account_id = ? AND c.status = 'active'", id);
  if (active) throw bad(409, `Pause campaign "${active.name}" before removing this account`);
  tx(() => { run('DELETE FROM campaign_accounts WHERE account_id = ?', id); run('DELETE FROM accounts WHERE id = ?', id); });
  audit('account.delete', { id }, req.user.email); res.json({ ok: true });
});

// OAuth2 (authorization-code). State is single-use and bound to the signed-in session.
const oauthStates = new Map();
core.get('/oauth/:provider/start', (req, res) => {
  const p = OAUTH[req.params.provider];
  if (!p || !oauthConfigured(req.params.provider)) throw bad(400, `OAuth for ${req.params.provider} is not configured. Set the client ID and secret in .env, or connect with an app password.`);
  const state = token(18);
  oauthStates.set(state, { provider: req.params.provider, user: req.user.id, at: Date.now() });
  res.redirect(`${p.auth}?${new URLSearchParams({ client_id: p.creds().clientId, redirect_uri: `${config.publicUrl}/api/oauth/${req.params.provider}/callback`, response_type: 'code', scope: p.scope, access_type: 'offline', prompt: 'consent', state })}`);
});
core.get('/oauth/:provider/callback', async (req, res) => {
  const st = oauthStates.get(String(req.query.state)); oauthStates.delete(String(req.query.state));
  if (!st || st.provider !== req.params.provider || st.user !== req.user.id || Date.now() - st.at > 10 * 60e3) throw bad(400, 'OAuth state is invalid or expired; start again.');
  const p = OAUTH[st.provider], c = p.creds();
  const tr = await fetch(p.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'authorization_code', code: String(req.query.code || ''), redirect_uri: `${config.publicUrl}/api/oauth/${st.provider}/callback` }) });
  const tok = await tr.json();
  if (!tr.ok || !tok.refresh_token) throw bad(400, `The provider did not grant offline access: ${tok.error_description || tok.error || 'no refresh token returned'}`);
  const claims = j(Buffer.from(String(tok.id_token || '').split('.')[1] || '', 'base64url').toString() || 'null', {});
  const email = String(claims?.email || claims?.preferred_username || '').toLowerCase();
  if (!checkSyntax(email).ok) throw bad(400, 'Could not determine the mailbox address from the provider response.');
  const preset = PROVIDERS[st.provider];
  const blob = encrypt(JSON.stringify({ refresh_token: tok.refresh_token, access_token: tok.access_token, expires_at: Date.now() + (tok.expires_in || 3600) * 1000 }));
  const ex = get('SELECT id FROM accounts WHERE email = ?', email);
  const id = ex ? (run('UPDATE accounts SET oauth_enc = ?, secret_enc = NULL WHERE id = ?', blob, ex.id), ex.id)
    : Number(run('INSERT INTO accounts (email, provider, smtp_host, smtp_port, smtp_secure, imap_host, imap_port, username, oauth_enc, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', email, st.provider, preset.smtp_host, preset.smtp_port, preset.smtp_secure, preset.imap_host, preset.imap_port, email, blob, now()).lastInsertRowid);
  await checkAccount(id);
  res.redirect('/#/accounts');
});
export { domainOf };
