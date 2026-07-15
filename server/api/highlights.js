// Highlights ("toppertjes"): community-segmenten die je op de kaart aanbeveelt.
// Aanmaken, zoeken binnen een kaartgebied (bbox) en stemmen (duim). Antwoorden
// altijd via highlightSummary uit serialize.js (camelCase), met viewerId zodat
// `voted`/`isOwner` klopt voor de ingelogde gebruiker.

import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import { bboxOf } from '../geo.js';
import { highlightSummary } from '../serialize.js';

export const highlightsRouter = Router();

const SPORTS = ['wandelen', 'fietsen', 'mtb', 'alle'];
// Alleen op deze sporten kan het zoekfilter draaien (zoals bij discover); een
// 'alle'-highlight matcht elk van deze filters.
const QUERY_SPORTS = new Set(['wandelen', 'fietsen', 'mtb']);
// Ruime voorselectie (al gesorteerd) waaruit we in JS op bbox filteren.
const POOL = 1000;
// Maximaal aantal highlights in het antwoord.
const MAX_RESULTS = 200;

/* ---------- validatie ---------- */

function nameError(name) {
  if (typeof name !== 'string') return 'Geef een naam op.';
  const n = name.trim();
  if (n.length < 1) return 'Geef een naam op.';
  if (n.length > 80) return 'De naam mag hoogstens 80 tekens lang zijn.';
  return null;
}

function descriptionError(description) {
  if (typeof description !== 'string' || description.length > 500)
    return 'De beschrijving is te lang (max. 500 tekens).';
  return null;
}

function trackError(track) {
  if (!Array.isArray(track)) return 'Ongeldige track.';
  if (track.length < 2) return 'Een highlight heeft minstens 2 punten nodig.';
  if (track.length > 2000) return 'Dit segment is te lang (max. 2000 punten).';
  for (const p of track) {
    if (!Array.isArray(p) || p.length < 2) return 'Ongeldig trackpunt.';
    const [lon, lat, ele] = p;
    if (typeof lon !== 'number' || typeof lat !== 'number' || Number.isNaN(lon) || Number.isNaN(lat))
      return 'Ongeldige coördinaten in de track.';
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90)
      return 'Coördinaten liggen buiten bereik.';
    if (ele !== undefined && ele !== null && (typeof ele !== 'number' || Number.isNaN(ele)))
      return 'Ongeldige hoogte in de track.';
  }
  return null;
}

/* ---------- helpers ---------- */

function fetchHighlight(id) {
  if (!Number.isInteger(id)) return undefined;
  return db.prepare(
    'SELECT h.*, u.name AS owner_name FROM highlights h JOIN users u ON u.id = h.user_id WHERE h.id = ?'
  ).get(id);
}

function votesInfo(highlightId, viewerId) {
  const votes = db.prepare('SELECT COUNT(*) AS c FROM highlight_votes WHERE highlight_id = ?').get(highlightId).c;
  const voted = !!db.prepare('SELECT 1 AS x FROM highlight_votes WHERE highlight_id = ? AND user_id = ?')
    .get(highlightId, viewerId);
  return { votes, voted };
}

// Mutaties alleen door de eigenaar; bestaan van andermans highlight niet
// lekken (altijd 404 voor niet-eigenaars).
function requireOwner(row, req, res) {
  if (!row || row.user_id !== req.user.id) {
    res.status(404).json({ error: 'Highlight niet gevonden.' });
    return false;
  }
  return true;
}

// Overlap tussen twee bbox'en [w, s, e, n] (zoals in discover).
function overlaps(a, w2, s2, e2, n2) {
  const [w, s, e, n] = a;
  return w <= e2 && e >= w2 && s <= n2 && n >= s2;
}

/* ---------- lijst (zoeken op gebied) & aanmaken ---------- */

// GET /api/highlights?bbox=w,s,e,n&sport=
highlightsRouter.get('/', requireAuth, (req, res) => {
  const bboxRaw = typeof req.query.bbox === 'string' ? req.query.bbox.trim() : '';
  const box = bboxRaw.split(',').map(Number);
  if (box.length !== 4 || box.some((n) => !Number.isFinite(n))) {
    return res.status(400).json({ error: 'Geef een geldig kaartgebied op (bbox=w,s,e,n).' });
  }
  const [w2, s2, e2, n2] = box;
  const sport = QUERY_SPORTS.has(req.query.sport) ? req.query.sport : null;

  const where = [];
  const params = [];
  if (sport) { where.push("(h.sport = ? OR h.sport = 'alle')"); params.push(sport); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  // Voorselectie op stemmen (desc) en daarna nieuwste eerst; pas in JS filteren
  // op bbox-overlap en afkappen op de gevraagde limiet.
  const rows = db.prepare(`
    SELECT h.*, u.name AS owner_name,
      (SELECT COUNT(*) FROM highlight_votes hv WHERE hv.highlight_id = h.id) AS vote_count
    FROM highlights h
    JOIN users u ON u.id = h.user_id
    ${whereSql}
    ORDER BY vote_count DESC, h.created_at DESC
    LIMIT ?
  `).all(...params, POOL);

  const matched = [];
  for (const row of rows) {
    let bb = null;
    try { bb = row.bbox ? JSON.parse(row.bbox) : null; } catch { bb = null; }
    if (!Array.isArray(bb) || bb.length !== 4 || bb.some((n) => !Number.isFinite(n))) continue;
    if (overlaps(bb, w2, s2, e2, n2)) {
      matched.push(row);
      if (matched.length >= MAX_RESULTS) break;
    }
  }

  res.json({ highlights: matched.map((row) => highlightSummary(row, req.user.id)) });
});

// POST /api/highlights
highlightsRouter.post('/', requireAuth, (req, res) => {
  const b = req.body || {};
  const ne = nameError(b.name); if (ne) return res.status(400).json({ error: ne });
  const description = b.description === undefined || b.description === null ? '' : b.description;
  const de = descriptionError(description); if (de) return res.status(400).json({ error: de });
  if (!SPORTS.includes(b.sport)) return res.status(400).json({ error: 'Kies een geldige sport.' });
  const te = trackError(b.track); if (te) return res.status(400).json({ error: te });

  const bbox = bboxOf(b.track);
  const start = b.track[0];
  const info = db.prepare(`
    INSERT INTO highlights (user_id, name, description, sport, track, start_lat, start_lon, bbox)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.user.id, b.name.trim(), description, b.sport, JSON.stringify(b.track),
    start[1], start[0], JSON.stringify(bbox),
  );
  const row = fetchHighlight(Number(info.lastInsertRowid));
  res.status(201).json({ highlight: highlightSummary(row, req.user.id) });
});

/* ---------- stemmen (duim) ---------- */

function voteGuard(req, res) {
  const row = fetchHighlight(Number(req.params.id));
  if (!row) { res.status(404).json({ error: 'Highlight niet gevonden.' }); return null; }
  if (row.user_id === req.user.id) {
    res.status(400).json({ error: 'Je kan niet op je eigen highlight stemmen.' });
    return null;
  }
  return row;
}

highlightsRouter.post('/:id/vote', requireAuth, (req, res) => {
  const row = voteGuard(req, res); if (!row) return;
  db.prepare('INSERT OR IGNORE INTO highlight_votes (highlight_id, user_id) VALUES (?, ?)').run(row.id, req.user.id);
  res.json(votesInfo(row.id, req.user.id));
});

highlightsRouter.delete('/:id/vote', requireAuth, (req, res) => {
  const row = voteGuard(req, res); if (!row) return;
  db.prepare('DELETE FROM highlight_votes WHERE highlight_id = ? AND user_id = ?').run(row.id, req.user.id);
  res.json(votesInfo(row.id, req.user.id));
});

/* ---------- wijzigen & verwijderen (alleen eigenaar) ---------- */

highlightsRouter.put('/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = fetchHighlight(id);
  if (!requireOwner(row, req, res)) return;
  const b = req.body || {};
  const sets = [];
  const args = [];

  if (b.name !== undefined) {
    const ne = nameError(b.name); if (ne) return res.status(400).json({ error: ne });
    sets.push('name = ?'); args.push(b.name.trim());
  }
  if (b.description !== undefined) {
    const de = descriptionError(b.description); if (de) return res.status(400).json({ error: de });
    sets.push('description = ?'); args.push(b.description);
  }
  if (b.sport !== undefined) {
    if (!SPORTS.includes(b.sport)) return res.status(400).json({ error: 'Kies een geldige sport.' });
    sets.push('sport = ?'); args.push(b.sport);
  }

  if (sets.length) {
    args.push(id);
    db.prepare(`UPDATE highlights SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }
  res.json({ highlight: highlightSummary(fetchHighlight(id), req.user.id) });
});

highlightsRouter.delete('/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = fetchHighlight(id);
  if (!requireOwner(row, req, res)) return;
  db.prepare('DELETE FROM highlights WHERE id = ?').run(id);
  res.json({ ok: true });
});
