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

  await browser.close();
} catch (e) {
  console.error('\n✖ E2E FAALDE:', e.message);
  failed = true;
} finally {
  for (const p of procs) p.kill('SIGTERM');
}
process.exit(failed ? 1 : 0);
