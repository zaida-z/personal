import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { db, get, all, audit } from './db.js';
import { requireAuth, currentUser, createUser, login, startSession, endSession, bad } from './http.js';
import { core } from './api-core.js';
import { api } from './api-campaigns.js';
import { tracking } from './tracking.js';
import { tick } from './engine/scheduler.js';
import { syncAll } from './inbox/sync.js';
import { runDomainCheck } from './domains/health.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  db();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    next();
  });
  app.use(tracking);
  app.use('/api', (req, res, next) => (req.path.startsWith('/imports/parse') || req.path.startsWith('/imports/stage') ? next() : express.json({ limit: '2mb' })(req, res, next)));

  const secure = config.publicUrl.startsWith('https://');
  app.get('/api/session', (req, res) => res.json({ user: currentUser(req), needs_setup: !get('SELECT 1 x FROM users LIMIT 1') }));
  app.post('/api/setup', (req, res) => {
    if (get('SELECT 1 x FROM users LIMIT 1')) throw bad(409, 'Setup has already been completed');
    const id = createUser(req.body?.email, req.body?.password);
    audit('user.setup', { email: req.body.email }); startSession(res, id, secure); res.status(201).json({ ok: true });
  });
  app.post('/api/login', (req, res) => { const u = login(req.body?.email, req.body?.password, req.ip); startSession(res, u.id, secure); res.json({ ok: true }); });
  app.post('/api/logout', (req, res) => { endSession(req, res); res.json({ ok: true }); });
  app.use('/api', requireAuth, core, api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(express.static(path.join(here, '..', 'public'), { extensions: ['html'] }));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status || (err.type === 'entity.too.large' ? 413 : err.type === 'entity.parse.failed' ? 400 : 500);
    if (!err.status) console.error(err);
    // Errors we raise ourselves carry .status and a user-facing message; body-parser errors (.type) and
    // anything unexpected get a generic message so internals never reach the client.
    const message = err.type ? (status === 413 ? 'Request too large' : 'Malformed request body') : err.status ? err.message : 'Internal error';
    res.status(status).json({ error: message, ...(err.extra || {}) });
  });
  return app;
}

function every(seconds, name, fn) {
  let busy = false;
  setInterval(async () => { if (busy) return; busy = true; try { await fn(); } catch (err) { console.error(`[${name}]`, err.message); } finally { busy = false; } }, seconds * 1000).unref();
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`Outbound OS running at http://localhost:${config.port}`);
    if (!get('SELECT 1 x FROM users LIMIT 1')) console.log('First run: open the URL above to create your admin account.');
  });
  if (config.scheduler) {
    every(config.tickSeconds, 'sender', () => tick());
    every(config.inboxSyncSeconds, 'inbox', () => syncAll());
    every(config.domainMonitorHours * 3600, 'domains', async () => { for (const d of all('SELECT id FROM domains')) await runDomainCheck(d.id); });
  }
}
