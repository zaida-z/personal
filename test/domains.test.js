import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, fakeDns, GOOD_ZONE } from './_helpers.js';
import { checkSpf, checkDkim, checkDmarc, checkDomain, checkBlocklists, ensureDomain, runDomainCheck } from '../src/domains/health.js';
import { get, all, logEvent } from '../src/db.js';

beforeEach(() => freshDb());
const spf = async (...recs) => { fakeDns({ 'd.test/TXT': recs, 'i1.test/TXT': ['v=spf1 include:i2.test -all'], 'i2.test/TXT': ['v=spf1 a mx -all'] }); return checkSpf('d.test'); };

test('SPF: missing, multiple, +all, too many lookups, weak, good', async () => {
  assert.equal((await spf()).status, 'fail');
  assert.equal((await spf('v=spf1 -all', 'v=spf1 ~all')).status, 'fail');
  assert.equal((await spf('v=spf1 +all')).status, 'fail');
  assert.equal((await spf('v=spf1 include:i1.test ?all')).status, 'warn');
  const many = await spf('v=spf1 ' + Array.from({ length: 11 }, (_, i) => `include:x${i}.test`).join(' ') + ' -all');
  assert.equal(many.status, 'fail'); assert.match(many.detail, /11 DNS lookups/);
  const good = await spf('v=spf1 include:i1.test ~all');
  assert.equal(good.status, 'pass'); assert.equal(good.lookups, 4); // i1 + i2 + a + mx
  assert.ok((await spf()).fix, 'failing checks carry a recommended fix');
});
test('SPF: "all" inside an include hostname is not mistaken for the all mechanism (found on first live DNS run)', async () => {
  fakeDns({ 'd.test/TXT': ['v=spf1 include:spf.firewall.test include:mail-all.test -all'], 'spf.firewall.test/TXT': ['v=spf1 ip4:192.0.2.0/24 -all'], 'mail-all.test/TXT': ['v=spf1 ip4:198.51.100.0/24 -all'] });
  assert.equal((await checkSpf('d.test')).status, 'pass');
  fakeDns({ 'd.test/TXT': ['v=spf1 include:spf.firewall.test'], 'spf.firewall.test/TXT': ['v=spf1 ip4:192.0.2.0/24 -all'] });
  assert.equal((await checkSpf('d.test')).status, 'warn');
});

test('DMARC: missing fails, p=none warns, enforced passes', async () => {
  fakeDns({}); assert.equal((await checkDmarc('d.test')).status, 'fail');
  fakeDns({ '_dmarc.d.test/TXT': ['v=DMARC1; p=none'] }); assert.equal((await checkDmarc('d.test')).status, 'warn');
  fakeDns({ '_dmarc.d.test/TXT': ['v=DMARC1; p=reject; rua=mailto:x@d.test'] }); assert.equal((await checkDmarc('d.test')).status, 'pass');
  fakeDns({ '_dmarc.d.test/TXT': 'ERR' }); assert.equal((await checkDmarc('d.test')).status, 'unknown');
});
test('DKIM: not found under common selectors is "unknown" (unverifiable), a missing user-named selector is "fail"', async () => {
  fakeDns({});
  assert.equal((await checkDkim('d.test')).status, 'unknown');
  assert.equal((await checkDkim('d.test', ['mysel'])).status, 'fail');
  fakeDns(GOOD_ZONE('d.test'));
  const ok = await checkDkim('d.test');
  assert.equal(ok.status, 'pass'); assert.match(ok.detail, /not that outgoing mail is being signed/);
});
test('blocklists: listed fails, refused resolvers are unknown rather than clean', async () => {
  fakeDns({ 'd.test.dbl.spamhaus.org/A': ['127.0.1.2'] });
  assert.equal((await checkBlocklists('d.test')).status, 'fail');
  fakeDns({ 'd.test.dbl.spamhaus.org/A': ['127.255.255.254'], 'd.test.multi.surbl.org/A': ['127.0.0.1'], 'd.test.multi.uribl.com/A': ['127.0.0.1'] });
  assert.equal((await checkBlocklists('d.test')).status, 'unknown');
});
test('a fully authenticated domain is healthy and still never claims inbox placement', async () => {
  fakeDns(GOOD_ZONE('d.test'));
  const r = await checkDomain('d.test');
  assert.equal(r.status, 'healthy'); assert.ok(r.score >= 85 && r.score < 100, `score ${r.score} leaves room for unmeasured bounce/complaint data`);
  assert.match(r.disclaimer, /does not measure inbox placement/);
  assert.ok(r.unverified.includes('reputation'));
  assert.doesNotMatch(JSON.stringify(r), /inbox[- ]safe/i);
});
test('a critical failure caps the score, marks the domain unhealthy, alerts, and records history', async () => {
  const zone = GOOD_ZONE('d.test'); delete zone['_dmarc.d.test/TXT'];
  fakeDns(zone);
  const d = ensureDomain('d.test');
  const r = await runDomainCheck(d.id);
  assert.equal(r.status, 'unhealthy'); assert.ok(r.score <= 49); assert.deepEqual(r.critical, ['dmarc']);
  assert.equal(all("SELECT * FROM alerts WHERE entity_type = 'domain' AND resolved_at IS NULL").length, 1);
  fakeDns(GOOD_ZONE('d.test'));
  await runDomainCheck(d.id);
  assert.equal(all("SELECT * FROM alerts WHERE resolved_at IS NULL").length, 0, 'alert resolves when the domain recovers');
  assert.equal(get('SELECT COUNT(*) n FROM domain_checks WHERE domain_id = ?', d.id).n, 2);
});
test('unreachable DNS yields "unverified", not healthy', async () => {
  fakeDns({ 'd.test/TXT': 'ERR', 'd.test/MX': 'ERR', '_dmarc.d.test/TXT': 'ERR' });
  assert.equal((await checkDomain('d.test')).status, 'unverified');
});
test('measured bounce rate above 5% makes the domain unhealthy', async () => {
  fakeDns(GOOD_ZONE('d.test'));
  for (let i = 0; i < 40; i++) logEvent('sent', { domain: 'd.test' });
  for (let i = 0; i < 4; i++) logEvent('bounce_hard', { domain: 'd.test' });
  for (let i = 0; i < 50; i++) logEvent('bounce_hard', { domain: 'd.test', simulated: true }); // sandbox data must not count
  const r = await checkDomain('d.test');
  assert.equal(r.checks.find((c) => c.key === 'bounce_rate').status, 'fail'); assert.equal(r.metrics.bounce_hard, 4); assert.equal(r.status, 'unhealthy');
});
