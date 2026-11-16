// Creates a SANDBOX rehearsal data set so the dashboard, inbox and analytics can be explored
// without sending anything. Everything it creates is flagged simulated and only appears when
// the UI is switched to "Sandbox". Demo leads use the reserved .example TLD.
import crypto from 'node:crypto';
import { db, run, get, all, now, logEvent } from '../src/db.js';
import { launchCampaign, tick } from '../src/engine/scheduler.js';
import { processInbound } from '../src/inbox/sync.js';

db();
if (get("SELECT 1 x FROM accounts WHERE email = 'demo@sandbox.example'")) { console.log('Demo data already present.'); process.exit(0); }
const DAYS = 14, start = new Date(Date.now() - DAYS * 864e5); start.setUTCHours(9, 0, 0, 0);
const t = now();
const acct = (email, name) => Number(run("INSERT INTO accounts (email, from_name, provider, daily_limit, status, created_at) VALUES (?,?,'sandbox',25,'sandbox',?)", email, name, t).lastInsertRowid);
const a1 = acct('demo@sandbox.example', 'Demo Sender'), a2 = acct('demo2@sandbox.example', 'Demo Sender');
const first = ['Ava', 'Noah', 'Mia', 'Liam', 'Zoe', 'Omar', 'Ines', 'Kofi', 'Yuki', 'Lena', 'Ravi', 'Sara'], cos = ['Northwind', 'Globex', 'Initech', 'Umbra', 'Hooli', 'Vandelay', 'Stark', 'Wonka', 'Acme', 'Soylent'];
const detail = JSON.stringify({ checks: { mx: 'pass', demo: 'seeded' }, reasons: ['Demo data: this status was assigned by the seed script, not by a real verification.'] });
const ids = [];
for (let i = 0; i < 120; i++) {
  const f = first[i % first.length], c = cos[i % cos.length];
  ids.push(Number(run(`INSERT INTO leads (email, first_name, company, title, source, tags, verification_status, verification_confidence, verification_checked_at, verification_detail, created_at, updated_at)
    VALUES (?,?,?,?,'demo-seed','["demo"]','valid',0.95,?,?,?,?)`, `${f.toLowerCase()}.${i}@${c.toLowerCase()}.example`, f, c, ['Head of Ops', 'CTO', 'Founder', 'VP Sales'][i % 4], t, detail, t, t).lastInsertRowid));
}
const cid = Number(run(`INSERT INTO campaigns (name, timezone, window_start, window_end, days, daily_limit, min_interval, max_interval, created_at) VALUES ('Demo: ops leaders (sandbox)','UTC','00:00','23:59','0,1,2,3,4,5,6',40,60,120,?)`, t).lastInsertRowid);
const steps = [[0, 'Idea for {{company}}', 'Hi {{first_name}},\n\nHow does {{company}} handle onboarding handoffs today? We put together a short walkthrough of how teams cut the back-and-forth: https://example.com/walkthrough\n\nWorth a look?', 'question about {{company}} onboarding', 'Hi {{first_name}},\n\nQuick one: is onboarding handoff something {{company}} is actively working on this quarter? If so, this may be useful: https://example.com/walkthrough'],
  [3, '', 'Hi {{first_name}}, did my note about onboarding handoffs land with the right person at {{company}}?'], [4, '', 'Hi {{first_name}}, I will leave it here. If handoffs become a priority, the walkthrough is at https://example.com/walkthrough']];
steps.forEach(([delay, subj, body, subjB, bodyB], i) => {
  const sid = Number(run('INSERT INTO steps (campaign_id, position, delay_days) VALUES (?,?,?)', cid, i, delay).lastInsertRowid);
  run("INSERT INTO variants (step_id, label, subject, body) VALUES (?,'A',?,?)", sid, subj, body);
  if (subjB) run("INSERT INTO variants (step_id, label, subject, body) VALUES (?,'B',?,?)", sid, subjB, bodyB);
});
for (const a of [a1, a2]) run('INSERT INTO campaign_accounts (campaign_id, account_id) VALUES (?,?)', cid, a);
for (const id of ids) run('INSERT INTO campaign_leads (campaign_id, lead_id, added_at) VALUES (?,?,?)', cid, id, t);
launchCampaign(cid, 'seed');
run('UPDATE campaign_leads SET next_send_at = ? WHERE campaign_id = ?', start.toISOString(), cid);

const replies = [['Sounds interesting, can you send over more info?', 6], ['Not interested, thanks.', 5], ['Please remove me from your list.', 2], ['Happy to chat. Are you free next Tuesday?', 4], ['Who is the right person to speak to about pricing?', 3], ['I am out of the office until Monday.', 3]];
let handled = 0;
for (let d = 0; d < DAYS; d++) {
  for (let m = 0; m < 8 * 60; m += 3) await tick(new Date(start.getTime() + d * 864e5 + m * 60e3));
  // Simulated outcomes for messages sent on this simulated day.
  const fresh = all("SELECT m.*, a.id aid FROM messages m JOIN accounts a ON a.id = m.account_id WHERE m.direction = 'out' AND m.id > ? ORDER BY m.id", handled);
  for (const msg of fresh) {
    handled = msg.id;
    const acc = get('SELECT * FROM accounts WHERE id = ?', msg.account_id), roll = crypto.randomInt(1000), at = new Date(Date.parse(msg.created_at) + (1 + crypto.randomInt(20)) * 3600e3).toISOString();
    if (Date.parse(at) > Date.now()) continue;
    if (roll < 25) await processInbound(acc, { simulated: true, date: at, raw: msg.rfc_id, bounce: { recipient: msg.to_addr, status: roll < 18 ? '5.1.1' : '4.2.2', diagnostic: 'simulated bounce' } });
    else if (roll < 105) { const pick = replies[crypto.randomInt(replies.reduce((n, r) => n + r[1], 0)) % replies.length]; await processInbound(acc, { simulated: true, date: at, from: msg.to_addr, subject: `Re: ${msg.subject}`, text: pick[0], inReplyTo: msg.rfc_id, rfcId: `<${crypto.randomUUID()}@sandbox.invalid>` }); }
    else if (roll < 190 && get('SELECT 1 x FROM links WHERE message_id = ?', msg.id)) logEvent('click', { campaign_id: msg.campaign_id, lead_id: msg.lead_id, account_id: msg.account_id, message_id: msg.id, step_id: msg.step_id, variant_id: msg.variant_id, simulated: true, at, meta: { bot: roll > 170 ? 1 : 0, url: 'https://example.com/walkthrough' } });
  }
}
for (const m of all("SELECT * FROM messages WHERE direction = 'in' AND classification = 'interested' LIMIT 3")) logEvent('meeting_booked', { campaign_id: m.campaign_id, lead_id: m.lead_id, account_id: m.account_id, simulated: true, at: m.created_at, meta: { marked_by: 'seed' } });
const n = (q) => get(q).n;
console.log(`Sandbox demo created: ${n("SELECT COUNT(*) n FROM messages WHERE direction='out'")} simulated sends, ${n("SELECT COUNT(*) n FROM messages WHERE direction='in'")} simulated replies. Switch the UI to "Sandbox" to see it. No email was sent.`);
