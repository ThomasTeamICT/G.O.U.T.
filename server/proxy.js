import { Router } from 'express';
import { requireAuth } from './auth.js';

// Routering loopt via de server zodat CORS geen probleem is en de
// BRouter-instantie configureerbaar blijft (zelf hosten kan ook).
const BROUTER_URL = process.env.BROUTER_URL || 'https://brouter.de/brouter';
const NOMINATIM_URL = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
const UA = 'G.O.U.T.-routeplanner/1.0 (zelfgehost, contact via beheerder)';

// BRouter-profielen per sport; overschrijfbaar via env-variabelen.
export const PROFILES = {
  wandelen: process.env.BROUTER_PROFILE_WANDELEN || 'hiking-beta',
  fietsen: process.env.BROUTER_PROFILE_FIETSEN || 'trekking',
  mtb: process.env.BROUTER_PROFILE_MTB || 'mtb',
};
// Als een (custom) profiel niet op de BRouter-server staat, val terug op:
const FALLBACK_PROFILE = 'trekking';

// Eigen .brf-profielen in server/profiles/<sport>.brf worden automatisch naar
// de BRouter-server geüpload (zoals brouter-web doet) en krijgen voorrang.
// Mislukt de upload of de routering ermee, dan vallen we terug op het
// standaardprofiel. Zo kan je bos-/asfaltvoorkeur zelf tunen.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const PROFILES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'profiles');
const customProfileIds = new Map(); // sport -> profileid | null (null = upload faalde)

async function customProfileFor(sport) {
  if (customProfileIds.has(sport)) return customProfileIds.get(sport);
  const file = join(PROFILES_DIR, `${sport}.brf`);
  if (!existsSync(file)) { customProfileIds.set(sport, null); return null; }
  try {
    const r = await fetch(`${BROUTER_URL}/profile`, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'text/plain' },
      body: readFileSync(file, 'utf8'),
      signal: AbortSignal.timeout(15000),
    });
    const data = r.ok ? await r.json().catch(() => null) : null;
    const id = data && data.profileid && !data.error ? data.profileid : null;
    customProfileIds.set(sport, id);
    if (id) console.log(`BRouter-profiel geüpload voor ${sport}: ${id}`);
    else console.warn(`BRouter-profielupload voor ${sport} geweigerd; standaardprofiel wordt gebruikt.`);
    return id;
  } catch {
    customProfileIds.set(sport, null);
    return null;
  }
}

export const proxyRouter = Router();

const LONLATS_RE = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?(\|-?\d+(\.\d+)?,-?\d+(\.\d+)?)+$/;

proxyRouter.get('/routing', requireAuth, async (req, res) => {
  const { lonlats, sport } = req.query;
  if (typeof lonlats !== 'string' || !LONLATS_RE.test(lonlats) || lonlats.length > 2000)
    return res.status(400).json({ error: 'Ongeldige coördinaten.' });
  const profile = PROFILES[sport] || PROFILES.fietsen;

  const fetchRoute = async (prof) => {
    const url = `${BROUTER_URL}?lonlats=${encodeURIComponent(lonlats)}&profile=${encodeURIComponent(prof)}&alternativeidx=0&format=geojson`;
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25000) });
    return { ok: r.ok, status: r.status, text: await r.text() };
  };

  try {
    const custom = await customProfileFor(sport);
    let result = null, usedProfile = null;
    if (custom) {
      result = await fetchRoute(custom);
      usedProfile = custom;
      if (!result.ok) customProfileIds.set(sport, null); // niet blijven proberen
    }
    if (!result || !result.ok) {
      result = await fetchRoute(profile);
      usedProfile = profile;
    }
    if (!result.ok && profile !== FALLBACK_PROFILE) {
      result = await fetchRoute(FALLBACK_PROFILE);
      usedProfile = FALLBACK_PROFILE;
    }
    if (!result.ok)
      return res.status(502).json({ error: 'Routeserver gaf een fout terug.', detail: result.text.slice(0, 300) });
    res.setHeader('X-Used-Profile', usedProfile);
    res.type('application/json').send(result.text);
  } catch {
    res.status(502).json({ error: 'Routeserver niet bereikbaar. Probeer zo dadelijk opnieuw.' });
  }
});

// Plaatsnaam zoeken (voor "Ontdek" en de planner).
proxyRouter.get('/geocode', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  if (q.length < 2) return res.json({ results: [] });
  try {
    const url = `${NOMINATIM_URL}/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`;
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return res.json({ results: [] });
    const data = await r.json();
    res.json({
      results: data.map((d) => ({
        name: d.display_name,
        lat: Number(d.lat),
        lon: Number(d.lon),
      })),
    });
  } catch {
    res.json({ results: [] });
  }
});

// Omgekeerd geocoderen: "Opwijk, België" bij het opslaan van een route.
proxyRouter.get('/revgeocode', requireAuth, async (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.json({ region: null });
  try {
    const url = `${NOMINATIM_URL}/reverse?format=jsonv2&zoom=10&lat=${lat}&lon=${lon}`;
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return res.json({ region: null });
    const d = await r.json();
    const a = d.address || {};
    const place = a.city || a.town || a.village || a.municipality || a.county || null;
    const region = place ? `${place}${a.country ? ', ' + a.country : ''}` : (d.display_name || null);
    res.json({ region });
  } catch {
    res.json({ region: null });
  }
});

// ---- Bekende routes (GR's, camino's) — Waymarked Trails-API ----------------

const WMT_BASE = process.env.WMT_BASE || 'https://{site}.waymarkedtrails.org';
const WMT_SITE = { wandelen: 'hiking', fietsen: 'cycling', mtb: 'mtb' };
const wmtCache = new Map(); // url -> { t, data }

async function wmtFetch(url) {
  const hit = wmtCache.get(url);
  if (hit && Date.now() - hit.t < 3600_000) return hit.data;
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`WMT ${r.status}`);
  const data = await r.json();
  wmtCache.set(url, { t: Date.now(), data });
  return data;
}

proxyRouter.get('/knownroutes', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  const site = WMT_SITE[req.query.sport] || 'hiking';
  if (q.length < 2) return res.json({ routes: [] });
  try {
    const base = WMT_BASE.replace('{site}', site);
    const data = await wmtFetch(`${base}/api/v1/list/search?query=${encodeURIComponent(q)}&limit=20`);
    const items = data.results || data.items || [];
    res.json({
      routes: items.map((it) => ({
        id: it.id,
        name: it.name || it.ref || `Route ${it.id}`,
        ref: it.ref || null,
        group: it.group || it.network || null,
      })).filter((it) => it.id),
    });
  } catch {
    res.status(502).json({ error: 'Routebibliotheek niet bereikbaar. Probeer zo dadelijk opnieuw.' });
  }
});

proxyRouter.get('/knownroutes/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const site = WMT_SITE[req.query.sport] || 'hiking';
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Ongeldige route.' });
  try {
    // Naam via Waymarked Trails (best effort), geometrie via Overpass (OSM zelf):
    // de relatie + al haar deelrelaties, met weg-geometrie inline.
    const base = WMT_BASE.replace('{site}', site);
    const infoP = wmtFetch(`${base}/api/v1/details/relation/${id}`).catch(() => null);
    const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
    const query = `[out:json][timeout:120];rel(${id});(._;>>;);out geom;`;
    const r = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) throw new Error(`Overpass ${r.status}`);
    const data = await r.json();

    // Wegen verzamelen. Bij voorkeur via de relatie-leden zodat we varianten,
    // zijtakken en aanlooproutes (rol 'alternative', 'excursion', ...) kunnen
    // overslaan — anders knoopt de aaneenrijger die met luchtlijnen vast.
    const EXCLUDE_ROLES = new Set(['alternative', 'excursion', 'approach', 'connection', 'shortcut', 'variant', 'detour', 'link']);
    const seen = new Set();
    const segments = [];
    const addWay = (ref, geometry) => {
      if (!Array.isArray(geometry) || geometry.length < 2) return;
      if (ref != null && seen.has(ref)) return;
      if (ref != null) seen.add(ref);
      segments.push(geometry.map((p) => [p.lon, p.lat]));
    };
    let viaRelaties = false;
    for (const el of data.elements || []) {
      if (el.type !== 'relation' || !Array.isArray(el.members)) continue;
      for (const m of el.members) {
        if (m.type !== 'way' || !m.geometry) continue;
        if (EXCLUDE_ROLES.has(String(m.role || '').toLowerCase())) continue;
        addWay(m.ref, m.geometry);
        viaRelaties = true;
      }
    }
    if (!viaRelaties) {
      for (const el of data.elements || []) {
        if (el.type === 'way') addWay(el.id, el.geometry);
      }
    }
    if (!segments.length) return res.status(404).json({ error: 'Geen geometrie gevonden voor deze route.' });

    // Aaneenrijgen tot doorlopende kettingen: alleen verbinden als de einden
    // écht aansluiten (< 300 m). Losse onderdelen worden aparte kettingen;
    // we geven het langste doorlopende tracé terug (geen luchtlijnen meer).
    const { simplify, haversine, trackDistance } = await import('./geo.js');
    const GAP_M = 300;
    const dm = (a, b) => haversine(a[0], a[1], b[0], b[1]);
    const kettingen = [];
    const pool = segments;
    while (pool.length) {
      const chain = pool.shift().slice();
      let gegroeid = true;
      while (gegroeid && pool.length) {
        gegroeid = false;
        const head = chain[0], tail = chain[chain.length - 1];
        let best = -1, bestD = Infinity, flip = false, append = true;
        for (let i = 0; i < pool.length; i++) {
          const s = pool[i];
          const opts = [
            [dm(tail, s[0]), true, false], [dm(tail, s[s.length - 1]), true, true],
            [dm(head, s[s.length - 1]), false, false], [dm(head, s[0]), false, true],
          ];
          for (const [d, app, fl] of opts) {
            if (d < bestD) { bestD = d; best = i; append = app; flip = fl; }
          }
        }
        if (best >= 0 && bestD <= GAP_M) {
          const seg = pool.splice(best, 1)[0].slice();
          if (flip) seg.reverse();
          if (append) chain.push(...seg); else chain.unshift(...seg.reverse());
          gegroeid = true;
        }
      }
      kettingen.push(chain);
    }
    kettingen.sort((x, y) => trackDistance(y) - trackDistance(x));
    let track = kettingen[0];
    const weggelaten = kettingen.length - 1;
    let tol = 0.00005;
    while (track.length > 6000 && tol < 0.01) { track = simplify(track, tol); tol *= 2; }
    const info = await infoP;
    res.json({
      name: info?.name || `Route ${id}`,
      ref: info?.ref || null,
      track,
      note: weggelaten > 0
        ? `Hoofdtracé gekozen; ${weggelaten} losse variant(en)/zijtak(ken) weggelaten. Hoogtedata niet inbegrepen.`
        : 'Geometrie uit OpenStreetMap (Overpass); hoogtedata niet inbegrepen.',
    });
  } catch {
    res.status(502).json({ error: 'Kon de routegeometrie niet ophalen. Probeer opnieuw.' });
  }
});
