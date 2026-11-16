import { j, run } from '../db.js';
import { token } from '../crypto.js';
import { config } from '../config.js';
import { VAR_RE } from '../ai/lint.js';

export const SENDER_VARS = ['sender_name', 'sender_email', 'sender_first_name'];
export const LEAD_VARS = ['first_name', 'last_name', 'email', 'company', 'title', 'website', 'country'];

export function leadContext(lead, account = {}) {
  return {
    ...j(lead.custom, {}),
    ...Object.fromEntries(LEAD_VARS.map((k) => [k, lead[k]])),
    sender_name: account.from_name || '', sender_email: account.email || '', sender_first_name: (account.from_name || '').split(' ')[0] || '',
  };
}
const has = (ctx, k) => ctx[k] != null && String(ctx[k]).trim() !== '';

/**
 * Render a template. Supports {{var}}, {{var|fallback}} and {{#if var}}..{{else}}..{{/if}}.
 * Returns the variables that were required but empty, so callers can refuse to send.
 */
export function render(template, ctx) {
  const missing = new Set();
  let out = String(template ?? '');
  let prev;
  do { // innermost-first so blocks can nest
    prev = out;
    out = out.replace(/\{\{\s*#if\s+([\w.]+)\s*\}\}((?:(?!\{\{\s*#if)[\s\S])*?)\{\{\s*\/if\s*\}\}/g, (_, name, inner) => {
      const [yes, no = ''] = inner.split(/\{\{\s*else\s*\}\}/);
      return has(ctx, name) ? yes : no;
    });
  } while (out !== prev);
  out = out.replace(VAR_RE, (_, name, fallback) => {
    if (has(ctx, name)) return String(ctx[name]).trim();
    if (fallback !== undefined) return fallback.trim();
    missing.add(name);
    return '';
  });
  return { text: out, missing: [...missing] };
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const URL_RE = /https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g;

/**
 * Build the final text + HTML parts. Adds signature, a working unsubscribe link and the postal
 * address. Click tracking rewrites links in the HTML part only; the text part keeps real URLs.
 */
export function composeBodies({ bodyText, account, unsubToken, messageId, trackClicks }) {
  const unsubUrl = `${config.publicUrl}/u/${unsubToken}`;
  const footer = [`If you'd rather not hear from me, unsubscribe here: ${unsubUrl}`, config.postalAddress].filter(Boolean).join('\n');
  const text = [bodyText.trim(), account.signature?.trim(), footer].filter(Boolean).join('\n\n');
  const linkify = (chunk) => {
    let html = '', last = 0;
    for (const m of chunk.matchAll(URL_RE)) {
      html += esc(chunk.slice(last, m.index));
      let href = m[0];
      if (trackClicks && messageId && !href.startsWith(config.publicUrl)) {
        const t = token(12);
        run('INSERT INTO links (token, message_id, url) VALUES (?,?,?)', t, messageId, href);
        href = `${config.publicUrl}/c/${t}`;
      }
      html += `<a href="${esc(href)}">${esc(m[0])}</a>`;
      last = m.index + m[0].length;
    }
    return (html + esc(chunk.slice(last))).replace(/\n/g, '<br>\n');
  };
  const main = [bodyText.trim(), account.signature?.trim()].filter(Boolean).join('\n\n');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">${linkify(main)}<br><br><span style="color:#777;font-size:12px">If you'd rather not hear from me, <a href="${esc(unsubUrl)}">unsubscribe here</a>.${config.postalAddress ? '<br>' + esc(config.postalAddress) : ''}</span></div>`;
  return { text, html, unsubUrl };
}

/** Deterministic weighted variant pick so a lead always gets the same A/B arm for a step. */
export function pickVariant(variants, leadId) {
  const total = variants.reduce((s, v) => s + Math.max(0, v.weight), 0);
  if (!total) return variants[0];
  let n = (leadId * 2654435761) % total;
  for (const v of variants) { n -= Math.max(0, v.weight); if (n < 0) return v; }
  return variants[0];
}
