import { Router } from 'express';
import crypto from 'node:crypto';
import { db } from './db.js';

const SESSION_DAYS = 90;
const COOKIE = 'gout_session';

// --- wachtwoord-hashing met scrypt (ingebouwd, geen dependencies) ---

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `s1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [v, saltB64, hashB64] = String(stored).split('$');
  if (v !== 's1' || !saltB64 || !hashB64) return false;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, salt, expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// --- sessies ---

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, expires.toISOString());
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
}

function readToken(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COOKIE) return rest.join('=');
  }
  return null;
}

export function sessionMiddleware(req, _res, next) {
  req.user = null;
  const token = readToken(req);
  if (token) {
    const row = db.prepare(`
      SELECT u.id, u.email, u.name, u.avatar_color
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > datetime('now')
    `).get(sha256(token));
    if (row) req.user = row;
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Niet ingelogd' });
  next();
}

export const publicUser = (u) => ({
  id: u.id, email: u.email, name: u.name, avatarColor: u.avatar_color,
});

// --- eenvoudige rate-limiter voor auth-endpoints ---

const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || 'x';
  const entry = hits.get(key) || { n: 0, t: now };
  if (now - entry.t > 60_000) { entry.n = 0; entry.t = now; }
  if (++entry.n > 20) return res.status(429).json({ error: 'Te veel pogingen, wacht even.' });
  hits.set(key, entry);
  next();
}

// --- routes ---

export const authRouter = Router();

authRouter.post('/register', rateLimit, (req, res) => {
  const { email, name, password } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Geef een geldig e-mailadres op.' });
  if (!name || String(name).trim().length < 2)
    return res.status(400).json({ error: 'Geef een naam op (min. 2 tekens).' });
  if (!password || String(password).length < 8)
    return res.status(400).json({ error: 'Wachtwoord moet minstens 8 tekens lang zijn.' });

  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(String(email).trim());
  if (exists) return res.status(400).json({ error: 'Er bestaat al een account met dit e-mailadres.' });

  const colors = ['#3d5a3c', '#b04a17', '#33586e', '#6b4a7a', '#7a6210'];
  const info = db.prepare(
    'INSERT INTO users (email, name, pass_hash, avatar_color) VALUES (?, ?, ?, ?)'
  ).run(String(email).trim(), String(name).trim(), hashPassword(String(password)),
        colors[Math.floor(Math.random() * colors.length)]);
  createSession(res, Number(info.lastInsertRowid));
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid));
  res.json({ user: publicUser(u) });
});

authRouter.post('/login', rateLimit, (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim());
  if (!u || !verifyPassword(String(password || ''), u.pass_hash))
    return res.status(401).json({ error: 'E-mailadres of wachtwoord klopt niet.' });
  createSession(res, u.id);
  res.json({ user: publicUser(u) });
});

authRouter.post('/logout', (req, res) => {
  const token = readToken(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  res.json({ user: req.user ? publicUser({ ...req.user, avatar_color: req.user.avatar_color }) : null });
});

authRouter.put('/profile', requireAuth, (req, res) => {
  const { name, avatarColor, currentPassword, newPassword } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  if (newPassword) {
    if (!currentPassword || !verifyPassword(String(currentPassword), u.pass_hash))
      return res.status(400).json({ error: 'Huidig wachtwoord klopt niet.' });
    if (String(newPassword).length < 8)
      return res.status(400).json({ error: 'Nieuw wachtwoord moet minstens 8 tekens lang zijn.' });
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?')
      .run(hashPassword(String(newPassword)), u.id);
  }
  if (name && String(name).trim().length >= 2)
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(String(name).trim(), u.id);
  if (avatarColor && /^#[0-9a-fA-F]{6}$/.test(avatarColor))
    db.prepare('UPDATE users SET avatar_color = ? WHERE id = ?').run(avatarColor, u.id);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
  res.json({ user: publicUser(updated) });
});
