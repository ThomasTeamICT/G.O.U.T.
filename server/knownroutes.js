// Herbruikbare geometrie-ophaler voor bekende routes (OSM-relaties via Overpass):
// gebruikt door de API (server/proxy.js) én door het bibliotheek-oogstscript.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { simplify, haversine, trackDistance } from './geo.js';

const UA = 'G.O.U.T.-routeplanner/1.0 (zelfgehost, contact via beheerder)';
const DATA_DIR = process.env.GOUT_DATA_DIR ||
  join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

const memCache = new Map();   // cacheKey -> { t, data }
const inflight = new Map();   // cacheKey -> Promise

export class KnownRouteError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const OVERPASS_INSTANCES = [
  process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

// Ruwe Overpass-query met terugval over meerdere instanties.
export async function overpassQuery(query, { timeoutMs = 100000, instances = OVERPASS_INSTANCES } = {}) {
  let saw429 = false;
  for (const instantie of instances) {
    try {
      const r = await fetch(instantie, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.status === 429) saw429 = true;
      if (!r.ok) continue;
      const d = await r.json();
      if (!d || !Array.isArray(d.elements)) continue;
      return d;
    } catch { /* volgende instantie */ }
  }
  if (saw429)
    throw new KnownRouteError(429, 'De OpenStreetMap-server vraagt even rust (te veel verzoeken kort na elkaar). Wacht een halve minuut en probeer opnieuw.');
  throw new KnownRouteError(502, 'Kon de routegeometrie niet ophalen. Lange routes kunnen druk bezet zijn — probeer het zo opnieuw, of kies een deeltraject (etappe) uit de lijst.');
}

// Wegsegmenten uit een Overpass-antwoord halen; varianten/zijtakken op rol overslaan.
const EXCLUDE_ROLES = new Set(['alternative', 'excursion', 'approach', 'connection', 'shortcut', 'variant', 'detour', 'link']);

export function collectSegments(data) {
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
  return segments;
}

// Segmenten aaneenrijgen tot doorlopende kettingen (einden < 300 m), langste eerst.
export function stitchChains(segments) {
  const GAP_M = 300;
  const dm = (a, b) => haversine(a[0], a[1], b[0], b[1]);
  const kettingen = [];
  const pool = segments.slice();
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
        if (append) chain.push(...seg); else chain.unshift(...seg);
        gegroeid = true;
      }
    }
    kettingen.push(chain);
  }
  kettingen.sort((x, y) => trackDistance(y) - trackDistance(x));
  return kettingen;
}

function verklein(t, maxPts = 6000) {
  let tol = 0.00005;
  while (t.length > maxPts && tol < 0.01) { t = simplify(t, tol); tol *= 2; }
  return t;
}

// Volwaardige takken selecteren (ruisfragmenten weg), langste eerst.
export function selectBranches(kettingen) {
  const langste = trackDistance(kettingen[0]);
  return kettingen
    .filter((k) => {
      const d = trackDistance(k);
      return d >= 5000 && d >= 0.25 * langste;
    })
    .slice(0, 4)
    .map((k) => ({ track: verklein(k), distanceM: Math.round(trackDistance(k)) }));
}

// Volledige pijplijn met geheugen- + schijfcache en in-flight-dedupe.
export async function fetchKnownRouteGeometry(id, opts = {}) {
  const cacheKey = `geom:${id}`;
  const cacheDir = join(DATA_DIR, 'cache');
  const cacheFile = join(cacheDir, `knownroute-${id}.json`);

  let data;
  const hit = memCache.get(cacheKey);
  if (hit && Date.now() - hit.t < 24 * 3600_000) {
    data = hit.data;
  } else if (existsSync(cacheFile)) {
    try { data = JSON.parse(readFileSync(cacheFile, 'utf8')); memCache.set(cacheKey, { t: Date.now(), data }); } catch { /* herophalen */ }
  }
  if (!data) {
    if (!inflight.has(cacheKey)) {
      inflight.set(cacheKey, (async () => {
        const query = `[out:json][timeout:90];rel(${id})->.r0;rel(r.r0)->.r1;rel(r.r1)->.r2;(.r0; .r1; .r2;)->.rels;way(r.rels)->.wegen;(.rels; .wegen;);out geom;`;
        const d = await overpassQuery(query, opts);
        if (!d.elements.length) throw new KnownRouteError(404, 'Geen geometrie gevonden voor deze route.');
        return d;
      })().finally(() => setTimeout(() => inflight.delete(cacheKey), 1000)));
    }
    data = await inflight.get(cacheKey);
    memCache.set(cacheKey, { t: Date.now(), data });
    try { mkdirSync(cacheDir, { recursive: true }); writeFileSync(cacheFile, JSON.stringify(data)); } catch { /* best effort */ }
  }

  const segments = collectSegments(data);
  if (!segments.length) throw new KnownRouteError(404, 'Geen geometrie gevonden voor deze route.');
  const kettingen = stitchChains(segments);
  const takken = selectBranches(kettingen);
  return {
    track: takken[0].track,
    chains: takken.length > 1 ? takken : undefined,
    weggelaten: kettingen.length - takken.length,
  };
}
