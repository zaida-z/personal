// The launch gate. Every item is computed from current data; a campaign cannot be
// activated (or resumed) while any blocking item fails, and the sender re-checks the
// per-recipient items again immediately before each send.
import { all, get, j } from '../db.js';
import { meetsThreshold, THRESHOLDS } from '../verify/engine.js';
import { canSend, effectiveDailyLimit, domainOf } from '../accounts/service.js';
import { lintEmail, extractVariables } from '../ai/lint.js';
import { leadContext, render, LEAD_VARS, SENDER_VARS } from './render.js';
import { config } from '../config.js';

export function loadCampaign(id) {
  const c = get('SELECT * FROM campaigns WHERE id = ?', id);
  if (!c) return null;
  c.steps = all('SELECT * FROM steps WHERE campaign_id = ? ORDER BY position', id).map((s) => ({
    ...s, condition: j(s.condition, { type: 'always' }), variants: all('SELECT * FROM variants WHERE step_id = ? ORDER BY id', s.id),
  }));
  c.accounts = all('SELECT a.* FROM accounts a JOIN campaign_accounts ca ON ca.account_id = a.id WHERE ca.campaign_id = ?', id);
  return c;
}
export const isSuppressed = (email) => get('SELECT reason FROM suppressions WHERE value IN (?, ?)', email, domainOf(email));
export function validTimezone(tz) { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }

export function validateSchedule(c) {
  const errs = [];
  const hm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!hm.test(c.window_start) || !hm.test(c.window_end)) errs.push('sending window times must be HH:MM');
  else if (c.window_start >= c.window_end) errs.push('sending window must end after it starts');
  const days = String(c.days).split(',').filter(Boolean).map(Number);
  if (!days.length || days.some((d) => !(d >= 0 && d <= 6))) errs.push('select at least one sending day');
  if (!validTimezone(c.timezone)) errs.push(`unknown time zone "${c.timezone}"`);
  if (!(c.min_interval >= 30)) errs.push('minimum interval between emails must be at least 30 seconds');
  if (c.max_interval < c.min_interval) errs.push('maximum interval must be >= minimum interval');
  if (!(c.daily_limit >= 1)) errs.push('daily limit must be at least 1');
  return errs;
}

export function readiness(id) {
  const c = loadCampaign(id);
  if (!c) throw new Error('Campaign not found');
  const items = [];
  const add = (key, label, status, detail, extra = {}) => items.push({ key, label, status, blocking: status === 'fail', detail, ...extra });
  const leads = all(`SELECT l.*, cl.status cl_status, cl.id cl_id FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id
                     WHERE cl.campaign_id = ? AND cl.status IN ('pending','active')`, id);

  // 1. recipients
  add('leads', 'Lead list', leads.length ? 'pass' : 'fail', leads.length ? `${leads.length} lead(s) queued.` : get('SELECT 1 x FROM campaign_leads WHERE campaign_id = ?', id) ? 'No leads are waiting to be sent: everyone in this campaign has finished or been stopped. Add new leads to continue.' : 'No leads have been added to this campaign.');

  // 2. verification threshold
  const failing = leads.map((l) => ({ l, r: meetsThreshold(l, c.verification_threshold) })).filter((x) => !x.r.ok);
  const byReason = {};
  for (const f of failing) byReason[f.r.reason] = (byReason[f.r.reason] || 0) + 1;
  add('verification', 'Email verification', !leads.length ? 'fail' : failing.length ? 'fail' : 'pass',
    failing.length ? `${failing.length} of ${leads.length} lead(s) do not meet the "${c.verification_threshold}" threshold (${Object.entries(byReason).map(([k, v]) => `${v} ${k}`).join('; ')}).`
      : leads.length ? `All ${leads.length} lead(s) meet the "${c.verification_threshold}" threshold (allowed: ${THRESHOLDS[c.verification_threshold].join(', ')}).` : 'No leads to check.',
    { lead_ids: failing.map((f) => f.l.id), action: failing.length ? 'verify_or_remove' : null });
  if (c.verification_threshold === 'dns_verified' && leads.length) add('verification_risk', 'Verification depth', 'warn', 'Threshold allows addresses whose mailbox was never confirmed (DNS-only). Expect a higher bounce rate; keep volume low and watch the first sends.');

  // 3. accounts connected + healthy
  const real = c.accounts.filter((a) => a.provider !== 'sandbox'), sandbox = c.accounts.filter((a) => a.provider === 'sandbox');
  const bad = c.accounts.filter((a) => !canSend(a));
  add('accounts', 'Sending accounts', !c.accounts.length || bad.length ? 'fail' : 'pass',
    !c.accounts.length ? 'No sending account selected.' : bad.length ? `Not ready: ${bad.map((a) => `${a.email} (${a.paused ? 'paused' : a.status})`).join(', ')}.` : `${c.accounts.length} account(s) connected and passing checks.`);
  if (sandbox.length && real.length) add('sandbox_mix', 'Sandbox isolation', 'fail', 'Sandbox and real accounts are mixed in one campaign; simulated and real results would be indistinguishable to recipients of this report.');
  else if (sandbox.length) add('sandbox', 'Simulation mode', 'warn', 'This campaign uses only sandbox accounts: no email will actually be sent and all metrics will be flagged as simulated.');

  // 4. domain authentication
  const domains = [...new Set(real.map((a) => domainOf(a.email)))];
  const domProblems = [];
  for (const d of domains) {
    const row = get('SELECT * FROM domains WHERE name = ?', d);
    const res = j(row?.last_result);
    if (!res) { domProblems.push(`${d}: never checked`); continue; }
    for (const key of ['spf', 'dkim', 'dmarc']) {
      const ch = res.checks.find((x) => x.key === key);
      if (!ch || ch.status === 'fail' || ch.status === 'unknown') domProblems.push(`${d}: ${key.toUpperCase()} ${ch?.status === 'fail' ? 'failing' : 'unverified'}`);
    }
    if (res.checks.find((x) => x.key === 'blocklist')?.status === 'fail') domProblems.push(`${d}: on a blocklist`);
    if ((Date.now() - Date.parse(row.last_checked_at)) / 36e5 > 48) domProblems.push(`${d}: last checked more than 48h ago`);
  }
  if (real.length) add('domains', 'Domain authentication', domProblems.length ? 'fail' : 'pass', domProblems.length ? domProblems.join('; ') + '.' : `SPF, DKIM and DMARC verified for ${domains.join(', ')}. (Authentication only; not a guarantee of inbox placement.)`);

  // 5. duplicates
  const dup = all(`SELECT l.email, COUNT(*) n FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE cl.campaign_id = ? GROUP BY l.email HAVING n > 1`, id);
  const elsewhere = leads.length ? get(`SELECT COUNT(DISTINCT cl.lead_id) n FROM campaign_leads cl JOIN campaigns c2 ON c2.id = cl.campaign_id
     WHERE c2.status = 'active' AND c2.id != ? AND cl.status IN ('pending','active') AND cl.lead_id IN (SELECT lead_id FROM campaign_leads WHERE campaign_id = ?)`, id, id).n : 0;
  add('duplicates', 'Duplicate recipients', dup.length ? 'fail' : elsewhere ? 'warn' : 'pass',
    dup.length ? `${dup.length} duplicate recipient(s).` : elsewhere ? `No duplicates here, but ${elsewhere} lead(s) are also in another active campaign and will receive both sequences.` : 'Every recipient appears once.');

  // 6. unsubscribed / suppressed
  const suppressed = leads.filter((l) => isSuppressed(l.email));
  add('suppression', 'Unsubscribed & suppressed', suppressed.length ? 'fail' : 'pass',
    suppressed.length ? `${suppressed.length} recipient(s) are unsubscribed, bounced or suppressed and must be removed.` : 'No unsubscribed or suppressed contacts in the list.',
    { lead_ids: suppressed.map((l) => l.id), action: suppressed.length ? 'remove' : null });

  // 7. sequence + content
  const stepProblems = [], lintProblems = [], lintWarn = [];
  const customKeys = all('SELECT key FROM custom_fields').map((r) => r.key);
  const known = [...LEAD_VARS, ...SENDER_VARS, ...customKeys];
  if (!c.steps.length) stepProblems.push('sequence has no steps');
  c.steps.forEach((s, i) => {
    if (!s.variants.length) stepProblems.push(`step ${i + 1} has no email`);
    if (i > 0 && s.delay_days < 1) stepProblems.push(`step ${i + 1} must wait at least 1 day after the previous step`);
    for (const v of s.variants) {
      if (!v.body.trim()) stepProblems.push(`step ${i + 1} variant ${v.label} has an empty body`);
      if (i === 0 && !v.subject.trim()) stepProblems.push(`step 1 variant ${v.label} has no subject`);
      const lint = lintEmail(v, known);
      for (const is of lint.issues) (is.severity === 'error' ? lintProblems : is.severity === 'warn' ? lintWarn : []).push(`step ${i + 1}${s.variants.length > 1 ? v.label : ''}: ${is.message}`);
    }
    if (s.variants.length && !s.variants.some((v) => v.weight > 0)) stepProblems.push(`step ${i + 1}: all variants have weight 0`);
  });
  const pendingAi = get(`SELECT COUNT(*) n FROM ai_drafts d JOIN variants v ON v.id = d.variant_id JOIN steps s ON s.id = v.step_id WHERE s.campaign_id = ? AND d.status = 'pending'`, id).n;
  if (pendingAi) lintProblems.push(`${pendingAi} AI-generated draft(s) for this campaign are awaiting your review`);
  add('sequence', 'Email sequence', stepProblems.length ? 'fail' : 'pass', stepProblems.length ? stepProblems.join('; ') + '.' : `${c.steps.length} step(s), ${c.steps.reduce((n, s) => n + s.variants.length, 0)} email variant(s).`);
  add('content', 'Content checks', lintProblems.length ? 'fail' : lintWarn.length ? 'warn' : 'pass',
    lintProblems.length ? lintProblems.join('; ') + '.' : lintWarn.length ? `${lintWarn.length} warning(s): ${lintWarn.slice(0, 4).join('; ')}${lintWarn.length > 4 ? '…' : ''}.` : 'No blocking content issues found by the heuristic checks.');

  // 8. personalisation populated for every recipient
  const missing = {};
  const acct = c.accounts[0] ?? {};
  for (const s of c.steps) for (const v of s.variants) {
    const needs = extractVariables(`${v.subject}\n${v.body}`).filter((x) => !x.hasFallback);
    if (!needs.length) continue;
    for (const l of leads) {
      const r = render(`${v.subject}\n${v.body}`, leadContext(l, acct));
      for (const m of r.missing) (missing[m] ??= new Set()).add(l.id);
    }
  }
  const mKeys = Object.keys(missing);
  add('personalisation', 'Personalisation variables', mKeys.length ? 'fail' : 'pass',
    mKeys.length ? mKeys.map((k) => `{{${k}}} is empty for ${missing[k].size} lead(s)`).join('; ') + '. Fill the field, add a fallback like {{' + mKeys[0] + '|there}}, or remove those leads.' : 'Every variable resolves for every recipient (or has a fallback).',
    { lead_ids: [...new Set(mKeys.flatMap((k) => [...missing[k]]))] });

  // 9. limits
  const capacity = c.accounts.filter(canSend).reduce((n, a) => n + effectiveDailyLimit(a), 0);
  const zero = c.accounts.filter((a) => effectiveDailyLimit(a) < 1);
  add('limits', 'Sending limits', zero.length ? 'fail' : c.daily_limit > capacity && c.accounts.length ? 'warn' : c.accounts.length ? 'pass' : 'fail',
    zero.length ? `${zero.map((a) => a.email).join(', ')} has a daily limit of 0.` : !c.accounts.length ? 'No accounts to compute capacity from.'
      : c.daily_limit > capacity ? `Campaign limit is ${c.daily_limit}/day but the selected accounts can only send ${capacity}/day today; sending will be capped at ${capacity}.` : `Campaign limit ${c.daily_limit}/day is within account capacity (${capacity}/day). Account limits are shared across all campaigns.`);

  // 10. schedule
  const sched = validateSchedule(c);
  add('schedule', 'Sending schedule', sched.length ? 'fail' : 'pass', sched.length ? sched.join('; ') + '.' : `${c.window_start}–${c.window_end} ${c.timezone}, days ${c.days}, ${c.min_interval}–${c.max_interval}s random gap per inbox.`);

  // 11. compliance
  add('compliance', 'Compliance footer', real.length && !config.postalAddress ? 'warn' : 'pass',
    real.length && !config.postalAddress ? 'An unsubscribe link is added automatically, but no physical postal address is configured (SENDER_POSTAL_ADDRESS). CAN-SPAM requires one in commercial email.' : 'Unsubscribe link and List-Unsubscribe header are added to every email.');
  if (real.length && /localhost|127\.0\.0\.1/.test(config.publicUrl)) add('public_url', 'Tracking & unsubscribe URL', 'fail', `PUBLIC_URL is ${config.publicUrl}: recipients cannot reach it, so unsubscribe links would be broken. Set PUBLIC_URL to an internet-reachable address before sending real email.`);

  const blocking = items.filter((i) => i.blocking);
  return { campaign_id: id, ready: blocking.length === 0, blocking: blocking.length, warnings: items.filter((i) => i.status === 'warn').length, items, checked_at: new Date().toISOString(), simulated: sandbox.length > 0 && !real.length };
}
