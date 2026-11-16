import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, fakeDns, lead, sandboxAccount, campaign, GOOD_ZONE } from './_helpers.js';
import { createApp } from '../src/server.js';
import { get, run, all } from '../src/db.js';
import { transport } from '../src/engine/transport.js';

let server, base, cookie = '';
const call = async (method, path, body, headers = {}) => {
  const raw = body instanceof Buffer;
  const res = await fetch(base + path, { method, redirect: 'manual', headers: { cookie, 'x-requested-with': 'outbound-os', ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...headers }, body: raw ? body : body ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
};
before(async () => { freshDb(); fakeDns({ 'good.test/MX': [{ priority: 1, exchange: 'mx.good.test' }] }); server = createApp().listen(0); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());

test('auth: API is closed until setup + login; weak passwords rejected; setup cannot be repeated', async () => {
  assert.equal((await call('GET', '/api/leads')).status, 401);
  assert.equal((await call('GET', '/api/session')).json.needs_setup, true);
  assert.equal((await call('POST', '/api/setup', { email: 'me@example.com', password: 'short' })).status, 400);
  assert.equal((await call('POST', '/api/setup', { email: 'me@example.com', password: 'correct horse battery' })).status, 201);
  assert.match(cookie, /^sid=/);
  assert.equal((await call('POST', '/api/setup', { email: 'x@example.com', password: 'another long password' })).status, 409);
  assert.equal((await call('GET', '/api/leads')).status, 200);
  assert.equal((await call('POST', '/api/leads', { email: 'a@good.test' }, { 'x-requested-with': '' })).status, 403, 'state-changing calls need the custom header');
  const saved = cookie; cookie = '';
  assert.equal((await call('POST', '/api/login', { email: 'me@example.com', password: 'wrong' })).status, 401);
  assert.equal((await call('POST', '/api/login', { email: 'me@example.com', password: 'correct horse battery' })).status, 200);
  assert.notEqual(cookie, saved);
  assert.equal(get('SELECT COUNT(*) n FROM sessions').n, 2); assert.doesNotMatch(get('SELECT password_hash h FROM users').h, /correct horse/);
});
test('leads: create validates, duplicates are refused, editing the email resets verification, bulk tag + filter work', async () => {
  assert.equal((await call('POST', '/api/leads', { email: 'nope' })).status, 422);
  const made = await call('POST', '/api/leads', { email: 'Jane@Good.test', first_name: 'Jane', company: 'Good', custom: { Industry: 'SaaS' }, tags: ['vip'] });
  assert.equal(made.status, 201); assert.equal(made.json.email, 'jane@good.test'); assert.equal(made.json.verification_status, 'unverified');
  assert.equal((await call('POST', '/api/leads', { email: 'jane@good.test' })).status, 409);
  run("UPDATE leads SET verification_status = 'valid', verification_checked_at = '2026-01-01' WHERE id = ?", made.json.id);
  const ed = await call('PATCH', `/api/leads/${made.json.id}`, { email: 'jane2@good.test' });
  assert.equal(ed.json.verification_status, 'unverified'); assert.equal(ed.json.verification_checked_at, null);
  await call('POST', '/api/leads/bulk', { ids: [made.json.id], action: 'add_tags', tags: ['q3'] });
  assert.equal((await call('GET', '/api/leads?tag=q3')).json.total, 1);
  assert.equal((await call('GET', '/api/leads?custom_key=industry&custom_value=saas')).json.total, 1);
  assert.equal((await call('GET', '/api/leads?q=nobody')).json.total, 0);
  const v = await call('POST', '/api/verify', { email: 'jane2@good.test' });
  assert.equal(v.json.status, 'unknown', 'ad-hoc verification without SMTP probing never reports valid');
});
test('import over HTTP: parse -> stage (report) -> commit', async () => {
  const csv = Buffer.from('Email,First Name\nnew1@good.test,N1\nnew1@good.test,Dup\nbroken,No\n');
  const parsed = await call('POST', '/api/imports/parse?filename=l.csv', csv, { 'content-type': 'text/csv' });
  assert.equal(parsed.json.rows, 3); assert.equal(parsed.json.mapping.Email, 'email');
  const staged = await call('POST', `/api/imports/stage?filename=l.csv&options=${encodeURIComponent(JSON.stringify({ mapping: parsed.json.mapping }))}`, csv, { 'content-type': 'text/csv' });
  assert.equal(staged.status, 201); assert.deepEqual([staged.json.report.counts.importable, staged.json.report.counts.rejected], [1, 2]);
  assert.equal(get("SELECT COUNT(*) n FROM leads WHERE email = 'new1@good.test'").n, 0);
  assert.equal((await call('POST', `/api/imports/${staged.json.id}/commit`)).json.inserted, 1);
  assert.equal((await call('POST', `/api/imports/${staged.json.id}/commit`)).status, 409);
  assert.match((await call('GET', `/api/imports/${staged.json.id}/errors.csv`)).text, /invalid email syntax/);
});
test('campaign over HTTP: launch is refused with the checklist, then succeeds; tracking + unsubscribe links work end to end', async () => {
  const a = sandboxAccount('s@sandbox.test'), l = lead('rcpt@x.test');
  const c = (await call('POST', '/api/campaigns', { name: 'HTTP test' })).json;
  const refused = await call('POST', `/api/campaigns/${c.id}/launch`);
  assert.equal(refused.status, 422); assert.equal(refused.json.readiness.ready, false);
  await call('PUT', `/api/campaigns/${c.id}`, { account_ids: [a.id], window_start: '00:00', window_end: '23:59', days: [0, 1, 2, 3, 4, 5, 6], min_interval: 30, max_interval: 30,
    steps: [{ variants: [{ subject: 'Idea for {{company}}', body: 'Hi {{first_name}}, worth a look? https://example.com/x' }] }] });
  assert.deepEqual((await call('POST', `/api/campaigns/${c.id}/leads`, { lead_ids: [l.id, l.id] })).json, { added: 1, already_in_campaign: 1, suppressed: 0, missing: 0 });
  const prev = await call('POST', `/api/campaigns/${c.id}/preview`, { step: 0 });
  assert.equal(prev.json.subject, 'Idea for Acme');
  assert.equal((await call('POST', `/api/campaigns/${c.id}/launch`)).json.launched, true);
  let html;
  const orig = transport.deliver; transport.deliver = async (acct, mail) => { html = mail.html; return {}; };
  assert.equal((await call('POST', '/api/engine/tick', {})).json.sent, 1);
  transport.deliver = orig;
  const click = html.match(/\/c\/[\w-]+/)[0], unsub = html.match(/\/u\/[\w-]+/)[0];
  const saved = cookie; cookie = ''; // recipients are anonymous
  const r1 = await call('GET', click, null, { 'user-agent': 'Mozilla/5.0 Chrome' });
  assert.equal(r1.status, 302); assert.equal(r1.headers.get('location'), 'https://example.com/x');
  run("UPDATE messages SET created_at = '2026-01-01T00:00:00Z'"); // an old send: a later click is treated as human
  await call('GET', click, null, { 'user-agent': 'Mozilla/5.0 Chrome' });
  await call('GET', click, null, { 'user-agent': 'Proofpoint URL Defense scanner' });
  assert.equal((await call('GET', unsub)).status, 200);
  assert.equal(get("SELECT COUNT(*) n FROM suppressions").n, 0, 'a GET (link scanner) must not unsubscribe anyone');
  assert.match((await call('POST', unsub)).text, /You are unsubscribed/);
  assert.equal((await call('GET', '/c/bogus')).status, 404);
  cookie = saved;
  assert.equal(get("SELECT reason FROM suppressions WHERE value = 'rcpt@x.test'").reason, 'unsubscribe');
  const s = (await call('GET', '/api/analytics/summary?mode=sandbox')).json;
  assert.deepEqual([s.measured.sent, s.measured.clicks, s.measured.suspected_bot_clicks, s.measured.unique_clickers, s.measured.unsubscribes], [1, 1, 2, 1, 1]);
  assert.equal(s.rates.click_rate, 100);
  assert.equal((await call('GET', '/api/analytics/summary')).json.measured.sent, 0, 'sandbox activity never appears in real analytics');
  assert.match((await call('GET', '/api/analytics/export.csv?mode=sandbox&by=campaign')).text, /SIMULATED \(sandbox\)/);
  assert.equal((await call('POST', `/api/campaigns/${c.id}/leads`, { lead_ids: [l.id] })).json.suppressed, 1, 'an unsubscribed lead cannot be re-added');
  const l2 = lead('rcpt2@x.test'); run("INSERT INTO suppressions (value, kind, reason, created_at) VALUES ('rcpt2@x.test','email','manual','x')");
  assert.equal((await call('POST', `/api/campaigns/${c.id}/leads`, { lead_ids: [l2.id] })).json.suppressed, 1);
  const dash = (await call('GET', '/api/dashboard?mode=sandbox')).json;
  assert.equal(dash.campaigns[0].simulated, true); assert.equal(dash.series.length, 30);
  assert.equal((await call('POST', '/api/sandbox/inbound', { message_id: all("SELECT id FROM messages WHERE direction='out'")[0].id, text: 'Interested, lets talk' })).json.label, 'interested');
  assert.equal((await call('GET', '/api/inbox/threads?mode=sandbox')).json.length, 1);
  assert.equal((await call('GET', '/api/inbox/threads')).json.length, 0);
});
test('errors do not leak internals; unknown routes 404', async () => {
  assert.equal((await call('GET', '/api/nope')).status, 404);
  const r = await call('POST', '/api/leads', Buffer.from('{bad json'), { 'content-type': 'application/json' });
  assert.equal(r.status, 400); assert.doesNotMatch(r.text, /node_modules|at /);
});

test('accounts: CSV import (Instantly layout) connects valid rows, skips bad ones, and never returns or stores passwords in the clear', async () => {
  const { testers } = await import('../src/accounts/service.js');
  testers.smtp = async () => {}; testers.imap = async () => {};
  fakeDns({ ...GOOD_ZONE('mail-a.test'), ...GOOD_ZONE('mail-b.test') });
  const csv = [
    'Email,First Name,Last Name,IMAP Username,IMAP Password,IMAP Host,IMAP Port,SMTP Username,SMTP Password,SMTP Host,SMTP Port,Daily Limit,Warmup Enabled,Warmup Limit,Warmup Increment',
    'one@mail-a.test,One,A,one@mail-a.test,S3cret!one,imap.host.test,993,one@mail-a.test,S3cret!one,smtp.host.test,465,5,true,20–25,3',
    'two@mail-b.test,Two,B,two@mail-b.test,S3cret!two,imap.host.test,993,two@mail-b.test,S3cret!two,smtp.host.test,587,,true,20–25,3',
    'ONE@mail-a.test,Dup,A,x,S3cret!dup,imap.host.test,993,x,S3cret!dup,smtp.host.test,465,5,true,,3',
    'not-an-email,Bad,B,x,pw,imap.host.test,993,x,pw,smtp.host.test,465,5,,,',
    'nopw@mail-a.test,No,Pw,x,,imap.host.test,993,x,,smtp.host.test,465,5,,,',
  ].join('\n');
  const body = Buffer.from(csv);
  const pv = await call('POST', '/api/accounts/import/preview?filename=a.csv', body);
  assert.equal(pv.status, 200); assert.equal(pv.json.rows, 5);
  assert.equal(pv.json.accounts.filter((a) => !a.error).length, 2);
  assert.doesNotMatch(pv.text, /S3cret/, 'preview must not echo passwords');
  assert.equal(get('SELECT COUNT(*) n FROM accounts WHERE email LIKE \'%@mail-%\'').n, 0, 'preview must not save anything');

  const r = await call('POST', '/api/accounts/import?filename=a.csv', body);
  assert.equal(r.status, 201); assert.equal(r.json.created, 2); assert.equal(r.json.failed, 3);
  assert.doesNotMatch(r.text, /S3cret/, 'result must not echo passwords');
  assert.match(r.json.results.find((x) => x.line === 4).error, /Duplicate/);
  assert.match(r.json.results.find((x) => x.line === 5).error, /Invalid email/);
  assert.match(r.json.results.find((x) => x.line === 6).error, /No password/);
  assert.equal(r.json.results.find((x) => x.line === 2).status, 'healthy');
  const a1 = get("SELECT * FROM accounts WHERE email = 'one@mail-a.test'"), a2 = get("SELECT * FROM accounts WHERE email = 'two@mail-b.test'");
  assert.equal(a1.smtp_secure, 1); assert.equal(a1.smtp_port, 465); assert.equal(a1.daily_limit, 5); assert.equal(a1.from_name, 'One A'); assert.equal(a1.warmup_enabled, 0);
  assert.equal(a2.smtp_secure, 0); assert.equal(a2.daily_limit, 30, 'missing daily limit falls back to the default');
  assert.doesNotMatch(String(a1.secret_enc), /S3cret/, 'password is encrypted at rest');
  assert.ok(!JSON.stringify((await call('GET', '/api/accounts')).json).includes('S3cret'));
  // Importing the same file again connects nothing new.
  const again = await call('POST', '/api/accounts/import?filename=a.csv', body);
  assert.equal(again.json.created, 0); assert.match(again.json.results.find((x) => x.line === 2).error, /already connected/);
  assert.equal((await call('POST', '/api/accounts/import?filename=a.csv', Buffer.alloc(0))).status, 400);
  assert.equal((await call('GET', '/api/accounts/import/template.csv')).status, 200);
  cookie = ''; assert.equal((await call('POST', '/api/accounts/import?filename=a.csv', body)).status, 401);
});
