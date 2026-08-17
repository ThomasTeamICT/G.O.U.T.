#!/usr/bin/env node
// scripts/bibliotheek.js
// Batch-oogst van bewegwijzerde routes per Belgische gemeente uit OpenStreetMap.
// Draait op de machine van de gebruiker (met echt internet). Zie docs/CONTRACT.md,
// sectie "Bibliotheek: aanbevolen routes per gemeente (batch-oogst)".
//
//   node scripts/bibliotheek.js                  # alle gemeenten
//   node scripts/bibliotheek.js --gemeente "Opwijk"
//   node scripts/bibliotheek.js --max 25         # hoogstens 25 gemeenten deze run
//   node scripts/bibliotheek.js --droog          # tonen, niets wegschrijven
//
// Hervatbaar via data/bibliotheek-voortgang.json; idempotent op osm_rel_id.

import crypto from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { db } from '../server/db.js';
import { hashPassword } from '../server/auth.js';
import { routeStats, preview, haversine, trackDistance } from '../server/geo.js';
import { overpassQuery, fetchKnownRouteGeometry } from '../server/knownroutes.js';
import { readFileSync as _rf, writeFileSync as _wf, existsSync as _ex, mkdirSync as _mk } from 'node:fs';

// OSM-rate-limits zijn normaal bij landelijke query's: niet opgeven maar wachten.
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
async function metGeduld(naam, fn, pogingen = 5) {
  for (let p = 1; ; p++) {
    // Hartslag: laat zien dat we bezig zijn (één poging kan tot ±5 min duren
    // omdat er drie OSM-servers na elkaar geprobeerd worden).
    const tik = setInterval(() => console.log(`  … ${naam}: nog bezig (poging ${p}/${pogingen}, servers antwoorden traag)`), 45_000);
    try {
      const uit = await fn();
      clearInterval(tik);
      return uit;
    } catch (e) {
      clearInterval(tik);
      const herstelbaar = e?.status === 429 || e?.status === 502;
      if (p >= pogingen || !herstelbaar) throw e;
      const wacht = Math.min(30_000 * 2 ** (p - 1), 240_000);
      console.log(`  OSM vraagt rust bij ${naam} — ik wacht ${Math.round(wacht / 1000)} s en probeer opnieuw (poging ${p + 1}/${pogingen})…`);
      await slaap(wacht);
    }
  }
}

// Geometrie per route: kort lontje (25 s, 2 pogingen) — één trage route mag de
// oogst niet gijzelen. Bij 6 mislukkingen op rij: stroomonderbreker (5 min rust),
// daarna nog één kans; blijft het misgaan, dan stoppen we netjes (hervatbaar).
let mislukkingenOpRij = 0;
async function haalGeometrieSnel(relId) {
  for (let p = 1; p <= 2; p++) {
    try {
      const uit = await fetchKnownRouteGeometry(relId, { timeoutMs: 25_000 });
      mislukkingenOpRij = 0;
      return uit;
    } catch (e) {
      if (e?.status === 404) throw e; // geen geometrie = kandidaat echt ongeldig
      if (p === 2) {
        mislukkingenOpRij++;
        if (mislukkingenOpRij === 6) {
          console.log('  ⏸ 6 mislukkingen op rij — de OSM-server heeft ons even in de strafbank. Ik pauzeer 5 minuten…');
          await slaap(300_000);
          mislukkingenOpRij = 0;
          try {
            const uit = await fetchKnownRouteGeometry(relId, { timeoutMs: 25_000 });
            return uit;
          } catch {
            console.log('  ✋ Nog steeds geweigerd na de rustpauze. Ik bewaar de voortgang — start het script later gewoon opnieuw.');
            process.exit(2);
          }
        }
        throw e;
      }
      await slaap(8_000);
    }
  }
}

// Zware startquery's 7 dagen cachen zodat een herstart ze niet opnieuw doet.
async function metSchijfcache(bestand, ophaler) {
  const pad = join(DATA_DIR, 'cache', bestand);
  if (_ex(pad)) {
    try {
      const c = JSON.parse(_rf(pad, 'utf8'));
      if (Date.now() - c.t < 7 * 86_400_000) return c.data;
    } catch { /* herophalen */ }
  }
  const data = await ophaler();
  try { _mk(join(DATA_DIR, 'cache'), { recursive: true }); _wf(pad, JSON.stringify({ t: Date.now(), data })); } catch { /* best effort */ }
  return data;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.GOUT_DATA_DIR || join(ROOT, 'data');
const VOORTGANG_FILE = join(DATA_DIR, 'bibliotheek-voortgang.json');
// Beleefdheidspauze tussen echte (niet-gecachte) geometrie-ophalingen.
const PAUZE_MS = Number(process.env.BIB_PAUZE_MS ?? 1200);

const BIB_EMAIL = 'bibliotheek@gout.be';
const BIB_NAAM = 'G.O.U.T. Bibliotheek';
const BESCHRIJVING =
  'Bewegwijzerde route uit OpenStreetMap — automatisch opgenomen in de bibliotheek.';

// Per sport: welke route-waarden tellen, de scoregrens voor de distance-tag (km)
// en de aanvaarde werkelijke lengte (m) van de opgehaalde geometrie.
const SPORTS = {
  wandelen: { routeVals: ['hiking', 'foot'], tagKm: [5, 25], echtM: [4000, 30000] },
  mtb:      { routeVals: ['mtb'],            tagKm: [15, 45], echtM: [10000, 50000] },
};
const PER_SPORT_MAX = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ---- Overpass-queries -------------------------------------------------------

const gemeenteQuery = `[out:json][timeout:180];
area["ISO3166-1"="BE"][admin_level=2]->.be;
relation["boundary"="administrative"]["admin_level"="8"](area.be);
out tags center;`;

function kandidatenQuery(routeVals) {
  const regels = routeVals.map((v) => `  relation["route"="${v}"](area.be);`).join('\n');
  return `[out:json][timeout:300];
area["ISO3166-1"="BE"][admin_level=2]->.be;
(
${regels}
);
out tags center;`;
}

// ---- Ophalen, toewijzen & scoren -------------------------------------------

async function haalGemeenten() {
  const data = await metSchijfcache('bib-gemeenten.json',
    () => metGeduld('gemeentelijst', () => overpassQuery(gemeenteQuery)));
  const uit = [];
  for (const el of data.elements || []) {
    if (el.type !== 'relation') continue;
    const naam = el.tags?.name;
    const lat = el.center?.lat, lon = el.center?.lon;
    if (!naam || lat == null || lon == null) continue;
    uit.push({ id: el.id, naam, lat, lon });
  }
  return uit;
}

function parseDistanceKm(v) {
  if (v == null) return null;
  const m = String(v).replace(',', '.').match(/[\d.]+/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : null;
}

function scoreVan(tags, sport) {
  const cfg = SPORTS[sport];
  let score = 0;
  if (tags.name) score += 2;                                 // heeft naam
  const net = String(tags.network || '').toLowerCase();
  if (net === 'lwn' || net === 'rwn') score += 1;            // lokaal/regionaal netwerk
  const km = parseDistanceKm(tags.distance);
  if (km != null && km >= cfg.tagKm[0] && km <= cfg.tagKm[1]) score += 1; // lengte-tag in bereik
  // Ontbrekende distance-tag: geen strafpunt (km == null → +0).
  if (String(tags.roundtrip || '').toLowerCase() === 'yes') score += 1;   // rondlus
  return score;
}

// Dichtstbijzijnde gemeentekern (haversine op de centers).
function dichtstbijzijnde(lon, lat, gemeenten) {
  let best = null, bestD = Infinity;
  for (const g of gemeenten) {
    const d = haversine(lon, lat, g.lon, g.lat);
    if (d < bestD) { bestD = d; best = g; }
  }
  return { gemeente: best, afstand: bestD };
}

async function haalKandidaten(sport, gemeenten) {
  const data = await metSchijfcache(`bib-kandidaten-${sport}.json`,
    () => metGeduld(`kandidaten ${sport}`, () => overpassQuery(kandidatenQuery(SPORTS[sport].routeVals))));
  const perGemeente = new Map();
  for (const el of data.elements || []) {
    if (el.type !== 'relation') continue;
    const lat = el.center?.lat, lon = el.center?.lon;
    if (lat == null || lon == null) continue;
    const { gemeente, afstand } = dichtstbijzijnde(lon, lat, gemeenten);
    if (!gemeente) continue;
    const kand = {
      id: el.id,
      naam: el.tags?.name || null,
      score: scoreVan(el.tags || {}, sport),
      afstand,
    };
    if (!perGemeente.has(gemeente.id)) perGemeente.set(gemeente.id, []);
    perGemeente.get(gemeente.id).push(kand);
  }
  // Sorteer per gemeente: hoogste score eerst, dan dichtst bij de kern.
  for (const lijst of perGemeente.values()) {
    lijst.sort((a, b) => b.score - a.score || a.afstand - b.afstand);
  }
  return perGemeente;
}

// ---- Opslag -----------------------------------------------------------------

async function ensureBibliotheek() {
  const bestaand = db.prepare('SELECT id FROM users WHERE email = ?').get(BIB_EMAIL);
  if (bestaand) return bestaand.id;
  // Willekeurig wachtwoord — bewust NOOIT gelogd; het account is enkel eigenaar
  // van de bibliotheekroutes en logt zelf nooit in.
  const wachtwoord = crypto.randomBytes(24).toString('base64url');
  const info = db.prepare(
    'INSERT INTO users (email, name, pass_hash, avatar_color) VALUES (?, ?, ?, ?)'
  ).run(BIB_EMAIL, BIB_NAAM, await hashPassword(wachtwoord), '#3d5a3c');
  return Number(info.lastInsertRowid);
}

const bestaatRoute = (osmRelId) =>
  !!db.prepare('SELECT 1 FROM routes WHERE osm_rel_id = ?').get(osmRelId);

function slaOp(gemeente, sport, kand, track, bibId) {
  const s = routeStats(sport, track);
  const naam = kand.naam || `Bewegwijzerde route (OSM ${kand.id})`;
  db.prepare(`
    INSERT INTO routes (user_id, name, description, sport, track, distance_m, ascent_m, descent_m,
      duration_s, difficulty, visibility, start_lat, start_lon, bbox, region, source, preview,
      curated, osm_rel_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'public', ?, ?, ?, ?, 'gepland', ?, 1, ?)
  `).run(bibId, naam, BESCHRIJVING, sport, JSON.stringify(track), s.distance_m, s.ascent_m,
    s.descent_m, s.duration_s, s.difficulty, s.start_lat, s.start_lon, JSON.stringify(s.bbox),
    `${gemeente.naam}, België`, JSON.stringify(preview(track)), kand.id);
}

// ---- Voortgang (checkpoint) -------------------------------------------------

function laadVoortgang() {
  try { return JSON.parse(readFileSync(VOORTGANG_FILE, 'utf8')); } catch { return {}; }
}
function bewaarVoortgang(v) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(VOORTGANG_FILE, JSON.stringify(v, null, 2));
  } catch { /* best effort */ }
}

// Cachepad exact zoals server/knownroutes.js het schrijft.
const cacheAanwezig = (id) => existsSync(join(DATA_DIR, 'cache', `knownroute-${id}.json`));

// ---- Kernlogica per gemeente ------------------------------------------------

async function verwerkGemeente(gemeente, kandidaten, bibId, droog) {
  const tellers = {};
  const verworpen = [];
  let fetchFouten = 0;
  for (const sport of ['wandelen', 'mtb']) {
    const cfg = SPORTS[sport];
    const lijst = kandidaten[sport].get(gemeente.id) || [];
    let geldig = 0;
    for (const kand of lijst) {
      if (geldig >= PER_SPORT_MAX) break;
      // Idempotent: al opgenomen → telt mee, geen (dure) ophaling nodig.
      if (bestaatRoute(kand.id)) { geldig++; continue; }

      const uitCache = cacheAanwezig(kand.id);
      let geo;
      try {
        geo = await haalGeometrieSnel(kand.id);
      } catch (e) {
        if (!uitCache) await sleep(PAUZE_MS);
        if (e?.status === 404) {
          verworpen.push({ naam: kand.naam || `OSM ${kand.id}`, reden: 'geen geometrie' });
        } else {
          fetchFouten++;
          verworpen.push({ naam: kand.naam || `OSM ${kand.id}`, reden: 'server druk' });
        }
        continue;
      }
      if (!uitCache) await sleep(PAUZE_MS); // pauze na een echte ophaling

      const echtM = Math.round(trackDistance(geo.track));
      if (echtM < cfg.echtM[0] || echtM > cfg.echtM[1]) {
        verworpen.push({ naam: kand.naam || `OSM ${kand.id}`, km: Math.round(echtM / 1000) });
        continue;
      }
      if (!droog) slaOp(gemeente, sport, kand, geo.track, bibId);
      geldig++;
    }
    tellers[sport] = geldig;
  }

  let regel = `${gemeente.naam}: wandelen ${tellers.wandelen}/${PER_SPORT_MAX}, ` +
    `mtb ${tellers.mtb}/${PER_SPORT_MAX}`;
  if (verworpen.length) {
    const perReden = new Map();
    for (const v of verworpen) {
      const k = v.km != null ? `lengte (bv. ${v.km} km)` : v.reden;
      perReden.set(k, (perReden.get(k) || 0) + 1);
    }
    const details = [...perReden.entries()].map(([k, n]) => `${n}× ${k}`).join(', ');
    regel += ` (${verworpen.length} verworpen: ${details})`;
  }
  log(regel);
  return { tellers, fetchFouten };
}

// ---- CLI --------------------------------------------------------------------

function parseArgs(argv) {
  const args = { gemeente: null, max: null, droog: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--droog') args.droog = true;
    else if (a === '--gemeente') args.gemeente = argv[++i];
    else if (a.startsWith('--gemeente=')) args.gemeente = a.slice('--gemeente='.length);
    else if (a === '--max') args.max = parseInt(argv[++i], 10);
    else if (a.startsWith('--max=')) args.max = parseInt(a.slice('--max='.length), 10);
    else if (a === '--help' || a === '-h') { toonHelp(); process.exit(0); }
  }
  if (!Number.isInteger(args.max)) args.max = null;
  return args;
}

function toonHelp() {
  log(`Gebruik: node scripts/bibliotheek.js [opties]
  --gemeente "Naam"   verwerk alleen deze gemeente
  --max N             hoogstens N gemeenten deze run
  --droog             toon de keuzes maar schrijf niets weg`);
}

// ---- Hoofdprogramma ---------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  log(`G.O.U.T.-bibliotheek — oogst${args.droog ? ' (DROOGLOOP: niets wordt weggeschreven)' : ''}`);

  const bibId = args.droog ? null : await ensureBibliotheek();

  log('Belgische gemeenten ophalen…');
  const gemeenten = await haalGemeenten();
  log(`  ${gemeenten.length} gemeente(n) gevonden.`);

  log('Route-relaties per sport ophalen…');
  const kandWandelen = await haalKandidaten('wandelen', gemeenten);
  await slaap(5000); // adempauze tussen twee landelijke query's
  const kandidaten = {
    wandelen: kandWandelen,
    mtb: await haalKandidaten('mtb', gemeenten),
  };
  const totWandel = [...kandidaten.wandelen.values()].reduce((n, l) => n + l.length, 0);
  const totMtb = [...kandidaten.mtb.values()].reduce((n, l) => n + l.length, 0);
  log(`  ${totWandel} wandel- en ${totMtb} mtb-kandidaten toegewezen aan een gemeentekern.`);

  let teDoen = gemeenten;
  if (args.gemeente) {
    teDoen = gemeenten.filter((g) => g.naam.toLowerCase() === args.gemeente.toLowerCase());
    if (!teDoen.length) log(`Let op: geen gemeente "${args.gemeente}" gevonden.`);
  }

  const voortgang = laadVoortgang();
  const rapport = { gelukt: [], overgeslagen: [], gefaald: [] };
  let verwerkt = 0;

  for (const g of teDoen) {
    if (args.max != null && verwerkt >= args.max) break;
    if (!args.droog && voortgang[g.naam]?.status === 'klaar') {
      rapport.overgeslagen.push(g.naam);
      continue; // al klaar → telt niet mee voor --max
    }
    try {
      const { tellers, fetchFouten } = await verwerkGemeente(g, kandidaten, bibId, args.droog);
      const onvolledig = fetchFouten > 0 &&
        (tellers.wandelen < PER_SPORT_MAX || tellers.mtb < PER_SPORT_MAX);
      if (!args.droog) {
        voortgang[g.naam] = {
          status: onvolledig ? 'onvolledig' : 'klaar',
          ...tellers, bijgewerkt: new Date().toISOString(),
        };
        bewaarVoortgang(voortgang);
      }
      if (onvolledig) log(`  ⚠ ${g.naam} onvolledig door serverdrukte — volgende run probeert opnieuw.`);
      rapport.gelukt.push(g.naam);
    } catch (e) {
      rapport.gefaald.push({ naam: g.naam, fout: e.message });
      log(`  ✗ ${g.naam}: ${e.message}`);
    }
    verwerkt++;
  }

  log('');
  log('Eindrapport:');
  log(`  Gelukt:       ${rapport.gelukt.length}`);
  log(`  Overgeslagen: ${rapport.overgeslagen.length} (al klaar volgens checkpoint)`);
  log(`  Gefaald:      ${rapport.gefaald.length}`);
  for (const f of rapport.gefaald) log(`    - ${f.naam}: ${f.fout}`);
  if (args.droog) log('Droogloop voltooid — er is niets weggeschreven.');
}

main()
  .catch((e) => { console.error('Onverwachte fout:', e?.message || e); process.exitCode = 1; })
  .finally(() => {
    // Zorg dat alles op schijf staat (WAL naar hoofdbestand) en sluit netjes af,
    // zodat een parallel (read-only) proces alles kan lezen en de CLI prompt teruggeeft.
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* ok */ }
    try { db.close(); } catch { /* ok */ }
    process.exit(process.exitCode || 0);
  });
