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
      GOUT_DATA_DIR: `/tmp/gout-test-${process.pid}`,
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

test('routes-lijst: ontbrekende preview wordt aangevuld (backfill, finding 3)', async () => {
  // De lijst-endpoints selecteren geen track-blob meer. Voor een rij zonder
  // preview moet de lijst hem toch teruggeven (backfill). We zetten preview
  // buiten de server om op NULL, dus een aparte serverinstantie met een echte
  // db-file. Poort in 6100-6900.
  const PORT2 = 6234;
  const BASE2 = `http://localhost:${PORT2}`;
  const dataDir = pathJoin(tmpdir(), `gout-preview-${process.pid}-${Date.now()}`);
  const env = { ...process.env, PORT: String(PORT2), GOUT_DATA_DIR: dataDir };
  delete env.GOUT_DB; // echte db-file i.p.v. :memory: zodat een 2e connectie kan schrijven
  const srv = spawn(process.execPath, ['--no-warnings', 'server/index.js'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('server2 startte niet')), 8000);
      srv.stdout.on('data', (d) => { if (String(d).includes('draait op')) { clearTimeout(to); resolve(); } });
    });

    let cookie = '';
    const req = async (method, path, body) => {
      const res = await fetch(BASE2 + path, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      const t = await res.text();
      return { status: res.status, data: t ? JSON.parse(t) : null };
    };

    await req('POST', '/api/auth/register', { email: 'pv@test.be', name: 'Preview', password: 'wachtwoord1' });
    let r = await req('POST', '/api/routes', { name: 'Preview-route', sport: 'wandelen', track: TRACK });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const id = r.data.route.id;

    // preview buiten de server om wissen
    const db2 = new DatabaseSync(pathJoin(dataDir, 'gout.db'));
    try { db2.prepare('UPDATE routes SET preview = NULL WHERE id = ?').run(id); } finally { db2.close(); }

    // lijst geeft nog steeds een preview terug (backfill)
    r = await req('GET', '/api/routes');
    assert.equal(r.status, 200);
    const route = r.data.routes.find((x) => x.id === id);
    assert.ok(route, 'route in lijst');
    assert.ok(Array.isArray(route.preview) && route.preview.length >= 2,
      `preview aangevuld (kreeg ${JSON.stringify(route.preview)})`);

    // backfill is bewaard: preview staat weer in de db
    const db3 = new DatabaseSync(pathJoin(dataDir, 'gout.db'), { readOnly: true });
    try {
      const stored = db3.prepare('SELECT preview FROM routes WHERE id = ?').get(id).preview;
      assert.ok(stored && JSON.parse(stored).length >= 2, 'preview backfilled in db');
    } finally { db3.close(); }
  } finally {
    srv.kill();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ok */ }
  }
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
  assert.ok(!lons.some((x) => x > 5), 'hoofdtracé bevat de zijtak niet — geen luchtlijnen');
  assert.ok(Array.isArray(r.data.chains) && r.data.chains.length === 2, 'beide takken aangeboden');
  assert.ok(r.data.chains[1].track.some((p) => p[0] > 5), 'tweede tak is de zijtak');
  assert.ok(r.data.chains[0].distanceM > r.data.chains[1].distanceM, 'takken gesorteerd op lengte');
  assert.ok(!r.data.track.some((p) => p[0] === 4.21), 'alternative-variant weggefilterd');
  assert.ok(typeof r.data.note === 'string' && r.data.note.length > 0, 'note aanwezig');

  // korte bewegwijzerde route (<5 km): selectBranches filtert alle kettingen
  // weg -> val terug op de langste ketting i.p.v. 502 met gelekte fouttekst
  r = await c.req('GET', '/api/knownroutes/903?sport=wandelen');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(Array.isArray(r.data.track) && r.data.track.length >= 2, 'korte route levert een track');
  assert.ok(r.data.chains === undefined, 'korte route: geen extra takken');

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
  r = await c.req('POST', '/api/highlights', { name: 'x', sport: 'wandelen', track: [] });
  assert.equal(r.status, 400, 'te korte track geweigerd');
});

test('highlights v2: punt-highlight met categorie, 1 punt geldig, ongeldige categorie', async () => {
  const c = client();
  await c.req('POST', '/api/auth/register', { email: 'hlcat@test.be', name: 'Cat', password: 'wachtwoord1' });

  // punt-highlight (POI): track met 1 punt + geldige categorie -> 201
  let r = await c.req('POST', '/api/highlights', {
    name: 'Panoramabank', sport: 'wandelen', category: 'uitzicht', track: [[4.18, 50.93]],
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.highlight.category, 'uitzicht', 'categorie in antwoord');
  assert.equal(r.data.highlight.track.length, 1, 'track met 1 punt bewaard');
  const pid = r.data.highlight.id;

  // ongeldige categorie -> 400
  r = await c.req('POST', '/api/highlights', {
    name: 'Foute POI', sport: 'wandelen', category: 'zwembad', track: [[4.18, 50.93]],
  });
  assert.equal(r.status, 400, 'onbekende categorie geweigerd');

  // categorie optioneel: segment zonder categorie mag ook
  r = await c.req('POST', '/api/highlights', {
    name: 'Zonder categorie', sport: 'fietsen', track: TRACK.slice(0, 6),
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.highlight.category, null, 'geen categorie = null');

  // PUT: categorie aanpassen en wissen ('' = null)
  r = await c.req('PUT', `/api/highlights/${pid}`, { category: 'horeca' });
  assert.equal(r.status, 200);
  assert.equal(r.data.highlight.category, 'horeca');
  r = await c.req('PUT', `/api/highlights/${pid}`, { category: '' });
  assert.equal(r.status, 200);
  assert.equal(r.data.highlight.category, null, 'lege categorie wist');
  r = await c.req('PUT', `/api/highlights/${pid}`, { category: 'nonsens' });
  assert.equal(r.status, 400, 'ongeldige categorie bij PUT geweigerd');
});

test('ontdek: standaardlimiet 10, met limit=100 alles', async () => {
  const c = client();
  await c.req('POST', '/api/auth/register', { email: 'lim@test.be', name: 'Limiet', password: 'wachtwoord1' });

  // Eigen gebied ver van andere tests, zodat de bbox-filter deze routes isoleert.
  const FARTRACK = [];
  for (let i = 0; i <= 10; i++) FARTRACK.push([6.50 + 0.001 * i, 49.50 + 0.001 * i, 30]);

  for (let i = 0; i < 12; i++) {
    const r = await c.req('POST', '/api/routes', { name: `Verre route ${i}`, sport: 'wandelen', track: FARTRACK });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    await c.req('PUT', `/api/routes/${r.data.route.id}`, { visibility: 'public' });
  }

  const bbox = 'bbox=6.4,49.4,6.6,49.6';
  let r = await c.req('GET', `/api/discover?${bbox}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.routes.length, 10, 'standaardlimiet is 10');

  r = await c.req('GET', `/api/discover?${bbox}&limit=100`);
  assert.equal(r.status, 200);
  assert.equal(r.data.routes.length, 12, 'met limit=100 alle 12');
});

// --- Bibliotheek-oogstscript (scripts/bibliotheek.js) ------------------------
// Draait het script in een apart proces tegen de mock-Overpass (die in before()
// al op poort 17777 luistert). Het script gebruikt server/db.js en respecteert
// GOUT_DATA_DIR: we geven het een echte db-file in een tempmap en openen die
// daarna read-only met een tweede DatabaseSync om te asserten.
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { rmSync } from 'node:fs';

function draaiBibliotheek(dataDir, extraArgs = []) {
  const env = {
    ...process.env,
    GOUT_DATA_DIR: dataDir,
    OVERPASS_URL: 'http://localhost:17777/overpass',
    WMT_BASE: 'http://localhost:17777/wmt/{site}',
    BIB_PAUZE_MS: '20', // korte beleefdheidspauze zodat de test vlot draait
  };
  delete env.GOUT_DB; // geen :memory: -> db.js gebruikt een echte file in dataDir
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--no-warnings', 'scripts/bibliotheek.js', ...extraArgs],
      { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', reject);
    p.on('exit', (code) => resolve({ code, out }));
  });
}

function openReadOnly(dataDir) {
  return new DatabaseSync(pathJoin(dataDir, 'gout.db'), { readOnly: true });
}

test('bibliotheek-oogst: 3 wandel + 3 mtb per gemeente, curated, idempotent, droog', async () => {
  const tmp = pathJoin(tmpdir(), `gout-bib-${process.pid}-${Date.now()}`);
  const tmpDroog = pathJoin(tmpdir(), `gout-bib-droog-${process.pid}-${Date.now()}`);
  try {
    // --- eerste run: schrijft de bibliotheek weg ---
    let r = await draaiBibliotheek(tmp);
    assert.equal(r.code, 0, `script eindigt netjes:\n${r.out}`);

    let db1 = openReadOnly(tmp);
    let eersteAantal;
    try {
      // bibliotheekgebruiker bestaat
      const bib = db1.prepare("SELECT id, name FROM users WHERE email = 'bibliotheek@gout.be'").get();
      assert.ok(bib, 'bibliotheekaccount aangemaakt');
      assert.equal(bib.name, 'G.O.U.T. Bibliotheek');

      const routes = db1.prepare('SELECT * FROM routes WHERE user_id = ?').all(bib.id);
      assert.ok(routes.length >= 4, `routes opgeslagen (kreeg ${routes.length})`);
      eersteAantal = db1.prepare('SELECT COUNT(*) c FROM routes').get().c;

      // alle routes zijn curated met osm_rel_id, publiek en van het bib-account
      for (const rt of routes) {
        assert.equal(rt.curated, 1, 'curated=1');
        assert.ok(rt.osm_rel_id != null, 'osm_rel_id aanwezig');
        assert.equal(rt.visibility, 'public', 'publiek');
        assert.equal(rt.source, 'gepland', 'source=gepland');
        assert.match(rt.region, /, België$/, 'region = "Gemeente, België"');
      }

      // per nepgemeente hoogstens 3 wandel + 3 mtb
      for (const gem of ['Opwijk', 'Affligem', 'Aalst']) {
        const w = db1.prepare("SELECT COUNT(*) c FROM routes WHERE region = ? AND sport = 'wandelen'").get(`${gem}, België`).c;
        const m = db1.prepare("SELECT COUNT(*) c FROM routes WHERE region = ? AND sport = 'mtb'").get(`${gem}, België`).c;
        assert.ok(w <= 3, `${gem}: hoogstens 3 wandelroutes (kreeg ${w})`);
        assert.ok(m <= 3, `${gem}: hoogstens 3 mtb-routes (kreeg ${m})`);
      }
    } finally {
      db1.close();
    }

    // --- tweede run: idempotent, voegt niets toe ---
    r = await draaiBibliotheek(tmp);
    assert.equal(r.code, 0, `tweede run eindigt netjes:\n${r.out}`);
    const db2 = openReadOnly(tmp);
    try {
      const na = db2.prepare('SELECT COUNT(*) c FROM routes').get().c;
      assert.equal(na, eersteAantal, 'tweede run voegt niets toe (idempotent)');
    } finally {
      db2.close();
    }

    // --- droogloop op een verse map: schrijft niets ---
    const dr = await draaiBibliotheek(tmpDroog, ['--droog']);
    assert.equal(dr.code, 0, `droogloop eindigt netjes:\n${dr.out}`);
    const db3 = openReadOnly(tmpDroog);
    try {
      const aantal = db3.prepare('SELECT COUNT(*) c FROM routes').get().c;
      assert.equal(aantal, 0, '--droog schrijft geen routes weg');
      const bibDroog = db3.prepare("SELECT COUNT(*) c FROM users WHERE email = 'bibliotheek@gout.be'").get().c;
      assert.equal(bibDroog, 0, '--droog maakt geen bibliotheekaccount aan');
    } finally {
      db3.close();
    }
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ok */ }
    try { rmSync(tmpDroog, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

test('ontdek: aanbevolen bewegwijzerd (OSM) — sortering, ≤3 per sport, filter, bbox, auth', async () => {
  const c = client();
  await c.req('POST', '/api/auth/register', { email: 'aanb@test.be', name: 'Aanb', password: 'wachtwoord1' });

  // zonder login -> 401
  const anon = client();
  let r = await anon.req('GET', '/api/discover/aanbevolen?bbox=4.0,50.8,4.4,51.0');
  assert.equal(r.status, 401, 'auth verplicht');

  // zonder bbox -> 400
  r = await c.req('GET', '/api/discover/aanbevolen');
  assert.equal(r.status, 400, 'bbox verplicht');

  // beide sporten (geen sportfilter) -> union van wandel + mtb
  r = await c.req('GET', '/api/discover/aanbevolen?bbox=4.0,50.8,4.4,51.0');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.aanbevolen, 'aanbevolen-veld aanwezig');
  const w = r.data.aanbevolen.wandelen;
  const m = r.data.aanbevolen.mtb;
  assert.ok(Array.isArray(w) && Array.isArray(m), 'twee lijsten');
  assert.ok(w.length <= 3, `hoogstens 3 wandel (kreeg ${w.length})`);
  assert.ok(m.length <= 3, `hoogstens 3 mtb (kreeg ${m.length})`);
  assert.ok(w.length >= 1, 'minstens één wandelaanbeveling uit de mock');

  // itemvorm: {id, name, ref, distanceKm, sport}
  const it = w[0];
  for (const k of ['id', 'name', 'ref', 'distanceKm', 'sport']) assert.ok(k in it, `veld ${k} aanwezig`);
  assert.equal(it.sport, 'wandelen');

  // afstand-tag buiten bereik (nameloze relatie, 60 km) is weggefilterd
  assert.ok(!w.some((x) => x.distanceKm != null && x.distanceKm > 35), 'te lange wandelroute weggefilterd');
  assert.ok(!w.some((x) => x.id === 1004), 'nameloze/te-lange relatie niet aanbevolen');

  // sortering: score desc, dan afstand desc. Mock-wandel na filter:
  // 1002 (naam+rwn+afst20 = score 4), 902 (naam+lwn+afst12 = score 4), 1003 (naam+afst8 = score 3)
  assert.deepEqual(w.map((x) => x.id), [1002, 902, 1003], 'wandel gesorteerd op score dan afstand');
  assert.deepEqual(m.map((x) => x.id), [2002, 2001], 'mtb gesorteerd (rwn+afst30 vóór afst25)');

  // sportfilter mtb -> enkel de mtb-tak
  r = await c.req('GET', '/api/discover/aanbevolen?bbox=4.0,50.8,4.4,51.0&sport=mtb');
  assert.equal(r.status, 200);
  assert.equal(r.data.aanbevolen.wandelen.length, 0, 'sport=mtb geeft geen wandelroutes');
  assert.ok(r.data.aanbevolen.mtb.length >= 1, 'mtb-aanbevelingen aanwezig');

  // sportfilter wandelen -> enkel de wandel-tak
  r = await c.req('GET', '/api/discover/aanbevolen?bbox=4.0,50.8,4.4,51.0&sport=wandelen');
  assert.equal(r.status, 200);
  assert.equal(r.data.aanbevolen.mtb.length, 0, 'sport=wandelen geeft geen mtb-routes');
  assert.ok(r.data.aanbevolen.wandelen.length >= 1);

  // fietsen kent geen bewegwijzerde tak -> beide leeg
  r = await c.req('GET', '/api/discover/aanbevolen?bbox=4.0,50.8,4.4,51.0&sport=fietsen');
  assert.equal(r.status, 200);
  assert.equal(r.data.aanbevolen.wandelen.length, 0);
  assert.equal(r.data.aanbevolen.mtb.length, 0);
});

test('aanbevolen: nabijheid weegt mee bij zoeken op een dorp', async () => {
  const c = client();
  await c.req('POST', '/api/auth/register', { email: 'dorp@test.be', name: 'Dorpszoeker', password: 'wachtwoord1' });

  // Zonder centrum wint bij gelijke score de langste (Dendervallei, 20 km).
  let r = await c.req('GET', '/api/discover/aanbevolen?bbox=3.9,50.8,4.3,51.0&sport=wandelen');
  assert.equal(r.status, 200);
  assert.equal(r.data.aanbevolen.wandelen[0].name, 'Dendervallei-voetpad');

  // Met centrum bij de Kravaalbos-lus (4.18, 50.93) wint nabijheid.
  r = await c.req('GET', '/api/discover/aanbevolen?bbox=3.9,50.8,4.3,51.0&sport=wandelen&center=4.18,50.93');
  assert.equal(r.status, 200);
  assert.equal(r.data.aanbevolen.wandelen[0].name, 'Kravaalbos-lus', 'dichtstbijzijnde relevante route eerst');
  assert.ok(r.data.aanbevolen.wandelen[0].vanCentrumKm < 2, 'afstand tot centrum meegegeven');
  assert.ok(r.data.aanbevolen.wandelen[1].vanCentrumKm > r.data.aanbevolen.wandelen[0].vanCentrumKm);
});
