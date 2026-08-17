// Demodata: demo-account + drie openbare voorbeeldroutes rond Opwijk/Aalst.
// Draaien: npm run seed  (idempotent: slaat over wat al bestaat)

import { db } from '../server/db.js';
import { hashPassword } from '../server/auth.js';
import { routeStats, preview } from '../server/geo.js';

async function ensureUser(email, name, password, color) {
  const bestaand = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (bestaand) return bestaand.id;
  const info = db.prepare(
    'INSERT INTO users (email, name, pass_hash, avatar_color) VALUES (?, ?, ?, ?)'
  ).run(email, name, await hashPassword(password), color);
  return Number(info.lastInsertRowid);
}

// Synthetische maar geloofwaardige lus rond een middelpunt.
function loop(lonC, latC, straalKm, punten, hoogteBasis, hoogteAmp) {
  const track = [];
  const rLon = straalKm / 71.5, rLat = straalKm / 111.3;
  for (let i = 0; i <= punten; i++) {
    const a = (i / punten) * 2 * Math.PI;
    const wob = 1 + 0.18 * Math.sin(a * 3.3) + 0.08 * Math.sin(a * 7.1);
    track.push([
      lonC + Math.cos(a) * rLon * wob,
      latC + Math.sin(a) * rLat * wob,
      Math.round(hoogteBasis + hoogteAmp * (Math.sin(a * 2) + 0.5 * Math.sin(a * 5)) * 10) / 10,
    ]);
  }
  return track;
}

// Opruimoptie: npm run seed -- --verwijder-voorbeelden
// (wist de voorbeeldroutes en -highlights van het demo-account; het account blijft)
if (process.argv.includes('--verwijder-voorbeelden')) {
  const demo = db.prepare('SELECT id FROM users WHERE email = ?').get('demo@gout.be');
  if (demo) {
    const namen = ['Lus door de Brabantse Kouters', 'MTB-rondje Affligem', 'Dendervallei-verkenner'];
    for (const n of namen) {
      const r = db.prepare('DELETE FROM routes WHERE user_id = ? AND name = ?').run(demo.id, n);
      if (r.changes) console.log(`✘ route verwijderd: ${n}`);
    }
    const h = db.prepare('DELETE FROM highlights WHERE user_id = ?').run(demo.id);
    if (h.changes) console.log(`✘ ${h.changes} voorbeeld-highlight(s) verwijderd`);
    console.log('Voorbeelddata opgeruimd.');
  } else {
    console.log('Geen demo-account gevonden — niets te doen.');
  }
  process.exit(0);
}

const demoId = await ensureUser('demo@gout.be', 'Demo Wandelaar', 'demo1234', '#33586e');

const voorbeelden = [
  { name: 'Lus door de Brabantse Kouters', sport: 'wandelen', c: [4.185, 50.935], r: 4.2, ele: [35, 18], region: 'Opwijk, België', desc: 'Rustige wandeling door veldwegen en kerkpaadjes rond Opwijk.' },
  { name: 'MTB-rondje Affligem', sport: 'mtb', c: [4.11, 50.90], r: 7.5, ele: [40, 30], region: 'Affligem, België', desc: 'Speels rondje met korte kuitenbijters en een paar mooie dreven.' },
  { name: 'Dendervallei-verkenner', sport: 'fietsen', c: [4.05, 50.94], r: 12, ele: [25, 15], region: 'Aalst, België', desc: 'Vlakke tocht langs het jaagpad met koffiestop in Aalst.' },
];

for (const v of voorbeelden) {
  const bestaat = db.prepare('SELECT id FROM routes WHERE user_id = ? AND name = ?').get(demoId, v.name);
  if (bestaat) continue;
  const track = loop(v.c[0], v.c[1], v.r, 160, v.ele[0], v.ele[1]);
  const s = routeStats(v.sport, track);
  db.prepare(`
    INSERT INTO routes (user_id, name, description, sport, track, distance_m, ascent_m, descent_m,
      duration_s, difficulty, visibility, start_lat, start_lon, bbox, region, source, preview)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'public', ?, ?, ?, ?, 'gepland', ?)
  `).run(demoId, v.name, v.desc, v.sport, JSON.stringify(track), s.distance_m, s.ascent_m,
    s.descent_m, s.duration_s, s.difficulty, s.start_lat, s.start_lon,
    JSON.stringify(s.bbox), v.region, JSON.stringify(preview(track)));
  console.log(`✔ route: ${v.name}`);
}

// Voorbeeld-highlights zodat de functie meteen zichtbaar is (rond de demoroutes).
const hlVoorbeelden = [
  { name: 'Bankje met uitzicht over de kouters', category: 'uitzicht', sport: 'wandelen',
    track: [[4.169, 50.942, 45]] },
  { name: 'Kapelletje van Mazenzele', category: 'bezienswaardig', sport: 'alle',
    track: [[4.196, 50.928, 38]] },
  { name: 'Dreef door het Kravaalbos', category: 'trail', sport: 'alle',
    track: [[4.155, 50.935, 40], [4.158, 50.938, 42], [4.162, 50.940, 44], [4.166, 50.941, 43]] },
];
for (const h of hlVoorbeelden) {
  const bestaat = db.prepare('SELECT id FROM highlights WHERE user_id = ? AND name = ?').get(demoId, h.name);
  if (bestaat) continue;
  const lons = h.track.map((p) => p[0]), lats = h.track.map((p) => p[1]);
  db.prepare(`
    INSERT INTO highlights (user_id, name, description, sport, track, category, start_lat, start_lon, bbox)
    VALUES (?, ?, '', ?, ?, ?, ?, ?, ?)
  `).run(demoId, h.name, h.sport, JSON.stringify(h.track), h.category,
    h.track[0][1], h.track[0][0],
    JSON.stringify([Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]));
  console.log(`✔ highlight: ${h.name}`);
}

console.log('Klaar. Demo-account: demo@gout.be / demo1234');
