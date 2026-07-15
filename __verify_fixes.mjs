import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const PORT = 4951;
const BASE = `http://localhost:${PORT}`;
const MOCK = 'http://localhost:17777';
const procs = [];
const SHOT = '/tmp/claude-0/-home-user-G-O-U-T-/5bc37bf3-823b-5171-85c1-5be675c48302/scratchpad/live_fix3.png';

function start(cmd, args, env) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stderr.on('data', (d) => process.stderr.write(d));
  procs.push(p);
  return p;
}
async function waitFor(url, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok || r.status === 401) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`niet bereikbaar: ${url}`);
}

let failed = false;
const results = [];
function check(name, cond, extra = '') {
  results.push([name, cond]);
  console.log(`  ${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failed = true;
}

try {
  start(process.execPath, ['scripts/mock-brouter.js']);
  start(process.execPath, ['--no-warnings', 'server/index.js'], {
    GOUT_DB: ':memory:', PORT: String(PORT),
    BROUTER_URL: MOCK,
    WMT_BASE: `${MOCK}/wmt/{site}`,
    OVERPASS_URL: `${MOCK}/overpass`,
  });
  await waitFor(`${BASE}/api/auth/me`);
  await waitFor(`${MOCK}/?lonlats=4,50|4.1,50.1`);

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    args: ['--no-sandbox'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => { pageErrors.push(e.message); console.error('  pagina-fout:', e.message); });

  // ---- inloggen ----
  await page.goto(`${BASE}/#/login`);
  await page.click('.tabs button:nth-child(2)');
  await page.fill('input[type=email]', 'verify@gout.be');
  await page.fill('input[autocomplete=name]', 'Verify');
  await page.fill('input[type=password]', 'wachtwoord123');
  await page.click('button[type=submit]');
  await page.waitForSelector('.topbar', { timeout: 6000 });

  // === FIX 4 (d): lus-knop toont ander icoon dan beeline ===
  console.log('\n== FIX 4 (d): lus-icoon != beeline-icoon ==');
  await page.goto(`${BASE}/#/plan`);
  await page.waitForSelector('.plan-actions .btn-icon', { timeout: 6000 });
  const ico = await page.evaluate(() => {
    const beeline = document.querySelector('.plan-actions [title^="Nieuwe segmenten hemelsbreed"]');
    const loop = document.querySelector('.plan-actions [title="Sluit de lus"]');
    return { beeline: beeline?.querySelector('svg')?.innerHTML || '', loop: loop?.querySelector('svg')?.innerHTML || '' };
  });
  check('lus-knop bestaat met eigen svg', !!ico.loop);
  check('lus-icoon verschilt van beeline-icoon', !!ico.loop && ico.loop !== ico.beeline);

  // === FIX 5 (e): Bekende routes-modal heeft werkende Sluiten-knop ===
  console.log('\n== FIX 5 (e): Sluiten-knop in bekende-routes-modal ==');
  await page.click('.plan-known');
  await page.waitForSelector('.kr-modal', { timeout: 5000 });
  const sluitBtn = page.locator('.kr-modal .modal-actions button', { hasText: 'Sluiten' });
  check('Sluiten-knop aanwezig in .modal-actions', await sluitBtn.count() === 1);
  await sluitBtn.click();
  await page.waitForTimeout(300);
  check('modal weg na Sluiten-klik', await page.locator('.modal-backdrop').count() === 0);

  // === FIX 1 (a): wegnavigeren midden in het laden ruimt modal/timers/fetch op ===
  console.log('\n== FIX 1 (a): cleanup bij wegnavigeren tijdens laden ==');
  await page.route('**/api/knownroutes/*', async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    try { await route.continue(); } catch {}
  });
  await page.click('.plan-known');
  await page.waitForSelector('.kr-modal', { timeout: 5000 });
  await page.fill('.kr-modal input', 'GR 12');
  await page.waitForSelector('.kr-result', { timeout: 6000 });
  await page.click('.kr-result');
  await page.waitForSelector('.kr-loading', { timeout: 5000 });
  const t1 = await page.textContent('.kr-load-timer').catch(() => '');
  await page.waitForTimeout(1200);
  const t2 = await page.textContent('.kr-load-timer').catch(() => '');
  check('laadpaneel zichtbaar met tikkende timer', !!t1 && t1 !== t2, `${t1} -> ${t2}`);
  await page.evaluate(() => { location.hash = '#/routes'; });
  await page.waitForTimeout(900);
  const backdrops = await page.locator('.modal-backdrop').count();
  const loadingLeft = await page.locator('.kr-loading').count();
  check('GEEN wees-modal-backdrop na wegnavigeren', backdrops === 0, `backdrops=${backdrops}`);
  check('GEEN laadpaneel (timers gestopt) na wegnavigeren', loadingLeft === 0);
  await page.waitForTimeout(4200);
  check('nog steeds geen backdrop nadat de fetch zou aflopen', await page.locator('.modal-backdrop').count() === 0);
  await page.unroute('**/api/knownroutes/*');

  // === FIX 2 (b): etappepaneel wijkt tijdens 'Kies je deel' op 390x844 ===
  console.log('\n== FIX 2 (b): etappepaneel wijkt voor A/B-kiezen (390x844) ==');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/#/plan`);
  await page.waitForSelector('.leaflet-container', { timeout: 6000 });
  await page.waitForTimeout(500);
  await page.click('.plan-known');
  await page.waitForSelector('.kr-modal', { timeout: 5000 });
  await page.fill('.kr-modal input', 'GR 12');
  await page.waitForSelector('.kr-result', { timeout: 6000 });
  await page.click('.kr-result');
  await page.waitForSelector('.plan-part-btn', { timeout: 12000, state: 'visible' });
  await page.waitForTimeout(600);
  check('etappepaneel zichtbaar vóór het kiezen', await page.locator('.plan-etap').isVisible());
  await page.click('.plan-part-btn');
  await page.waitForTimeout(400);
  check('etappepaneel ONzichtbaar tijdens het kiezen', !(await page.locator('.plan-etap').isVisible()));
  check('kies-hint zichtbaar tijdens het kiezen', await page.locator('.plan-pickhint').isVisible());
  const map = page.locator('.leaflet-container');
  await map.click({ position: { x: 300, y: 560 } });
  await page.waitForTimeout(400);
  check('etappepaneel blijft onzichtbaar na A (nog aan het kiezen)', !(await page.locator('.plan-etap').isVisible()));
  await map.click({ position: { x: 80, y: 200 } });
  await page.waitForTimeout(700);
  check('etappepaneel terug zichtbaar na B (deel gekozen)', await page.locator('.plan-etap').isVisible());

  // === FIX 3 (c): live-overlay boven de detailkaart-controls (geen dubbele) ===
  console.log('\n== FIX 3 (c): live-overlay boven kaartcontrols ==');
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.evaluate(() => { location.hash = '#/routes'; });
  await page.waitForTimeout(500);
  await page.evaluate(() => { location.hash = '#/plan'; });
  await page.waitForSelector('.leaflet-container', { timeout: 6000 });
  await page.waitForTimeout(800);
  const pmap = page.locator('.leaflet-container');
  await pmap.click({ position: { x: 500, y: 380 } });
  await page.waitForTimeout(400);
  await pmap.click({ position: { x: 720, y: 430 } });
  await page.waitForTimeout(1600);
  await page.click('text=Opslaan');
  await page.waitForSelector('.modal', { timeout: 5000 });
  await page.fill('.modal input', 'Verify Live-route');
  await page.click('.modal .btn-primary');
  await page.waitForURL(/#\/route\//, { timeout: 9000 });
  await page.waitForSelector('text=Start live', { timeout: 8000 });
  await page.waitForSelector('.route-detail-map .leaflet-control-zoom', { timeout: 6000 });
  await page.waitForTimeout(600);
  await page.click('text=Start live');
  await page.waitForSelector('.live-overlay', { timeout: 6000 });
  await page.waitForTimeout(900);
  const live = await page.evaluate(() => {
    const bodyLive = document.body.classList.contains('live-open');
    const detailCtrl = document.querySelector('.route-detail-map .leaflet-control-container');
    const detailDisp = detailCtrl ? getComputedStyle(detailCtrl).display : 'ABSENT';
    const ovl = document.querySelector('.live-overlay');
    const ovlZ = ovl ? getComputedStyle(ovl).zIndex : 'ABSENT';
    const liveZoomCount = document.querySelectorAll('.live-overlay .leaflet-control-zoom').length;
    return { bodyLive, detailDisp, ovlZ, liveZoomCount };
  });
  check('body.live-open actief', live.bodyLive);
  check('.live-overlay z-index = 1100', live.ovlZ === '1100', `z=${live.ovlZ}`);
  check('onderliggende detailkaart-controls verborgen (display:none)', live.detailDisp === 'none', `display=${live.detailDisp}`);
  check('live-overlay heeft eigen zoomcontrol', live.liveZoomCount >= 1, `n=${live.liveZoomCount}`);
  await page.screenshot({ path: SHOT });
  console.log('  screenshot:', SHOT);

  check('geen pagina-fouten tijdens de hele verificatie', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();
} catch (e) {
  console.error('\nVERIFICATIE-UITZONDERING:', (e && e.stack) || e);
  failed = true;
} finally {
  for (const p of procs) p.kill('SIGTERM');
}

console.log('\n==== SAMENVATTING ====');
for (const [n, c] of results) console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`);
console.log(failed ? '\nRESULTAAT: FAAL' : '\nRESULTAAT: ALLES GROEN');
process.exit(failed ? 1 : 0);
