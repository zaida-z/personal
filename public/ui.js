// DOM + API helpers and chart components. No framework, no inline scripts (strict CSP).
export function h(tag, attrs, ...kids) {
  const el = tag === 'svg' || NS_TAGS.has(tag) ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.setAttribute('class', v);
    else if (k === 'value' && 'value' in el) el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const NS_TAGS = new Set(['g', 'path', 'rect', 'line', 'circle', 'text', 'title']);
export const $ = (sel, root = document) => root.querySelector(sel);
/** replaceChildren that ignores null/false and flattens arrays (the native one renders null as the text "null"). */
export function set(el, ...kids) { el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false)); return el; }

export class ApiError extends Error { constructor(status, body) { super(body?.error || `Request failed (${status})`); this.status = status; this.body = body || {}; } }
export async function api(method, path, body, opts = {}) {
  const raw = body instanceof Blob;
  const res = await fetch('/api' + path, { method, headers: { 'x-requested-with': 'outbound-os', ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...(raw ? { 'content-type': 'application/octet-stream' } : {}) }, body: raw ? body : body ? JSON.stringify(body) : undefined });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (res.status === 401 && !opts.noAuthRedirect) { window.dispatchEvent(new Event('signed-out')); throw new ApiError(401, data); }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
export function toast(msg, isErr = false) {
  const t = h('div', { class: 'toast' + (isErr ? ' err' : '') }, msg);
  $('#toasts').append(t); setTimeout(() => t.remove(), isErr ? 8000 : 4000);
}
/** Run an async action from a button: disables it, surfaces errors as toasts. */
export const act = (fn) => async (ev) => {
  const btn = ev?.currentTarget?.tagName === 'BUTTON' ? ev.currentTarget : null;
  if (btn) btn.disabled = true;
  try { await fn(ev); } catch (err) { toast(err.message, true); if (!(err instanceof ApiError)) console.error(err); } finally { if (btn) btn.disabled = false; }
};
export function modal(title, body, { wide = false, actions = [] } = {}) {
  const close = () => overlay.remove();
  const overlay = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-label': title }, h('h2', null, title), body,
      h('div', { class: 'actions' }, h('button', { onclick: close }, 'Close'), actions.map((a) => h('button', { class: a.class || 'primary', onclick: act(async (e) => { if ((await a.run(e)) !== false) close(); }) }, a.label)))));
  $('#modal-root').append(overlay);
  return { close, el: overlay };
}
export const field = (label, input, hint) => h('label', { class: 'f' }, h('span', null, label), input, hint && h('div', { class: 'small muted' }, hint));
export const fmt = {
  n: (v) => (v == null ? '–' : Number(v).toLocaleString()),
  pct: (v) => (v == null ? '–' : `${v}%`),
  date: (s) => (s ? new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '–'),
  dt: (s) => (s ? new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–'),
  ago: (s) => { if (!s) return 'never'; const m = (Date.now() - Date.parse(s)) / 60e3; return m < 1 ? 'just now' : m < 60 ? `${Math.floor(m)}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`; },
};
const TONE = { pass: 'good', healthy: 'good', valid: 'good', active: 'good', completed: 'good', interested: 'good', approved: 'good', committed: 'good', sent: 'good',
  warn: 'warn', warning: 'warn', risky: 'warn', catch_all: 'warn', role_based: 'warn', unverified: 'warn', unknown: 'warn', paused: 'warn', staged: 'warn', pending: 'warn', question: 'warn', unchecked: 'warn',
  fail: 'bad', failing: 'bad', unhealthy: 'bad', invalid: 'bad', disposable: 'bad', bounced: 'bad', failed: 'bad', not_interested: 'bad', unsubscribe_request: 'bad', unsubscribed: 'bad', critical: 'bad', rejected: 'bad',
  sandbox: 'sim' };
const ICON = { good: '✓', warn: '!', bad: '✕', sim: '◇' };
/** Status badge: icon + label, never colour alone. */
export const badge = (status, label) => { const tone = TONE[status]; return h('span', { class: 'badge ' + (tone || '') }, tone ? ICON[tone] + ' ' : '', label ?? String(status).replace(/_/g, ' ')); };
export const checkRow = (c) => h('div', { class: 'check' }, h('div', null, badge(c.status, c.status === 'unknown' ? 'unverified' : c.status)),
  h('div', null, h('b', null, c.label), c.critical && c.status !== 'pass' ? h('span', { class: 'small muted' }, ' · required') : null, h('div', null, c.detail), c.fix && h('div', { class: 'fix' }, h('b', null, 'Fix: '), c.fix)));

// ---------- charts ----------
const cssVar = (name) => `var(--${name})`;
function dataTable(rows, cols) {
  return h('details', { class: 'data' }, h('summary', null, 'View as table'), h('div', { class: 'table-wrap' }, h('table', null,
    h('thead', null, h('tr', null, cols.map((c) => h('th', { class: c.num ? 'num' : '' }, c.label)))),
    h('tbody', null, rows.map((r) => h('tr', null, cols.map((c) => h('td', { class: c.num ? 'num' : '' }, r[c.key]))))))));
}
const niceMax = (v) => { if (v <= 4) return 4; const p = 10 ** Math.floor(Math.log10(v)); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; };
const W = 640, H = 200, PAD = { l: 34, r: 64, t: 10, b: 22 };
function frame(data, max, xLabel) {
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const x = (i) => PAD.l + (data.length === 1 ? iw / 2 : (i / (data.length - 1)) * iw), y = (v) => PAD.t + ih - (v / max) * ih;
  const svg = h('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  for (const t of [0, 0.5, 1]) {
    svg.append(h('line', { x1: PAD.l, x2: W - PAD.r, y1: y(max * t), y2: y(max * t), stroke: cssVar('grid'), 'stroke-width': 1 }), h('text', { x: PAD.l - 6, y: y(max * t) + 4, 'text-anchor': 'end' }, fmt.n(max * t)));
  }
  const every = Math.ceil(data.length / 6);
  data.forEach((d, i) => { if (i % every === 0) svg.append(h('text', { x: x(i), y: H - 5, 'text-anchor': 'middle' }, xLabel(d))); });
  return { svg, x, y, iw, ih };
}
function hover(wrap, svg, data, x, render) {
  const tip = h('div', { class: 'tip' }), cross = h('line', { y1: PAD.t, y2: H - PAD.b, stroke: cssVar('text-3'), 'stroke-width': 1, visibility: 'hidden' });
  svg.append(cross); wrap.append(tip);
  svg.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect(), px = ((e.clientX - box.left) / box.width) * W;
    let i = 0, best = Infinity; data.forEach((_, k) => { const d = Math.abs(x(k) - px); if (d < best) { best = d; i = k; } });
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    set(tip, render(data[i])); tip.style.display = 'block';
    const left = (x(i) / W) * box.width; tip.style.left = `${left > box.width * 0.6 ? left - tip.offsetWidth - 10 : left + 10}px`; tip.style.top = '8px';
  });
  svg.addEventListener('pointerleave', () => { tip.style.display = 'none'; cross.setAttribute('visibility', 'hidden'); });
}
const short = (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** Single-series daily bars (magnitude). */
export function barChart(data, key, label) {
  const max = niceMax(Math.max(...data.map((d) => d[key]), 1));
  const { svg, x, y, iw } = frame(data, max, (d) => short(d.date));
  const bw = Math.max(2, Math.min(22, iw / data.length - 2));
  data.forEach((d, i) => { if (!d[key]) return; const top = y(d[key]), r = Math.min(4, bw / 2, (H - PAD.b - top));
    svg.append(h('path', { fill: cssVar('series-1'), d: `M${x(i) - bw / 2},${H - PAD.b} V${top + r} Q${x(i) - bw / 2},${top} ${x(i) - bw / 2 + r},${top} H${x(i) + bw / 2 - r} Q${x(i) + bw / 2},${top} ${x(i) + bw / 2},${top + r} V${H - PAD.b} Z` })); });
  svg.setAttribute('aria-label', `${label} per day, last ${data.length} days`);
  const wrap = h('div', { class: 'chart' }, svg);
  hover(wrap, svg, data, x, (d) => [h('b', null, short(d.date)), h('div', null, `${label}: ${fmt.n(d[key])}`)]);
  wrap.append(dataTable(data.map((d) => ({ date: d.date, v: fmt.n(d[key]) })), [{ key: 'date', label: 'Date' }, { key: 'v', label, num: true }]));
  return wrap;
}
/** Multi-series daily lines sharing one count axis; legend + end labels + crosshair tooltip + table. */
export function lineChart(data, series) {
  const max = niceMax(Math.max(...data.flatMap((d) => series.map((s) => d[s.key])), 1));
  const { svg, x, y } = frame(data, max, (d) => short(d.date));
  const ends = series.map((s, si) => ({ s, si, y: y(data.at(-1)[s.key]) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
  series.forEach((s, si) => {
    svg.append(h('path', { fill: 'none', stroke: cssVar(`series-${si + 1}`), 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', d: data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[s.key]).toFixed(1)}` ).join(' ') }));
    svg.append(h('circle', { cx: x(data.length - 1), cy: y(data.at(-1)[s.key]), r: 4, fill: cssVar(`series-${si + 1}`), stroke: cssVar('surface'), 'stroke-width': 2 }));
  });
  for (const e of ends) svg.append(h('text', { x: W - PAD.r + 10, y: e.y + 4 }, e.s.label));
  svg.setAttribute('aria-label', `${series.map((s) => s.label).join(', ')} per day, last ${data.length} days`);
  const wrap = h('div', { class: 'chart' }, h('div', { class: 'legend' }, series.map((s, si) => h('span', null, h('i', { style: `background:var(--series-${si + 1})` }), s.label))), svg);
  hover(wrap, svg, data, x, (d) => [h('b', null, short(d.date)), ...series.map((s, si) => h('div', null, h('i', { style: `display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;background:var(--series-${si + 1})` }), `${s.label}: ${fmt.n(d[s.key])}`))]);
  wrap.append(dataTable(data.map((d) => ({ date: d.date, ...Object.fromEntries(series.map((s) => [s.key, fmt.n(d[s.key])])) })), [{ key: 'date', label: 'Date' }, ...series.map((s) => ({ key: s.key, label: s.label, num: true }))]));
  return wrap;
}
export const meter = (pct, label) => h('div', { class: 'row', style: 'flex-wrap:nowrap' }, h('div', { class: 'meter grow', role: 'img', 'aria-label': `${label ?? 'progress'} ${pct}%` }, h('i', { style: `width:${pct}%` })), h('span', { class: 'small muted', style: 'min-width:34px;text-align:right' }, `${pct}%`));
