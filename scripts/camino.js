// Zet de camino-etappe "Van Orléans naar Tours" (±138 km langs de Loire) in
// je eigen account, gepland via BRouter, en schrijf het GPX-bestand ernaast.
//
// Gebruik (in de projectmap, nadat je je account in de app hebt aangemaakt):
//   node scripts/camino.js jouw@email.be
//
// Werkt ook offline testbaar met: BROUTER_URL=http://localhost:17777

import { writeFileSync } from 'node:fs';
import { db } from '../server/db.js';
import { routeStats, preview } from '../server/geo.js';
import { buildGpx } from '../server/gpx.js';

const BROUTER_URL = process.env.BROUTER_URL || 'https://brouter.de/brouter';

// Etappepunten langs de Loire (lon, lat) — de klassieke corridor van de
// jacobsweg tussen Orléans en Tours.
const WAYPOINTS = [
  [1.8385, 47.8880], // La Chapelle-Saint-Mesmin (Orléans)
  [1.6957, 47.8306], // Meung-sur-Loire
  [1.6320, 47.7797], // Beaugency
  [1.4855, 47.6560], // Saint-Dyé-sur-Loire
  [1.3337, 47.5861], // Blois
  [1.1834, 47.4809], // Chaumont-sur-Loire
  [0.9846, 47.4136], // Amboise
  [0.8309, 47.3884], // Montlouis-sur-Loire
  [0.6635, 47.3512], // Joué-lès-Tours (Tours)
];

const email = process.argv[2];
if (!email) {
  console.error('Gebruik: node scripts/camino.js <e-mailadres van je account>');
  process.exit(1);
}
const user = db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);
if (!user) {
  console.error(`Geen account gevonden voor ${email}. Maak eerst een account aan in de app.`);
  process.exit(1);
}

async function fetchLeg(a, b, profile) {
  const lonlats = `${a[0]},${a[1]}|${b[0]},${b[1]}`;
  const url = `${BROUTER_URL}?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=geojson`;
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`BRouter ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const g = await r.json();
  return g.features[0].geometry.coordinates; // [[lon,lat,ele],...]
}

console.log(`Route plannen voor ${user.name} — ${WAYPOINTS.length - 1} etappestukken via BRouter...`);
let track = [];
for (let i = 1; i < WAYPOINTS.length; i++) {
  let leg;
  try {
    leg = await fetchLeg(WAYPOINTS[i - 1], WAYPOINTS[i], 'hiking-beta');
  } catch {
    leg = await fetchLeg(WAYPOINTS[i - 1], WAYPOINTS[i], 'trekking'); // fallback
  }
  track = track.concat(i === 1 ? leg : leg.slice(1));
  console.log(`  ✔ stuk ${i}/${WAYPOINTS.length - 1} (${track.length} punten)`);
  await new Promise((r) => setTimeout(r, 800)); // hoffelijk voor de publieke server
}

const name = 'Van Orléans naar Tours';
const description =
  'Camino-etappe langs de Loire: Orléans – Meung-sur-Loire – Beaugency – Blois – ' +
  'Chaumont – Amboise – Tours. Geplande wandelroute, opgedeeld in dagetappes naar keuze.';
const s = routeStats('wandelen', track);
const waypoints = WAYPOINTS.map(([lon, lat]) => ({ lon, lat }));

const bestaand = db.prepare('SELECT id FROM routes WHERE user_id = ? AND name = ?').get(user.id, name);
if (bestaand) {
  db.prepare(`
    UPDATE routes SET track = ?, waypoints = ?, distance_m = ?, ascent_m = ?, descent_m = ?,
      duration_s = ?, difficulty = ?, bbox = ?, start_lat = ?, start_lon = ?,
      preview = ?, gpx = NULL, updated_at = datetime('now') WHERE id = ?
  `).run(JSON.stringify(track), JSON.stringify(waypoints), s.distance_m, s.ascent_m, s.descent_m,
    s.duration_s, s.difficulty, JSON.stringify(s.bbox), s.start_lat, s.start_lon,
    JSON.stringify(preview(track)), bestaand.id);
  console.log(`\n✔ Bestaande route bijgewerkt (id ${bestaand.id}).`);
} else {
  const info = db.prepare(`
    INSERT INTO routes (user_id, name, description, sport, waypoints, track, distance_m,
      ascent_m, descent_m, duration_s, difficulty, visibility, start_lat, start_lon,
      bbox, region, source, preview)
    VALUES (?, ?, ?, 'wandelen', ?, ?, ?, ?, ?, ?, ?, 'private', ?, ?, ?, 'Orléans, Frankrijk', 'gepland', ?)
  `).run(user.id, name, description, JSON.stringify(waypoints), JSON.stringify(track),
    s.distance_m, s.ascent_m, s.descent_m, s.duration_s, s.difficulty,
    s.start_lat, s.start_lon, JSON.stringify(s.bbox), JSON.stringify(preview(track)));
  console.log(`\n✔ Route opgeslagen in je account (id ${Number(info.lastInsertRowid)}).`);
}

const gpxPath = 'camino-orleans-tours.gpx';
writeFileSync(gpxPath, buildGpx({ name, description, track, sport: 'wandelen' }));
console.log(`✔ GPX-bestand geschreven: ${gpxPath}`);
console.log(`\n${name}: ${(s.distance_m / 1000).toFixed(1)} km · ↗ ${s.ascent_m} m · ↘ ${s.descent_m} m`);
console.log('Ververs de app (F5) en kijk bij Mijn routes. Buen camino!');
