// Routes-API: CRUD, GPX-download, delen (share-token), likes en de publieke
// deelpagina. Alle antwoorden via de serializers uit serialize.js (camelCase).

import { Router } from 'express';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import { routeStats, preview } from '../geo.js';
import { buildGpx, gpxFilename } from '../gpx.js';
import { routeSummary, routeFull } from '../serialize.js';

export const routesRouter = Router();
export const sharedRouter = Router();

const SPORTS = ['wandelen', 'fietsen', 'mtb'];
const VISIBILITIES = ['private', 'public'];

/* ---------- validatie ---------- */

function nameError(name) {
  if (typeof name !== 'string') return 'Geef een routenaam op.';
  const n = name.trim();
  if (n.length < 1) return 'Geef een routenaam op.';
  if (n.length > 120) return 'De naam mag hoogstens 120 tekens lang zijn.';
  return null;
}

function trackError(track) {
  if (!Array.isArray(track)) return 'Ongeldige track.';
  if (track.length < 2) return 'Een route heeft minstens 2 punten nodig.';
  if (track.length > 100000) return 'Deze track is te groot (max. 100.000 punten).';
  for (const p of track) {
    if (!Array.isArray(p) || p.length < 2) return 'Ongeldig trackpunt.';
    const [lon, lat, ele, t] = p;
    if (typeof lon !== 'number' || typeof lat !== 'number' || Number.isNaN(lon) || Number.isNaN(lat))
      return 'Ongeldige coördinaten in de track.';
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90)
      return 'Coördinaten liggen buiten bereik.';
    if (ele !== undefined && ele !== null && (typeof ele !== 'number' || Number.isNaN(ele)))
      return 'Ongeldige hoogte in de track.';
    if (t !== undefined && t !== null &&
        (typeof t !== 'number' || Number.isNaN(t) || t < 0 || t >= 4102444800))
      return 'Ongeldige tijd in de track.';
  }
  return null;
}

function sanitizeWaypoints(waypoints) {
  if (waypoints === undefined || waypoints === null) return { value: null };
  if (!Array.isArray(waypoints)) return { error: 'Ongeldige waypoints.' };
  if (waypoints.length > 200) return { error: 'Te veel waypoints (max. 200).' };
  const out = [];
  for (const w of waypoints) {
    if (!w || typeof w !== 'object') return { error: 'Ongeldig waypoint.' };
    const { lon, lat, beeline } = w;
    if (typeof lon !== 'number' || typeof lat !== 'number' || Number.isNaN(lon) || Number.isNaN(lat))
      return { error: 'Ongeldige waypoint-coördinaten.' };
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90)
      return { error: 'Waypoint-coördinaten buiten bereik.' };
    const o = { lon, lat };
    if (beeline === true) o.beeline = true;
    out.push(o);
  }
  return { value: JSON.stringify(out) };
}

function regionValue(region) {
  if (typeof region !== 'string') return null;
  const r = region.trim();
  return r ? r.slice(0, 200) : null;
}

/* ---------- helpers ---------- */

function fetchRoute(id) {
  if (!Number.isInteger(id)) return undefined;
  return db.prepare(
    'SELECT r.*, u.name AS owner_name FROM routes r JOIN users u ON u.id = r.user_id WHERE r.id = ?'
  ).get(id);
}

function fetchByToken(token) {
  return db.prepare(
    'SELECT r.*, u.name AS owner_name FROM routes r JOIN users u ON u.id = r.user_id WHERE r.share_token = ?'
  ).get(String(token));
}

function likesInfo(routeId, viewerId) {
  const likes = db.prepare('SELECT COUNT(*) AS c FROM route_likes WHERE route_id = ?').get(routeId).c;
  const liked = viewerId
    ? !!db.prepare('SELECT 1 AS x FROM route_likes WHERE route_id = ? AND user_id = ?').get(routeId, viewerId)
    : false;
  return { likes, liked };
}

function sendGpx(res, row) {
  const gpx = row.gpx || buildGpx({
    name: row.name, description: row.description, track: JSON.parse(row.track), sport: row.sport,
  });
  res.setHeader('Content-Type', 'application/gpx+xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${gpxFilename(row.name)}"`);
  res.send(gpx);
}

// Eigenaarscontrole voor mutaties: bestaan van andermans PRIVATE route niet
// lekken (404), maar bij een PUBLIC route wél laten weten dat het niet van jou is (403).
function requireOwner(row, req, res) {
  if (!row) { res.status(404).json({ error: 'Route niet gevonden.' }); return false; }
  if (row.user_id !== req.user.id) {
    if (row.visibility === 'public') res.status(403).json({ error: 'Dit is niet jouw route.' });
    else res.status(404).json({ error: 'Route niet gevonden.' });
    return false;
  }
  return true;
}

/* ---------- lijst & aanmaken ---------- */

routesRouter.get('/', requireAuth, (req, res) => {
  const { q, sport, sort } = req.query;
  let sql = 'SELECT r.*, u.name AS owner_name FROM routes r JOIN users u ON u.id = r.user_id WHERE r.user_id = ?';
  const args = [req.user.id];
  if (sport && SPORTS.includes(String(sport))) { sql += ' AND r.sport = ?'; args.push(String(sport)); }
  if (q && String(q).trim()) {
    const like = '%' + String(q).trim().replace(/[\\%_]/g, '\\$&') + '%';
    sql += " AND r.name LIKE ? ESCAPE '\\'";
    args.push(like);
  }
  const order = sort === 'name' ? 'r.name COLLATE NOCASE ASC'
    : sort === 'distance' ? 'r.distance_m DESC'
    : 'r.created_at DESC, r.id DESC';
  sql += ' ORDER BY ' + order;
  const rows = db.prepare(sql).all(...args);
  res.json({ routes: rows.map((row) => routeSummary(row, req.user.id)) });
});

routesRouter.post('/', requireAuth, (req, res) => {
  const b = req.body || {};
  const ne = nameError(b.name); if (ne) return res.status(400).json({ error: ne });
  if (!SPORTS.includes(b.sport)) return res.status(400).json({ error: 'Kies een geldige sport.' });
  const te = trackError(b.track); if (te) return res.status(400).json({ error: te });
  if (b.description !== undefined && (typeof b.description !== 'string' || b.description.length > 2000))
    return res.status(400).json({ error: 'De beschrijving is te lang (max. 2000 tekens).' });
  const wp = sanitizeWaypoints(b.waypoints); if (wp.error) return res.status(400).json({ error: wp.error });

  const stats = routeStats(b.sport, b.track);
  const info = db.prepare(`
    INSERT INTO routes (user_id, name, description, sport, waypoints, track,
      distance_m, ascent_m, descent_m, duration_s, difficulty,
      region, source, preview, start_lat, start_lon, bbox)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'gepland', ?, ?, ?, ?)
  `).run(
    req.user.id, b.name.trim(), typeof b.description === 'string' ? b.description : '', b.sport,
    wp.value, JSON.stringify(b.track),
    stats.distance_m, stats.ascent_m, stats.descent_m, stats.duration_s, stats.difficulty,
    regionValue(b.region), JSON.stringify(preview(b.track)),
    stats.start_lat, stats.start_lon, JSON.stringify(stats.bbox),
  );
  const row = fetchRoute(Number(info.lastInsertRowid));
  res.status(201).json({ route: routeFull(row, req.user.id) });
});

routesRouter.post('/import', requireAuth, (req, res) => {
  const b = req.body || {};
  const ne = nameError(b.name); if (ne) return res.status(400).json({ error: ne });
  if (!SPORTS.includes(b.sport)) return res.status(400).json({ error: 'Kies een geldige sport.' });
  const te = trackError(b.track); if (te) return res.status(400).json({ error: te });
  const gpxText = typeof b.gpx === 'string' ? b.gpx : null;

  const stats = routeStats(b.sport, b.track);
  const info = db.prepare(`
    INSERT INTO routes (user_id, name, description, sport, track,
      distance_m, ascent_m, descent_m, duration_s, difficulty,
      region, source, preview, start_lat, start_lon, bbox, gpx)
    VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, 'geimporteerd', ?, ?, ?, ?, ?)
  `).run(
    req.user.id, b.name.trim(), b.sport, JSON.stringify(b.track),
    stats.distance_m, stats.ascent_m, stats.descent_m, stats.duration_s, stats.difficulty,
    regionValue(b.region), JSON.stringify(preview(b.track)),
    stats.start_lat, stats.start_lon, JSON.stringify(stats.bbox), gpxText,
  );
  const row = fetchRoute(Number(info.lastInsertRowid));
  res.status(201).json({ route: routeFull(row, req.user.id) });
});

/* ---------- detail, wijzigen, verwijderen ---------- */

routesRouter.get('/:id/gpx', requireAuth, (req, res) => {
  const row = fetchRoute(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Route niet gevonden.' });
  if (row.user_id !== req.user.id && row.visibility !== 'public')
    return res.status(404).json({ error: 'Route niet gevonden.' });
  sendGpx(res, row);
});

routesRouter.post('/:id/share', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = fetchRoute(id);
  if (!requireOwner(row, req, res)) return;
  let token = row.share_token;
  if (!token) {
    token = crypto.randomBytes(12).toString('base64url');
    db.prepare('UPDATE routes SET share_token = ? WHERE id = ?').run(token, id);
  }
  res.json({ shareToken: token });
});

routesRouter.delete('/:id/share', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = fetchRoute(id);
  if (!requireOwner(row, req, res)) return;
  db.prepare('UPDATE routes SET share_token = NULL WHERE id = ?').run(id);
  res.json({ ok: true });
});

function likeGuard(req, res) {
  const row = fetchRoute(Number(req.params.id));
  if (!row) { res.status(404).json({ error: 'Route niet gevonden.' }); return null; }
  if (row.visibility !== 'public') {
    if (row.user_id === req.user.id) res.status(400).json({ error: 'Je kan alleen openbare routes liken.' });
    else res.status(404).json({ error: 'Route niet gevonden.' });
    return null;
  }
  if (row.user_id === req.user.id) {
    res.status(400).json({ error: 'Je kan je eigen route niet liken.' });
    return null;
  }
  return row;
}

routesRouter.post('/:id/like', requireAuth, (req, res) => {
  const row = likeGuard(req, res); if (!row) return;
  db.prepare('INSERT OR IGNORE INTO route_likes (route_id, user_id) VALUES (?, ?)').run(row.id, req.user.id);
  res.json(likesInfo(row.id, req.user.id));
});

routesRouter.delete('/:id/like', requireAuth, (req, res) => {
  const row = likeGuard(req, res); if (!row) return;
  db.prepare('DELETE FROM route_likes WHERE route_id = ? AND user_id = ?').run(row.id, req.user.id);
  res.json(likesInfo(row.id, req.user.id));
});

routesRouter.get('/:id', requireAuth, (req, res) => {
  const row = fetchRoute(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Route niet gevonden.' });
  if (row.user_id !== req.user.id && row.visibility !== 'public')
    return res.status(404).json({ error: 'Route niet gevonden.' });
  res.json({ route: routeFull(row, req.user.id) });
});

routesRouter.put('/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = fetchRoute(id);
  if (!requireOwner(row, req, res)) return;
  const b = req.body || {};
  const sets = [];
  const args = [];

  if (b.name !== undefined) {
    const ne = nameError(b.name); if (ne) return res.status(400).json({ error: ne });
    sets.push('name = ?'); args.push(b.name.trim());
  }
  if (b.description !== undefined) {
    if (typeof b.description !== 'string' || b.description.length > 2000)
      return res.status(400).json({ error: 'De beschrijving is te lang (max. 2000 tekens).' });
    sets.push('description = ?'); args.push(b.description);
  }
  let sport = row.sport;
  if (b.sport !== undefined) {
    if (!SPORTS.includes(b.sport)) return res.status(400).json({ error: 'Kies een geldige sport.' });
    sport = b.sport; sets.push('sport = ?'); args.push(b.sport);
  }
  if (b.region !== undefined) { sets.push('region = ?'); args.push(regionValue(b.region)); }
  if (b.visibility !== undefined) {
    if (!VISIBILITIES.includes(b.visibility)) return res.status(400).json({ error: 'Ongeldige zichtbaarheid.' });
    sets.push('visibility = ?'); args.push(b.visibility);
  }
  if (b.waypoints !== undefined) {
    const wp = sanitizeWaypoints(b.waypoints); if (wp.error) return res.status(400).json({ error: wp.error });
    sets.push('waypoints = ?'); args.push(wp.value);
  }
  if (b.track !== undefined) {
    const te = trackError(b.track); if (te) return res.status(400).json({ error: te });
    const stats = routeStats(sport, b.track);
    sets.push('track = ?', 'distance_m = ?', 'ascent_m = ?', 'descent_m = ?', 'duration_s = ?',
      'difficulty = ?', 'bbox = ?', 'start_lat = ?', 'start_lon = ?', 'preview = ?', 'gpx = NULL');
    args.push(JSON.stringify(b.track), stats.distance_m, stats.ascent_m, stats.descent_m,
      stats.duration_s, stats.difficulty, JSON.stringify(stats.bbox),
      stats.start_lat, stats.start_lon, JSON.stringify(preview(b.track)));
  } else if (b.sport !== undefined) {
    // Sport gewijzigd zonder nieuwe track: duur & moeilijkheid hangen af van sport.
    const stats = routeStats(sport, JSON.parse(row.track));
    sets.push('duration_s = ?', 'difficulty = ?'); args.push(stats.duration_s, stats.difficulty);
  }

  if (sets.length) {
    sets.push("updated_at = datetime('now')");
    args.push(id);
    db.prepare(`UPDATE routes SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }
  res.json({ route: routeFull(fetchRoute(id), req.user.id) });
});

routesRouter.delete('/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = fetchRoute(id);
  if (!requireOwner(row, req, res)) return;
  db.prepare('DELETE FROM routes WHERE id = ?').run(id);
  res.json({ ok: true });
});

/* ---------- publieke deelpagina (geen auth) ---------- */

sharedRouter.get('/:token/gpx', (req, res) => {
  const row = fetchByToken(req.params.token);
  if (!row) return res.status(404).json({ error: 'Deze deellink bestaat niet (meer).' });
  sendGpx(res, row);
});

sharedRouter.get('/:token', (req, res) => {
  const row = fetchByToken(req.params.token);
  if (!row) return res.status(404).json({ error: 'Deze deellink bestaat niet (meer).' });
  res.json({ route: routeFull(row) });
});
