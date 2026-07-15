// Jullie camino-dagplanning (het handgeschreven briefje van 23-29 juli) als
// zeven aparte dagroutes in je account, elk met GPX en "Start live".
//
// Gebruik: node scripts/camino-dagen.js jouw@email.be

import { db } from '../server/db.js';
import { routeStats, preview } from '../server/geo.js';

const BROUTER_URL = process.env.BROUTER_URL || 'https://brouter.de/brouter';

// Overnachtings- en tussenpunten (lon, lat). Twee gehuchten zijn benaderd —
// versleep het eindpunt gerust in de planner (Bewerken) als het net anders ligt.
const P = {
  orleans: [1.904, 47.900],
  saintAy: [1.751, 47.858],
  beaugency: [1.632, 47.780],
  lestiou: [1.585, 47.755],
  suevres: [1.462, 47.665],
  menars: [1.400, 47.643],
  blois: [1.334, 47.586],
  cande: [1.258, 47.494],          // Candé-sur-Beuvron
  chaumont: [1.183, 47.481],
  laBarre: [1.089, 47.446],        // ± Mosnes; "La Barre" benaderd
  amboise: [0.985, 47.413],
  ormeauxVigneau: [0.925, 47.393], // ± Lussault-sur-Loire; benaderd
  tours: [0.693, 47.390],
};

const DAGEN = [
  { datum: '23/07', naam: 'Orléans → Saint-Ay', punten: [P.orleans, P.saintAy], briefje: 13 },
  { datum: '24/07', naam: 'Saint-Ay → Lestiou (via Beaugency)', punten: [P.saintAy, P.beaugency, P.lestiou], briefje: 25 },
  { datum: '25/07', naam: 'Lestiou → Ménars (via Suèvres)', punten: [P.lestiou, P.suevres, P.menars], briefje: 20 },
  { datum: '26/07', naam: 'Ménars → Candé-sur-Beuvron (via Blois, regio Chambord)', punten: [P.menars, P.blois, P.cande], briefje: 25 },
  { datum: '27/07', naam: 'Candé-sur-Beuvron → La Barre (via Chaumont)', punten: [P.cande, P.chaumont, P.laBarre], briefje: 19 },
  { datum: '28/07', naam: 'La Barre → L’Ormeaux-Vigneau (via Amboise)', punten: [P.laBarre, P.amboise, P.ormeauxVigneau], briefje: 17 },
  { datum: '29/07', naam: 'L’Ormeaux-Vigneau → Tours', punten: [P.ormeauxVigneau, P.tours], briefje: 24 },
];

const email = process.argv[2];
if (!email) {
  console.error('Gebruik: node scripts/camino-dagen.js <e-mailadres van je account>');
  process.exit(1);
}
const user = db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);
if (!user) {
  console.error(`Geen account gevonden voor ${email}.`);
  process.exit(1);
}

async function fetchLeg(a, b, profile) {
  const url = `${BROUTER_URL}?lonlats=${a[0]},${a[1]}|${b[0]},${b[1]}&profile=${profile}&alternativeidx=0&format=geojson`;
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`BRouter ${r.status}`);
  return (await r.json()).features[0].geometry.coordinates;
}

console.log(`Camino-dagetappes plannen voor ${user.name} (${DAGEN.length} dagen)…`);
let dag = 0;
for (const d of DAGEN) {
  dag++;
  const naam = `Camino dag ${dag} (${d.datum}): ${d.naam}`;
  if (db.prepare('SELECT id FROM routes WHERE user_id = ? AND name = ?').get(user.id, naam)) {
    console.log(`  ↷ dag ${dag} bestaat al — overgeslagen`);
    continue;
  }
  let track = [];
  for (let i = 1; i < d.punten.length; i++) {
    let leg;
    try { leg = await fetchLeg(d.punten[i - 1], d.punten[i], 'hiking-beta'); }
    catch { leg = await fetchLeg(d.punten[i - 1], d.punten[i], 'trekking'); }
    track = track.concat(i === 1 ? leg : leg.slice(1));
    await new Promise((r) => setTimeout(r, 700));
  }
  const s = routeStats('wandelen', track);
  db.prepare(`
    INSERT INTO routes (user_id, name, description, sport, waypoints, track, distance_m,
      ascent_m, descent_m, duration_s, difficulty, visibility, start_lat, start_lon,
      bbox, region, source, preview)
    VALUES (?, ?, ?, 'wandelen', ?, ?, ?, ?, ?, ?, ?, 'private', ?, ?, ?, ?, 'gepland', ?)
  `).run(
    user.id, naam,
    `Dagetappe van jullie camino-briefje (${d.briefje} km gepland). La Barre en L’Ormeaux-Vigneau zijn benaderd — versleep het punt via Bewerken indien nodig.`,
    JSON.stringify(d.punten.map(([lon, lat]) => ({ lon, lat }))),
    JSON.stringify(track), s.distance_m, s.ascent_m, s.descent_m, s.duration_s,
    s.difficulty, s.start_lat, s.start_lon, JSON.stringify(s.bbox),
    'Loire, Frankrijk', JSON.stringify(preview(track)),
  );
  console.log(`  ✔ dag ${dag} (${d.datum}): ${(s.distance_m / 1000).toFixed(1)} km (briefje: ${d.briefje} km)`);
}
console.log('\nKlaar! Kijk bij Mijn routes — zeven dagen, elk met GPX en Start live. Buen camino!');
