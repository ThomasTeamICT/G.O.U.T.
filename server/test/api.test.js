// Integratietests tegen een echte serverinstantie met :memory:-databank.
// Draait met: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = 4321;
const BASE = `http://localhost:${PORT}`;
let proc;

function client() {
  let cookie = '';
  return {
    async req(method, path, body, raw = false) {
      const res = await fetch(BASE + path, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      if (raw) return res;
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      return { status: res.status, data };
    },
  };
}

// Vierkantje rond Opwijk met hoogtes: klim en afdaling.
const TRACK = [];
for (let i = 0; i <= 40; i++) {
  const t = i / 40;
  TRACK.push([4.18 + 0.02 * t, 50.93 + 0.01 * Math.sin(t * Math.PI), 20 + 30 * Math.sin(t * Math.PI)]);
}
const TIMED_TRACK = TRACK.map((p, i) => [p[0], p[1], p[2], 1750000000 + i * 60]);

let mockProc;
before(async () => {
  mockProc = spawn(process.execPath, ['scripts/mock-brouter.js'], { stdio: 'ignore' });
  proc = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    env: {
      ...process.env, GOUT_DB: ':memory:', PORT: String(PORT),
      BROUTER_URL: 'http://localhost:17777',
      WMT_BASE: 'http://localhost:17777/wmt/{site}',
      OVERPASS_URL: 'http://localhost:17777/overpass',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('server startte niet')), 8000);
    proc.stdout.on('data', (d) => {
      if (String(d).includes('draait op')) { clearTimeout(to); resolve(); }
    });
  });
});

after(() => { proc?.kill(); mockProc?.kill(); });

test('auth: registreren, me, verkeerd wachtwoord', async () => {
  const c = client();
  let r = await c.req('POST', '/api/auth/register', { email: 'a@test.be', name: 'Anna', password: 'wachtwoord1' });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.name, 'Anna');

  r = await c.req('GET', '/api/auth/me');
  assert.equal(r.data.user.email, 'a@test.be');

  const c2 = client();
  r = await c2.req('POST', '/api/auth/login', { email: 'a@test.be', password: 'fout' });
  assert.equal(r.status, 401);
});

test('routes: CRUD + GPX + delen + likes', async () => {
  const anna = client();
  await anna.req('POST', '/api/auth/register', { email: 'anna@test.be', name: 'Anna', password: 'wachtwoord1' });

  // aanmaken
  let r = await anna.req('POST', '/api/routes', {
    name: 'Testtocht', description: 'Mooie lus', sport: 'wandelen', track: TRACK,
    waypoints: [{ lon: 4.18, lat: 50.93 }, { lon: 4.20, lat: 50.93 }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const route = r.data.route;
  assert.equal(route.name, 'Testtocht');
  assert.ok(route.distanceM > 1000, 'afstand berekend');
  assert.ok(route.ascentM > 0, 'stijging berekend');
  assert.ok(route.preview.length >= 2, 'preview aanwezig');
  assert.equal(route.visibility, 'private');

  // lijst
  r = await anna.req('GET', '/api/routes');
  assert.equal(r.data.routes.length, 1);

  // GPX
  const gpxRes = await anna.req('GET', `/api/routes/${route.id}/gpx`, undefined, true);
  assert.equal(gpxRes.status, 200);
  assert.match(gpxRes.headers.get('content-type') || '', /gpx/);
  const gpx = await gpxRes.text();
  assert.match(gpx, /<trkpt/);
  assert.match(gpx, /Testtocht/);

  // update naam + zichtbaarheid
  r = await anna.req('PUT', `/api/routes/${route.id}`, { name: 'Testtocht 2', visibility: 'public' });
  assert.equal(r.status, 200);
  assert.equal(r.data.route.name, 'Testtocht 2');
  assert.equal(r.data.route.visibility, 'public');

  // delen
  r = await anna.req('POST', `/api/routes/${route.id}/share`);
  const token = r.data.shareToken;
  assert.ok(token && token.length > 8);

  // publieke share zonder login
  const anon = client();
  r = await anon.req('GET', `/api/shared/${token}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.route.name, 'Testtocht 2');
  assert.equal(r.data.route.shareToken, null, 'token niet lekken naar bezoekers');
  const sharedGpx = await anon.req('GET', `/api/shared/${token}/gpx`, undefined, true);
  assert.equal(sharedGpx.status, 200);

  // tweede gebruiker: like + geen toegang tot privé
  const bert = client();
  await bert.req('POST', '/api/auth/register', { email: 'bert@test.be', name: 'Bert', password: 'wachtwoord1' });
  r = await bert.req('POST', `/api/routes/${route.id}/like`);
  assert.equal(r.status, 200);
  assert.equal(r.data.likes, 1);
  assert.equal(r.data.liked, true);

  r = await bert.req('GET', `/api/routes/${route.id}`);
  assert.equal(r.status, 200, 'public route leesbaar voor andere gebruiker');
  r = await bert.req('PUT', `/api/routes/${route.id}`, { name: 'hack' });
  assert.ok(r.status === 403 || r.status === 404, 'andermans route niet bewerken');

  // privé maken -> Bert ziet 404
  await anna.req('PUT', `/api/routes/${route.id}`, { visibility: 'private' });
  r = await bert.req('GET', `/api/routes/${route.id}`);
  assert.equal(r.status, 404);
});

test('routes: import bewaart origineel gpx', async () => {
  const c = client();
  await c.req('POST', '/api/auth/register', { email: 'imp@test.be', name: 'Import', password: 'wachtwoord1' });
  const origineel = '<?xml version="1.0"?><gpx version="1.1" creator="elders"><trk><trkseg>' +
    TRACK.slice(0, 5).map((p) => `<trkpt lat="${p[1]}" lon="${p[0]}"><ele>${p[2]}</ele></trkpt>`).join('') +
    '</trkseg></trk></gpx>';
  let r = await c.req('POST', '/api/routes/import', {
    name: 'Camino etappe', sport: 'wandelen', track: TRACK.slice(0, 5), gpx: origineel,
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.route.source, 'geimporteerd');
  const gpxRes = await c.req('GET', `/api/routes/${r.data.route.id}/gpx`, undefined, true);
  const text = await gpxRes.text();
  assert.match(text, /creator="elders"/, 'origineel gpx teruggeven zolang onbewerkt');
});

test('activiteiten: aanmaken + stats', async () => {
  const c = client();
  await c.req('POST', '/api/auth/register', { email: 'act@test.be', name: 'Actief', password: 'wachtwoord1' });

  let r = await c.req('POST', '/api/activities', {
    name: 'Ochtendwandeling', sport: 'wandelen', track: TIMED_TRACK,
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const act = r.data.activity;
  assert.ok(act.distanceM > 1000);
  assert.ok(act.elapsedS === 40 * 60, `elapsed uit timestamps (kreeg ${act.elapsedS})`);
  assert.ok(act.movingS > 0, 'bewegingstijd berekend');
  assert.ok(act.startedAt, 'startdatum afgeleid');

  r = await c.req('GET', '/api/activities');
  assert.equal(r.data.activities.length, 1);

  r = await c.req('GET', '/api/stats');
  assert.equal(r.status, 200);
  assert.equal(r.data.totals.count, 1);
  assert.ok(r.data.totals.distanceM > 1000);
  assert.equal(r.data.monthly.length, 12);
  assert.ok(r.data.records.longest, 'record aanwezig');

  const gpxRes = await c.req('GET', `/api/activities/${act.id}/gpx`, undefined, true);
  assert.equal(gpxRes.status, 200);
  assert.match(await gpxRes.text(), /<time>/, 'tijden mee in gpx');
});

test('ontdek: publieke routes + top 10', async () => {
  const c = client();
  await c.req('POST', '/api/auth/register', { email: 'ont@test.be', name: 'Ontdekker', password: 'wachtwoord1' });
  let r = await c.req('POST', '/api/routes', { name: 'Openbare lus', sport: 'mtb', track: TRACK });
  const id = r.data.route.id;
  await c.req('PUT', `/api/routes/${id}`, { visibility: 'public' });

  r = await c.req('GET', '/api/discover?bbox=4.0,50.8,4.4,51.0');
  assert.equal(r.status, 200);
  assert.ok(r.data.routes.some((x) => x.id === id), 'route in gebied gevonden');
  assert.ok(r.data.routes.every((x) => x.visibility === 'public'));
  assert.ok(r.data.routes.find((x) => x.id === id).ownerName, 'ownerName aanwezig');

  r = await c.req('GET', '/api/discover?bbox=10.0,50.0,10.5,50.5');
  assert.ok(!r.data.routes.some((x) => x.id === id), 'buiten gebied niet gevonden');

  r = await c.req('GET', '/api/discover/top');
  assert.equal(r.status, 200);
  assert.ok(r.data.routes.length >= 1);
});

test('beveiliging: auth verplicht, validatie', async () => {
  const anon = client();
  let r = await anon.req('GET', '/api/routes');
  assert.equal(r.status, 401);
  r = await anon.req('GET', '/api/activities');
  assert.equal(r.status, 401);
  r = await anon.req('GET', '/api/routing?lonlats=4,50|4.1,50.1&sport=wandelen');
  assert.equal(r.status, 401);

  const c = client();
  await c.req('POST', '/api/auth/register', { email: 'val@test.be', name: 'Valid', password: 'wachtwoord1' });
  r = await c.req('POST', '/api/routes', { name: '', sport: 'wandelen', track: TRACK });
  assert.equal(r.status, 400, 'lege naam geweigerd');
  r = await c.req('POST', '/api/routes', { name: 'x', sport: 'zwemmen', track: TRACK });
  assert.equal(r.status, 400, 'onbekende sport geweigerd');
  r = await c.req('POST', '/api/routes', { name: 'x', sport: 'wandelen', track: [[1, 2]] });
  assert.equal(r.status, 400, 'te korte track geweigerd');
  r = await c.req('GET', '/api/routing?lonlats=kwaad&sport=wandelen');
  assert.equal(r.status, 400, 'ongeldige lonlats geweigerd');
});

test('review-fixes: tijdvalidatie, spaarzame logging, eigen like', async () => {
  const c = client();
  await c.req('POST', '/api/auth/register', { email: 'fix@test.be', name: 'Fixer', password: 'wachtwoord1' });

  // absurde timestamps netjes geweigerd (geen 500 meer op gpx-download)
  const badTrack = [[4.5, 50.8, 100, 1e15], [4.6, 50.9, 110, 1e15]];
  let r = await c.req('POST', '/api/routes', { name: 'x', sport: 'wandelen', track: badTrack });
  assert.equal(r.status, 400, 'route met onmogelijke tijd geweigerd');
  r = await c.req('POST', '/api/activities', { name: 'x', sport: 'wandelen', track: badTrack });
  assert.equal(r.status, 400, 'activiteit met onmogelijke tijd geweigerd');

  // spaarzaam geloggede GPX (punt om de 90 s, wandeltempo) telt als bewegen
  const sparse = [];
  for (let i = 0; i <= 20; i++) sparse.push([4.18 + 0.0018 * i, 50.93, 20, 1750000000 + i * 90]);
  r = await c.req('POST', '/api/activities', { name: 'Spaarzaam', sport: 'wandelen', track: sparse });
  assert.equal(r.status, 201);
  assert.ok(r.data.activity.movingS > 0, `bewegingstijd bij 90s-intervallen (kreeg ${r.data.activity.movingS})`);

  // eigen openbare route liken kan niet
  r = await c.req('POST', '/api/routes', { name: 'Eigen lus', sport: 'wandelen', track: TRACK });
  const rid = r.data.route.id;
  await c.req('PUT', `/api/routes/${rid}`, { visibility: 'public' });
  r = await c.req('POST', `/api/routes/${rid}/like`);
  assert.equal(r.status, 400, 'eigen route liken geblokkeerd');
});

test('bekende routes: zoeken en geometrie aaneenrijgen', async () => {
  const c = client();
  await c.req('POST', '/api/auth/register', { email: 'gr@test.be', name: 'GRfan', password: 'wachtwoord1' });

  let r = await c.req('GET', '/api/knownroutes?q=via&sport=wandelen');
  assert.equal(r.status, 200);
  assert.ok(r.data.routes.length >= 2, 'zoekresultaten uit WMT');
  assert.ok(r.data.routes[0].name);

  r = await c.req('GET', '/api/knownroutes/902?sport=wandelen');
  assert.equal(r.status, 200);
  assert.equal(r.data.name, 'Via Turonensis (Parijs - Tours)');
  assert.ok(Array.isArray(r.data.track) && r.data.track.length >= 5, 'aaneengeregen track');
  // segmenten [4.30..4.20] en [4.20..4.10] moeten één doorlopende ketting vormen
  const lons = r.data.track.map((p) => p[0]);
  const sorted = [...lons].sort((a, b) => b - a);
  assert.deepEqual(lons, sorted, 'kettingvolgorde klopt (aflopende lon)');

  r = await c.req('GET', '/api/knownroutes/abc?sport=wandelen');
  assert.equal(r.status, 400);

  const anon = client();
  r = await anon.req('GET', '/api/knownroutes?q=via');
  assert.equal(r.status, 401, 'auth verplicht');
});

test('highlights: aanmaken, zoeken op gebied, stemmen', async () => {
  const anna = client();
  await anna.req('POST', '/api/auth/register', { email: 'hl-anna@test.be', name: 'Anna', password: 'wachtwoord1' });

  // aanmaken
  let r = await anna.req('POST', '/api/highlights', {
    name: 'Mooi uitzicht', description: 'Prachtig panorama', sport: 'wandelen', track: TRACK.slice(0, 10),
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const hl = r.data.highlight;
  assert.equal(hl.name, 'Mooi uitzicht');
  assert.equal(hl.sport, 'wandelen');
  assert.equal(hl.votes, 0);
  assert.equal(hl.voted, false);
  assert.equal(hl.isOwner, true);
  assert.ok(Array.isArray(hl.bbox) && hl.bbox.length === 4, 'bbox berekend');
  assert.ok(hl.startLat != null && hl.startLon != null, 'start berekend');
  assert.equal(hl.ownerName, 'Anna');

  // zoeken in gebied -> gevonden
  r = await anna.req('GET', '/api/highlights?bbox=4.0,50.8,4.4,51.0');
  assert.equal(r.status, 200);
  assert.ok(r.data.highlights.some((x) => x.id === hl.id), 'highlight in gebied gevonden');

  // sportfilter mtb vindt een wandel-highlight niet
  r = await anna.req('GET', '/api/highlights?bbox=4.0,50.8,4.4,51.0&sport=mtb');
  assert.ok(!r.data.highlights.some((x) => x.id === hl.id), 'andere sport niet gevonden');

  // buiten gebied -> niet gevonden
  r = await anna.req('GET', '/api/highlights?bbox=10.0,50.0,10.5,50.5');
  assert.ok(!r.data.highlights.some((x) => x.id === hl.id), 'buiten gebied niet gevonden');

  // bbox verplicht
  r = await anna.req('GET', '/api/highlights');
  assert.equal(r.status, 400, 'bbox verplicht');

  // tweede gebruiker stemt + unstemt
  const bert = client();
  await bert.req('POST', '/api/auth/register', { email: 'hl-bert@test.be', name: 'Bert', password: 'wachtwoord1' });
  r = await bert.req('POST', `/api/highlights/${hl.id}/vote`);
  assert.equal(r.status, 200);
  assert.equal(r.data.votes, 1);
  assert.equal(r.data.voted, true);
  // dubbel stemmen blijft 1 (INSERT OR IGNORE)
  r = await bert.req('POST', `/api/highlights/${hl.id}/vote`);
  assert.equal(r.data.votes, 1, 'dubbele stem telt niet dubbel');
  r = await bert.req('DELETE', `/api/highlights/${hl.id}/vote`);
  assert.equal(r.status, 200);
  assert.equal(r.data.votes, 0);
  assert.equal(r.data.voted, false);

  // eigen highlight stemmen geweigerd
  r = await anna.req('POST', `/api/highlights/${hl.id}/vote`);
  assert.equal(r.status, 400, 'niet op eigen highlight stemmen');

  // PUT/DELETE door niet-eigenaar -> 404 (bestaan niet lekken)
  r = await bert.req('PUT', `/api/highlights/${hl.id}`, { name: 'gekaapt' });
  assert.equal(r.status, 404, 'andermans highlight niet bewerken');
  r = await bert.req('DELETE', `/api/highlights/${hl.id}`);
  assert.equal(r.status, 404, 'andermans highlight niet verwijderen');

  // eigenaar bewerkt -> sport 'alle'
  r = await anna.req('PUT', `/api/highlights/${hl.id}`, { name: 'Nog mooier', sport: 'alle' });
  assert.equal(r.status, 200);
  assert.equal(r.data.highlight.name, 'Nog mooier');
  assert.equal(r.data.highlight.sport, 'alle');

  // sport 'alle' matcht nu wel de mtb-filter
  r = await anna.req('GET', '/api/highlights?bbox=4.0,50.8,4.4,51.0&sport=mtb');
  assert.ok(r.data.highlights.some((x) => x.id === hl.id), "sport 'alle' matcht elke sportfilter");

  // eigenaar verwijdert
  r = await anna.req('DELETE', `/api/highlights/${hl.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
});

test('highlights: validatie en auth', async () => {
  const anon = client();
  let r = await anon.req('GET', '/api/highlights?bbox=4.0,50.8,4.4,51.0');
  assert.equal(r.status, 401, 'auth verplicht');

  const c = client();
  await c.req('POST', '/api/auth/register', { email: 'hl-val@test.be', name: 'Valid', password: 'wachtwoord1' });
  r = await c.req('POST', '/api/highlights', { name: '', sport: 'wandelen', track: TRACK.slice(0, 5) });
  assert.equal(r.status, 400, 'lege naam geweigerd');
  r = await c.req('POST', '/api/highlights', { name: 'x', sport: 'zwemmen', track: TRACK.slice(0, 5) });
  assert.equal(r.status, 400, 'onbekende sport geweigerd');
  r = await c.req('POST', '/api/highlights', { name: 'x', sport: 'wandelen', track: [[4.18, 50.93]] });
  assert.equal(r.status, 400, 'te korte track geweigerd');
});
