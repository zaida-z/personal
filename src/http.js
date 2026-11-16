import { get, run, now } from './db.js';
import { sha256, token, hashPassword, verifyPassword } from './crypto.js';

export const bad = (status, message, extra = {}) => Object.assign(new Error(message), { status, extra });
export const int = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 0) throw bad(400, 'Invalid id'); return n; };
export const str = (v, max = 500) => (v == null ? null : String(v).trim().slice(0, max) || null);

const SESSION_DAYS = 14;
const cookieOf = (req) => (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith('sid='))?.slice(4);
export function currentUser(req) {
  const sid = cookieOf(req);
  if (!sid) return null;
  return get('SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?', sha256(sid), now()) ?? null;
}
export function startSession(res, userId, secure) {
  const sid = token(32);
  run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)', sha256(sid), userId, new Date(Date.now() + SESSION_DAYS * 864e5).toISOString());
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}
export function endSession(req, res) {
  const sid = cookieOf(req);
  if (sid) run('DELETE FROM sessions WHERE token_hash = ?', sha256(sid));
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}
export function createUser(email, password) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) throw bad(400, 'Enter a valid email address');
  if (String(password || '').length < 10) throw bad(400, 'Password must be at least 10 characters');
  return Number(run('INSERT INTO users (email, password_hash, created_at) VALUES (?,?,?)', email.toLowerCase(), hashPassword(password), now()).lastInsertRowid);
}
const attempts = new Map();
export function login(email, password, ip) {
  const key = `${ip}|${String(email).toLowerCase()}`;
  const a = attempts.get(key) ?? { n: 0, until: 0 };
  if (a.until > Date.now()) throw bad(429, 'Too many attempts. Try again in a few minutes.');
  const u = get('SELECT * FROM users WHERE email = ?', String(email || '').toLowerCase());
  const ok = verifyPassword(String(password || ''), u?.password_hash ?? 'scrypt.00.00') && Boolean(u);
  if (!ok) { a.n++; if (a.n >= 5) { a.until = Date.now() + 5 * 60e3; a.n = 0; } attempts.set(key, a); throw bad(401, 'Incorrect email or password'); }
  attempts.delete(key);
  return u;
}
/** Requires a session; state-changing requests must also carry the custom header (CSRF defence in depth). */
export function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-requested-with'] !== 'outbound-os') return res.status(403).json({ error: 'Missing request header' });
  req.user = user; next();
}

/** Tiny in-memory job tracker for long-running bulk work (verification). */
const jobs = new Map();
export function startJob(kind, total, worker) {
  const id = token(8);
  const job = { id, kind, total, done: 0, status: 'running', result: null, error: null };
  jobs.set(id, job);
  worker(job).then((r) => { job.status = 'done'; job.result = r ?? null; }, (e) => { job.status = 'failed'; job.error = String(e.message); });
  setTimeout(() => jobs.delete(id), 3600e3).unref();
  return job;
}
export const getJob = (id) => jobs.get(id);
