// Ontdek: openbare routebibliotheek. Top-10 wereldwijd + zoeken binnen een
// kaartgebied (bbox). Antwoorden altijd via de gedeelde serializer, met
// viewerId zodat `liked` klopt voor de ingelogde gebruiker.

import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import { routeSummary } from '../serialize.js';

export const discoverRouter = Router();

const SPORTS = new Set(['wandelen', 'fietsen', 'mtb']);

// LIKE-jokertekens in gebruikersinvoer onschadelijk maken.
function likeEscape(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

// Overlap tussen twee bbox'en [w, s, e, n].
function overlaps(a, w2, s2, e2, n2) {
  const [w, s, e, n] = a;
  return w <= e2 && e >= w2 && s <= n2 && n >= s2;
}

// Gedeelde selectie van publieke routes met optioneel sport/q-filter,
// gesorteerd op likes (desc) en daarna nieuwste eerst.
function selectPublic({ sport, q, limit }) {
  const where = ["r.visibility = 'public'"];
  const params = [];
  if (sport) { where.push('r.sport = ?'); params.push(sport); }
  if (q) {
    where.push("(LOWER(r.name) LIKE ? ESCAPE '\\' OR LOWER(r.region) LIKE ? ESCAPE '\\')");
    const like = '%' + likeEscape(q.toLowerCase()) + '%';
    params.push(like, like);
  }
  return db.prepare(`
    SELECT r.*, u.name AS owner_name,
      (SELECT COUNT(*) FROM route_likes rl WHERE rl.route_id = r.id) AS like_count
    FROM routes r
    JOIN users u ON u.id = r.user_id
    WHERE ${where.join(' AND ')}
    ORDER BY like_count DESC, r.created_at DESC
    LIMIT ?
  `).all(...params, limit);
}

// GET /api/discover?bbox=w,s,e,n&sport=&q=&limit=
discoverRouter.get('/', requireAuth, (req, res) => {
  const bboxRaw = typeof req.query.bbox === 'string' ? req.query.bbox.trim() : '';
  const box = bboxRaw.split(',').map(Number);
  if (box.length !== 4 || box.some((n) => !Number.isFinite(n))) {
    return res.status(400).json({ error: 'Geef een geldig kaartgebied op (bbox=w,s,e,n).' });
  }
  const [w2, s2, e2, n2] = box;

  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
  const sport = SPORTS.has(req.query.sport) ? req.query.sport : null;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

  // Ruime selectie ophalen (al gesorteerd), daarna in JS filteren op
  // bbox-overlap en pas dan afkappen op de gevraagde limiet.
  const rows = selectPublic({ sport, q, limit: 500 });

  const matched = [];
  for (const row of rows) {
    let bb = null;
    try { bb = row.bbox ? JSON.parse(row.bbox) : null; } catch { bb = null; }
    if (!Array.isArray(bb) || bb.length !== 4 || bb.some((n) => !Number.isFinite(n))) continue;
    if (overlaps(bb, w2, s2, e2, n2)) {
      matched.push(row);
      if (matched.length >= limit) break;
    }
  }

  res.json({ routes: matched.map((row) => routeSummary(row, req.user.id)) });
});

// GET /api/discover/top?sport=
discoverRouter.get('/top', requireAuth, (req, res) => {
  const sport = SPORTS.has(req.query.sport) ? req.query.sport : null;
  const rows = selectPublic({ sport, q: '', limit: 10 });
  res.json({ routes: rows.map((row) => routeSummary(row, req.user.id)) });
});
