// DNS access behind one small interface so every check can be tested with fixtures
// and so "the lookup failed" is never confused with "the record does not exist".
import { Resolver } from 'node:dns/promises';
import { config } from '../config.js';

export class DnsError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}
const NOT_FOUND = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

function systemResolver(servers) {
  const r = new Resolver({ timeout: 4000, tries: 2 });
  if (servers) r.setServers(servers);
  return async (name, type) => {
    try {
      if (type === 'MX') return (await r.resolveMx(name)).sort((a, b) => a.priority - b.priority);
      if (type === 'TXT') return (await r.resolveTxt(name)).map((chunks) => chunks.join(''));
      if (type === 'A') return await r.resolve4(name);
      if (type === 'AAAA') return await r.resolve6(name);
      throw new DnsError('EBADTYPE');
    } catch (err) {
      if (NOT_FOUND.has(err.code)) return [];
      throw new DnsError(err.code || 'EDNS', `DNS ${type} ${name}: ${err.code || err.message}`);
    }
  };
}
const DOH = { cloudflare: 'https://cloudflare-dns.com/dns-query', google: 'https://dns.google/resolve' };
function dohResolver(endpoint) {
  return async (name, type) => {
    let body;
    try {
      const res = await fetch(`${endpoint}?name=${encodeURIComponent(name)}&type=${type}`, {
        headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.json();
    } catch (err) { throw new DnsError('EDOH', `DoH ${type} ${name}: ${err.message}`); }
    if (body.Status === 3) return [];
    if (body.Status !== 0) throw new DnsError('ESERVFAIL', `DoH ${type} ${name}: rcode ${body.Status}`);
    const code = { MX: 15, TXT: 16, A: 1, AAAA: 28 }[type];
    const answers = (body.Answer || []).filter((a) => a.type === code).map((a) => a.data);
    if (type === 'MX') return answers.map((d) => { const [p, ex] = d.split(' '); return { priority: Number(p), exchange: ex.replace(/\.$/, '') }; }).sort((a, b) => a.priority - b.priority);
    if (type === 'TXT') return answers.map((d) => d.replace(/^"|"$/g, '').replace(/" "/g, ''));
    return answers;
  };
}

/** resolve(name, type) -> array (empty = authoritative "no such record"); throws DnsError when the lookup itself failed. */
let _resolve;
export function resolve(name, type) {
  _resolve ??= config.dnsMode === 'doh' ? dohResolver(DOH.cloudflare) : systemResolver();
  return _resolve(name, type);
}
export function setResolver(fn) { _resolve = fn; }

/** Independent vantage points used by the propagation check. */
export function vantagePoints() {
  return config.dnsMode === 'doh'
    ? { cloudflare: dohResolver(DOH.cloudflare), google: dohResolver(DOH.google) }
    : { cloudflare: systemResolver(['1.1.1.1']), google: systemResolver(['8.8.8.8']), quad9: systemResolver(['9.9.9.9']) };
}
let _vantage;
export function getVantagePoints() { return _vantage ?? vantagePoints(); }
export function setVantagePoints(v) { _vantage = v; }
