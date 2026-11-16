import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
process.env.DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'outbound-test-'));
process.env.SCHEDULER = 'off';
process.env.PUBLIC_URL = 'https://track.example.test';
delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN;
const { openDb, setDb, run, get, now } = await import('../src/db.js');
const { setResolver, setVantagePoints, DnsError } = await import('../src/lib/dns.js');

export function freshDb() { setDb(openDb(':memory:')); }

/** Fixture DNS. zone: { 'name/TYPE': [...records] }. Missing keys = no record; value 'ERR' = lookup failure. */
export function fakeDns(zone) {
  const fn = async (name, type) => {
    const v = zone[`${name}/${type}`];
    if (v === 'ERR') throw new DnsError('ESERVFAIL', 'servfail');
    return v ?? [];
  };
  setResolver(fn); setVantagePoints({ a: fn, b: fn });
  return fn;
}
export const GOOD_ZONE = (d) => ({
  [`${d}/MX`]: [{ priority: 10, exchange: `mx.${d}` }],
  [`${d}/TXT`]: ['v=spf1 include:_spf.mailhost.test ~all'],
  ['_spf.mailhost.test/TXT']: ['v=spf1 ip4:192.0.2.0/24 -all'],
  [`_dmarc.${d}/TXT`]: ['v=DMARC1; p=quarantine; rua=mailto:d@' + d],
  [`google._domainkey.${d}/TXT`]: ['v=DKIM1; k=rsa; p=' + Buffer.alloc(294, 1).toString('base64')],
});
export function lead(email, extra = {}) {
  const t = now();
  const v = extra.verified === false ? {} : { verification_status: extra.status ?? 'valid', verification_confidence: 0.95, verification_checked_at: t,
    verification_detail: JSON.stringify({ checks: { mx: 'pass' }, reasons: [] }) };
  const id = Number(run(`INSERT INTO leads (email, first_name, company, website, custom, verification_status, verification_confidence, verification_checked_at, verification_detail, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, email, extra.first_name ?? 'Ada', extra.company ?? 'Acme', extra.website ?? null, JSON.stringify(extra.custom ?? {}),
    v.verification_status ?? 'unverified', v.verification_confidence ?? null, v.verification_checked_at ?? null, v.verification_detail ?? null, t, t).lastInsertRowid);
  return get('SELECT * FROM leads WHERE id = ?', id);
}
export function sandboxAccount(email = 'sender@sandbox.test', extra = {}) {
  const id = Number(run("INSERT INTO accounts (email, from_name, provider, daily_limit, status, created_at) VALUES (?,?,?,?,?,?)", email, 'Sam Sender', extra.provider ?? 'sandbox', extra.daily_limit ?? 100, extra.status ?? 'sandbox', now()).lastInsertRowid);
  return get('SELECT * FROM accounts WHERE id = ?', id);
}
/** Campaign open 24/7 UTC with two steps (day 0, +3 days). */
export function campaign({ accounts, leads, steps, ...over } = {}) {
  const cid = Number(run(`INSERT INTO campaigns (name, timezone, window_start, window_end, days, daily_limit, min_interval, max_interval, verification_threshold, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    over.name ?? 'Test', 'UTC', '00:00', '23:59', '0,1,2,3,4,5,6', over.daily_limit ?? 50, 30, 30, over.threshold ?? 'valid', now()).lastInsertRowid);
  (steps ?? [{ delay: 0, subject: 'Quick idea for {{company}}', body: 'Hi {{first_name}}, would a short call make sense? https://example.com/demo' }, { delay: 3, subject: '', body: 'Hi {{first_name}}, any thoughts on my note?' }])
    .forEach((s, i) => {
      const sid = Number(run('INSERT INTO steps (campaign_id, position, delay_days, condition) VALUES (?,?,?,?)', cid, i, s.delay, JSON.stringify(s.condition ?? { type: 'always' })).lastInsertRowid);
      for (const [vi, v] of (s.variants ?? [s]).entries()) run('INSERT INTO variants (step_id, label, subject, body, weight) VALUES (?,?,?,?,?)', sid, String.fromCharCode(65 + vi), v.subject, v.body, v.weight ?? 1);
    });
  for (const a of accounts ?? []) run('INSERT INTO campaign_accounts (campaign_id, account_id) VALUES (?,?)', cid, a.id);
  for (const l of leads ?? []) run("INSERT INTO campaign_leads (campaign_id, lead_id, added_at) VALUES (?,?,?)", cid, l.id, now());
  return cid;
}
