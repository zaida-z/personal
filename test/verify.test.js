import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, fakeDns } from './_helpers.js';
import { checkSyntax, verifyEmail, meetsThreshold } from '../src/verify/engine.js';

beforeEach(() => freshDb());
const mx = (d) => ({ [`${d}/MX`]: [{ priority: 1, exchange: `mx.${d}` }] });
const probe = (target, random) => async () => ({ completed: true, target: target && { code: target[0], text: target[1] }, random: random && { code: random[0], text: random[1] } });

test('syntax: accepts normal addresses, rejects malformed ones', () => {
  for (const ok of ['a@b.co', 'first.last+tag@sub.example.com', "o'neil@example.org", 'USER@Example.COM']) assert.equal(checkSyntax(ok).ok, true, ok);
  for (const bad of ['', 'plain', '@x.com', 'a@', 'a@@b.com', 'a b@c.com', '.a@b.com', 'a..b@c.com', 'a.@b.com', 'a@b', 'a@-b.com', 'a@b..com', 'a@b.123', 'x'.repeat(65) + '@b.com']) assert.equal(checkSyntax(bad).ok, false, bad);
  assert.equal(checkSyntax(' USER@Example.COM ').email, 'user@example.com');
});
test('invalid syntax -> invalid without touching DNS', async () => {
  fakeDns({});
  const r = await verifyEmail('not-an-email');
  assert.equal(r.status, 'invalid'); assert.equal(r.checks.dns, 'not_run');
});
test('no MX and no A -> invalid; null MX -> invalid', async () => {
  fakeDns({ 'nullmx.test/MX': [{ priority: 0, exchange: '' }] });
  assert.equal((await verifyEmail('a@nodomain.test')).status, 'invalid');
  assert.equal((await verifyEmail('a@nullmx.test')).status, 'invalid');
});
test('DNS failure is unknown, never invalid or valid', async () => {
  fakeDns({ 'flaky.test/MX': 'ERR' });
  const r = await verifyEmail('a@flaky.test');
  assert.equal(r.status, 'unknown'); assert.equal(r.checks.dns, 'error');
});
test('disposable and role-based are classified', async () => {
  fakeDns({ ...mx('mailinator.com'), ...mx('corp.test') });
  assert.equal((await verifyEmail('x@mailinator.com')).status, 'disposable');
  assert.equal((await verifyEmail('x@sub.mailinator.com')).status, 'invalid'); // subdomain has no MX in fixture
  assert.equal((await verifyEmail('info@corp.test', { probe: null })).status, 'role_based');
});
test('HONESTY: without an SMTP probe a deliverable-looking address is "unknown", never "valid"', async () => {
  fakeDns(mx('corp.test'));
  const r = await verifyEmail('jane@corp.test', { probe: null });
  assert.equal(r.status, 'unknown');
  assert.equal(r.checks.smtp, 'skipped');
  assert.match(r.reasons.join(' '), /not confirmed/i);
  assert.ok(r.checked_at);
});
test('SMTP probe outcomes map to the right status', async () => {
  fakeDns({ ...mx('corp.test'), 'yahoo.test/MX': [{ priority: 1, exchange: 'mta5.am0.yahoodns.net' }] });
  const v = (p, e = 'jane@corp.test') => verifyEmail(e, { probe: p });
  assert.equal((await v(probe([250, 'ok'], [550, 'no such user']))).status, 'valid');
  assert.equal((await v(probe([250, 'ok'], [250, 'ok']))).status, 'catch_all');
  assert.equal((await v(probe([550, '5.1.1 user unknown'], null))).status, 'invalid');
  assert.equal((await v(probe([552, 'mailbox full'], null))).status, 'risky');
  assert.equal((await v(probe([451, 'greylisted'], null))).status, 'unknown');
  assert.equal((await v(probe([554, 'blocked by spam policy'], null))).status, 'unknown');
  assert.equal((await v(probe([250, 'ok'], null))).status, 'unknown'); // catch-all test incomplete
  assert.equal((await v(async () => ({ completed: false, error: 'timeout' }))).status, 'unknown');
  assert.equal((await v(probe([250, 'ok'], [550, 'no']), 'sales@corp.test')).status, 'role_based');
  assert.equal((await v(probe([250, 'ok'], [550, 'no']), 'jane@yahoo.test')).status, 'risky'); // accept-then-bounce provider
});
test('typo domains are risky with a suggestion', async () => {
  fakeDns(mx('gmial.com'));
  const r = await verifyEmail('jane@gmial.com', { probe: null });
  assert.equal(r.status, 'risky'); assert.match(r.reasons[0], /gmail\.com/);
});
test('thresholds: unverified and stale results never pass', () => {
  const base = { verification_status: 'valid', verification_checked_at: new Date().toISOString(), verification_detail: '{"checks":{"mx":"pass"}}' };
  assert.equal(meetsThreshold(base, 'valid').ok, true);
  assert.equal(meetsThreshold({ ...base, verification_checked_at: null }, 'valid').ok, false);
  assert.equal(meetsThreshold({ ...base, verification_status: 'catch_all' }, 'valid').ok, false);
  assert.equal(meetsThreshold({ ...base, verification_status: 'catch_all' }, 'valid_catchall').ok, true);
  assert.equal(meetsThreshold({ ...base, verification_status: 'unknown' }, 'dns_verified').ok, true);
  assert.equal(meetsThreshold({ ...base, verification_status: 'unknown', verification_detail: '{"checks":{"dns":"error"}}' }, 'dns_verified').ok, false);
  assert.equal(meetsThreshold({ ...base, verification_status: 'invalid' }, 'dns_verified').ok, false);
  assert.equal(meetsThreshold({ ...base, verification_checked_at: new Date(Date.now() - 100 * 864e5).toISOString() }, 'valid').ok, false);
});
