// Importeer een hele map GPX-bestanden in één keer als openbare, aanbevolen
// routes — jouw handgekozen bibliotheek.
//
// Gebruik:
//   node scripts/import-map.js <map-met-gpx> <jouw@email.be> [--sport wandelen|fietsen|mtb] [--prive] [--gewoon]
//
//   --sport   sport voor alle bestanden in deze run (standaard: wandelen)
//   --prive   als privéroutes i.p.v. openbaar
//   --gewoon  zonder 'Aanbevolen'-label (standaard krijgen ze dat wél)

import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { db } from '../server/db.js';
import { routeStats, preview } from '../server/geo.js';

// Kleine GPX-lezer voor Node (geen DOMParser nodig): trkpt/rtept + ele + naam.
function parseGpxNode(text) {
  const naamMatch = text.match(/<trk>[\s\S]*?<name>([^<]+)<\/name>/) ||
    text.match(/<metadata>[\s\S]*?<name>([^<]+)<\/name>/) ||
    text.match(/<name>([^<]+)<\/name>/);
  const naam = naamMatch ? naamMatch[1].trim() : null;

  const track = [];
  const puntRe = /<(trkpt|rtept)\b[^>]*lat="(-?[\d.]+)"[^>]*lon="(-?[\d.]+)"[^>]*(?:\/>|>([\s\S]*?)<\/\1>)/g;
  let m;
  while ((m = puntRe.exec(text)) !== null) {
    const p = [Number(m[3]), Number(m[2])];
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const binnen = m[4] || '';
    const ele = binnen.match(/<ele>(-?[\d.]+)<\/ele>/);
    if (ele) p[2] = Number(ele[1]);
    track.push(p);
  }
  // lon/lat kunnen ook omgekeerd in het bestand staan (lon vóór lat)
  if (!track.length) {
    const puntRe2 = /<(trkpt|rtept)\b[^>]*lon="(-?[\d.]+)"[^>]*lat="(-?[\d.]+)"[^>]*(?:\/>|>([\s\S]*?)<\/\1>)/g;
    while ((m = puntRe2.exec(text)) !== null) {
      const p = [Number(m[2]), Number(m[3])];
      const binnen = m[4] || '';
      const ele = binnen.match(/<ele>(-?[\d.]+)<\/ele>/);
      if (ele) p[2] = Number(ele[1]);
      track.push(p);
    }
  }
  return { naam, track };
}

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const rest = args.filter((a) => !a.startsWith('--') && !['wandelen', 'fietsen', 'mtb'].includes(a));
const sportIdx = args.indexOf('--sport');
const sport = sportIdx >= 0 ? args[sportIdx + 1] : 'wandelen';
const [map, email] = rest;

if (!map || !email || !['wandelen', 'fietsen', 'mtb'].includes(sport)) {
  console.error('Gebruik: node scripts/import-map.js <map-met-gpx> <jouw@email.be> [--sport wandelen|fietsen|mtb] [--prive] [--gewoon]');
  process.exit(1);
}
const user = db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);
if (!user) { console.error(`Geen account gevonden voor ${email}.`); process.exit(1); }

const bestanden = readdirSync(map).filter((f) => f.toLowerCase().endsWith('.gpx'));
if (!bestanden.length) { console.error(`Geen .gpx-bestanden gevonden in ${map}`); process.exit(1); }

console.log(`${bestanden.length} GPX-bestand(en) importeren als ${sport} voor ${user.name}…`);
let ok = 0, overgeslagen = 0, fout = 0;

for (const bestand of bestanden) {
  try {
    const tekst = readFileSync(join(map, bestand), 'utf8');
    const { naam, track } = parseGpxNode(tekst);
    const routenaam = (naam || basename(bestand, '.gpx').replace(/[-_]+/g, ' ')).slice(0, 120);
    if (track.length < 2) { console.log(`  ✗ ${bestand}: geen trackpunten`); fout++; continue; }
    if (db.prepare('SELECT id FROM routes WHERE user_id = ? AND name = ?').get(user.id, routenaam)) {
      console.log(`  ↷ ${routenaam} bestaat al`);
      overgeslagen++;
      continue;
    }
    const s = routeStats(sport, track);
    db.prepare(`
      INSERT INTO routes (user_id, name, description, sport, waypoints, track, distance_m,
        ascent_m, descent_m, duration_s, difficulty, visibility, start_lat, start_lon,
        bbox, region, source, gpx, curated, preview)
      VALUES (?, ?, '', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'geimporteerd', ?, ?, ?)
    `).run(
      user.id, routenaam, sport, JSON.stringify(track),
      s.distance_m, s.ascent_m, s.descent_m, s.duration_s, s.difficulty,
      flags.has('--prive') ? 'private' : 'public',
      s.start_lat, s.start_lon, JSON.stringify(s.bbox),
      tekst, flags.has('--gewoon') ? 0 : 1, JSON.stringify(preview(track)),
    );
    console.log(`  ✔ ${routenaam} — ${(s.distance_m / 1000).toFixed(1)} km, ↗ ${s.ascent_m} m`);
    ok++;
  } catch (e) {
    console.log(`  ✗ ${bestand}: ${e.message}`);
    fout++;
  }
}
console.log(`\nKlaar: ${ok} geïmporteerd, ${overgeslagen} bestond al, ${fout} mislukt.`);
