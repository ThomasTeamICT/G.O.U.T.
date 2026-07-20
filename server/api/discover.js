// Ontdek: openbare routebibliotheek. Top-10 wereldwijd + zoeken binnen een
// kaartgebied (bbox). Antwoorden altijd via de gedeelde serializer, met
// viewerId zodat `liked` klopt voor de ingelogde gebruiker.
//
// Daarnaast 'Aanbevolen (bewegwijzerd)': live de beste bewegwijzerde routes uit
// OpenStreetMap voor het gevraagde gebied — grondstof met een zwaarte-voorkeur,
// geen pretentie van curatie.

import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import { routeSummary, ROUTE_SUMMARY_COLUMNS, ensurePreviews } from '../serialize.js';
import { overpassQuery, KnownRouteError } from '../knownroutes.js';
import { haversine } from '../geo.js';
import { cacheSet } from '../cache.js';

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

// Fase 1: goedkope voorselectie van publieke routes met optioneel sport/q-filter,
// gesorteerd op likes (desc) en daarna nieuwste eerst. Enkel id, bbox en
// like_count — géén track/gpx materialiseren voor honderden rijen die we
// grotendeels weer wegfilteren.
function selectPublicIds({ sport, q, limit }) {
  const where = ["r.visibility = 'public'"];
  const params = [];
  if (sport) { where.push('r.sport = ?'); params.push(sport); }
  if (q) {
    where.push("(LOWER(r.name) LIKE ? ESCAPE '\\' OR LOWER(r.region) LIKE ? ESCAPE '\\')");
    const like = '%' + likeEscape(q.toLowerCase()) + '%';
    params.push(like, like);
  }
  return db.prepare(`
    SELECT r.id, r.bbox,
      (SELECT COUNT(*) FROM route_likes rl WHERE rl.route_id = r.id) AS like_count
    FROM routes r
    WHERE ${where.join(' AND ')}
    ORDER BY like_count DESC, r.created_at DESC
    LIMIT ?
  `).all(...params, limit);
}

// Fase 2: alleen voor de ≤limit gematchte rijen de smalle summary-kolommen
// ophalen (zonder track/gpx) en serializen. Het al getelde like_count geven we
// door aan routeSummary zodat likesFor de likes niet opnieuw telt.
function hydrate(matched, viewerId) {
  const stmt = db.prepare(
    `SELECT ${ROUTE_SUMMARY_COLUMNS}, u.name AS owner_name FROM routes r JOIN users u ON u.id = r.user_id WHERE r.id = ?`
  );
  const rows = [];
  const counts = [];
  for (const m of matched) {
    const row = stmt.get(m.id);
    if (row) { rows.push(row); counts.push(m.like_count); }
  }
  ensurePreviews('routes', rows);
  return rows.map((row, i) => routeSummary(row, viewerId, counts[i]));
}

// GET /api/discover?bbox=w,s,e,n&sport=&q=&limit=
discoverRouter.get('/', requireAuth, (req, res) => {
  const bboxRaw = typeof req.query.bbox === 'string' ? req.query.bbox.trim() : '';
  const box = bboxRaw.split(',').map(Number);
  if (box.length !== 4 || box.some((n) => !Number.isFinite(n))) {
    return res.status(400).json({ error: 'Geef een geldig kaartgebied op (bbox=w,s,e,n).' });
  }
  const [w2, s2, e2, n2] = box;

  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
  const sport = SPORTS.has(req.query.sport) ? req.query.sport : null;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

  // Ruime voorselectie ophalen (al gesorteerd, enkel id/bbox/like_count), daarna
  // in JS filteren op bbox-overlap en pas dan afkappen op de gevraagde limiet.
  const idRows = selectPublicIds({ sport, q, limit: 500 });

  const matched = [];
  for (const row of idRows) {
    let bb = null;
    try { bb = row.bbox ? JSON.parse(row.bbox) : null; } catch { bb = null; }
    if (!Array.isArray(bb) || bb.length !== 4 || bb.some((n) => !Number.isFinite(n))) continue;
    if (overlaps(bb, w2, s2, e2, n2)) {
      matched.push(row);
      if (matched.length >= limit) break;
    }
  }

  res.json({ routes: hydrate(matched, req.user.id) });
});

// GET /api/discover/top?sport=
discoverRouter.get('/top', requireAuth, (req, res) => {
  const sport = SPORTS.has(req.query.sport) ? req.query.sport : null;
  const idRows = selectPublicIds({ sport, q: '', limit: 10 });
  res.json({ routes: hydrate(idRows, req.user.id) });
});

// ---- Aanbevolen (bewegwijzerd) ---------------------------------------------
// Live de beste bewegwijzerde OSM-routes voor een gebied. Licht gehouden: enkel
// tags + center via Overpass, met een eenvoudige zwaarte-/kwaliteitsscore.
// Enkel wandelen (route=hiking|foot) en mtb (route=mtb) hebben zulke takken.

const AANBEVOLEN_TTL = 6 * 3600_000;               // 6 uur cache per bbox+sport
const AANBEVOLEN_MAX = 500;                         // harde grens tegen onbegrensde groei
const aanbevolenCache = new Map();                 // key -> { t, data }
const AFSTAND = { wandelen: [4, 35], mtb: [10, 60] }; // toegelaten km-bereik

// Distance-tag (OSM, in km) parsen: "12", "12.5", "12,5", "12 km" -> getal | null.
function parseAfstandKm(tag) {
  if (tag == null) return null;
  const m = String(tag).replace(',', '.').match(/\d+(\.\d+)?/);
  if (!m) return null;
  const km = parseFloat(m[0]);
  return Number.isFinite(km) && km > 0 ? km : null;
}

function sportVanRoute(route) {
  if (route === 'mtb') return 'mtb';
  if (route === 'hiking' || route === 'foot') return 'wandelen';
  return null;
}

// Zwaarte-/kwaliteitsscore: naam +2, netwerk lwn/rwn +1, bruikbare afstand +1.
function scoreRelatie(tags, afstandKm) {
  let score = 0;
  if (tags.name) score += 2;
  const net = String(tags.network || '').toLowerCase();
  if (net === 'lwn' || net === 'rwn') score += 1;
  if (afstandKm != null) score += 1;
  return score;
}

const round2 = (x) => (Math.round(x * 100) / 100).toFixed(2);

// GET /api/discover/aanbevolen?bbox=w,s,e,n&sport=
discoverRouter.get('/aanbevolen', requireAuth, async (req, res) => {
  const bboxRaw = typeof req.query.bbox === 'string' ? req.query.bbox.trim() : '';
  const box = bboxRaw.split(',').map(Number);
  if (box.length !== 4 || box.some((n) => !Number.isFinite(n))) {
    return res.status(400).json({ error: 'Geef een geldig kaartgebied op (bbox=w,s,e,n).' });
  }
  const [w, s, e, n] = box;

  const gevraagd = SPORTS.has(req.query.sport) ? req.query.sport : null;
  const wilWandel = gevraagd === null || gevraagd === 'wandelen';
  const wilMtb = gevraagd === null || gevraagd === 'mtb';

  // Optioneel middelpunt (bv. het gezochte dorp): nabijheid weegt dan mee.
  let centrum = null;
  if (typeof req.query.center === 'string') {
    const c = req.query.center.split(',').map(Number);
    if (c.length === 2 && c.every(Number.isFinite)) centrum = c; // [lon, lat]
  }

  const cacheKey = `${round2(w)},${round2(s)},${round2(e)},${round2(n)}|${gevraagd || 'beide'}|` +
    (centrum ? `${round2(centrum[0])},${round2(centrum[1])}` : '-');
  const hit = aanbevolenCache.get(cacheKey);
  if (hit && Date.now() - hit.t < AANBEVOLEN_TTL) return res.json(hit.data);

  // Fietsen kent hier geen bewegwijzerde tak -> meteen leeg (en gecachet).
  if (!wilWandel && !wilMtb) {
    const leeg = { aanbevolen: { wandelen: [], mtb: [] } };
    cacheSet(aanbevolenCache, cacheKey, { t: Date.now(), data: leeg }, { max: AANBEVOLEN_MAX, ttl: AANBEVOLEN_TTL });
    return res.json(leeg);
  }

  // Licht: alleen tags + center. Overpass-bbox = (zuid,west,noord,oost).
  const bb = `(${s},${w},${n},${e})`;
  const takken = [];
  if (wilWandel) takken.push(`relation["route"~"^(hiking|foot)$"]${bb};`);
  if (wilMtb) takken.push(`relation["route"="mtb"]${bb};`);
  const query = `[out:json][timeout:25];(${takken.join('')});out tags center;`;

  let data;
  try {
    data = await overpassQuery(query, { timeoutMs: 30000 });
  } catch (err) {
    const status = err instanceof KnownRouteError ? err.status : 502;
    return res.status(status).json({
      error: err?.message || 'Kon de bewegwijzerde routes niet ophalen. Probeer het zo opnieuw.',
    });
  }

  const emmers = { wandelen: [], mtb: [] };
  for (const el of data.elements || []) {
    if (el.type !== 'relation' || !el.tags) continue;
    const sp = sportVanRoute(el.tags.route);
    if (!sp || (sp === 'wandelen' && !wilWandel) || (sp === 'mtb' && !wilMtb)) continue;
    const afstandKm = parseAfstandKm(el.tags.distance);
    if (afstandKm != null) {
      const [lo, hi] = AFSTAND[sp];
      if (afstandKm < lo || afstandKm > hi) continue; // afstand-tag buiten bereik = weg
    }
    let nabijKm = null;
    if (centrum && el.center) {
      nabijKm = haversine(centrum[0], centrum[1], el.center.lon, el.center.lat) / 1000;
    }
    emmers[sp].push({
      id: el.id,
      name: el.tags.name || null,
      ref: el.tags.ref || null,
      distanceKm: afstandKm != null ? Math.round(afstandKm * 10) / 10 : null,
      vanCentrumKm: nabijKm != null ? Math.round(nabijKm * 10) / 10 : null,
      sport: sp,
      _score: scoreRelatie(el.tags, afstandKm),
      _zwaar: afstandKm ?? 0,
      _nabij: nabijKm,
    });
  }

  // Sorteren: score met nabijheidskorting (elke ~4 km van het zoekpunt kost
  // een punt), dichtstbij eerst bij gelijke stand, dan zwaarder/langer.
  const effectief = (x) => x._score - (x._nabij != null ? x._nabij / 4 : 0);
  const top3 = (lijst) => lijst
    .sort((a, b) =>
      effectief(b) - effectief(a) ||
      ((a._nabij ?? Infinity) - (b._nabij ?? Infinity)) ||
      b._zwaar - a._zwaar)
    .slice(0, 3)
    .map(({ _score, _zwaar, _nabij, ...rest }) => rest);

  const result = { aanbevolen: { wandelen: top3(emmers.wandelen), mtb: top3(emmers.mtb) } };
  cacheSet(aanbevolenCache, cacheKey, { t: Date.now(), data: result }, { max: AANBEVOLEN_MAX, ttl: AANBEVOLEN_TTL });
  res.json(result);
});
