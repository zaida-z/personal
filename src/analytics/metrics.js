// Analytics. Two kinds of numbers come out of here and they are never mixed:
//   measured  - counted from events this system observed (sends accepted by SMTP, bounces, replies, clicks...)
//   estimated - derived (e.g. "delivered" = sent - bounces; we cannot observe inbox placement)
// Sandbox (simulated) activity is only ever returned when mode=sandbox.
import { all, get } from '../db.js';

function where(f, alias = '') {
  const p = alias ? alias + '.' : '';
  const cond = [`${p}simulated = ?`], args = [f.mode === 'sandbox' ? 1 : 0];
  if (f.campaign_id) { cond.push(`${p}campaign_id = ?`); args.push(Number(f.campaign_id)); }
  if (f.account_id) { cond.push(`${p}account_id = ?`); args.push(Number(f.account_id)); }
  if (f.from) { cond.push(`${p}created_at >= ?`); args.push(f.from); }
  if (f.to) { cond.push(`${p}created_at < ?`); args.push(f.to); }
  return { sql: cond.join(' AND '), args };
}
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

export function shape(c) {
  const sent = c.sent || 0;
  const bounces = (c.bounce_hard || 0) + (c.bounce_soft || 0);
  const delivered = Math.max(0, sent - bounces);
  const pos = c.reply_interested || 0, neg = (c.reply_not_interested || 0);
  return {
    measured: {
      sent, send_failed: c.send_failed || 0, blocked_by_validation: c.blocked || 0,
      bounces, hard_bounces: c.bounce_hard || 0, soft_bounces: c.bounce_soft || 0,
      replies: c.reply || 0, positive_replies: pos, negative_replies: neg, auto_replies: c.auto_reply || 0,
      unsubscribes: c.unsubscribe || 0, spam_complaints: c.complaint || 0, meetings_booked: c.meeting_booked || 0,
      clicks: c.click || 0, unique_clickers: c.unique_clickers || 0, suspected_bot_clicks: c.click_bot || 0,
    },
    estimated: { delivered, note: 'Delivered = sent minus recorded bounces. It means "not rejected", not "reached the inbox": spam-folder placement is invisible to senders.' },
    rates: {
      bounce_rate: pct(bounces, sent), hard_bounce_rate: pct(c.bounce_hard || 0, sent), reply_rate: pct(c.reply || 0, delivered),
      positive_reply_rate: pct(pos, delivered), click_rate: pct(c.unique_clickers || 0, delivered), unsubscribe_rate: pct(c.unsubscribe || 0, delivered),
      complaint_rate: pct(c.complaint || 0, sent), meeting_rate: pct(c.meeting_booked || 0, delivered),
      lead_to_meeting_conversion: pct(c.meeting_booked || 0, c.leads_contacted || 0),
    },
    leads_contacted: c.leads_contacted || 0,
  };
}

function counts(f, groupExpr = null) {
  const w = where(f, 'e');
  const g = groupExpr ? `${groupExpr} AS grp,` : '';
  const rows = all(`SELECT ${g} e.type, COUNT(*) n, COUNT(DISTINCT e.lead_id) leads,
      SUM(CASE WHEN e.type = 'click' AND json_extract(e.meta, '$.bot') = 1 THEN 1 ELSE 0 END) bots,
      COUNT(DISTINCT CASE WHEN e.type = 'click' AND COALESCE(json_extract(e.meta, '$.bot'), 0) = 0 THEN e.lead_id END) human_leads
    FROM events e WHERE ${w.sql} GROUP BY ${groupExpr ? 'grp,' : ''} e.type`, ...w.args);
  // Reply sentiment uses the *current* label on the message so manual corrections are reflected.
  const mw = where(f, 'm');
  const labels = all(`SELECT ${groupExpr ? groupExpr.replace(/\be\./g, 'm.') + ' AS grp,' : ''} m.classification label, COUNT(*) n FROM messages m
     WHERE m.direction = 'in' AND ${mw.sql} GROUP BY ${groupExpr ? 'grp,' : ''} m.classification`, ...mw.args);
  const out = new Map();
  const bucket = (k) => { if (!out.has(k)) out.set(k, {}); return out.get(k); };
  for (const r of rows) {
    const b = bucket(r.grp ?? '_');
    if (r.type === 'click') { b.click = r.n - r.bots; b.click_bot = r.bots; b.unique_clickers = r.human_leads; }
    else b[r.type] = r.n;
    if (r.type === 'sent') b.leads_contacted = r.leads;
  }
  for (const r of labels) bucket(r.grp ?? '_')[`reply_${r.label}`] = r.n;
  return out;
}

export const summary = (f) => shape(counts(f).get('_') ?? {});

const GROUPS = {
  campaign: { expr: 'e.campaign_id', name: (id) => get('SELECT name FROM campaigns WHERE id = ?', id)?.name },
  account: { expr: 'e.account_id', name: (id) => get('SELECT email FROM accounts WHERE id = ?', id)?.email },
  domain: { expr: 'e.domain', name: (d) => d },
  day: { expr: 'substr(e.created_at, 1, 10)', name: (d) => d },
  variant: { expr: 'e.variant_id', name: (id) => { const v = get('SELECT v.label, s.position FROM variants v JOIN steps s ON s.id = v.step_id WHERE v.id = ?', id); return v ? `Step ${v.position + 1} · ${v.label}` : null; } },
  step: { expr: 'e.step_id', name: (id) => { const s = get('SELECT position FROM steps WHERE id = ?', id); return s ? `Step ${s.position + 1}` : null; } },
};
export function breakdown(f, by) {
  const g = GROUPS[by];
  if (!g) throw Object.assign(new Error(`Unknown breakdown "${by}"`), { status: 400 });
  // Domain-level events only exist where an account was involved; messages have no domain column.
  const expr = by === 'domain' ? "(SELECT substr(a.email, instr(a.email, '@') + 1) FROM accounts a WHERE a.id = e.account_id)" : g.expr;
  return [...counts(f, expr)].filter(([k]) => k !== null && k !== '_').map(([key, c]) => ({ key, name: g.name(key) ?? `#${key}`, ...shape(c) }))
    .sort((a, b) => (by === 'day' ? String(a.key).localeCompare(String(b.key)) : b.measured.sent - a.measured.sent));
}

/** Daily series with zero-filled gaps so charts do not interpolate across missing days. */
export function timeseries(f, days = 30) {
  const from = new Date(Date.now() - (days - 1) * 864e5).toISOString().slice(0, 10);
  const rows = new Map(breakdown({ ...f, from: f.from ?? from }, 'day').map((r) => [r.key, r]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    const m = rows.get(d)?.measured;
    out.push({ date: d, sent: m?.sent ?? 0, replies: m?.replies ?? 0, clicks: m?.unique_clickers ?? 0, bounces: m?.bounces ?? 0, unsubscribes: m?.unsubscribes ?? 0, meetings: m?.meetings_booked ?? 0 });
  }
  return out;
}

/** Per-campaign sequence progress for the dashboard. */
export function campaignProgress(mode) {
  return all(`SELECT c.id, c.name, c.status, c.daily_limit, c.launched_at,
      (SELECT COUNT(*) FROM steps s WHERE s.campaign_id = c.id) steps,
      COUNT(cl.id) leads,
      SUM(cl.status = 'completed') completed, SUM(cl.status = 'replied') replied, SUM(cl.status IN ('pending','active')) in_progress,
      SUM(cl.status = 'bounced') bounced, SUM(cl.status = 'unsubscribed') unsubscribed, SUM(cl.status IN ('skipped','failed')) stopped,
      SUM(cl.current_step) steps_done
    FROM campaigns c LEFT JOIN campaign_leads cl ON cl.campaign_id = c.id GROUP BY c.id ORDER BY c.id DESC`).map((c) => {
    const simulated = Boolean(get("SELECT 1 x FROM campaign_accounts ca JOIN accounts a ON a.id = ca.account_id WHERE ca.campaign_id = ? AND a.provider = 'sandbox' LIMIT 1", c.id));
    const total = (c.leads || 0) * (c.steps || 0);
    return { ...c, simulated, progress_pct: total ? Math.min(100, Math.round(((c.steps_done || 0) / total) * 100)) : 0, stats: summary({ mode: simulated ? 'sandbox' : 'real', campaign_id: c.id }) };
  }).filter((c) => (mode === 'sandbox' ? c.simulated : mode === 'real' ? !c.simulated : true));
}

const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" + s : s).replace(/"/g, '""')}"` : s; };
export const toCsv = (rows) => (rows.length ? [Object.keys(rows[0]).join(','), ...rows.map((r) => Object.values(r).map(csvCell).join(','))].join('\n') : '');
export function exportRows(f, by) {
  return breakdown(f, by).map((r) => ({ [by]: r.name, data_source: f.mode === 'sandbox' ? 'SIMULATED (sandbox)' : 'measured',
    ...r.measured, delivered_ESTIMATED: r.estimated.delivered, ...Object.fromEntries(Object.entries(r.rates).map(([k, v]) => [k + '_pct', v ?? ''])) }));
}
