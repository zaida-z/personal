import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, fakeDns, GOOD_ZONE, lead, sandboxAccount, campaign } from './_helpers.js';
import { readiness } from '../src/campaigns/readiness.js';
import { launchCampaign, tick, inWindow } from '../src/engine/scheduler.js';
import { transport } from '../src/engine/transport.js';
import { processInbound } from '../src/inbox/sync.js';
import { summary, breakdown } from '../src/analytics/metrics.js';
import { checkAccount, effectiveDailyLimit, testers } from '../src/accounts/service.js';
import { ensureDomain, runDomainCheck } from '../src/domains/health.js';
import { all, get, run, now } from '../src/db.js';

const realDeliver = transport.deliver;
let sent;
beforeEach(() => { freshDb(); sent = []; transport.deliver = async (account, mail) => { sent.push({ account: account.email, ...mail }); return { simulated: account.provider === 'sandbox' }; }; });
const item = (r, key) => r.items.find((i) => i.key === key);
const T0 = new Date('2026-03-02T10:00:00Z'); // a Monday
const plus = (d, min = 0) => new Date(T0.getTime() + d * 864e5 + min * 60e3);

test('readiness: an empty draft is blocked on every prerequisite', () => {
  const cid = campaign({ steps: [{ delay: 0, subject: '', body: '' }] });
  const r = readiness(cid);
  assert.equal(r.ready, false);
  for (const k of ['leads', 'verification', 'accounts', 'sequence', 'limits']) assert.equal(item(r, k).status, 'fail', k);
  assert.throws(() => launchCampaign(cid), /not ready/);
  assert.equal(get('SELECT status FROM campaigns WHERE id = ?', cid).status, 'draft');
});
test('readiness: unverified, suppressed and un-personalisable leads each block launch', () => {
  const a = sandboxAccount();
  const ok = lead('ok@x.test'), unv = lead('unv@x.test', { verified: false }), catchall = lead('ca@x.test', { status: 'catch_all' }), sup = lead('sup@x.test'), noname = lead('nn@x.test', { first_name: '' });
  run("UPDATE leads SET first_name = NULL WHERE id = ?", noname.id);
  run("INSERT INTO suppressions (value, kind, reason, created_at) VALUES ('sup@x.test','email','unsubscribe',?)", now());
  const cid = campaign({ accounts: [a], leads: [ok, unv, catchall, sup, noname] });
  const r = readiness(cid);
  assert.equal(r.ready, false);
  assert.deepEqual(item(r, 'verification').lead_ids.sort(), [unv.id, catchall.id].sort());
  assert.deepEqual(item(r, 'suppression').lead_ids, [sup.id]);
  assert.match(item(r, 'personalisation').detail, /\{\{first_name\}\} is empty for 1 lead/);
  assert.equal(item(r, 'sandbox').status, 'warn');
  // Fix each problem -> ready.
  run('DELETE FROM campaign_leads WHERE lead_id IN (?,?,?,?)', unv.id, catchall.id, sup.id, noname.id);
  assert.equal(readiness(cid).ready, true);
});
test('readiness: content errors (unknown variable, fake Re:, shortener) block; fallbacks satisfy personalisation', () => {
  const a = sandboxAccount(), l = lead('a@x.test');
  run('UPDATE leads SET first_name = NULL WHERE id = ?', l.id);
  let cid = campaign({ accounts: [a], leads: [l], steps: [{ delay: 0, subject: 'Re: our chat', body: 'Hi {{frist_name}}, see https://bit.ly/x' }] });
  const r = readiness(cid);
  assert.equal(item(r, 'content').status, 'fail');
  assert.match(item(r, 'content').detail, /Unknown variable \{\{frist_name\}\}/); assert.match(item(r, 'content').detail, /fakes a reply/); assert.match(item(r, 'content').detail, /shorteners/);
  cid = campaign({ accounts: [a], leads: [l], steps: [{ delay: 0, subject: 'Idea', body: 'Hi {{first_name|there}}, {{#if title}}as {{title}} {{/if}}worth a chat about {{company}}?' }] });
  assert.equal(readiness(cid).ready, true);
});
test('readiness: a real account needs a healthy status and verified SPF/DKIM/DMARC; failing accounts are never shown healthy', async () => {
  testers.smtp = async () => {}; testers.imap = async () => {};
  const zone = GOOD_ZONE('corp.test'); delete zone['corp.test/TXT'];
  fakeDns(zone);
  const id = Number(run("INSERT INTO accounts (email, provider, smtp_host, smtp_port, smtp_secure, imap_host, secret_enc, created_at) VALUES ('me@corp.test','smtp','smtp.corp.test',587,0,'imap.corp.test','x',?)", now()).lastInsertRowid);
  let res = await checkAccount(id);
  assert.equal(res.status, 'failing'); assert.equal(res.checks.find((c) => c.key === 'spf').status, 'fail');
  const cid = campaign({ accounts: [get('SELECT * FROM accounts WHERE id = ?', id)], leads: [lead('a@x.test')] });
  let r = readiness(cid);
  assert.equal(item(r, 'accounts').status, 'fail'); assert.match(item(r, 'domains').detail, /SPF failing/);
  fakeDns(GOOD_ZONE('corp.test'));
  res = await checkAccount(id);
  assert.equal(res.status, 'healthy');
  r = readiness(cid);
  assert.equal(item(r, 'accounts').status, 'pass'); assert.equal(item(r, 'domains').status, 'pass');
  assert.equal(item(r, 'compliance').status, 'warn'); // no postal address configured
  assert.equal(r.ready, true);
  // SMTP auth failure flips it back and raises an alert.
  testers.smtp = async () => { throw Object.assign(new Error('535 Invalid login'), { code: 'EAUTH' }); };
  res = await checkAccount(id);
  assert.equal(res.status, 'failing'); assert.equal(readiness(cid).ready, false);
  assert.ok(get("SELECT 1 x FROM alerts WHERE entity_type = 'account' AND resolved_at IS NULL"));
  assert.ok(get("SELECT 1 x FROM events WHERE type = 'auth_failure'"));
});
test('sending window respects time zone and weekday', () => {
  const c = { timezone: 'America/New_York', window_start: '09:00', window_end: '17:00', days: '1,2,3,4,5' };
  assert.equal(inWindow(c, new Date('2026-03-02T15:00:00Z')), true);  // Mon 10:00 EST
  assert.equal(inWindow(c, new Date('2026-03-02T12:00:00Z')), false); // Mon 07:00 EST
  assert.equal(inWindow(c, new Date('2026-03-01T15:00:00Z')), false); // Sunday
});
test('engine: sends step 1, spaces sends per inbox, threads the follow-up after the delay, then completes', async () => {
  const a = sandboxAccount(), l1 = lead('one@x.test'), l2 = lead('two@x.test', { first_name: 'Bo' });
  const cid = campaign({ accounts: [a], leads: [l1, l2] });
  launchCampaign(cid);
  run('UPDATE campaign_leads SET next_send_at = ? WHERE campaign_id = ?', T0.toISOString(), cid);
  assert.deepEqual(await tick(T0), { sent: 1, blocked: 0, failed: 0 }, 'one email per inbox per tick');
  assert.equal((await tick(plus(0, 0.2))).sent, 0, 'inbox is cooling down (random interval)');
  assert.equal((await tick(plus(0, 1))).sent, 1);
  assert.equal(sent[0].subject, 'Quick idea for Acme'); assert.match(sent[0].text, /^Hi Ada,/);
  assert.match(sent[0].text, /unsubscribe here: https:\/\/track\.example\.test\/u\//);
  assert.match(sent[0].headers['List-Unsubscribe'], /^<https:\/\/track\.example\.test\/u\//);
  assert.match(sent[0].html, /href="https:\/\/track\.example\.test\/c\//, 'links are click-tracked in HTML');
  assert.match(sent[0].text, /https:\/\/example\.com\/demo/, 'plain-text part keeps the real URL');
  assert.equal((await tick(plus(2))).sent, 0, 'follow-up is not due before day 3');
  assert.equal((await tick(plus(3, 2))).sent, 1);
  const fu = sent[2];
  assert.equal(fu.subject, 'Re: Quick idea for Acme'); assert.equal(fu.inReplyTo, sent.find((m) => m.to === fu.to).messageId);
  await tick(plus(3, 4));
  assert.equal(sent.length, 4);
  assert.deepEqual(all('SELECT status FROM campaign_leads WHERE campaign_id = ?', cid).map((r) => r.status), ['completed', 'completed']);
  await tick(plus(3, 6));
  assert.equal(get('SELECT status FROM campaigns WHERE id = ?', cid).status, 'completed');
});
test('engine: campaign and account daily limits and warm-up ramp are enforced', async () => {
  const a = sandboxAccount('a@s.test', { daily_limit: 2 }), b = sandboxAccount('b@s.test', { daily_limit: 100 });
  const leads = Array.from({ length: 8 }, (_, i) => lead(`l${i}@x.test`));
  const cid = campaign({ accounts: [a, b], leads, daily_limit: 5, steps: [{ delay: 0, subject: 'Hi', body: 'Hello {{first_name}}, open to a chat?' }] });
  launchCampaign(cid); run('UPDATE campaign_leads SET next_send_at = ? WHERE campaign_id = ?', T0.toISOString(), cid);
  for (let m = 0; m < 20; m++) await tick(plus(0, m));
  assert.equal(sent.length, 5, 'campaign daily limit');
  assert.equal(sent.filter((m) => m.account === 'a@s.test').length, 2, 'account daily limit');
  for (let m = 0; m < 10; m++) await tick(plus(1, m));
  assert.equal(sent.length, 8, 'remaining leads go out the next day');
  const acct = { daily_limit: 40, warmup_enabled: 1, warmup_start: 5, warmup_increment: 3, warmup_started_at: T0.toISOString() };
  assert.equal(effectiveDailyLimit(acct, T0.getTime()), 5); assert.equal(effectiveDailyLimit(acct, plus(4).getTime()), 17); assert.equal(effectiveDailyLimit(acct, plus(60).getTime()), 40);
});
test('engine pre-send gate: a lead suppressed or invalidated AFTER launch is not emailed', async () => {
  const a = sandboxAccount(), l1 = lead('late-unsub@x.test'), l2 = lead('went-bad@x.test'), l3 = lead('fine@x.test');
  const cid = campaign({ accounts: [a], leads: [l1, l2, l3] });
  launchCampaign(cid); run('UPDATE campaign_leads SET next_send_at = ? WHERE campaign_id = ?', T0.toISOString(), cid);
  run("INSERT INTO suppressions (value, kind, reason, created_at) VALUES ('late-unsub@x.test','email','unsubscribe',?)", now());
  run("UPDATE leads SET verification_status = 'invalid' WHERE id = ?", l2.id);
  for (let m = 0; m < 5; m++) await tick(plus(0, m));
  assert.deepEqual(sent.map((m) => m.to), ['fine@x.test']);
  assert.equal(get('SELECT status FROM campaign_leads WHERE lead_id = ?', l1.id).status, 'unsubscribed');
  assert.match(get('SELECT skip_reason FROM campaign_leads WHERE lead_id = ?', l2.id).skip_reason, /verification/);
  assert.equal(get("SELECT COUNT(*) n FROM events WHERE type = 'blocked'").n, 2);
});
test('replies stop the sequence; unsubscribe replies suppress; hard bounces suppress and invalidate; unrelated mail is ignored', async () => {
  const a = sandboxAccount(), ls = ['r@x.test', 'u@x.test', 'b@x.test', 'q@x.test'].map((e) => lead(e));
  const cid = campaign({ accounts: [a], leads: ls });
  launchCampaign(cid); run('UPDATE campaign_leads SET next_send_at = ? WHERE campaign_id = ?', T0.toISOString(), cid);
  for (let m = 0; m < 6; m++) await tick(plus(0, m));
  const out = (e) => get("SELECT * FROM messages WHERE to_addr = ? AND direction = 'out'", e);
  const inbound = (e, text, extra = {}) => processInbound(a, { simulated: true, from: e, subject: 'Re: hi', text, inReplyTo: out(e).rfc_id, rfcId: `<${e}-${Math.random()}@m>`, ...extra });
  assert.equal((await inbound('r@x.test', 'Sounds good, tell me more. Can we book a call?')).label, 'interested');
  assert.equal((await inbound('u@x.test', 'Please remove me from your list.')).label, 'unsubscribe_request');
  assert.equal((await processInbound(a, { simulated: true, raw: `Original: ${out('b@x.test').rfc_id}`, bounce: { recipient: 'b@x.test', status: '5.1.1', diagnostic: '550 user unknown' } })).hard, true);
  assert.equal((await inbound('q@x.test', 'I am out of the office until Monday.', { auto: true })).label, 'auto_reply');
  assert.equal((await processInbound(a, { from: 'stranger@else.test', subject: 'hello', text: 'unrelated' })).kind, 'ignored');
  assert.equal(get("SELECT COUNT(*) n FROM messages WHERE from_addr = 'stranger@else.test'").n, 0, 'unrelated mail is never stored');
  const st = Object.fromEntries(all('SELECT l.email, cl.status FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id').map((r) => [r.email, r.status]));
  assert.deepEqual(st, { 'r@x.test': 'replied', 'u@x.test': 'unsubscribed', 'b@x.test': 'bounced', 'q@x.test': 'active' });
  assert.deepEqual(all('SELECT value, reason FROM suppressions ORDER BY value').map((r) => ({ ...r })), [{ value: 'b@x.test', reason: 'bounce' }, { value: 'u@x.test', reason: 'unsubscribe' }]);
  assert.equal(get("SELECT verification_status s FROM leads WHERE email = 'b@x.test'").s, 'invalid');
  const before = sent.length;
  for (let m = 0; m < 6; m++) await tick(plus(3, m));
  assert.deepEqual(sent.slice(before).map((m) => m.to), ['q@x.test'], 'only the auto-reply lead gets the follow-up');

  // Analytics: sandbox numbers exist only in sandbox mode; real mode is empty.
  const real = summary({ mode: 'real' }), sim = summary({ mode: 'sandbox' });
  assert.equal(real.measured.sent, 0);
  assert.deepEqual([sim.measured.sent, sim.measured.replies, sim.measured.positive_replies, sim.measured.hard_bounces, sim.measured.unsubscribes, sim.measured.auto_replies], [5, 2, 1, 1, 1, 1]);
  assert.equal(sim.estimated.delivered, 4); assert.match(sim.estimated.note, /not "reached the inbox"/);
  assert.equal(sim.rates.reply_rate, 50);
  assert.equal(breakdown({ mode: 'sandbox' }, 'campaign')[0].measured.sent, 5);
  assert.equal(breakdown({ mode: 'sandbox' }, 'domain')[0].name, 'sandbox.test');
});
test('A/B: each lead gets a stable variant and both arms are used', async () => {
  const a = sandboxAccount('a@s.test', { daily_limit: 500 }), leads = Array.from({ length: 30 }, (_, i) => lead(`l${i}@x.test`));
  const cid = campaign({ accounts: [a], leads, daily_limit: 500, steps: [{ delay: 0, variants: [{ subject: 'Subject A', body: 'Hi {{first_name}}, version A?' }, { subject: 'Subject B', body: 'Hi {{first_name}}, version B?' }] }] });
  launchCampaign(cid); run('UPDATE campaign_leads SET next_send_at = ? WHERE campaign_id = ?', T0.toISOString(), cid);
  for (let m = 0; m < 40; m++) await tick(plus(0, m));
  const n = (s) => sent.filter((m) => m.subject === s).length;
  assert.equal(sent.length, 30); assert.ok(n('Subject A') >= 8 && n('Subject B') >= 8, `A=${n('Subject A')} B=${n('Subject B')}`);
  assert.equal(breakdown({ mode: 'sandbox' }, 'variant').length, 2);
});
test('circuit breaker pauses a campaign whose hard-bounce rate exceeds 8%', async () => {
  const a = sandboxAccount('a@s.test', { daily_limit: 500 }), leads = Array.from({ length: 30 }, (_, i) => lead(`l${i}@x.test`));
  const cid = campaign({ accounts: [a], leads, daily_limit: 500, steps: [{ delay: 0, subject: 'Hi', body: 'Hello {{first_name}}, open to a chat?' }] });
  launchCampaign(cid); run('UPDATE campaign_leads SET next_send_at = ? WHERE campaign_id = ?', T0.toISOString(), cid);
  for (let m = 0; m < 22; m++) await tick(plus(0, m));
  for (const m of all("SELECT * FROM messages WHERE direction = 'out' LIMIT 3")) await processInbound(a, { simulated: true, raw: m.rfc_id, bounce: { recipient: m.to_addr, status: '5.1.1' } });
  await tick(plus(0, 30));
  assert.equal(get('SELECT status FROM campaigns WHERE id = ?', cid).status, 'paused');
  assert.match(get("SELECT message FROM alerts WHERE entity_type = 'campaign'").message, /hard bounce rate/);
  assert.equal(sent.length, 22);
});
test('transport failure: SMTP recipient rejection is recorded as a measured hard bounce', async () => {
  const a = sandboxAccount(), l = lead('gone@x.test');
  const cid = campaign({ accounts: [a], leads: [l] });
  launchCampaign(cid); run('UPDATE campaign_leads SET next_send_at = ? WHERE campaign_id = ?', T0.toISOString(), cid);
  transport.deliver = async () => { throw Object.assign(new Error('550 5.1.1 Recipient address rejected: user unknown'), { responseCode: 550 }); };
  assert.equal((await tick(T0)).failed, 1);
  assert.equal(get('SELECT status FROM campaign_leads WHERE lead_id = ?', l.id).status, 'bounced');
  assert.ok(get("SELECT 1 x FROM suppressions WHERE value = 'gone@x.test'"));
  transport.deliver = realDeliver;
});
