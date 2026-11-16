import { h, set, $, api, toast, act, modal, field, fmt, badge, checkRow, barChart, lineChart, meter, ApiError } from '/ui.js';
import { campaignsPage, campaignPage, inboxPage, analyticsPage, draftsPage } from '/pages.js';

export const state = { mode: localStorage.getItem('mode') === 'sandbox' ? 'sandbox' : 'real', system: null, user: null };
export const setMode = (m) => { state.mode = m; localStorage.setItem('mode', m); route(); };
export const modeToggle = () => h('div', { class: 'seg', role: 'group', 'aria-label': 'Data source' },
  h('button', { class: state.mode === 'real' ? 'active' : '', onclick: () => setMode('real') }, 'Real data'),
  h('button', { class: state.mode === 'sandbox' ? 'active' : '', onclick: () => setMode('sandbox') }, 'Sandbox'));
export const simBanner = () => state.mode === 'sandbox' && h('div', { class: 'banner sim' }, h('b', null, '◇ Simulated data. '), 'These numbers come from sandbox accounts. No email was sent and nothing here reflects real recipients.');
export const pageHead = (title, desc, ...actions) => h('div', { class: 'page-head' }, h('div', null, h('h1', null, title), desc && h('p', null, desc)), h('div', { class: 'row' }, actions));

const NAV = [['', 'Dashboard'], ['leads', 'Leads'], ['campaigns', 'Campaigns'], ['inbox', 'Inbox'], ['analytics', 'Analytics'], ['drafts', 'AI review'], ['accounts', 'Email accounts'], ['domains', 'Domain health'], ['settings', 'Settings']];
const ROUTES = { '': dashboardPage, leads: leadsPage, accounts: accountsPage, domains: domainsPage, settings: settingsPage, campaigns: campaignsPage, inbox: inboxPage, analytics: analyticsPage, drafts: draftsPage };

async function boot() {
  const s = await api('GET', '/session', null, { noAuthRedirect: true });
  if (!s.user) return authScreen(s.needs_setup);
  state.user = s.user; state.system = await api('GET', '/system');
  route();
}
window.addEventListener('hashchange', route);
window.addEventListener('signed-out', () => authScreen(false));

function authScreen(setup) {
  const email = h('input', { type: 'email', autocomplete: 'username', required: true }), pw = h('input', { type: 'password', autocomplete: setup ? 'new-password' : 'current-password', required: true, minlength: setup ? 10 : 1 });
  set($('#app'), h('form', { class: 'card login', onsubmit: act(async (e) => { e.preventDefault(); await api('POST', setup ? '/setup' : '/login', { email: email.value, password: pw.value }, { noAuthRedirect: true }); await boot(); }) },
    h('h1', null, 'Outbound OS'), h('p', { class: 'muted', style: 'margin:6px 0 16px' }, setup ? 'First run: create the admin account for this local installation.' : 'Sign in to continue.'),
    field('Email', email), field('Password', pw, setup && 'At least 10 characters. Stored as a salted scrypt hash.'), h('button', { class: 'primary', type: 'submit' }, setup ? 'Create account' : 'Sign in')));
}

export async function route() {
  if (!state.user) return;
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  const main = h('main', null, h('div', { class: 'empty' }, 'Loading…'));
  let badges = {};
  try { const d = await api('GET', `/dashboard?mode=${state.mode}`); badges = { inbox: d.unread_replies, drafts: d.pending_ai_drafts }; state.dash = d; } catch { /* handled by page */ }
  set($('#app'), h('div', { class: 'layout' },
    h('nav', { class: 'side' }, h('div', { class: 'brand' }, 'Outbound OS'),
      NAV.map(([key, label]) => h('a', { href: `#/${key}`, class: key === (name || '') ? 'active' : '' }, label, badges[key] ? h('span', { class: 'count' }, badges[key]) : null)),
      h('div', { class: 'spacer' }), h('div', { class: 'small muted', style: 'padding:0 10px' }, state.user.email),
      h('a', { href: '#', onclick: act(async (e) => { e.preventDefault(); await api('POST', '/logout'); state.user = null; authScreen(false); }) }, 'Sign out')),
    main));
  try { await (name === 'campaigns' && arg ? campaignPage(main, arg) : (ROUTES[name || ''] || dashboardPage)(main)); }
  catch (err) { if (!(err instanceof ApiError && err.status === 401)) set(main, h('div', { class: 'banner bad' }, `Could not load this page: ${err.message}`)); }
}

// ---------------- dashboard ----------------
function delta(cur, prev, { lowerIsBetter = false, unit = '' } = {}) {
  if (cur == null || prev == null) return 'no earlier period to compare';
  const d = Math.round((cur - prev) * 10) / 10;
  if (d === 0) return 'same as previous 30 days';
  const good = lowerIsBetter ? d < 0 : d > 0;
  return h('span', null, `${d > 0 ? '▲' : '▼'} ${Math.abs(d)}${unit} vs previous 30 days`, h('span', { class: 'muted' }, good ? ' (better)' : ' (worse)'));
}
const tile = (label, value, sub, tag) => h('div', { class: 'tile' }, h('div', { class: 'label' }, label, tag), h('div', { class: 'value' }, value), h('div', { class: 'sub' }, sub));
const EST = () => h('span', { class: 'badge warn', title: 'Derived, not observed' }, 'estimated');
const MEAS = () => h('span', { class: 'badge', title: 'Counted from events this system observed' }, 'measured');

async function dashboardPage(main) {
  const d = state.dash ?? await api('GET', `/dashboard?mode=${state.mode}`);
  const m = d.last_30.measured, r = d.last_30.rates, pm = d.previous_30.measured, pr = d.previous_30.rates;
  const empty = !m.sent;
  const todo = [
    [!d.accounts.length, 'Connect a sending account', '#/accounts'], [!d.leads.total, 'Import leads', '#/leads'],
    [d.leads.total && !d.leads.by_status.some((s) => s.value !== 'unverified'), 'Verify your leads', '#/leads'], [!d.campaigns.length && state.mode === 'real', 'Create a campaign', '#/campaigns'],
  ].filter(([cond]) => cond);
  set(main, 
    pageHead('Dashboard', 'Last 30 days. Every figure is labelled as measured (counted from observed events) or estimated (derived).', modeToggle()),
    simBanner(),
    d.alerts.map((a) => h('div', { class: 'banner ' + (a.severity === 'critical' ? 'bad' : 'warn') }, h('div', { class: 'row' }, h('span', { class: 'grow' }, h('b', null, a.severity === 'critical' ? '✕ Critical: ' : '! Warning: '), a.message, h('span', { class: 'small' }, ` · ${fmt.ago(a.created_at)}`)),
      h('button', { class: 'sm', onclick: act(async () => { await api('POST', `/alerts/${a.id}/resolve`); route(); }) }, 'Dismiss')))),
    todo.length ? h('div', { class: 'card' }, h('h2', null, 'Getting started'), todo.map(([, label, href]) => h('div', null, '○ ', h('a', { href }, label))),
      state.mode === 'real' && d.has_sandbox_data && !d.has_real_data ? h('p', { class: 'small muted', style: 'margin-top:8px' }, 'There is sandbox activity but no real sends yet. Switch to "Sandbox" above to see the simulated data.') : null) : null,
    h('div', { class: 'grid g4', style: 'margin-bottom:14px' },
      tile('Emails sent', fmt.n(m.sent), delta(m.sent, pm.sent), MEAS()),
      tile('Delivered', fmt.n(d.last_30.estimated.delivered), 'sent minus bounces; inbox placement is not observable', EST()),
      tile('Reply rate', fmt.pct(r.reply_rate), h('span', null, `${fmt.n(m.replies)} replies · `, delta(r.reply_rate, pr.reply_rate, { unit: ' pts' })), MEAS()),
      tile('Positive replies', fmt.n(m.positive_replies), `${fmt.pct(r.positive_reply_rate)} of delivered · ${fmt.n(m.negative_replies)} negative`, MEAS()),
      tile('Click rate', fmt.pct(r.click_rate), `${fmt.n(m.unique_clickers)} people clicked · ${fmt.n(m.suspected_bot_clicks)} scanner clicks excluded`, MEAS()),
      tile('Bounce rate', fmt.pct(r.bounce_rate), `${fmt.n(m.hard_bounces)} hard · ${fmt.n(m.soft_bounces)} soft`, MEAS()),
      tile('Unsubscribes', fmt.n(m.unsubscribes), `${fmt.pct(r.unsubscribe_rate)} of delivered · ${fmt.n(m.spam_complaints)} complaints logged`, MEAS()),
      tile('Meetings booked', fmt.n(m.meetings_booked), `${fmt.pct(r.lead_to_meeting_conversion)} of contacted leads · marked by you in the inbox`, MEAS())),
    empty ? h('div', { class: 'card empty' }, state.mode === 'sandbox' ? 'No sandbox activity yet. Create a campaign with a sandbox account to rehearse the full workflow.' : 'No real emails have been sent in the last 30 days, so there is nothing to chart yet.')
      : h('div', { class: 'grid g2' },
        h('div', { class: 'card' }, h('h2', null, 'Emails sent per day'), barChart(d.series, 'sent', 'Sent')),
        h('div', { class: 'card' }, h('h2', null, 'Replies, clicks and bounces per day'), lineChart(d.series, [{ key: 'replies', label: 'Replies' }, { key: 'clicks', label: 'Clickers' }, { key: 'bounces', label: 'Bounces' }]))),
    h('div', { class: 'card' }, h('h2', null, 'Campaign progress'),
      d.campaigns.length ? h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ['Campaign', 'Status', 'Sequence progress', 'Leads', 'Sent', 'Reply rate', 'Click rate', 'Bounce rate', 'Meetings'].map((t, i) => h('th', { class: i > 2 ? 'num' : '' }, t)))),
        h('tbody', null, d.campaigns.map((c) => h('tr', { class: 'click', onclick: () => { location.hash = `#/campaigns/${c.id}`; } },
          h('td', null, h('b', null, c.name), c.simulated ? h('span', null, ' ', badge('sandbox', 'simulated')) : null), h('td', null, badge(c.status)),
          h('td', { style: 'min-width:170px' }, meter(c.progress_pct, 'sequence progress'), h('div', { class: 'small muted' }, `${fmt.n(c.completed)} finished · ${fmt.n(c.replied)} replied · ${fmt.n(c.in_progress)} in progress`)),
          h('td', { class: 'num' }, fmt.n(c.leads)), h('td', { class: 'num' }, fmt.n(c.stats.measured.sent)), h('td', { class: 'num' }, fmt.pct(c.stats.rates.reply_rate)),
          h('td', { class: 'num' }, fmt.pct(c.stats.rates.click_rate)), h('td', { class: 'num' }, fmt.pct(c.stats.rates.bounce_rate)), h('td', { class: 'num' }, fmt.n(c.stats.measured.meetings_booked)))))))
        : h('div', { class: 'empty' }, state.mode === 'sandbox' ? 'No sandbox campaigns.' : 'No campaigns yet.')),
    h('div', { class: 'grid g3' },
      h('div', { class: 'card' }, h('h2', null, 'Sending accounts'), d.accounts.length ? d.accounts.map((a) => h('div', { class: 'row', style: 'margin-bottom:6px' }, h('span', { class: 'grow' }, a.email), badge(a.paused ? 'paused' : a.status))) : h('p', { class: 'muted' }, 'None connected.')),
      h('div', { class: 'card' }, h('h2', null, 'Domain health'), d.domains.length ? d.domains.map((x) => h('div', { class: 'row', style: 'margin-bottom:6px' }, h('span', { class: 'grow' }, x.name), h('span', { class: 'muted small' }, x.score == null ? '' : `${x.score}/100`), badge(x.status))) : h('p', { class: 'muted' }, 'No domains checked.'),
        h('p', { class: 'small muted', style: 'margin-top:8px' }, 'Authentication and blocklists only. Not a measure of inbox placement.')),
      h('div', { class: 'card' }, h('h2', null, `Leads (${fmt.n(d.leads.total)})`), d.leads.by_status.length ? d.leads.by_status.map((s) => h('div', { class: 'row', style: 'margin-bottom:6px' }, h('span', { class: 'grow' }, badge(s.value)), h('span', null, fmt.n(s.n)))) : h('p', { class: 'muted' }, 'No leads imported.'))),
    h('p', { class: 'small muted' }, 'Open rates are intentionally not tracked: Apple Mail Privacy Protection and corporate image proxies pre-load tracking pixels, so "opens" do not indicate that a person read the email.'));
}

// ---------------- leads ----------------
const leadFilter = { q: '', status: '', tag: '', source: '', page: 1 };
async function leadsPage(main) {
  const selected = new Set();
  const qs = () => new URLSearchParams(Object.entries(leadFilter).filter(([, v]) => v)).toString();
  const [data, facets, campaigns] = await Promise.all([api('GET', `/leads?${qs()}`), api('GET', '/leads/facets'), api('GET', '/campaigns')]);
  const reload = () => route();
  const setF = (k) => (e) => { leadFilter[k] = e.target.value; leadFilter.page = 1; reload(); };
  const opt = (list, cur, any) => [h('option', { value: '' }, any), ...list.map((o) => h('option', { value: o.value, selected: o.value === cur }, `${String(o.value).replace(/_/g, ' ')} (${o.n})`))];
  const bar = h('div', { class: 'row', style: 'display:none;margin-bottom:10px' });
  const bulk = async (action, extra = {}) => {
    const res = await api('POST', '/leads/bulk', { ids: [...selected], action, ...extra });
    if (res.status === 'running') return pollJob(res.id, reload);
    toast(`${fmt.n(res.affected)} lead(s) updated`); reload();
  };
  const refreshBar = () => {
    bar.style.display = selected.size ? 'flex' : 'none';
    set(bar, h('b', null, `${selected.size} selected`),
      h('button', { onclick: act(() => bulk('verify')) }, 'Verify emails'),
      h('button', { onclick: () => { const v = prompt('Tags to add (comma separated)'); if (v) act(() => bulk('add_tags', { tags: v.split(',') }))(); } }, 'Add tags'),
      h('button', { onclick: () => { const f = prompt('Field to set (e.g. company, title, or a custom field name)'); if (!f) return; const v = prompt(`New value for "${f}" (leave empty to clear)`); if (v !== null) act(() => bulk('set_field', { field: f, value: v }))(); } }, 'Edit field'),
      campaigns.length ? h('select', { onchange: act(async (e) => { const id = e.target.value; if (!id) return; const r = await api('POST', `/campaigns/${id}/leads`, { lead_ids: [...selected] }); toast(`Added ${r.added}. Skipped: ${r.already_in_campaign} already in campaign, ${r.suppressed} suppressed.`); reload(); }) }, h('option', { value: '' }, 'Add to campaign…'), campaigns.map((c) => h('option', { value: c.id }, c.name))) : null,
      state.system.ai.enabled ? h('button', { onclick: act(async () => { if (selected.size > 20) throw new Error('Select at most 20 leads per AI batch'); let ok = 0, no = 0; for (const id of selected) { try { (await api('POST', '/ai/opening-line', { lead_id: id })).usable ? ok++ : no++; } catch { no++; } } toast(`${ok} opening line(s) drafted for review, ${no} had no verifiable evidence`); }) }, 'AI opening lines') : null,
      h('button', { onclick: act(async () => { if (confirm(`Suppress ${selected.size} lead(s)? They will never be emailed.`)) await bulk('suppress'); }) }, 'Suppress'),
      h('button', { class: 'danger', onclick: act(async () => { if (confirm(`Permanently delete ${selected.size} lead(s)?`)) await bulk('delete'); }) }, 'Delete'));
  };
  const pages = Math.max(1, Math.ceil(data.total / data.size));
  set(main, 
    pageHead('Leads', `${fmt.n(facets.total)} leads. Nothing is imported until you have reviewed the validation report.`,
      h('a', { class: 'btn', href: `/api/leads/export.csv?${qs()}` }, 'Export CSV'), h('button', { onclick: () => importHistory() }, 'Import history'), h('button', { onclick: () => leadModal(null, reload) }, 'Add lead'), h('button', { class: 'primary', onclick: () => importWizard(reload) }, 'Import CSV / Excel')),
    h('div', { class: 'row', style: 'margin-bottom:12px' },
      h('input', { type: 'search', placeholder: 'Search email, name, company…', value: leadFilter.q, style: 'min-width:240px', onchange: setF('q') }),
      h('select', { onchange: setF('status') }, opt(facets.statuses, leadFilter.status, 'Any verification status')),
      h('select', { onchange: setF('tag') }, opt(facets.tags, leadFilter.tag, 'Any tag')), h('select', { onchange: setF('source') }, opt(facets.sources, leadFilter.source, 'Any source')),
      h('span', { class: 'muted small' }, `${fmt.n(data.total)} match`)),
    bar,
    h('div', { class: 'card', style: 'padding:0' }, data.leads.length ? h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, h('input', { type: 'checkbox', 'aria-label': 'Select page', onchange: (e) => { main.querySelectorAll('tbody input[type=checkbox]').forEach((c) => { c.checked = e.target.checked; c.dispatchEvent(new Event('change')); }); } })), ['Email', 'Name', 'Company', 'Verification', 'Last checked', 'Flags', 'Tags', 'Source'].map((t) => h('th', null, t)))),
      h('tbody', null, data.leads.map((l) => h('tr', null,
        h('td', null, h('input', { type: 'checkbox', 'aria-label': `Select ${l.email}`, onchange: (e) => { e.target.checked ? selected.add(l.id) : selected.delete(l.id); refreshBar(); } })),
        h('td', null, h('button', { class: 'link', onclick: () => leadModal(l, reload) }, l.email), l.suppressed ? h('div', null, badge('unsubscribed', `suppressed: ${l.suppressed}`)) : null),
        h('td', null, [l.first_name, l.last_name].filter(Boolean).join(' ') || '–', l.title ? h('div', { class: 'small muted' }, l.title) : null), h('td', null, l.company || '–'),
        h('td', null, badge(l.verification_status), l.verification_confidence != null ? h('div', { class: 'small muted', title: (l.verification_detail?.reasons || []).join('\n') }, `${Math.round(l.verification_confidence * 100)}% confidence`) : null),
        h('td', { class: 'small' }, l.verification_checked_at ? fmt.ago(l.verification_checked_at) : h('span', { class: 'muted' }, 'never')),
        h('td', null, l.flags.map((f) => h('span', { class: 'tag' }, f.replace(/_/g, ' ')))), h('td', null, l.tags.map((t) => h('span', { class: 'tag' }, t))), h('td', { class: 'small muted' }, l.source)))))) : h('div', { class: 'empty' }, facets.total ? 'No leads match these filters.' : 'No leads yet. Import a CSV/Excel file or add one manually.')),
    pages > 1 ? h('div', { class: 'row' }, h('button', { disabled: data.page <= 1, onclick: () => { leadFilter.page--; reload(); } }, '← Previous'), h('span', { class: 'muted' }, `Page ${data.page} of ${pages}`), h('button', { disabled: data.page >= pages, onclick: () => { leadFilter.page++; reload(); } }, 'Next →')) : null);
}
export async function pollJob(id, done) {
  const box = h('div', null, 'Starting…');
  const m = modal('Verifying emails', box);
  for (;;) {
    const j = await api('GET', `/jobs/${id}`);
    set(box, meter(Math.round((j.done / Math.max(1, j.total)) * 100), 'verification'), h('p', { class: 'muted', style: 'margin-top:8px' }, `${j.done} of ${j.total} checked`),
      j.status === 'done' ? h('div', null, h('h3', null, 'Results'), Object.entries(j.result || {}).map(([k, v]) => h('div', { class: 'row' }, badge(k), h('span', null, v))),
        !state.system.smtp_probe ? h('p', { class: 'small muted', style: 'margin-top:10px' }, 'SMTP mailbox probing is off, so no address can be confirmed as "valid": syntax, DNS, disposable and role checks were completed and deliverable-looking addresses are reported as "unknown".') : null) : null,
      j.status === 'failed' ? h('div', { class: 'banner bad' }, j.error) : null);
    if (j.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 700));
  }
  done?.(); return m;
}
function leadModal(lead, done) {
  const cf = state.system.custom_fields.map((c) => c.key);
  const keys = [...new Set([...cf, ...Object.keys(lead?.custom || {})])];
  const inp = {}; const cin = {};
  const body = h('div', null, h('div', { class: 'grid g2' }, ['email', 'first_name', 'last_name', 'company', 'title', 'website', 'phone', 'linkedin', 'country', 'timezone'].map((k) => field(k.replace(/_/g, ' '), (inp[k] = h('input', { value: lead?.[k] ?? '', type: k === 'email' ? 'email' : 'text' }))))),
    field('Tags (comma separated)', (inp.tags = h('input', { value: (lead?.tags || []).join(', ') }))),
    keys.length ? h('div', null, h('h3', null, 'Custom fields'), h('div', { class: 'grid g2' }, keys.map((k) => field(k, (cin[k] = h('input', { value: lead?.custom?.[k] ?? '' })))))) : null,
    lead ? h('div', { class: 'card', style: 'margin:10px 0 0' }, h('h3', null, 'Verification'), h('div', { class: 'row' }, badge(lead.verification_status), h('span', { class: 'muted small' }, lead.verification_checked_at ? `checked ${fmt.dt(lead.verification_checked_at)} · ${Math.round((lead.verification_confidence ?? 0) * 100)}% confidence` : 'never checked')),
      (lead.verification_detail?.reasons || []).map((r) => h('div', { class: 'small' }, '• ', r)),
      lead.verification_detail?.checks ? h('div', { class: 'small muted', style: 'margin-top:6px' }, Object.entries(lead.verification_detail.checks).map(([k, v]) => `${k}: ${String(v).replace(/_/g, ' ')}`).join(' · ')) : null) : null);
  const collect = () => ({ ...Object.fromEntries(Object.entries(inp).filter(([k]) => k !== 'tags').map(([k, el]) => [k, el.value])), tags: inp.tags.value.split(',').map((t) => t.trim()).filter(Boolean), custom: Object.fromEntries(Object.entries(cin).map(([k, el]) => [k, el.value])) });
  modal(lead ? 'Edit lead' : 'Add lead', body, { actions: [
    ...(lead ? [{ label: 'Delete', class: 'danger', run: async () => { if (!confirm('Delete this lead?')) return false; await api('DELETE', `/leads/${lead.id}`); done(); } }] : []),
    { label: 'Save', run: async () => { await api(lead ? 'PATCH' : 'POST', lead ? `/leads/${lead.id}` : '/leads', collect()); toast('Saved'); done(); } }] });
}
async function importHistory() {
  const list = await api('GET', '/imports');
  modal('Import history', list.length ? h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ['File', 'When', 'Status', 'Rows', 'Imported', 'Rejected', ''].map((t) => h('th', null, t)))),
    h('tbody', null, list.map((i) => h('tr', null, h('td', null, i.filename || '–'), h('td', { class: 'small' }, fmt.dt(i.created_at)), h('td', null, badge(i.status)), h('td', { class: 'num' }, i.total), h('td', { class: 'num' }, i.report?.committed?.inserted ?? (i.status === 'staged' ? `${i.importable} pending` : 0)), h('td', { class: 'num' }, i.rejected),
      h('td', null, h('a', { href: `/api/imports/${i.id}/errors.csv` }, 'Error report'))))))) : h('div', { class: 'empty' }, 'No imports yet.'), { wide: true });
}
function importWizard(done) {
  const box = h('div');
  const m = modal('Import leads', box, { wide: true });
  let file, parsed, mapping;
  const targets = [...state.system.core_fields.map((f) => [f, f.replace(/_/g, ' ')])];
  const step1 = () => set(box, h('p', { class: 'muted' }, 'Upload a .csv or .xlsx file with a header row. The file is validated first; you decide whether to commit after seeing the report.'),
    h('input', { type: 'file', accept: '.csv,.xlsx,text/csv', onchange: act(async (e) => { file = e.target.files[0]; if (!file) return; parsed = await api('POST', `/imports/parse?filename=${encodeURIComponent(file.name)}`, file); mapping = { ...parsed.mapping }; step2(); }) }));
  const step2 = () => {
    const tags = h('input', { placeholder: 'e.g. q3-saas, uk' }), reqName = h('input', { type: 'checkbox' }), reqCo = h('input', { type: 'checkbox' });
    set(box, h('p', null, h('b', null, `${fmt.n(parsed.rows)} rows`), ' found. Confirm how each column maps. Unrecognised columns become custom fields.'),
      h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ['Column in file', 'Sample', 'Import as'].map((t) => h('th', null, t)))), h('tbody', null, parsed.headers.map((hd) => h('tr', null, h('td', null, h('b', null, hd)), h('td', { class: 'small muted' }, parsed.sample.map((r) => r[hd]).filter(Boolean).slice(0, 2).join(' · ') || '–'),
        h('td', null, h('select', { onchange: (e) => { mapping[hd] = e.target.value || null; } }, h('option', { value: '' }, 'Skip this column'), targets.map(([v, l]) => h('option', { value: v, selected: mapping[hd] === v }, l)),
          h('option', { value: parsed.mapping[hd]?.startsWith('custom:') ? parsed.mapping[hd] : `custom:${hd.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, selected: mapping[hd]?.startsWith('custom:') }, 'Custom field')))))))),
      h('div', { class: 'grid g2', style: 'margin-top:12px' }, field('Tags to apply to this import', tags), h('div', null, h('span', { class: 'small muted' }, 'Also require'), h('div', null, h('label', null, reqName, ' First name  '), h('label', null, reqCo, ' Company')))),
      h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: act(async () => {
        const options = { mapping, tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean), required: [reqName.checked && 'first_name', reqCo.checked && 'company'].filter(Boolean) };
        step3(await api('POST', `/imports/stage?filename=${encodeURIComponent(file.name)}&options=${encodeURIComponent(JSON.stringify(options))}`, file));
      }) }, 'Validate file')));
  };
  const step3 = (st) => {
    const c = st.report.counts;
    set(box, h('h3', null, 'Validation report'), h('p', { class: 'muted' }, 'Nothing has been imported yet.'),
      h('div', { class: 'grid g4' }, tile('Rows in file', fmt.n(c.total), ''), tile('Ready to import', fmt.n(c.importable), `${fmt.n(c.flagged)} with warnings`), tile('Rejected', fmt.n(c.rejected), 'will not be imported'), tile('Domains unchecked', fmt.n(c.domain_unchecked), c.domain_unchecked ? 'DNS lookup failed: imported but flagged, not validated' : 'all domains resolved')),
      h('div', { class: 'card', style: 'margin-top:12px' }, h('h3', null, 'Why rows were rejected'), [['duplicate_in_file', 'Duplicate email within the file'], ['duplicate_existing', 'Lead already exists'], ['suppressed', 'On the suppression list'], ['invalid_domain', 'Domain cannot receive mail']].map(([k, l]) => h('div', { class: 'row' }, h('span', { class: 'grow' }, l), h('b', null, fmt.n(c[k])))),
        h('div', { class: 'row' }, h('span', { class: 'grow' }, 'Invalid syntax or missing required field'), h('b', null, fmt.n(c.invalid_or_incomplete)))),
      st.rejected.length ? h('details', { class: 'data', open: st.rejected.length <= 8 }, h('summary', null, `Rejected rows (${st.rejected.length}${c.rejected > st.rejected.length ? ' shown of ' + c.rejected : ''})`), h('table', null, h('tbody', null, st.rejected.map((r) => h('tr', null, h('td', { class: 'num' }, `row ${r.row}`), h('td', null, r.record.email || '–'), h('td', null, r.errors.join('; '))))))) : null,
      st.flagged.length ? h('details', { class: 'data' }, h('summary', null, `Imported with warnings (${c.flagged})`), h('table', null, h('tbody', null, st.flagged.map((r) => h('tr', null, h('td', { class: 'num' }, `row ${r.row}`), h('td', null, r.record.email), h('td', null, r.flags.map((f) => h('span', { class: 'tag' }, f.replace(/_/g, ' '))))))))) : null,
      h('p', { class: 'small muted', style: 'margin-top:10px' }, 'Imported leads start as "unverified". Run "Verify emails" before adding them to a campaign.'),
      h('div', { class: 'actions' }, h('a', { class: 'btn', href: `/api/imports/${st.id}/errors.csv` }, 'Download full report'), h('button', { onclick: act(async () => { await api('POST', `/imports/${st.id}/discard`); m.close(); }) }, 'Discard'),
        h('button', { class: 'primary', disabled: !c.importable, onclick: act(async () => { const r = await api('POST', `/imports/${st.id}/commit`); toast(`Imported ${r.inserted} lead(s)`); m.close(); done(); }) }, `Import ${fmt.n(c.importable)} lead(s)`)));
  };
  step1();
}

// ---------------- accounts ----------------
async function accountsPage(main) {
  const list = await api('GET', '/accounts');
  const reload = () => route();
  set(main, pageHead('Email accounts', 'An account is shown as healthy only when every required check passes. Failing or unverified accounts cannot send.', h('button', { class: 'primary', onclick: () => accountModal(null, reload) }, 'Connect account')),
    list.length ? list.map((a) => h('div', { class: 'card' },
      h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, a.email), badge(a.paused ? 'paused' : a.status), h('span', { class: 'muted small' }, `${state.system.providers[a.provider].label} · ${a.auth === 'oauth' ? 'OAuth2' : a.auth === 'password' ? 'password / app password' : 'no credentials'}`),
        h('span', { class: 'right row' }, h('button', { class: 'sm', onclick: act(async () => { await api('POST', `/accounts/${a.id}/check`); toast('Checks re-run'); reload(); }) }, 'Re-check'),
          h('button', { class: 'sm', onclick: act(async () => { await api('PATCH', `/accounts/${a.id}`, { paused: !a.paused }); reload(); }) }, a.paused ? 'Resume' : 'Pause'), h('button', { class: 'sm', onclick: () => accountModal(a, reload) }, 'Edit'),
          h('button', { class: 'sm danger', onclick: act(async () => { if (confirm(`Remove ${a.email}?`)) { await api('DELETE', `/accounts/${a.id}`); reload(); } }) }, 'Remove'))),
      h('div', { class: 'row small muted', style: 'margin:6px 0 10px' }, h('span', null, `Sent today: ${a.sent_today} / ${a.effective_limit}`), a.warmup_enabled ? h('span', null, `· ramp-up active (limit ${a.daily_limit}, +${a.warmup_increment}/day)`) : null, h('span', null, `· last checked ${fmt.ago(a.last_checked_at)}`), a.imap_synced_at ? h('span', null, `· inbox synced ${fmt.ago(a.imap_synced_at)}`) : null),
      a.checks.map(checkRow))) : h('div', { class: 'card empty' }, 'No sending accounts yet. Connect Gmail / Google Workspace, Microsoft 365, any SMTP+IMAP mailbox, or a sandbox account to rehearse without sending.'));
}
function accountModal(a, done) {
  const P = state.system.providers;
  const v = (k, d = '') => a?.[k] ?? d;
  const provider = h('select', { disabled: Boolean(a) }, Object.entries(P).map(([k, p]) => h('option', { value: k, selected: a?.provider === k }, p.label)));
  const f = { email: h('input', { type: 'email', value: v('email'), disabled: Boolean(a) }), from_name: h('input', { value: v('from_name') }), username: h('input', { value: v('username'), placeholder: 'defaults to the email address' }),
    password: h('input', { type: 'password', autocomplete: 'new-password', placeholder: a ? 'leave blank to keep current' : '' }), smtp_host: h('input', { value: v('smtp_host') }), smtp_port: h('input', { type: 'number', value: v('smtp_port', 587) }),
    smtp_secure: h('input', { type: 'checkbox', checked: v('smtp_secure') }), imap_host: h('input', { value: v('imap_host') }), imap_port: h('input', { type: 'number', value: v('imap_port', 993) }),
    daily_limit: h('input', { type: 'number', min: 1, value: v('daily_limit', 30) }), warmup_enabled: h('input', { type: 'checkbox', checked: v('warmup_enabled') }), warmup_start: h('input', { type: 'number', min: 1, value: v('warmup_start', 5) }),
    warmup_increment: h('input', { type: 'number', min: 0, value: v('warmup_increment', 3) }), signature: h('textarea', { style: 'min-height:70px' }, v('signature')) };
  const custom = h('div', { class: 'grid g2' }, field('SMTP host', f.smtp_host), field('SMTP port', f.smtp_port), field('IMAP host', f.imap_host), field('IMAP port', f.imap_port), h('label', null, f.smtp_secure, ' Implicit TLS (port 465)'));
  const creds = h('div', null, field('Username', f.username), field('Password / app password', f.password));
  const hint = h('div', { class: 'banner info small' });
  const sync = () => { const p = provider.value; custom.style.display = p === 'smtp' ? 'grid' : 'none'; creds.style.display = p === 'sandbox' ? 'none' : 'block';
    set(hint, p === 'google' ? h('span', null, 'Use a 16-character Google app password (requires 2-Step Verification) and make sure IMAP is enabled. ', state.system.oauth.google ? h('a', { href: '/api/oauth/google/start' }, 'Or connect with Google OAuth →') : 'OAuth sign-in becomes available once GOOGLE_CLIENT_ID/SECRET are set.')
      : p === 'microsoft' ? h('span', null, 'Authenticated SMTP must be enabled for the mailbox in the Microsoft 365 admin centre. ', state.system.oauth.microsoft ? h('a', { href: '/api/oauth/microsoft/start' }, 'Or connect with Microsoft OAuth →') : 'OAuth sign-in becomes available once MICROSOFT_CLIENT_ID/SECRET are set.')
      : p === 'sandbox' ? 'A sandbox account sends nothing. Use it to rehearse a campaign end to end; all of its activity is labelled simulated and kept out of real analytics.' : 'Passwords are encrypted at rest (AES-256-GCM) and never returned by the API.'); };
  provider.addEventListener('change', sync); sync();
  modal(a ? `Edit ${a.email}` : 'Connect a sending account', h('div', null, field('Provider', provider), hint, h('div', { class: 'grid g2' }, field('Email address', f.email), field('From name', f.from_name)), creds, custom,
    h('div', { class: 'grid g3' }, field('Daily sending limit', f.daily_limit), field('Ramp-up start / day', f.warmup_start), field('Ramp-up increase / day', f.warmup_increment)),
    h('label', null, f.warmup_enabled, ' Ramp volume up gradually (volume ramp only; this is not a warm-up network that exchanges emails with other inboxes)'), h('div', { style: 'margin-top:10px' }, field('Signature', f.signature))),
  { actions: [{ label: a ? 'Save' : 'Connect and run checks', run: async () => {
    const body = { provider: provider.value, ...Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value])) };
    if (!body.password) delete body.password; if (!body.username) delete body.username;
    const res = await api(a ? 'PATCH' : 'POST', a ? `/accounts/${a.id}` : '/accounts', body); toast(`${res.email}: ${res.status}`); done();
  } }] });
}

// ---------------- domains ----------------
async function domainsPage(main) {
  const list = await api('GET', '/domains');
  const reload = () => route();
  const name = h('input', { placeholder: 'example.com' }), sel = h('input', { placeholder: 'DKIM selector (optional), e.g. google' });
  set(main, pageHead('Domain health', 'DNS authentication, blocklists and your own measured bounce and complaint rates, re-checked automatically. These checks cannot tell you whether mail reaches the inbox.'),
    h('div', { class: 'card row' }, name, sel, h('button', { class: 'primary', onclick: act(async () => { await api('POST', '/domains', { name: name.value, dkim_selectors: sel.value }); reload(); }) }, 'Add and check domain')),
    list.length ? list.map((d) => { const r = d.last_result;
      return h('div', { class: 'card' }, h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, d.name), badge(d.status), r ? h('b', null, `${d.score}/100`) : null, h('span', { class: 'muted small' }, `checked ${fmt.ago(d.last_checked_at)}${d.accounts.length ? ' · used by ' + d.accounts.join(', ') : ''}`),
        h('span', { class: 'right row' }, h('button', { class: 'sm', onclick: act(async () => { const s = prompt('DKIM selector(s), comma separated', d.dkim_selectors); if (s !== null) { await api('PATCH', `/domains/${d.id}`, { dkim_selectors: s }); reload(); } }) }, 'DKIM selector'),
          h('button', { class: 'sm', onclick: act(async () => { await api('POST', `/domains/${d.id}/check`); reload(); }) }, 'Re-check'), h('button', { class: 'sm', onclick: act(() => domainHistory(d)) }, 'History'),
          h('button', { class: 'sm danger', onclick: act(async () => { if (confirm(`Remove ${d.name}?`)) { await api('DELETE', `/domains/${d.id}`); reload(); } }) }, 'Remove'))),
      r ? h('div', null, r.critical.length ? h('div', { class: 'banner bad', style: 'margin-top:10px' }, h('b', null, '✕ Critical: '), `${r.critical.join(', ').toUpperCase()} failing. Do not send from this domain until fixed.`) : null,
        r.unverified.length ? h('p', { class: 'small muted', style: 'margin:8px 0 0' }, `Not verifiable right now (earn no score): ${r.unverified.join(', ').replace(/_/g, ' ')}.`) : null,
        r.checks.map(checkRow), h('p', { class: 'small muted', style: 'margin:10px 0 0' }, r.disclaimer)) : h('p', { class: 'muted' }, 'Not checked yet.')); })
      : h('div', { class: 'card empty' }, 'No domains yet. Domains are added automatically when you connect a sending account.'));
}
async function domainHistory(d) {
  const hist = await api('GET', `/domains/${d.id}/history`);
  modal(`${d.name} · health history`, hist.length ? h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ['Checked', 'Score', 'Status', 'Failing / warning checks'].map((t) => h('th', null, t)))),
    h('tbody', null, hist.map((x) => h('tr', null, h('td', { class: 'small' }, fmt.dt(x.checked_at)), h('td', { class: 'num' }, x.score), h('td', null, badge(x.status)), h('td', { class: 'small' }, (x.result?.checks || []).filter((c) => c.status === 'fail' || c.status === 'warn').map((c) => `${c.key} (${c.status})`).join(', ') || '–')))))) : h('div', { class: 'empty' }, 'No history yet.'), { wide: true });
}

// ---------------- settings ----------------
async function settingsPage(main) {
  const s = state.system, sup = await api('GET', '/suppressions');
  const reload = () => route();
  const vals = h('textarea', { style: 'min-height:60px', placeholder: 'emails or domains, one per line' }), comp = h('input', { type: 'email', placeholder: 'recipient@example.com' });
  const line = (ok, label, detail) => h('div', { class: 'check' }, h('div', null, badge(ok ? 'pass' : 'warn', ok ? 'ready' : 'not set')), h('div', null, h('b', null, label), h('div', { class: 'muted' }, detail)));
  set(main, pageHead('Settings', 'What is configured on this installation, and the suppression list.'),
    h('div', { class: 'card' }, h('h2', null, 'System configuration'),
      line(s.public_url_reachable, 'Public URL', `${s.public_url}. Click tracking and unsubscribe links point here; recipients must be able to reach it. Real campaigns cannot launch while this is localhost.`),
      line(s.postal_address, 'Postal address in footer', 'SENDER_POSTAL_ADDRESS. Required by CAN-SPAM for commercial email.'),
      line(s.ai.enabled, 'AI assistant', s.ai.enabled ? `Enabled (${s.ai.model}).` : 'Set ANTHROPIC_API_KEY to enable drafting and review. Heuristic content checks work without it.'),
      line(s.smtp_probe, 'SMTP mailbox probing', s.smtp_probe ? 'Enabled: mailbox existence and catch-all detection run over port 25.' : 'Off (SMTP_PROBE). Without it, no address can be marked "valid"; verification covers syntax, DNS/MX, disposable and role detection only.'),
      line(s.oauth.google, 'Google OAuth', 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. Optional: app passwords work without it.'), line(s.oauth.microsoft, 'Microsoft OAuth', 'MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET. Optional.'),
      line(s.scheduler, 'Background scheduler', 'Sends due emails, syncs inboxes and re-checks domains while the server is running.')),
    h('div', { class: 'grid g2' },
      h('div', { class: 'card' }, h('h2', null, 'Add to suppression list'), vals, h('button', { style: 'margin-top:8px', onclick: act(async () => { const r = await api('POST', '/suppressions', { values: vals.value }); toast(`${r.added} added`); reload(); }) }, 'Suppress')),
      h('div', { class: 'card' }, h('h2', null, 'Record a spam complaint'), h('p', { class: 'muted small' }, 'Mailbox providers rarely notify senders of complaints. If you learn of one (feedback loop, Postmaster Tools, a direct message), record it so the rate is counted and the person is suppressed.'), h('div', { class: 'row' }, comp, h('button', { onclick: act(async () => { await api('POST', '/events/complaint', { email: comp.value }); toast('Complaint recorded'); reload(); }) }, 'Record')))),
    h('div', { class: 'card', style: 'padding:0' }, h('div', { style: 'padding:14px 16px 0' }, h('h2', null, `Suppression list (${sup.length})`)), sup.length ? h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ['Address / domain', 'Reason', 'Added', 'Note', ''].map((t) => h('th', null, t)))),
      h('tbody', null, sup.map((x) => h('tr', null, h('td', null, x.value), h('td', null, badge(x.reason === 'manual' ? 'paused' : 'unsubscribed', x.reason)), h('td', { class: 'small' }, fmt.date(x.created_at)), h('td', { class: 'small muted' }, x.note || ''),
        h('td', null, h('button', { class: 'sm', onclick: act(async () => { try { await api('DELETE', `/suppressions/${x.id}`); } catch (e) { if (!e.body?.needs_confirm) throw e; if (!confirm(e.message + '\n\nRemove anyway?')) return; await api('DELETE', `/suppressions/${x.id}?confirm=${e.body.needs_confirm}`); } reload(); }) }, 'Remove'))))))) : h('div', { class: 'empty' }, 'Nobody is suppressed.')));
}
boot().catch((err) => { set($('#app'), h('div', { class: 'card login' }, `Could not start: ${err.message}`)); });
