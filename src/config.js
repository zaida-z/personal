import fs from 'node:fs';
import path from 'node:path';

// Minimal .env loader (no dependency); real env vars win.
const envFile = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const e = process.env;
export const config = {
  port: Number(e.PORT || 4100),
  publicUrl: (e.PUBLIC_URL || `http://localhost:${e.PORT || 4100}`).replace(/\/$/, ''),
  dataDir: path.resolve(e.DATA_DIR || './data'),
  appSecret: e.APP_SECRET || '',
  aiModel: e.AI_MODEL || 'claude-opus-5-5',
  smtpProbe: e.SMTP_PROBE === 'on',
  smtpProbeHelo: e.SMTP_PROBE_HELO || '',
  smtpProbeFrom: e.SMTP_PROBE_FROM || '',
  dnsMode: e.DNS_MODE === 'doh' ? 'doh' : 'system',
  google: { clientId: e.GOOGLE_CLIENT_ID || '', clientSecret: e.GOOGLE_CLIENT_SECRET || '' },
  microsoft: { clientId: e.MICROSOFT_CLIENT_ID || '', clientSecret: e.MICROSOFT_CLIENT_SECRET || '' },
  scheduler: e.SCHEDULER !== 'off',
  tickSeconds: Number(e.TICK_SECONDS || 30),
  inboxSyncSeconds: Number(e.INBOX_SYNC_SECONDS || 120),
  domainMonitorHours: Number(e.DOMAIN_MONITOR_HOURS || 6),
  postalAddress: e.SENDER_POSTAL_ADDRESS || '',
};
