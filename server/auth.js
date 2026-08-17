import { Router } from 'express';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { db } from './db.js';
import { cacheSet } from './cache.js';

const SESSION_DAYS = 90;
const COOKIE = 'gout_session';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };

// Verlopen sessies opruimen: de tabel groeide anders eeuwig (alleen logout
// verwijdert). Bij opstart en daarna elke 6 uur; .unref() zodat deze timer het
// proces niet levend houdt (bv. in tests/CLI).
function pruneSessions() {
  try { db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run(); }
  catch { /* best effort */ }
}
pruneSessions();
setInterval(pruneSessions, 6 * 3600_000).unref();

// --- wachtwoord-hashing met scrypt (ingebouwd, geen dependencies) ---
// Async i.p.v. scryptSync: één hash kost ~47 ms CPU en blokkeerde op de
// hoofdthread de event loop (400 loginpogingen bevroren de server ~19 s).
// crypto.scrypt rekent op de libuv-threadpool, dus de server blijft ondertussen
// andere verzoeken bedienen.
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 32, SCRYPT);
  return `s1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [v, saltB64, hashB64] = String(stored).split('$');
  if (v !== 's1' || !saltB64 || !hashB64) return false;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, salt, expected.length, SCRYPT);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// --- sessies ---

function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  // expires_at in hetzelfde formaat als datetime('now') (spatie, UTC, geen 'T'/'Z'):
  // vroeger stond hier een ISO-string ('...T...Z') die lexicografisch altijd
  // groter is dan datetime('now'), waardoor sessies tot ~24 u te laat verliepen
  // én nooit opgeruimd werden. SQLite berekent de vervaltijd zelf, één formaat.
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', ?))")
    .run(sha256(token), userId, `+${SESSION_DAYS} days`);
  const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https');
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=${SESSION_DAYS * 86400}`);
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
    const th = sha256(token);
    const row = db.prepare(`
      SELECT u.id, u.email, u.name, u.avatar_color
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > datetime('now')
    `).get(th);
    if (row) req.user = row;
    else {
      // Aangeboden token levert niets op: ruim een eventueel verlopen rij meteen
      // op (naast de periodieke pruneSessions), zodat verlopen sessies niet
      // blijven staan tot de volgende veegbeurt.
      try { db.prepare("DELETE FROM sessions WHERE token_hash = ? AND expires_at <= datetime('now')").run(th); }
      catch { /* best effort */ }
    }
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

// --- rate-limiter voor auth-endpoints (per IP én per e-mailadres) ---
// Twee tellers: per IP (grove rem) én per genormaliseerd e-mailadres, zodat een
// account beschermd blijft ook als veel gebruikers achter dezelfde proxy-IP
// zitten en 400 pogingen op één account sowieso geweigerd worden. De mappen
// worden begrensd (cacheSet) en periodiek geveegd i.p.v. O(n) bij ELK verzoek —
// met veel unieke sleutels werd elke login anders steeds trager.
const RL_WINDOW = 60_000;
const RL_MAX_KEYS = 5000;
const RL_IP_MAX = 20;
const RL_EMAIL_MAX = 10;
const ipHits = new Map();
const emailHits = new Map();

function sweep(map) {
  const now = Date.now();
  for (const [k, v] of map) if (now - v.t > RL_WINDOW) map.delete(k);
}
setInterval(() => { sweep(ipHits); sweep(emailHits); }, RL_WINDOW).unref();

function overLimit(map, key, max) {
  const now = Date.now();
  let e = map.get(key);
  if (!e || now - e.t > RL_WINDOW) e = { n: 0, t: now };
  e.n += 1;
  cacheSet(map, key, e, { max: RL_MAX_KEYS, ttl: RL_WINDOW });
  return e.n > max;
}

function rateLimitIp(req, res, next) {
  if (overLimit(ipHits, req.ip || 'x', RL_IP_MAX))
    return res.status(429).json({ error: 'Te veel pogingen, wacht even.' });
  next();
}

function rateLimitEmail(req, res, next) {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (email && overLimit(emailHits, email, RL_EMAIL_MAX))
    return res.status(429).json({ error: 'Te veel pogingen voor dit account, wacht even.' });
  next();
}

// --- routes ---

export const authRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_MAX = 80;
const EMAIL_MAX = 254; // RFC 5321-bovengrens

authRouter.post('/register', rateLimitIp, rateLimitEmail, async (req, res, next) => {
  try {
    const { email, name, password } = req.body || {};
    const mail = String(email || '').trim();
    if (!mail || !EMAIL_RE.test(mail))
      return res.status(400).json({ error: 'Geef een geldig e-mailadres op.' });
    if (mail.length > EMAIL_MAX)
      return res.status(400).json({ error: 'Dat e-mailadres is te lang.' });
    const naam = String(name || '').trim();
    if (naam.length < 2)
      return res.status(400).json({ error: 'Geef een naam op (min. 2 tekens).' });
    if (naam.length > NAME_MAX)
      return res.status(400).json({ error: `Je naam mag hoogstens ${NAME_MAX} tekens lang zijn.` });
    if (!password || String(password).length < 8)
      return res.status(400).json({ error: 'Wachtwoord moet minstens 8 tekens lang zijn.' });

    // Bestaanscheck VÓÓR de dure hash: scheelt ~47 ms werk bij een bezet adres.
    const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(mail);
    if (exists) return res.status(400).json({ error: 'Er bestaat al een account met dit e-mailadres.' });

    const colors = ['#3d5a3c', '#b04a17', '#33586e', '#6b4a7a', '#7a6210'];
    const passHash = await hashPassword(String(password));
    const info = db.prepare(
      'INSERT INTO users (email, name, pass_hash, avatar_color) VALUES (?, ?, ?, ?)'
    ).run(mail, naam, passHash, colors[Math.floor(Math.random() * colors.length)]);
    createSession(req, res, Number(info.lastInsertRowid));
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid));
    res.json({ user: publicUser(u) });
  } catch (err) { next(err); }
});

authRouter.post('/login', rateLimitIp, rateLimitEmail, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim());
    if (!u || !(await verifyPassword(String(password || ''), u.pass_hash)))
      return res.status(401).json({ error: 'E-mailadres of wachtwoord klopt niet.' });
    createSession(req, res, u.id);
    res.json({ user: publicUser(u) });
  } catch (err) { next(err); }
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

authRouter.put('/profile', requireAuth, async (req, res, next) => {
  try {
    const { name, avatarColor, currentPassword, newPassword } = req.body || {};
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    let otherSessionsEnded;
    if (newPassword) {
      if (!currentPassword || !(await verifyPassword(String(currentPassword), u.pass_hash)))
        return res.status(400).json({ error: 'Huidig wachtwoord klopt niet.' });
      if (String(newPassword).length < 8)
        return res.status(400).json({ error: 'Nieuw wachtwoord moet minstens 8 tekens lang zijn.' });
      const passHash = await hashPassword(String(newPassword));
      db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(passHash, u.id);
      // Na een wachtwoordwijziging alle ANDERE sessies uitloggen (huidige behouden),
      // zodat een meegelezen/gestolen cookie niet 90 dagen blijft doorwerken.
      const currentToken = readToken(req);
      const th = currentToken ? sha256(currentToken) : '';
      const r = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(u.id, th);
      otherSessionsEnded = Number(r.changes) || 0;
    }
    if (name !== undefined) {
      const naam = String(name).trim();
      if (naam.length > NAME_MAX)
        return res.status(400).json({ error: `Je naam mag hoogstens ${NAME_MAX} tekens lang zijn.` });
      if (naam.length >= 2)
        db.prepare('UPDATE users SET name = ? WHERE id = ?').run(naam, u.id);
    }
    if (avatarColor && /^#[0-9a-fA-F]{6}$/.test(avatarColor))
      db.prepare('UPDATE users SET avatar_color = ? WHERE id = ?').run(avatarColor, u.id);

    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
    const body = { user: publicUser(updated) };
    // Optioneel extra veld (JSON-vorm blijft compatibel): laat de UI weten dat
    // andere sessies zijn afgemeld.
    if (otherSessionsEnded !== undefined) body.otherSessionsEnded = otherSessionsEnded;
    res.json(body);
  } catch (err) { next(err); }
});
