import { h, set, api, toast, act, modal, field, fmt, badge, barChart, lineChart, meter } from '/ui.js';
import { state, route, modeToggle, simBanner, pageHead } from '/app.js';

const mq = () => `mode=${state.mode}`;

// ---------------- campaigns list ----------------
export async function campaignsPage(main) {
  const list = await api('GET', '/campaigns');
  set(main, pageHead('Campaigns', 'A campaign can only be activated once every item on its readiness checklist passes.',
    h('button', { class: 'primary', onclick: act(async () => { const name = prompt('Campaign name'); if (!name) return; const c = await api('POST', '/campaigns', { name, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }); location.hash = `#/campaigns/${c.id}`; }) }, 'New campaign')),
    list.length ? h('div', { class: 'card', style: 'padding:0' }, h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ['Campaign', 'Status', 'Progress', 'Leads', 'Sent', 'Replies', 'Clickers', 'Bounces', ''].map((t, i) => h('th', { class: i > 2 && i < 8 ? 'num' : '' }, t)))),
      h('tbody', null, list.map((c) => h('tr', null, h('td', null, h('a', { href: `#/campaigns/${c.id}` }, h('b', null, c.name)), c.simulated ? h('span', null, ' ', badge('sandbox', 'simulated')) : null), h('td', null, badge(c.status)), h('td', { style: 'min-width:150px' }, meter(c.progress_pct, 'sequence progress')),
        h('td', { class: 'num' }, fmt.n(c.leads)), h('td', { class: 'num' }, fmt.n(c.stats.measured.sent)), h('td', { class: 'num' }, fmt.n(c.stats.measured.replies)), h('td', { class: 'num' }, fmt.n(c.stats.measured.unique_clickers)), h('td', { class: 'num' }, fmt.n(c.stats.measured.bounces)),
        h('td', null, h('div', { class: 'row' }, h('button', { class: 'sm', onclick: act(async () => { const n = await api('POST', `/campaigns/${c.id}/duplicate`); toast('Duplicated without leads'); location.hash = `#/campaigns/${n.id}`; }) }, 'Duplicate'),
          h('button', { class: 'sm danger', onclick: act(async () => { if (confirm(`Delete "${c.name}"?`)) { await api('DELETE', `/campaigns/${c.id}`); route(); } }) }, 'Delete')))))))))
      : h('div', { class: 'card empty' }, 'No campaigns yet.'));
}

// ---------------- campaign builder ----------------
let tab = 'sequence';
export async function campaignPage(main, id) {
  const [c, accounts] = await Promise.all([api('GET', `/campaigns/${id}`), api('GET', '/accounts')]);
  const reload = () => route();
  const save = async (patch) => { const r = await api('PUT', `/campaigns/${id}`, patch); if (r.paused_for_revalidation) toast('Email content changed on a live campaign: it has been paused. Review the checklist and resume.', true); return r; };
  const body = h('div');
  const tabs = [['sequence', 'Sequence'], ['leads', `Leads (${Object.values(c.lead_counts).reduce((a, b) => a + b, 0)})`], ['settings', 'Schedule & accounts'], ['launch', 'Readiness & launch']];
  set(main, pageHead(c.name, null, badge(c.status), h('a', { href: '#/campaigns' }, '← All campaigns')),
    h('div', { class: 'tabs' }, tabs.map(([k, l]) => h('button', { class: tab === k ? 'active' : '', onclick: () => { tab = k; reload(); } }, l))), body);
  ({ sequence: seqTab, leads: leadsTab, settings: settingsTab, launch: launchTab })[tab](body, c, { accounts, save, reload });
}

function seqTab(body, c, { save, reload }) {
  const steps = c.steps.map((s) => ({ id: s.id, delay_days: s.delay_days, condition: s.condition, variants: s.variants.map((v) => ({ id: v.id, subject: v.subject, body: v.body, weight: v.weight })) }));
  const vars = ['first_name', 'last_name', 'company', 'title', 'website', 'sender_name', 'sender_first_name', ...state.system.custom_fields.map((f) => f.key)];
  const draw = () => {
    let day = 1;
    set(body, h('div', { class: 'banner info small' }, 'Variables: ', vars.map((v) => h('span', { class: 'tag mono' }, `{{${v}}}`)), h('div', { style: 'margin-top:4px' }, 'Fallback: ', h('span', { class: 'mono' }, '{{first_name|there}}'), ' · Conditional: ', h('span', { class: 'mono' }, '{{#if title}}As {{title}}, {{/if}}'), ' · An unsubscribe link is appended automatically. Leave a follow-up subject empty to reply in the same thread.')),
      steps.map((s, si) => { day += si ? Number(s.delay_days) || 0 : 0;
        return h('div', { class: 'step' }, h('div', { class: 'row', style: 'margin-bottom:10px' }, h('b', null, `Step ${si + 1} · Day ${day}`),
          si ? h('span', { class: 'row' }, 'wait', h('input', { type: 'number', min: 1, style: 'width:64px', value: s.delay_days, onchange: (e) => { s.delay_days = Number(e.target.value); draw(); } }), 'day(s) after the previous step,') : h('span', { class: 'muted' }, 'sent when the lead enters the campaign'),
          si ? h('select', { onchange: (e) => { s.condition = { type: e.target.value, field: e.target.value === 'if_field' ? prompt('Send only when this lead field has a value (e.g. opening_line)') || 'company' : undefined }; draw(); } },
            [['always', 'send to everyone who has not replied'], ['if_not_clicked', 'only if no link was clicked'], ['if_clicked', 'only if a link was clicked'], ['if_field', `only if a field is set${s.condition.field ? ' (' + s.condition.field + ')' : ''}`]].map(([v, l]) => h('option', { value: v, selected: s.condition.type === v }, l))) : null,
          h('span', { class: 'right row' }, s.variants.length < 5 ? h('button', { class: 'sm', onclick: () => { s.variants.push({ subject: s.variants[0].subject, body: s.variants[0].body, weight: 1 }); draw(); } }, '+ A/B variant') : null,
            steps.length > 1 ? h('button', { class: 'sm danger', onclick: () => { steps.splice(si, 1); draw(); } }, 'Remove step') : null)),
        h('div', { class: 'grid ' + (s.variants.length > 1 ? 'g2' : '') }, s.variants.map((v, vi) => variantEditor(v, vi, s, si, draw, c))));
      }),
      h('div', { class: 'row' }, steps.length < 12 ? h('button', { onclick: () => { steps.push({ delay_days: 3, condition: { type: 'always' }, variants: [{ subject: '', body: '', weight: 1 }] }); draw(); } }, '+ Add follow-up step') : null,
        h('button', { class: 'primary', onclick: act(async () => { await save({ steps }); toast('Sequence saved'); reload(); }) }, 'Save sequence')));
  };
  draw();
}
function variantEditor(v, vi, s, si, draw, c) {
  const lintBox = h('div');
  const runLint = async () => { try { const r = await api('POST', '/ai/lint', v);
    set(lintBox, h('div', { class: 'small muted' }, `${r.words} words · content checks: `, badge(r.verdict === 'ok' ? 'pass' : r.verdict === 'blocked' ? 'fail' : 'warn', r.verdict.replace(/_/g, ' '))), r.issues.map((i) => h('div', { class: 'issue ' + i.severity }, (i.severity === 'error' ? '✕ ' : i.severity === 'warn' ? '! ' : '· ') + i.message))); } catch { /* ignore */ } };
  let t; const debounce = () => { clearTimeout(t); t = setTimeout(runLint, 500); };
  const subject = h('input', { style: 'width:100%', value: v.subject, placeholder: si ? 'Empty = reply in the same thread' : 'Subject', oninput: (e) => { v.subject = e.target.value; debounce(); } });
  const text = h('textarea', { oninput: (e) => { v.body = e.target.value; debounce(); } }, v.body);
  const aiOn = state.system.ai.enabled;
  const aiBtn = (label, fn) => h('button', { class: 'sm', disabled: !aiOn, title: aiOn ? '' : 'Set ANTHROPIC_API_KEY to enable', onclick: act(fn) }, label);
  runLint();
  return h('div', null, h('div', { class: 'row', style: 'margin-bottom:6px' }, s.variants.length > 1 ? [h('b', null, `Variant ${String.fromCharCode(65 + vi)}`), 'weight', h('input', { type: 'number', min: 0, style: 'width:60px', value: v.weight, onchange: (e) => { v.weight = Number(e.target.value); } }),
    h('button', { class: 'sm danger right', onclick: () => { s.variants.splice(vi, 1); draw(); } }, 'Remove')] : null),
    subject, h('div', { style: 'height:6px' }), text,
    h('div', { class: 'row', style: 'margin:6px 0' },
      aiBtn('Suggest subjects', async () => { const r = await api('POST', '/ai/subjects', v); pick('Subject suggestions', r.subjects.map((x) => ({ subject: x, body: v.body })), (p) => { v.subject = p.subject; draw(); }, 'subject'); }),
      aiBtn('Rewrite tone', async () => { const tone = prompt('Tone (e.g. friendly and direct, formal, concise)', 'friendly and direct'); if (!tone) return; const r = await api('POST', '/ai/rewrite', { ...v, tone }); pick('Rewrite', [r], (p) => { v.subject = p.subject; v.body = p.body; draw(); }); }),
      aiBtn('Generate A/B variations', async () => { const r = await api('POST', '/ai/variations', { ...v, count: 2 }); pick('Variations', r.variations, (p) => { if (s.variants.length < 5) s.variants.push({ subject: p.subject, body: p.body, weight: 1 }); draw(); }); }),
      aiBtn('AI review', async () => { const r = await api('POST', '/ai/review', v); const sec = (title, items, f) => items.length ? h('div', { style: 'margin-bottom:10px' }, h('h3', null, title), items.map((i) => h('div', { class: 'issue warn' }, h('b', null, `"${i.text}"`), ' — ', f(i)))) : null;
        modal('AI review', h('div', null, h('p', null, r.summary), sec('Unsupported claims', r.unsupported_claims, (i) => i.why), sec('Personalisation problems', r.personalisation_errors, (i) => i.why), sec('Generic passages', r.generic_passages, (i) => i.suggestion), h('p', { class: 'small muted' }, 'AI assessment. Verify before relying on it.'))); }),
      h('button', { class: 'sm', onclick: act(async () => { const p = await api('POST', `/campaigns/${c.id}/preview`, { step: si, variant_id: v.id }); modal('Preview (saved version)', h('div', null, h('div', { class: 'small muted' }, `To ${p.to} · from ${p.from} · variant ${p.variant}`), p.missing.length ? h('div', { class: 'banner bad' }, `Empty for this lead: ${p.missing.map((m) => `{{${m}}}`).join(', ')}. This email would be blocked.`) : null, h('h3', { style: 'margin-top:8px' }, p.subject), h('div', { class: 'msg' }, p.text))); }) }, 'Preview')),
    lintBox);
}
/** AI output is never applied silently: the user reads it and chooses. */
function pick(title, options, apply, only) {
  const m = modal(title, h('div', null, h('div', { class: 'banner warn small' }, 'AI-generated. Read it before using it: check every claim is true for your business.'), options.map((o) => h('div', { class: 'step' },
    only === 'subject' ? h('b', null, o.subject) : [h('b', null, o.subject || '(no subject)'), h('div', { class: 'msg', style: 'margin-top:6px' }, o.body)],
    o.lint?.issues?.filter((i) => i.severity !== 'info').map((i) => h('div', { class: 'issue ' + i.severity }, '! ' + i.message)),
    h('div', { style: 'margin-top:8px' }, h('button', { class: 'sm primary', onclick: () => { apply(o); m.close(); toast('Applied to the editor. Save the sequence to keep it.'); } }, 'Use this'))))), { wide: true });
}

async function leadsTab(body, c, { reload }) {
  const [rows, facets] = await Promise.all([api('GET', `/campaigns/${c.id}/leads`), api('GET', '/leads/facets')]);
  const tag = h('select', null, h('option', { value: '' }, 'any tag'), facets.tags.map((t) => h('option', { value: t.value }, `${t.value} (${t.n})`)));
  const status = h('select', null, h('option', { value: '' }, 'any verification status'), facets.statuses.map((t) => h('option', { value: t.value }, `${t.value.replace(/_/g, ' ')} (${t.n})`)));
  set(body, h('div', { class: 'card' }, h('h2', null, 'Add leads'), h('div', { class: 'row' }, 'Leads with', tag, 'and', status, h('button', { class: 'primary', onclick: act(async () => {
    const qs = new URLSearchParams({ size: 200, not_in_campaign: c.id, ...(tag.value && { tag: tag.value }), ...(status.value && { status: status.value }) });
    let page = 1, ids = [];
    for (;;) { const r = await api('GET', `/leads?${qs}&page=${page}`); ids.push(...r.leads.map((l) => l.id)); if (ids.length >= r.total || !r.leads.length || page >= 50) break; page++; }
    if (!ids.length) return toast('No matching leads to add');
    const r = await api('POST', `/campaigns/${c.id}/leads`, { lead_ids: ids }); toast(`Added ${r.added}. Refused: ${r.suppressed} suppressed, ${r.already_in_campaign} already in this campaign.`); reload();
  }) }, 'Add matching leads')), h('p', { class: 'small muted', style: 'margin:8px 0 0' }, 'Suppressed contacts and leads already in this campaign are refused. You can also select leads on the Leads page and use "Add to campaign".')),
    h('div', { class: 'card', style: 'padding:0' }, rows.length ? h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ['Lead', 'Company', 'Verification', 'Sequence status', 'Step', 'Next send', ''].map((t) => h('th', null, t)))),
      h('tbody', null, rows.map((r) => h('tr', null, h('td', null, r.email), h('td', null, r.company || '–'), h('td', null, badge(r.verification_status)), h('td', null, badge(r.status), r.skip_reason ? h('div', { class: 'small muted' }, r.skip_reason) : null), h('td', { class: 'num' }, `${Math.min(r.current_step + (r.status === 'completed' ? 0 : 1), c.steps.length)}/${c.steps.length}`), h('td', { class: 'small' }, r.next_send_at ? fmt.dt(r.next_send_at) : '–'),
        h('td', null, ['pending', 'active', 'skipped'].includes(r.status) ? h('button', { class: 'sm', onclick: act(async () => { await api('POST', `/campaigns/${c.id}/leads/remove`, { lead_ids: [r.lead_id] }); reload(); }) }, 'Remove') : null)))))) : h('div', { class: 'empty' }, 'No leads in this campaign yet.')));
}

function settingsTab(body, c, { accounts, save, reload }) {
  const T = state.system.thresholds;
  const f = { name: h('input', { value: c.name }), timezone: h('input', { value: c.timezone, list: 'tzs' }), window_start: h('input', { type: 'time', value: c.window_start }), window_end: h('input', { type: 'time', value: c.window_end }),
    daily_limit: h('input', { type: 'number', min: 1, value: c.daily_limit }), min_interval: h('input', { type: 'number', min: 30, value: c.min_interval }), max_interval: h('input', { type: 'number', min: 30, value: c.max_interval }),
    verification_threshold: h('select', null, [['valid', 'Valid only (mailbox confirmed)'], ['valid_catchall', 'Valid + catch-all'], ['valid_catchall_role', 'Valid + catch-all + role-based'], ['dns_verified', 'Also allow unconfirmed mailboxes that passed DNS (higher bounce risk)']].map(([v, l]) => h('option', { value: v, selected: c.verification_threshold === v }, l))),
    track_clicks: h('input', { type: 'checkbox', checked: c.track_clicks }), stop_on_reply: h('input', { type: 'checkbox', checked: c.stop_on_reply }) };
  const days = c.days.split(',').map(Number), dayBox = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => { const cb = h('input', { type: 'checkbox', checked: days.includes(i), 'data-d': i }); return h('label', { style: 'margin-right:10px' }, cb, ' ', d); });
  const chosen = new Set(c.accounts.map((a) => a.id));
  let zones = []; try { zones = Intl.supportedValuesOf('timeZone'); } catch { /* older browsers */ }
  set(body, h('datalist', { id: 'tzs' }, zones.map((z) => h('option', { value: z }))),
    h('div', { class: 'card' }, h('h2', null, 'Campaign'), h('div', { class: 'grid g2' }, field('Name', f.name), field('Verification threshold', f.verification_threshold, `Leads must have a status of: ${T[c.verification_threshold].join(', ').replace(/_/g, ' ')}; results older than 90 days do not count.`)),
      h('label', null, f.stop_on_reply, ' Stop the sequence when a lead replies'), h('br'), h('label', null, f.track_clicks, ' Track link clicks (links in the HTML part are routed through your public URL)')),
    h('div', { class: 'card' }, h('h2', null, 'Sending schedule'), h('div', { class: 'grid g3' }, field('Time zone', f.timezone), field('Window start', f.window_start), field('Window end', f.window_end)), h('div', { style: 'margin-bottom:10px' }, dayBox),
      h('div', { class: 'grid g3' }, field('Campaign daily limit', f.daily_limit), field('Min gap between emails per inbox (s)', f.min_interval), field('Max gap (s)', f.max_interval, 'A random gap in this range is used after every send.'))),
    h('div', { class: 'card' }, h('h2', null, 'Sending accounts'), accounts.length ? accounts.map((a) => h('label', { class: 'row', style: 'margin-bottom:6px' }, h('input', { type: 'checkbox', checked: chosen.has(a.id), onchange: (e) => (e.target.checked ? chosen.add(a.id) : chosen.delete(a.id)) }), h('span', null, a.email), badge(a.paused ? 'paused' : a.status), h('span', { class: 'small muted' }, `${a.sent_today}/${a.effective_limit} today`))) : h('p', { class: 'muted' }, 'No accounts connected. ', h('a', { href: '#/accounts' }, 'Connect one')),
      h('p', { class: 'small muted' }, 'Sends rotate across the selected inboxes; each lead stays with the inbox that first emailed them so follow-ups thread correctly.')),
    h('button', { class: 'primary', onclick: act(async () => { await save({ ...Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value])), days: dayBox.map((l) => l.firstChild).filter((cb) => cb.checked).map((cb) => Number(cb.dataset.d)), account_ids: [...chosen] }); toast('Saved'); reload(); }) }, 'Save settings'));
}

async function launchTab(body, c, { reload }) {
  const r = await api('GET', `/campaigns/${c.id}/readiness`);
  const fixes = (i) => i.lead_ids?.length ? h('div', { class: 'row', style: 'margin-top:6px' },
    i.key === 'verification' ? h('button', { class: 'sm', onclick: act(async () => { const job = await api('POST', '/leads/bulk', { ids: i.lead_ids, action: 'verify' }); const { pollJob } = await import('/app.js'); await pollJob(job.id, reload); }) }, `Verify these ${i.lead_ids.length} lead(s)`) : null,
    h('button', { class: 'sm', onclick: act(async () => { if (!confirm(`Remove ${i.lead_ids.length} lead(s) from this campaign?`)) return; await api('POST', `/campaigns/${c.id}/leads/remove`, { lead_ids: i.lead_ids }); reload(); }) }, `Remove these ${i.lead_ids.length} lead(s) from the campaign`)) : null;
  set(body, 
    h('div', { class: 'banner ' + (r.ready ? (r.simulated ? 'sim' : 'info') : 'bad') }, r.ready ? h('span', null, h('b', null, r.simulated ? '◇ Ready (simulation). ' : '✓ Ready to launch. '), r.warnings ? `${r.warnings} warning(s) to review below.` : 'Every check passed.', r.simulated ? ' Sandbox accounts only: no email will be sent.' : '') : h('span', null, h('b', null, `✕ Not ready: ${r.blocking} blocking item(s). `), 'The campaign cannot be activated until these are fixed.')),
    h('div', { class: 'card' }, h('h2', null, 'Readiness checklist'), r.items.map((i) => h('div', { class: 'check' }, h('div', null, badge(i.status)), h('div', null, h('b', null, i.label), h('div', null, i.detail), fixes(i)))), h('p', { class: 'small muted', style: 'margin:10px 0 0' }, `Checked ${fmt.dt(r.checked_at)}. The recipient-level checks run again immediately before every individual send.`)),
    h('div', { class: 'row' }, c.status === 'active' ? h('button', { onclick: act(async () => { await api('POST', `/campaigns/${c.id}/pause`); reload(); }) }, 'Pause campaign')
      : h('button', { class: 'primary', disabled: !r.ready, onclick: act(async () => { if (!r.simulated && !confirm(`Start sending real email to ${(c.lead_counts.pending ?? 0) + (c.lead_counts.active ?? 0)} lead(s)?`)) return; await api('POST', `/campaigns/${c.id}/launch`); toast(c.status === 'paused' ? 'Campaign resumed' : 'Campaign launched'); reload(); }) }, c.status === 'paused' ? 'Resume campaign' : c.status === 'completed' ? 'Re-activate for new leads' : 'Launch campaign'),
      h('button', { onclick: reload }, 'Re-run checks'),
      r.simulated && c.status === 'active' ? h('button', { onclick: act(async () => { const o = await api('POST', '/engine/tick', {}); toast(`Scheduler ran: ${o.sent ?? 0} simulated send(s), ${o.blocked ?? 0} blocked`); reload(); }) }, 'Run scheduler now') : null));
}

// ---------------- inbox ----------------
const LABELS = ['interested', 'question', 'not_interested', 'wrong_person', 'unsubscribe_request', 'auto_reply', 'other'];
const inboxF = { label: '', unread: '', q: '', lead: null };
export async function inboxPage(main) {
  const qs = new URLSearchParams({ mode: state.mode, ...(inboxF.label && { label: inboxF.label }), ...(inboxF.unread && { unread: '1' }), ...(inboxF.q && { q: inboxF.q }) });
  const threads = await api('GET', `/inbox/threads?${qs}`);
  const reload = () => route();
  const view = h('div', { class: 'card' }, h('div', { class: 'empty' }, threads.length ? 'Select a conversation.' : 'No replies yet.'));
  const open = async (leadId) => {
    inboxF.lead = leadId;
    const t = await api('GET', `/inbox/threads/${leadId}`);
    const reply = h('textarea', { style: 'min-height:90px', placeholder: 'Write a reply…' });
    const lastIn = [...t.messages].reverse().find((m) => m.direction === 'in');
    set(view, h('div', { class: 'row', style: 'margin-bottom:10px' }, h('div', { class: 'grow' }, h('h2', { style: 'margin:0' }, [t.lead.first_name, t.lead.last_name].filter(Boolean).join(' ') || t.lead.email), h('div', { class: 'small muted' }, [t.lead.email, t.lead.title, t.lead.company].filter(Boolean).join(' · '))),
      t.suppressed ? badge('unsubscribed', `suppressed: ${t.suppressed}`) : null,
      h('button', { class: 'sm' + (t.meeting ? ' primary' : ''), onclick: act(async () => { await api('POST', `/inbox/threads/${leadId}/meeting`, { booked: !t.meeting }); open(leadId); }) }, t.meeting ? '✓ Meeting booked' : 'Mark meeting booked')),
      lastIn ? h('div', { class: 'row small', style: 'margin-bottom:10px' }, 'Label:', h('select', { onchange: act(async (e) => { await api('PATCH', `/inbox/messages/${lastIn.id}`, { classification: e.target.value }); toast('Label updated'); reload(); }) }, LABELS.map((l) => h('option', { value: l, selected: lastIn.classification === l }, l.replace(/_/g, ' ')))),
        h('span', { class: 'muted' }, lastIn.classification_source === 'manual' ? 'set by you' : lastIn.classification_source === 'ai' ? 'suggested by AI; correct it if wrong' : 'guessed from keywords; correct it if wrong')) : null,
      t.messages.map((m) => h('div', { class: 'msg ' + m.direction }, h('div', { class: 'meta' }, h('b', null, m.direction === 'in' ? m.from_addr : `You (${m.from_addr})`), ` · ${fmt.dt(m.created_at)}`, m.campaign ? ` · ${m.campaign}` : '', m.simulated ? h('span', null, ' ', badge('sandbox', 'simulated')) : null, m.status === 'failed' ? h('span', null, ' ', badge('failed', `not sent: ${m.error}`)) : null), m.subject ? h('div', null, h('b', null, m.subject)) : null, m.body_text)),
      reply, h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'primary', onclick: act(async () => {
        const send = (extra = {}) => api('POST', `/inbox/threads/${leadId}/reply`, { body: reply.value, ...extra });
        let r; try { r = await send(); } catch (e) { if (e.body?.needs_confirm !== 'override_suppression' || !confirm(e.message + '\n\nSend anyway?')) throw e; r = await send({ override_suppression: true }); }
        toast(r.simulated ? 'Reply recorded (sandbox: not actually sent)' : 'Reply sent'); open(leadId);
      }) }, 'Send reply'), h('span', { class: 'small muted' }, 'Sent from the inbox that holds this conversation, threaded onto it.')));
    list.querySelectorAll('.thread').forEach((el) => el.classList.toggle('active', Number(el.dataset.lead) === leadId));
  };
  const list = h('div', { class: 'card thread-list', style: 'padding:0' }, threads.length ? threads.map((t) => h('div', { class: 'thread' + (t.unread ? ' unread' : ''), 'data-lead': t.lead_id, tabindex: 0, onclick: act(() => open(t.lead_id)), onkeydown: (e) => { if (e.key === 'Enter') open(t.lead_id); } },
    h('div', { class: 'row' }, h('span', { class: 'who grow' }, [t.first_name, t.last_name].filter(Boolean).join(' ') || t.email), h('span', { class: 'small muted' }, fmt.ago(t.last_at))),
    h('div', { class: 'small muted' }, [t.company, t.campaign, t.account].filter(Boolean).join(' · ')), h('div', { class: 'small', style: 'margin:3px 0' }, t.snippet),
    h('div', { class: 'row' }, badge(t.label), t.meeting ? badge('pass', 'meeting booked') : null, t.unread ? h('span', { class: 'count' }, t.unread) : null))) : h('div', { class: 'empty' }, 'Nothing here.'));
  set(main, pageHead('Inbox', 'Replies from every connected sending account in one place. Only replies to emails sent from this system are stored.', modeToggle(), h('button', { onclick: act(async () => { const r = await api('POST', '/inbox/sync'); const errs = r.filter((x) => x.error); toast(errs.length ? `Sync failed for ${errs.map((e) => e.account).join(', ')}: ${errs[0].error}` : r.length ? `Synced ${r.length} inbox(es): ${r.reduce((n, x) => n + (x.replies || 0), 0)} new replies, ${r.reduce((n, x) => n + (x.bounces || 0), 0)} bounces` : 'No IMAP-connected accounts to sync', errs.length > 0); reload(); }) }, 'Sync now')),
    simBanner(),
    h('div', { class: 'row', style: 'margin-bottom:12px' }, h('input', { type: 'search', placeholder: 'Search replies…', value: inboxF.q, onchange: (e) => { inboxF.q = e.target.value; reload(); } }),
      h('select', { onchange: (e) => { inboxF.label = e.target.value; reload(); } }, h('option', { value: '' }, 'All replies (auto-replies hidden)'), LABELS.map((l) => h('option', { value: l, selected: inboxF.label === l }, l.replace(/_/g, ' ')))),
      h('label', null, h('input', { type: 'checkbox', checked: inboxF.unread, onchange: (e) => { inboxF.unread = e.target.checked ? '1' : ''; reload(); } }), ' Unread only')),
    h('div', { class: 'grid', style: 'grid-template-columns:minmax(260px,340px) 1fr' }, list, view));
  if (inboxF.lead && threads.some((t) => t.lead_id === inboxF.lead)) open(inboxF.lead);
}

// ---------------- analytics ----------------
let by = 'campaign';
export async function analyticsPage(main) {
  const [s, rows, series] = await Promise.all([api('GET', `/analytics/summary?${mq()}`), api('GET', `/analytics/breakdown?${mq()}&by=${by}`), api('GET', `/analytics/timeseries?${mq()}&days=30`)]);
  const m = s.measured, r = s.rates;
  const kv = (label, value) => h('div', { class: 'row', style: 'padding:5px 0;border-bottom:1px solid var(--border)' }, h('span', { class: 'grow' }, label), h('b', { style: 'font-variant-numeric:tabular-nums' }, value));
  set(main, pageHead('Analytics', 'All-time totals. Measured figures are counts of observed events; estimated figures are derived and labelled.', modeToggle(), h('a', { class: 'btn', href: `/api/analytics/export.csv?${mq()}&by=${by}` }, `Export by ${by} (CSV)`)),
    simBanner(),
    h('div', { class: 'grid g3' },
      h('div', { class: 'card' }, h('h2', null, 'Measured · sending'), kv('Emails sent (accepted by your SMTP server)', fmt.n(m.sent)), kv('Send attempts that failed', fmt.n(m.send_failed)), kv('Sends blocked by pre-send validation', fmt.n(m.blocked_by_validation)), kv('Hard bounces', fmt.n(m.hard_bounces)), kv('Soft bounces', fmt.n(m.soft_bounces)), kv('Bounce rate', fmt.pct(r.bounce_rate)), kv('Spam complaints recorded', fmt.n(m.spam_complaints))),
      h('div', { class: 'card' }, h('h2', null, 'Measured · engagement'), kv('Replies (human)', fmt.n(m.replies)), kv('Positive replies', fmt.n(m.positive_replies)), kv('Negative replies', fmt.n(m.negative_replies)), kv('Auto-replies (excluded from reply rate)', fmt.n(m.auto_replies)), kv('People who clicked a link', fmt.n(m.unique_clickers)), kv('Suspected scanner clicks (excluded)', fmt.n(m.suspected_bot_clicks)), kv('Unsubscribes', fmt.n(m.unsubscribes)), kv('Meetings booked (marked manually)', fmt.n(m.meetings_booked))),
      h('div', { class: 'card' }, h('h2', null, 'Estimated & rates'), kv(h('span', null, 'Delivered ', h('span', { class: 'badge warn' }, 'estimated')), fmt.n(s.estimated.delivered)), h('p', { class: 'small muted', style: 'margin:6px 0 10px' }, s.estimated.note),
        kv('Reply rate (of delivered)', fmt.pct(r.reply_rate)), kv('Positive reply rate', fmt.pct(r.positive_reply_rate)), kv('Click rate (people / delivered)', fmt.pct(r.click_rate)), kv('Unsubscribe rate', fmt.pct(r.unsubscribe_rate)), kv('Contacted leads → meeting', fmt.pct(r.lead_to_meeting_conversion)),
        h('p', { class: 'small muted', style: 'margin:10px 0 0' }, 'Open rate is not reported: mail clients and security gateways pre-load images, so opens do not show human engagement. Reply sentiment is a classification (keywords or AI) that you can correct in the inbox.'))),
    m.sent ? h('div', { class: 'grid g2' }, h('div', { class: 'card' }, h('h2', null, 'Emails sent per day (30 days)'), barChart(series, 'sent', 'Sent')), h('div', { class: 'card' }, h('h2', null, 'Daily outcomes (30 days)'), lineChart(series, [{ key: 'replies', label: 'Replies' }, { key: 'clicks', label: 'Clickers' }, { key: 'bounces', label: 'Bounces' }]))) : null,
    h('div', { class: 'card', style: 'padding:0' }, h('div', { class: 'row', style: 'padding:14px 16px 6px' }, h('h2', { style: 'margin:0' }, 'Breakdown'), h('div', { class: 'seg' }, [['campaign', 'Campaign'], ['account', 'Inbox'], ['domain', 'Domain'], ['step', 'Step'], ['variant', 'A/B variant'], ['day', 'Day']].map(([k, l]) => h('button', { class: by === k ? 'active' : '', onclick: () => { by = k; route(); } }, l)))),
      rows.length ? h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, [by === 'account' ? 'Inbox' : by[0].toUpperCase() + by.slice(1), 'Sent', 'Delivered (est.)', 'Bounce %', 'Replies', 'Reply %', 'Positive', 'Clickers', 'Click %', 'Unsubs', 'Meetings'].map((t, i) => h('th', { class: i ? 'num' : '' }, t)))),
        h('tbody', null, rows.map((x) => h('tr', null, h('td', null, x.name), ...[fmt.n(x.measured.sent), fmt.n(x.estimated.delivered), fmt.pct(x.rates.bounce_rate), fmt.n(x.measured.replies), fmt.pct(x.rates.reply_rate), fmt.n(x.measured.positive_replies), fmt.n(x.measured.unique_clickers), fmt.pct(x.rates.click_rate), fmt.n(x.measured.unsubscribes), fmt.n(x.measured.meetings_booked)].map((v) => h('td', { class: 'num' }, v))))))) : h('div', { class: 'empty' }, 'No data for this view yet.'),
      by === 'variant' && rows.length ? h('p', { class: 'small muted', style: 'padding:0 16px 12px' }, 'Differences between variants are not statistically meaningful until each has a few hundred delivered emails.') : null));
}

// ---------------- AI drafts review ----------------
let draftStatus = 'pending';
export async function draftsPage(main) {
  const list = await api('GET', `/ai/drafts?status=${draftStatus}`);
  const decide = (d, decision, content) => act(async () => { await api('POST', `/ai/drafts/${d.id}/decision`, { decision, content }); toast(decision === 'approve' ? 'Approved: saved to the lead as {{opening_line}}' : 'Rejected'); route(); });
  set(main, pageHead('AI review', 'AI-drafted personalisation waits here until you approve it. Each draft shows the page it was researched from and the exact quotes it relies on; drafts citing text that is not on the page are discarded before they reach this list.',
    h('div', { class: 'seg' }, ['pending', 'approved', 'rejected'].map((s) => h('button', { class: draftStatus === s ? 'active' : '', onclick: () => { draftStatus = s; route(); } }, s)))),
    !state.system.ai.enabled ? h('div', { class: 'banner warn' }, 'The AI assistant is not configured (ANTHROPIC_API_KEY is not set). Existing drafts can still be reviewed.') : null,
    list.length ? list.map((d) => { const text = h('textarea', { style: 'min-height:60px', disabled: d.status !== 'pending' }, d.content);
      return h('div', { class: 'card' }, h('div', { class: 'row', style: 'margin-bottom:8px' }, h('b', null, d.email || 'Lead removed'), h('span', { class: 'muted' }, d.company || ''), badge(d.status), h('span', { class: 'small muted right' }, `${d.model} · ${fmt.dt(d.created_at)}`)), text,
        d.sources ? h('div', { class: 'small', style: 'margin-top:8px' }, h('div', null, h('b', null, 'Source: '), h('a', { href: d.sources.url, target: '_blank', rel: 'noopener noreferrer' }, d.sources.url), h('span', { class: 'muted' }, ` · fetched ${fmt.dt(d.sources.fetched_at)}`)),
          d.sources.claims.map((c) => h('div', { style: 'margin-top:4px' }, '• ', c.statement, h('div', { class: 'muted', style: 'margin-left:12px' }, `Quote found on page: “${c.quote}”`))), h('div', { class: 'muted', style: 'margin-top:4px' }, d.sources.verification, ' Pages change and can be wrong: open the source if it matters.')) : null,
        d.status === 'pending' ? h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'primary', onclick: (e) => decide(d, 'approve', text.value)(e) }, 'Approve'), h('button', { onclick: decide(d, 'reject') }, 'Reject'), h('span', { class: 'small muted' }, 'You can edit the line before approving. Use it in a campaign with {{opening_line}}.')) : null); })
      : h('div', { class: 'card empty' }, draftStatus === 'pending' ? 'Nothing waiting for review. Select leads with a website on the Leads page and choose "AI opening lines".' : `No ${draftStatus} drafts.`));
}
