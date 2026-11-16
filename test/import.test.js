import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, fakeDns, lead } from './_helpers.js';
import { parseFile, guessMapping, stageImport, commitImport } from '../src/leads/import.js';
import { get, run, now } from '../src/db.js';

beforeEach(() => { freshDb(); fakeDns({ 'good.test/MX': [{ priority: 1, exchange: 'mx.good.test' }], 'mailinator.com/MX': [{ priority: 1, exchange: 'mx.m.com' }], 'flaky.test/MX': 'ERR' }); });
const CSV = `Email,First Name,Company,Industry,Last Updated
jane@good.test,Jane,Good Co,SaaS,${new Date().toISOString().slice(0, 10)}
JANE@good.test,Jane,Good Co,SaaS,
bad-email,Bob,Bad Co,,
,NoEmail,None Co,,
tom@nodomain.test,Tom,Nowhere,,
info@good.test,Info,Good Co,,
x@mailinator.com,Temp,Temp Co,,
old@good.test,Old,N/A,,2019-01-01
exists@good.test,Ex,Good Co,,
blocked@good.test,Bl,Good Co,,
maybe@flaky.test,May,Flaky,,
`;
async function stage() {
  const rows = await parseFile(Buffer.from(CSV), 'leads.csv');
  return stageImport({ rows, mapping: guessMapping(Object.keys(rows[0])), filename: 'leads.csv', tags: ['q3'] });
}
test('header mapping guesses core and custom fields', async () => {
  const m = guessMapping(['Email', 'First Name', 'Company', 'Industry', 'Last Updated']);
  assert.deepEqual(m, { Email: 'email', 'First Name': 'first_name', Company: 'company', Industry: 'custom:industry', 'Last Updated': 'source_date' });
});
test('staging produces a validation report and inserts NOTHING', async () => {
  lead('exists@good.test');
  run("INSERT INTO suppressions (value, kind, reason, created_at) VALUES ('blocked@good.test','email','unsubscribe',?)", now());
  const before = get('SELECT COUNT(*) n FROM leads').n;
  const { report, records } = await stage();
  assert.equal(get('SELECT COUNT(*) n FROM leads').n, before, 'no rows committed during staging');
  const c = report.counts;
  assert.equal(c.total, 11);
  assert.equal(c.duplicate_in_file, 1);
  assert.equal(c.duplicate_existing, 1);
  assert.equal(c.suppressed, 1);
  assert.equal(c.invalid_domain, 1);
  assert.equal(c.domain_unchecked, 1);
  assert.equal(c.rejected, 6); // dup-in-file, bad syntax, missing email, invalid domain, existing, suppressed
  assert.equal(c.importable, 5);
  const by = (e) => records.find((r) => r.record.email === e && !r.errors.some((x) => /duplicate of row/.test(x)));
  assert.deepEqual(by('info@good.test').flags, ['role_based']);
  assert.deepEqual(by('x@mailinator.com').flags, ['disposable']);
  assert.ok(by('old@good.test').flags.includes('possibly_outdated'));
  assert.ok(by('old@good.test').flags.includes('malformed_company'));
  assert.ok(by('maybe@flaky.test').flags.includes('domain_unchecked'));
  assert.match(records.find((r) => r.row === 4).errors[0], /invalid email syntax/);
  assert.match(records.find((r) => r.row === 5).errors[0], /missing required field/);
});
test('commit inserts only clean rows, keeps flags, leaves them unverified, and cannot run twice', async () => {
  const { id } = await stage();
  const r = commitImport(id);
  assert.equal(r.inserted, 7);
  const jane = get("SELECT * FROM leads WHERE email = 'jane@good.test'");
  assert.equal(jane.verification_status, 'unverified');
  assert.equal(JSON.parse(jane.custom).industry, 'SaaS');
  assert.deepEqual(JSON.parse(jane.tags), ['q3']);
  assert.equal(get("SELECT COUNT(*) n FROM leads WHERE email = 'tom@nodomain.test'").n, 0);
  assert.throws(() => commitImport(id), /already committed/);
});
test('required-field configuration rejects rows missing that field', async () => {
  const rows = await parseFile(Buffer.from('email,first name\na@good.test,\nb@good.test,Bee\n'), 'x.csv');
  const { report } = await stageImport({ rows, mapping: guessMapping(Object.keys(rows[0])), required: ['email', 'first_name'] });
  assert.equal(report.counts.rejected, 1); assert.equal(report.counts.importable, 1);
});
