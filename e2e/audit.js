// Visuele audit: legt alle pagina's en interactiestaten vast op meerdere
// schermbreedtes. Gebruik: node e2e/audit.js  (schrijft naar AUDIT_DIR of ./shots-audit)

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const PORT = 4777;
const BASE = `http://localhost:${PORT}`;
const OUT = process.env.AUDIT_DIR || 'shots-audit';
mkdirSync(OUT, { recursive: true });

const procs = [];
const start = (a, env) => { const p = spawn(process.execPath, a, { env: { ...process.env, ...env }, stdio: 'ignore' }); procs.push(p); return p; };

start(['scripts/mock-brouter.js']);
start(['--no-warnings', 'server/index.js'], {
  GOUT_DATA_DIR: process.env.SEED_DIR || 'data', PORT: String(PORT), BROUTER_URL: 'http://localhost:17777',
});
await new Promise((r) => setTimeout(r, 1500));

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--no-sandbox'],
});

const VIEWPORTS = {
  desktop: { width: 1380, height: 900 },
  laptop: { width: 1120, height: 760 },
  tablet: { width: 768, height: 1000 },
  mobiel: { width: 390, height: 800 },
};

async function login(page) {
  await page.goto(`${BASE}/#/login`);
  await page.fill('input[type=email]', 'demo@gout.be');
  await page.fill('input[type=password]', 'demo1234');
  await page.click('button[type=submit]');
  await page.waitForSelector('.topbar', { timeout: 6000 });
}

for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
  const ctx = await browser.newContext({
    viewport,
    geolocation: { latitude: 50.935, longitude: 4.19 },
    permissions: ['geolocation'],
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const shot = async (n, ms = 700) => { await page.waitForTimeout(ms); await page.screenshot({ path: `${OUT}/${vpName}--${n}.png` }).catch(() => {}); };
  const tryClick = (sel, t = 3500) => page.click(sel, { timeout: t }).catch(() => {});

  await page.goto(`${BASE}/#/login`);
  await shot('login');

  await login(page);

  await page.goto(`${BASE}/#/routes`);
  await shot('routes');
  await tryClick('text=Importeer een GPX-bestand');
  await shot('routes-importmodal');
  await page.keyboard.press('Escape');

  await page.goto(`${BASE}/#/route/1`);
  await shot('route-detail', 1600);
  await tryClick('button:has-text("Delen")');
  await shot('route-deelmodal');
  await page.keyboard.press('Escape');

  await tryClick('button:has-text("Start live")');
  await shot('route-live', 1800);
  await ctx.setGeolocation({ latitude: 50.94, longitude: 4.2 });
  await shot('route-live-onderweg', 1200);
  await page.locator('.live-close, button:has-text("Sluiten"), button:has-text("Stop live")').first()
    .click({ timeout: 3000 }).catch(() => page.keyboard.press('Escape'));

  await page.goto(`${BASE}/#/plan`);
  await shot('plan-leeg', 1200);
  const map = page.locator('.leaflet-container').first();
  const clickMap = (fx, fy) => map.click({
    position: { x: Math.round(viewport.width * fx), y: Math.round(viewport.height * fy) }, timeout: 4000,
  }).catch(() => {});
  await clickMap(0.4, 0.45);
  await page.waitForTimeout(500);
  await clickMap(0.55, 0.4);
  await page.waitForTimeout(900);
  await clickMap(0.65, 0.55);
  await shot('plan-punten', 1500);
  const chevron = page.locator('.plan-stats button, .statsbar button')
    .filter({ hasNot: page.locator('text=Opslaan') }).last();
  await chevron.click({ timeout: 3000 }).catch(() => {});
  await shot('plan-hoogteprofiel');
  await tryClick('button:has-text("Opslaan")');
  await shot('plan-opslaanmodal');
  await page.keyboard.press('Escape');

  await page.goto(`${BASE}/#/discover`);
  await shot('ontdek-gebied', 2200);
  await tryClick('.tabs button:has-text("Top 10")');
  await shot('ontdek-top10', 1500);

  await page.goto(`${BASE}/#/activities`);
  await shot('activiteiten');
  await tryClick('button:has-text("Activiteit uploaden")');
  await shot('activiteiten-uploadmodal');
  await page.keyboard.press('Escape');

  await page.goto(`${BASE}/#/stats`);
  await shot('statistieken');
  await page.goto(`${BASE}/#/profile`);
  await shot('profiel');

  await page.locator('.topbar .avatar').click({ timeout: 3000 }).catch(() => {});
  await shot('avatarmenu');

  const anon = await (await browser.newContext({ viewport })).newPage();
  const token = await page.evaluate(async () => {
    const r = await fetch('/api/routes/1/share', { method: 'POST' });
    return (await r.json()).shareToken;
  }).catch(() => null);
  if (token) {
    await anon.goto(`${BASE}/#/s/${token}`);
    await anon.waitForTimeout(1800);
    await anon.screenshot({ path: `${OUT}/${vpName}--deelpagina.png` }).catch(() => {});
  }
  await anon.context().close();

  if (errors.length) console.log(`[${vpName}] PAGINAFOUTEN:`, errors.join(' | '));
  await ctx.close();
}

await browser.close();
for (const p of procs) p.kill();
console.log('AUDIT KLAAR →', OUT);
