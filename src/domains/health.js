// Domain health: DNS authentication checks + blocklists + measured sending metrics.
// A passing DNS configuration is necessary for deliverability but says nothing about
// inbox placement, so no result here is ever worded as "inbox-safe".
import { resolve, getVantagePoints, DnsError } from '../lib/dns.js';
import { all, get, run, now, j, raiseAlert } from '../db.js';

const COMMON_SELECTORS = ['google', 'selector1', 'selector2', 'default', 'k1', 'k2', 's1', 's2', 'mail', 'dkim', 'smtp', 'mxvault', 'zoho', 'pm', 'mandrill', 'fm1', 'protonmail'];
const check = (key, label, status, critical, detail, fix = null, extra = {}) => ({ key, label, status, critical, detail, fix, ...extra });

async function txt(name) {
  try { return { ok: true, records: await resolve(name, 'TXT') }; }
  catch (err) { if (err instanceof DnsError) return { ok: false, error: err.message }; throw err; }
}

async function countSpfLookups(record, depth = 0, seen = new Set()) {
  if (depth > 10) return 99;
  let n = 0;
  for (const term of record.split(/\s+/).slice(1)) {
    const t = term.replace(/^[+\-~?]/, '').toLowerCase();
    if (/^(a|mx|ptr|exists)([:/]|$)/.test(t)) n++;
    const inc = t.match(/^(?:include:|redirect=)(.+)$/);
    if (inc) {
      n++;
      if (seen.has(inc[1])) continue;
      seen.add(inc[1]);
      const r = await txt(inc[1]);
      const sub = r.ok && r.records.find((x) => /^v=spf1(\s|$)/i.test(x));
      if (sub) n += await countSpfLookups(sub, depth + 1, seen);
    }
  }
  return n;
}

export async function checkSpf(domain) {
  const r = await txt(domain);
  if (!r.ok) return check('spf', 'SPF', 'unknown', true, `Lookup failed: ${r.error}`);
  const spf = r.records.filter((x) => /^v=spf1(\s|$)/i.test(x));
  if (!spf.length) return check('spf', 'SPF', 'fail', true, 'No SPF record published.', `Add a TXT record on ${domain}: "v=spf1 include:<your mail provider> ~all" (e.g. include:_spf.google.com for Google Workspace).`);
  if (spf.length > 1) return check('spf', 'SPF', 'fail', true, `${spf.length} SPF records found; receivers treat multiple records as a permanent error.`, 'Merge all mechanisms into a single v=spf1 TXT record.', { record: spf.join(' | ') });
  const rec = spf[0];
  const allTerm = rec.match(/([+\-~?]?)all\b/i);
  if (allTerm && (allTerm[1] === '+' || allTerm[1] === '')) return check('spf', 'SPF', 'fail', true, 'SPF ends in "+all", which authorises every server on the internet.', 'Change the final mechanism to "~all" or "-all".', { record: rec });
  const lookups = await countSpfLookups(rec);
  if (lookups > 10) return check('spf', 'SPF', 'fail', true, `SPF needs ${lookups} DNS lookups; the limit is 10, so receivers return permerror.`, 'Remove unused include: mechanisms or flatten the record.', { record: rec, lookups });
  if (!allTerm && !/redirect=/i.test(rec)) return check('spf', 'SPF', 'warn', false, 'SPF has no "all" mechanism, so unauthorised senders get a neutral result.', 'End the record with "~all" or "-all".', { record: rec, lookups });
  if (allTerm?.[1] === '?') return check('spf', 'SPF', 'warn', false, 'SPF ends in "?all" (neutral), which provides no protection.', 'Use "~all" or "-all".', { record: rec, lookups });
  return check('spf', 'SPF', 'pass', true, `Valid SPF record (${lookups}/10 lookups).`, null, { record: rec, lookups });
}

export async function checkDkim(domain, selectors = []) {
  const custom = selectors.map((s) => s.trim()).filter(Boolean);
  const tried = [...new Set([...custom, ...COMMON_SELECTORS])];
  const found = [], errors = [];
  await Promise.all(tried.map(async (sel) => {
    const r = await txt(`${sel}._domainkey.${domain}`);
    if (!r.ok) return errors.push(sel);
    const rec = r.records.join('');
    if (!/(^|;)\s*p=/i.test(rec) && !/k=rsa|v=DKIM1/i.test(rec)) return;
    const p = rec.match(/(?:^|;)\s*p=([^;]*)/i)?.[1]?.replace(/\s+/g, '') ?? '';
    found.push({ selector: sel, revoked: p === '', bits: p ? Math.round((Buffer.from(p, 'base64').length - 38) * 8 / 256) * 256 : 0 });
  }));
  const live = found.filter((f) => !f.revoked);
  if (live.length) {
    const weak = live.filter((f) => f.bits && f.bits < 2048);
    if (weak.length === live.length) return check('dkim', 'DKIM', 'warn', false, `DKIM key found (selector ${live.map((f) => f.selector).join(', ')}) but it is shorter than 2048 bits.`, 'Rotate to a 2048-bit key in your mail provider admin console.', { selectors: found });
    return check('dkim', 'DKIM', 'pass', true, `DKIM public key published for selector ${live.map((f) => f.selector).join(', ')}. This confirms the key exists, not that outgoing mail is being signed with it.`, null, { selectors: found });
  }
  if (errors.length === tried.length) return check('dkim', 'DKIM', 'unknown', true, 'DKIM lookups failed; could not check.');
  return check('dkim', 'DKIM', custom.length ? 'fail' : 'unknown', true,
    custom.length ? `No DKIM key found for selector(s) ${custom.join(', ')}.` : `No DKIM key found under ${COMMON_SELECTORS.length} common selectors. DKIM selectors cannot be enumerated, so this is unverified rather than proven missing.`,
    'Enable DKIM signing in your mail provider, publish the TXT record it gives you, then enter that selector on this domain so it can be verified.', { selectors: found });
}

export async function checkDmarc(domain) {
  const r = await txt(`_dmarc.${domain}`);
  if (!r.ok) return check('dmarc', 'DMARC', 'unknown', true, `Lookup failed: ${r.error}`);
  const recs = r.records.filter((x) => /^v=DMARC1/i.test(x));
  if (!recs.length) return check('dmarc', 'DMARC', 'fail', true, 'No DMARC record published. Gmail and Yahoo require one for bulk senders.', `Add a TXT record on _dmarc.${domain}: "v=DMARC1; p=none; rua=mailto:dmarc@${domain}" and tighten to quarantine/reject once reports are clean.`);
  if (recs.length > 1) return check('dmarc', 'DMARC', 'fail', true, 'Multiple DMARC records found; receivers ignore all of them.', 'Keep exactly one v=DMARC1 record.');
  const tags = Object.fromEntries(recs[0].split(';').map((p) => p.trim().split('=').map((s) => s.trim())).filter((p) => p.length === 2).map(([k, v]) => [k.toLowerCase(), v]));
  const policy = (tags.p || '').toLowerCase();
  const extra = { record: recs[0], policy, aspf: tags.aspf || 'r', adkim: tags.adkim || 'r', rua: tags.rua || null };
  if (!['none', 'quarantine', 'reject'].includes(policy)) return check('dmarc', 'DMARC', 'fail', true, 'DMARC record has no valid p= policy.', 'Set p=none, p=quarantine or p=reject.', extra);
  if (policy === 'none') return check('dmarc', 'DMARC', 'warn', false, `DMARC is published with p=none (monitoring only)${tags.rua ? '' : ' and no rua= reporting address'}. Meets the bulk-sender minimum but does not stop spoofing.`, 'After reviewing aggregate reports, move to p=quarantine.', extra);
  return check('dmarc', 'DMARC', 'pass', true, `DMARC enforced with p=${policy}${tags.rua ? '' : ' (no rua= reporting address, so you receive no reports)'}.`, null, extra);
}

export async function checkMx(domain) {
  try {
    const mx = await resolve(domain, 'MX');
    if (!mx.length || (mx.length === 1 && !mx[0].exchange.replace('.', ''))) return check('mx', 'MX', 'fail', true, 'No MX records: replies and bounces to this domain cannot be delivered.', 'Add the MX records from your mail provider.');
    return check('mx', 'MX', 'pass', true, `Mail is handled by ${mx.slice(0, 3).map((m) => m.exchange).join(', ')}.`, null, { hosts: mx.map((m) => m.exchange) });
  } catch (err) { if (err instanceof DnsError) return check('mx', 'MX', 'unknown', true, `Lookup failed: ${err.message}`); throw err; }
}

/** Compare SPF/DMARC answers across independent public resolvers. */
export async function checkPropagation(domain) {
  const points = getVantagePoints();
  const view = {};
  await Promise.all(Object.entries(points).map(async ([name, res]) => {
    try {
      const [a, b] = await Promise.all([res(domain, 'TXT'), res(`_dmarc.${domain}`, 'TXT')]);
      view[name] = [...a.filter((x) => /^v=spf1/i.test(x)), ...b.filter((x) => /^v=DMARC1/i.test(x))].sort().join(' || ');
    } catch { view[name] = null; }
  }));
  const answered = Object.entries(view).filter(([, v]) => v !== null);
  if (answered.length < 2) return check('propagation', 'DNS propagation', 'unknown', false, `Only ${answered.length} of ${Object.keys(view).length} public resolvers could be reached; propagation could not be compared.`);
  const distinct = new Set(answered.map(([, v]) => v));
  if (distinct.size > 1) return check('propagation', 'DNS propagation', 'warn', false, `Public resolvers disagree (${answered.map(([n]) => n).join(', ')}): a recent DNS change is still propagating.`, 'Wait for the record TTL to expire, then re-check before sending.', { view });
  return check('propagation', 'DNS propagation', 'pass', false, `${answered.length} public resolvers return identical SPF/DMARC records.`, null, { view });
}

const BLOCKLISTS = [
  { zone: 'dbl.spamhaus.org', name: 'Spamhaus DBL', refused: /^127\.255\.255\./ },
  { zone: 'multi.surbl.org', name: 'SURBL', refused: /^127\.0\.0\.1$/ },
  { zone: 'multi.uribl.com', name: 'URIBL', refused: /^127\.0\.0\.1$/ },
];
export async function checkBlocklists(domain) {
  const results = await Promise.all(BLOCKLISTS.map(async (bl) => {
    try {
      const a = await resolve(`${domain}.${bl.zone}`, 'A');
      if (!a.length) return { list: bl.name, state: 'clean' };
      if (a.some((ip) => bl.refused.test(ip))) return { list: bl.name, state: 'refused' };
      return { list: bl.name, state: 'listed', code: a.join(',') };
    } catch { return { list: bl.name, state: 'error' }; }
  }));
  const listed = results.filter((r) => r.state === 'listed');
  const answered = results.filter((r) => r.state === 'clean' || r.state === 'listed');
  if (listed.length) return check('blocklist', 'Blocklists', 'fail', true, `Listed on ${listed.map((l) => l.list).join(', ')}.`, 'Stop sending from this domain, fix the cause (complaints, bad lists), then request delisting from each operator.', { results });
  if (!answered.length) return check('blocklist', 'Blocklists', 'unknown', false, 'No blocklist answered. Spamhaus, SURBL and URIBL refuse queries from public/shared DNS resolvers; use your own resolver or a Spamhaus DQS key for a real answer.', null, { results });
  return check('blocklist', 'Blocklists', 'pass', false, `Not listed on ${answered.map((r) => r.list).join(', ')}${answered.length < results.length ? ` (${results.length - answered.length} list(s) did not answer)` : ''}. Only domain blocklists are checked, not sending IPs.`, null, { results });
}

/** Measured sending metrics for accounts on this domain (real sends only). */
export function sendingMetrics(domain, days = 14) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const c = Object.fromEntries(all('SELECT type, COUNT(*) n FROM events WHERE domain = ? AND simulated = 0 AND created_at >= ? GROUP BY type', domain, since).map((r) => [r.type, r.n]));
  const sent = c.sent || 0;
  const today = get("SELECT COUNT(*) n FROM events WHERE domain = ? AND simulated = 0 AND type = 'sent' AND created_at >= ?", domain, new Date(Date.now() - 864e5).toISOString()).n;
  const prior = Math.max(0, sent - today) / Math.max(1, days - 1);
  return { days, sent, bounce_hard: c.bounce_hard || 0, bounce_soft: c.bounce_soft || 0, complaint: c.complaint || 0, auth_failure: c.auth_failure || 0, today, daily_avg_prior: Math.round(prior * 10) / 10 };
}
export function metricChecks(m) {
  const out = [];
  if (m.sent < 30) {
    out.push(check('bounce_rate', 'Bounce rate', 'unknown', false, `Only ${m.sent} real emails sent in ${m.days} days: not enough data for a meaningful rate.`));
    out.push(check('complaint_rate', 'Spam complaints', 'unknown', false, 'Not enough sending data. Complaints are only recorded when you log them or a feedback loop reports them; Gmail does not send complaint notifications.'));
  } else {
    const br = (m.bounce_hard / m.sent) * 100;
    out.push(br > 5 ? check('bounce_rate', 'Bounce rate', 'fail', true, `Hard bounce rate is ${br.toFixed(1)}% (${m.bounce_hard}/${m.sent}); above 5% damages sender reputation quickly.`, 'Pause campaigns on this domain and re-verify the lead lists.')
      : br > 2 ? check('bounce_rate', 'Bounce rate', 'warn', false, `Hard bounce rate is ${br.toFixed(1)}% (${m.bounce_hard}/${m.sent}); keep it under 2%.`, 'Tighten the verification threshold on active campaigns.')
      : check('bounce_rate', 'Bounce rate', 'pass', false, `Hard bounce rate is ${br.toFixed(1)}% (${m.bounce_hard}/${m.sent}).`));
    const cr = (m.complaint / m.sent) * 100;
    out.push(cr >= 0.3 ? check('complaint_rate', 'Spam complaints', 'fail', true, `Recorded complaint rate is ${cr.toFixed(2)}%; Gmail and Yahoo enforce a 0.3% ceiling.`, 'Pause sending and review targeting and copy.')
      : cr >= 0.1 ? check('complaint_rate', 'Spam complaints', 'warn', false, `Recorded complaint rate is ${cr.toFixed(2)}%; stay under 0.1%.`)
      : check('complaint_rate', 'Spam complaints', 'pass', false, `Recorded complaint rate is ${cr.toFixed(2)}%. Only complaints logged in this system are counted; check Google Postmaster Tools for Gmail's own number.`));
  }
  if (m.daily_avg_prior >= 5 && m.today > m.daily_avg_prior * 2.5) out.push(check('volume', 'Sending volume', 'warn', false, `Sent ${m.today} emails in the last 24h versus a ${m.daily_avg_prior}/day average: sudden spikes look like spam.`, 'Ramp volume gradually (no more than ~20% per day).'));
  else out.push(check('volume', 'Sending volume', m.sent ? 'pass' : 'unknown', false, m.sent ? `Last 24h: ${m.today}; prior average ${m.daily_avg_prior}/day.` : 'No real sends recorded yet.'));
  if (m.auth_failure) out.push(check('auth_failures', 'Authentication failures', 'fail', true, `${m.auth_failure} SMTP authentication failure(s) in ${m.days} days.`, 'Re-connect the affected sending account.'));
  out.push(check('reputation', 'Domain reputation', 'unknown', false, 'No reputation data source is connected. Reputation is only observable through Google Postmaster Tools and Microsoft SNDS for your own verified domain.'));
  return out;
}

const WEIGHTS = { spf: 20, dkim: 20, dmarc: 20, mx: 10, blocklist: 15, bounce_rate: 8, complaint_rate: 7 };
/** Score counts only what was actually measured: unknown checks earn nothing and are listed as unverified. */
export function scoreChecks(checks) {
  let score = 0;
  for (const c of checks) {
    const w = WEIGHTS[c.key]; if (!w) continue;
    score += c.status === 'pass' ? w : c.status === 'warn' ? w * 0.6 : 0;
  }
  const criticalFail = checks.filter((c) => c.critical && c.status === 'fail');
  const criticalUnknown = checks.filter((c) => c.critical && c.status === 'unknown');
  const warns = checks.filter((c) => c.status === 'warn');
  score = Math.round(score);
  if (criticalFail.length) score = Math.min(score, 49);
  const status = criticalFail.length ? 'unhealthy' : criticalUnknown.length ? 'unverified' : warns.length ? 'warning' : 'healthy';
  return { score, status, critical: criticalFail.map((c) => c.key), unverified: checks.filter((c) => c.status === 'unknown').map((c) => c.key) };
}

export async function checkDomain(name, selectors = []) {
  const dns = await Promise.all([checkSpf(name), checkDkim(name, selectors), checkDmarc(name), checkMx(name), checkPropagation(name), checkBlocklists(name)]);
  const metrics = sendingMetrics(name);
  const checks = [...dns, ...metricChecks(metrics)];
  return { domain: name, checked_at: now(), checks, metrics, ...scoreChecks(checks),
    disclaimer: 'This score reflects DNS authentication, blocklists and your own measured bounce/complaint data. It does not measure inbox placement; a domain can pass every check here and still land in spam.' };
}

/** Run, persist history, and alert on a transition into "unhealthy". */
export async function runDomainCheck(id) {
  const d = get('SELECT * FROM domains WHERE id = ?', id);
  if (!d) throw new Error('Domain not found');
  const res = await checkDomain(d.name, d.dkim_selectors.split(','));
  run('UPDATE domains SET score=?, status=?, last_checked_at=?, last_result=? WHERE id=?', res.score, res.status, res.checked_at, JSON.stringify(res), id);
  run('INSERT INTO domain_checks (domain_id, checked_at, score, status, result) VALUES (?,?,?,?,?)', id, res.checked_at, res.score, res.status, JSON.stringify({ checks: res.checks.map(({ key, status }) => ({ key, status })), metrics: res.metrics }));
  if (res.status === 'unhealthy') {
    raiseAlert('critical', 'domain', id, `${d.name} is unhealthy: ${res.checks.filter((c) => c.critical && c.status === 'fail').map((c) => c.label).join(', ')} failing`);
  } else run("UPDATE alerts SET resolved_at = ? WHERE entity_type = 'domain' AND entity_id = ? AND resolved_at IS NULL", now(), id);
  return res;
}
export function ensureDomain(name) {
  run('INSERT OR IGNORE INTO domains (name, created_at) VALUES (?,?)', name.toLowerCase(), now());
  return get('SELECT * FROM domains WHERE name = ?', name.toLowerCase());
}
export const domainHistory = (id) => all('SELECT checked_at, score, status, result FROM domain_checks WHERE domain_id = ? ORDER BY id DESC LIMIT 60', id).map((r) => ({ ...r, result: j(r.result) }));
