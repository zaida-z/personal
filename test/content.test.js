import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './_helpers.js';
import { lintEmail, extractVariables } from '../src/ai/lint.js';
import { render } from '../src/campaigns/render.js';
import { verifyClaims, draftOpeningLine, fetcher, ai, generateVariations } from '../src/ai/assistant.js';
import { classifyHeuristic } from '../src/inbox/sync.js';
import { lead } from './_helpers.js';
import { get, all } from '../src/db.js';
import { decideDraft } from '../src/ai/assistant.js';

beforeEach(() => freshDb());
test('render: variables, fallbacks, conditionals, and missing-variable reporting', () => {
  const ctx = { first_name: 'Ada', company: '', title: 'CTO' };
  assert.deepEqual(render('Hi {{first_name}} at {{company|your company}}{{#if title}}, {{title}}{{else}}!{{/if}}', ctx), { text: 'Hi Ada at your company, CTO', missing: [] });
  assert.deepEqual(render('{{#if company}}About {{company}}. {{else}}No co. {{/if}}Bye {{nickname}}', ctx), { text: 'No co. Bye ', missing: ['nickname'] });
  assert.deepEqual(extractVariables('{{a}} {{b|x}} {{#if c}}{{c}}{{/if}}'), [{ name: 'a', hasFallback: false }, { name: 'b', hasFallback: true }, { name: 'c', hasFallback: true }]);
});
test('lint: flags spam phrases, generic filler, unsupported claims, fake replies and broken placeholders', () => {
  const r = lintEmail({ subject: 'RE: ACT NOW!!', body: 'I hope this email finds you well. We guarantee 300% growth, click here: https://bit.ly/a https://x.co/b. Hi [First Name] {name}' }, ['first_name']);
  const codes = new Set(r.issues.map((i) => i.code));
  for (const c of ['spam_phrase', 'generic', 'unsupported_claim', 'fake_reply', 'shortener', 'links', 'broken_placeholder', 'punctuation']) assert.ok(codes.has(c), c);
  assert.equal(r.verdict, 'blocked');
  const clean = lintEmail({ subject: 'question about onboarding', body: 'Hi {{first_name}},\n\nI noticed onboarding docs are a common pain for teams your size. Would it be useful if I sent over a two-minute walkthrough of how we approach it?\n\nThanks' }, ['first_name']);
  assert.equal(clean.verdict, 'ok'); assert.match(clean.note, /does not predict inbox placement/);
});
test('reply classifier: opt-outs win, quoted text is ignored', () => {
  assert.equal(classifyHeuristic('Not interested, please remove me.'), 'unsubscribe_request');
  assert.equal(classifyHeuristic('No thanks, we already use something.'), 'not_interested');
  assert.equal(classifyHeuristic('Sure, send over more info.'), 'interested');
  assert.equal(classifyHeuristic("I'm no longer with the company, reach out to Sam."), 'wrong_person');
  assert.equal(classifyHeuristic('Who is this?\n\nOn Mon, 2 Mar 2026 at 10:00, X wrote:\n> are you interested in a call?'), 'question');
});
test('traceability: only claims whose quote is verbatim in the source survive', () => {
  const src = 'Acme builds  scheduling software for dental clinics. Founded in Leeds.';
  const { verified, rejected } = verifyClaims([{ statement: 's', quote: 'scheduling software for dental clinics' }, { statement: 'x', quote: 'raised a $20M Series B' }, { statement: 'y', quote: 'Acme' }], src);
  assert.equal(verified.length, 1); assert.equal(rejected.length, 2);
});
test('opening line: fabricated evidence is discarded; verified drafts are saved as pending and only applied on approval', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const l = lead('a@acme.test', { website: 'https://acme.test' });
  fetcher.page = async () => ({ url: 'https://acme.test/', fetched_at: 'now', text: 'Acme builds scheduling software for dental clinics across the UK. '.repeat(5) });
  let reply;
  const calls = [];
  ai.client = () => ({ messages: { parse: async (req) => { calls.push(req); return { stop_reason: 'end_turn', parsed_output: reply }; } } });
  reply = { sufficient_evidence: true, opening_line: 'Congrats on the $20M raise!', claims: [{ statement: 'raised', quote: 'raised a $20M Series B last month' }] };
  let out = await draftOpeningLine(l);
  assert.equal(out.usable, false); assert.match(out.sources.verification, /does not appear on the page/);
  assert.equal(get('SELECT COUNT(*) n FROM ai_drafts').n, 0);
  reply = { sufficient_evidence: true, opening_line: 'Saw that Acme builds scheduling software for dental clinics.', claims: [{ statement: 'what they do', quote: 'scheduling software for dental clinics across the UK' }] };
  out = await draftOpeningLine(l);
  assert.equal(out.usable, true); assert.equal(out.sources.url, 'https://acme.test/');
  assert.equal(calls[0].model, 'claude-opus-5-5'); assert.ok(calls[0].output_config.format); assert.match(calls[0].messages[0].content, /<page url=/);
  assert.equal(get('SELECT status FROM ai_drafts WHERE id = ?', out.id).status, 'pending');
  assert.equal(JSON.parse(get('SELECT custom FROM leads WHERE id = ?', l.id).custom).opening_line, undefined, 'not applied before approval');
  decideDraft(out.id, 'approve');
  assert.match(JSON.parse(get('SELECT custom FROM leads WHERE id = ?', l.id).custom).opening_line, /dental clinics/);
  assert.throws(() => decideDraft(out.id, 'reject'), /already approved/);
  reply = { variations: [{ subject: 's', body: 'We guarantee results, {{first_name}}!' }] };
  const vars = await generateVariations({ subject: 'x', body: 'y', variables: ['first_name'] });
  assert.ok(vars[0].lint.issues.some((i) => i.code === 'spam_phrase'), 'AI output is linted before review');
  ai.client = () => ({ messages: { parse: async () => ({ stop_reason: 'refusal', parsed_output: null }) } });
  await assert.rejects(() => generateVariations({ subject: 'x', body: 'y' }), /declined/);
  delete process.env.ANTHROPIC_API_KEY;
  await assert.rejects(() => generateVariations({ subject: 'x', body: 'y' }), /not configured/);
});
