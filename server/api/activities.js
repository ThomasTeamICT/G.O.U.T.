// Activiteiten-API: aanmaken (upload/opname), lijst, detail, hernoemen,
// verwijderen en GPX-download. Antwoorden via de serializers (camelCase).

import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import { activityStats, preview } from '../geo.js';
import { buildGpx, gpxFilename } from '../gpx.js';
import { activitySummary, activityFull, ACTIVITY_SUMMARY_COLUMNS, ensurePreviews } from '../serialize.js';

export const activitiesRouter = Router();

const SPORTS = ['wandelen', 'fietsen', 'mtb'];
const MAX_GPX = 5 * 1024 * 1024; // 5 MB: cap op geuploade/originele gpx-tekst

/* ---------- validatie ---------- */

function nameError(name) {
  if (typeof name !== 'string') return 'Geef een naam op.';
  const n = name.trim();
  if (n.length < 1) return 'Geef een naam op.';
  if (n.length > 120) return 'De naam mag hoogstens 120 tekens lang zijn.';
  return null;
}

function trackError(track) {
  if (!Array.isArray(track)) return 'Ongeldige track.';
  if (track.length < 2) return 'Een activiteit heeft minstens 2 punten nodig.';
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

function regionValue(region) {
  if (typeof region !== 'string') return null;
  const r = region.trim();
  return r ? r.slice(0, 200) : null;
}

// startedAt: expliciet meegegeven ISO-string, anders afgeleid uit het eerste
// trackpunt met een tijdstempel, anders null.
function resolveStartedAt(startedAt, track) {
  if (typeof startedAt === 'string' && startedAt.trim()) {
    const d = new Date(startedAt);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const first = track.find((p) => typeof p[3] === 'number' && p[3] >= 0 && p[3] < 4102444800);
  if (first) return new Date(first[3] * 1000).toISOString();
  return null;
}

/* ---------- helpers ---------- */

function fetchActivity(id) {
  if (!Number.isInteger(id)) return undefined;
  return db.prepare('SELECT * FROM activities WHERE id = ?').get(id);
}

function requireOwn(row, req, res) {
  if (!row || row.user_id !== req.user.id) {
    res.status(404).json({ error: 'Activiteit niet gevonden.' });
    return false;
  }
  return true;
}

function sendGpx(res, row) {
  // Origineel bestand als dat bewaard is, anders zelf bouwen (met tijden).
  const gpx = row.gpx || buildGpx({ name: row.name, track: JSON.parse(row.track), sport: row.sport });
  res.setHeader('Content-Type', 'application/gpx+xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${gpxFilename(row.name)}"`);
  res.send(gpx);
}

/* ---------- lijst & aanmaken ---------- */

activitiesRouter.get('/', requireAuth, (req, res) => {
  // Smalle kolomlijst (geen track/gpx-blobs): de summary gebruikt enkel preview
  // + scalairen. Materialiseren van volle tracks per rij was ~87x trager.
  const rows = db.prepare(
    `SELECT ${ACTIVITY_SUMMARY_COLUMNS} FROM activities WHERE user_id = ? ORDER BY COALESCE(started_at, created_at) DESC, id DESC`
  ).all(req.user.id);
  ensurePreviews('activities', rows);
  res.json({ activities: rows.map(activitySummary) });
});

activitiesRouter.post('/', requireAuth, (req, res) => {
  const b = req.body || {};
  const ne = nameError(b.name); if (ne) return res.status(400).json({ error: ne });
  if (!SPORTS.includes(b.sport)) return res.status(400).json({ error: 'Kies een geldige sport.' });
  const te = trackError(b.track); if (te) return res.status(400).json({ error: te });
  if (typeof b.gpx === 'string' && b.gpx.length > MAX_GPX)
    return res.status(400).json({ error: 'Het GPX-bestand is te groot (max. 5 MB).' });

  // routeId enkel accepteren als die route van deze gebruiker is.
  let routeId = null;
  if (b.routeId !== undefined && b.routeId !== null) {
    const rid = Number(b.routeId);
    if (Number.isInteger(rid)) {
      const own = db.prepare('SELECT id FROM routes WHERE id = ? AND user_id = ?').get(rid, req.user.id);
      if (own) routeId = rid;
    }
  }

  const gpxText = typeof b.gpx === 'string' ? b.gpx : null;
  const startedAt = resolveStartedAt(b.startedAt, b.track);
  const stats = activityStats(b.track);

  const info = db.prepare(`
    INSERT INTO activities (user_id, route_id, name, sport, track,
      distance_m, ascent_m, descent_m, moving_s, elapsed_s,
      started_at, preview, region, gpx)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.user.id, routeId, b.name.trim(), b.sport, JSON.stringify(b.track),
    stats.distance_m, stats.ascent_m, stats.descent_m, stats.moving_s, stats.elapsed_s,
    startedAt, JSON.stringify(preview(b.track)), regionValue(b.region), gpxText,
  );
  const row = fetchActivity(Number(info.lastInsertRowid));
  res.status(201).json({ activity: activityFull(row) });
});

/* ---------- detail, wijzigen, verwijderen, gpx ---------- */

activitiesRouter.get('/:id/gpx', requireAuth, (req, res) => {
  const row = fetchActivity(Number(req.params.id));
  if (!requireOwn(row, req, res)) return;
  sendGpx(res, row);
});

activitiesRouter.get('/:id', requireAuth, (req, res) => {
  const row = fetchActivity(Number(req.params.id));
  if (!requireOwn(row, req, res)) return;
  res.json({ activity: activityFull(row) });
});

activitiesRouter.put('/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = fetchActivity(id);
  if (!requireOwn(row, req, res)) return;
  const b = req.body || {};
  const sets = [], args = [];
  if (b.name !== undefined) {
    const ne = nameError(b.name); if (ne) return res.status(400).json({ error: ne });
    sets.push('name = ?'); args.push(b.name.trim());
  }
  if (b.sport !== undefined) {
    if (!SPORTS.includes(b.sport)) return res.status(400).json({ error: 'Kies een geldige sport.' });
    sets.push('sport = ?'); args.push(b.sport);
  }
  if (sets.length) {
    args.push(id);
    db.prepare(`UPDATE activities SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }
  res.json({ activity: activityFull(fetchActivity(id)) });
});

activitiesRouter.delete('/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = fetchActivity(id);
  if (!requireOwn(row, req, res)) return;
  db.prepare('DELETE FROM activities WHERE id = ?').run(id);
  res.json({ ok: true });
});
