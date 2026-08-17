// End-to-end rooktest met Playwright (Chromium):
// registreren -> route plannen (mock-BRouter) -> opslaan -> lijst -> delen -> GPX.
// Draaien: npm run build && npm run test:e2e

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const PORT = 4555;
const BASE = `http://localhost:${PORT}`;
const procs = [];

function start(cmd, args, env) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stderr.on('data', (d) => process.stderr.write(d));
  procs.push(p);
  return p;
}

async function waitFor(url, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok || r.status === 401) return; } catch { /* opnieuw */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`niet bereikbaar: ${url}`);
}

let failed = false;
const step = (name) => console.log(`\n▶ ${name}`);
const ok = (name) => console.log(`  ✔ ${name}`);

try {
  start(process.execPath, ['scripts/mock-brouter.js']);
  start(process.execPath, ['--no-warnings', 'server/index.js'], {
    GOUT_DB: ':memory:', PORT: String(PORT), BROUTER_URL: 'http://localhost:17777',
  });
  await waitFor(`${BASE}/api/auth/me`);
  await waitFor('http://localhost:17777/?lonlats=4,50|4.1,50.1');

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    args: ['--no-sandbox'],
  });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  page.on('pageerror', (e) => { console.error('  ✖ pagina-fout:', e.message); failed = true; });

  step('Registreren');
  await page.goto(`${BASE}/#/login`);
  await page.click('.tabs button:nth-child(2)');
  await page.fill('input[type=email]', 'e2e@gout.be');
  await page.fill('input[autocomplete=name]', 'E2E Tester');
  await page.fill('input[type=password]', 'wachtwoord123');
  await page.click('button[type=submit]');
  await page.waitForSelector('.topbar', { timeout: 5000 });
  ok('ingelogd, topbar zichtbaar');

  step('Route plannen');
  await page.goto(`${BASE}/#/plan`);
  await page.waitForSelector('.leaflet-container', { timeout: 5000 });
  await page.waitForTimeout(800);
  const map = page.locator('.leaflet-container');
  await map.click({ position: { x: 500, y: 380 } });
  await page.waitForTimeout(400);
  await map.click({ position: { x: 700, y: 420 } });
  await page.waitForTimeout(1500); // routing via mock
  const stats = await page.textContent('body');
  if (!/km/.test(stats)) throw new Error('geen afstand zichtbaar na plannen');
  ok('twee punten geklikt, afstand zichtbaar');

  step('Route opslaan');
  await page.click('text=Opslaan');
  await page.waitForSelector('.modal', { timeout: 4000 });
  await page.fill('.modal input', 'E2E Camino-etappe');
  await page.click('.modal .btn-primary, .modal button[type=submit]');
  await page.waitForURL(/#\/route\//, { timeout: 8000 });
  ok('opgeslagen, detailpagina geopend');

  step('Mijn routes + GPX-download');
  await page.goto(`${BASE}/#/routes`);
  await page.waitForSelector('.route-card', { timeout: 5000 });
  const gpxHref = await page.getAttribute('a[href*="/gpx"]', 'href');
  const gpxRes = await page.request.get(BASE + gpxHref);
  if (!gpxRes.ok() || !(await gpxRes.text()).includes('<trkpt')) throw new Error('GPX-download faalt');
  ok('routekaart zichtbaar, GPX downloadbaar');

  step('Route verwijderen (bevestigdialoog)');
  await page.click('button[title="Verwijderen"]');
  await page.waitForSelector('.modal', { timeout: 4000 });
  await page.click('.modal .btn-primary');
  await page.waitForFunction(() => document.querySelectorAll('.route-card').length === 0, { timeout: 5000 });
  ok('route weg na bevestiging');

  step('Ontdek en statistieken renderen zonder fouten');
  await page.goto(`${BASE}/#/discover`);
  await page.waitForSelector('.leaflet-container', { timeout: 5000 });
  await page.goto(`${BASE}/#/stats`);
  await page.waitForSelector('main', { timeout: 5000 });
  await page.goto(`${BASE}/#/activities`);
  await page.waitForSelector('main', { timeout: 5000 });
  ok('ontdek, statistieken en activiteiten laden');

  step('Live volgen met gesimuleerde GPS');
  const ctx = page.context();
  await ctx.grantPermissions(['geolocation'], { origin: BASE });
  // Lus van ~4,5 km waarvan start=einde op 'huis' H (4.18, 50.93).
  const corners = [[4.18, 50.93], [4.18, 50.94], [4.196, 50.94], [4.196, 50.93], [4.18, 50.93]];
  const loop = [];
  for (let e = 0; e < 4; e++) {
    const a = corners[e], b = corners[e + 1];
    for (let i = 0; i < 40; i++) { const f = i / 40; loop.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, 20]); }
  }
  loop.push([4.18, 50.93, 20]);
  const made = await page.request.post(`${BASE}/api/routes`, { data: { name: 'Live-lus', sport: 'wandelen', track: loop } });
  if (!made.ok()) throw new Error('kon live-testroute niet maken');
  const liveId = (await made.json()).route.id;

  // Eerste fix: precies thuis (start ≈ einde vallen samen). Met refIdx=0 wint de
  // startkant deze lus-tie, ook met de aan de nauwkeurigheid gekoppelde marge (Fix 1).
  await ctx.setGeolocation({ latitude: 50.93, longitude: 4.18, accuracy: 20 });
  await page.goto(`${BASE}/#/route/${liveId}`);
  await page.waitForSelector('text=Start live', { timeout: 8000 });
  await page.click('text=Start live');
  await page.waitForSelector('.live-panel', { timeout: 8000 });
  const pctNow = () => page.evaluate(() => {
    const c = [...document.querySelectorAll('.live-stats > div')].find((d) => d.textContent.includes('Voltooid'));
    return c ? (parseInt(c.querySelector('.v').textContent, 10) || 0) : -1;
  });
  await page.waitForFunction(() => {
    const c = [...document.querySelectorAll('.live-stats > div')].find((d) => d.textContent.includes('Voltooid'));
    return c && /\d+%/.test(c.querySelector('.v').textContent);
  }, { timeout: 5000 });
  const startPct = await pctNow();
  if (startPct < 0 || startPct >= 10) throw new Error(`lus-bug: voortgang sprong naar ${startPct}% bij de start`);
  ok(`lus start op ${startPct}% (geen valse voltooiing)`);

  // Een paar stappen vooruit langs de lus -> voortgang stijgt, spoor groeit mee.
  for (const i of [8, 16, 24, 32]) {
    await ctx.setGeolocation({ latitude: loop[i][1], longitude: loop[i][0], accuracy: 15 });
    await page.waitForTimeout(350);
  }
  const midPct = await pctNow();
  if (midPct <= startPct) throw new Error(`voortgang steeg niet (${startPct}% -> ${midPct}%)`);
  const spoorPts = await page.evaluate(() => {
    const el = document.querySelector('.leaflet-overlay-pane path[stroke="#b5179e"]');
    return el ? ((el.getAttribute('d') || '').match(/[ML]/g) || []).length : 0;
  });
  if (spoorPts < 2) throw new Error(`afgelegd spoor niet getekend (${spoorPts} punten)`);
  ok(`voortgang steeg naar ${midPct}%, afgelegd spoor getekend (${spoorPts} punten)`);

  // Volledige lus uitlopen tot de eindmarkering: de voortgang moet nu ~100%
  // bereiken. Vroeger bleef ze structureel ~50 m / ~8% achter en haalde ze nooit
  // 100% (Fix 1: aan de nauwkeurigheid gekoppelde marge + distM-tie-break).
  for (const i of [40, 60, 80, 100, 120, 140, 155, 160]) {
    await ctx.setGeolocation({ latitude: loop[i][1], longitude: loop[i][0], accuracy: 12 });
    await page.waitForTimeout(350);
  }
  const endPct = await pctNow();
  if (endPct < 99) throw new Error(`lus bereikte de eindmarkering niet: bleef op ${endPct}%`);
  ok(`lus bereikt de eindmarkering op ${endPct}%`);


  await browser.close();
} catch (e) {
  console.error('\n✖ E2E FAALDE:', e.message);
  failed = true;
} finally {
  for (const p of procs) p.kill('SIGTERM');
}
process.exit(failed ? 1 : 0);
