import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const PORT = 4666;
const BASE = `http://localhost:${PORT}`;
const OUT = process.env.SHOT_DIR || 'shots';
const procs = [];
const start = (a, env) => { const p = spawn(process.execPath, a, { env: { ...process.env, ...env }, stdio: 'ignore' }); procs.push(p); return p; };

start(['scripts/mock-brouter.js']);
start(['--no-warnings', 'server/index.js'], {
  GOUT_DATA_DIR: process.env.SEED_DIR || 'data', PORT: String(PORT), BROUTER_URL: 'http://localhost:17777',
});
await new Promise((r) => setTimeout(r, 1500));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1380, height: 900 } });
const page = await ctx.newPage();

const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });

await page.goto(`${BASE}/#/login`);
await page.waitForTimeout(600);
await shot('1-login');

// login als demo-gebruiker uit de seed
await page.fill('input[type=email]', 'demo@gout.be');
await page.fill('input[type=password]', 'demo1234');
await page.click('button[type=submit]');
await page.waitForSelector('.topbar');
await page.waitForTimeout(800);
await shot('2-mijn-routes');

await page.goto(`${BASE}/#/route/1`);
await page.waitForTimeout(2200);
await shot('3-route-detail');

await page.goto(`${BASE}/#/plan`);
await page.waitForTimeout(1200);
const map = page.locator('.leaflet-container').first();
await map.click({ position: { x: 480, y: 360 } });
await page.waitForTimeout(500);
await map.click({ position: { x: 700, y: 300 } });
await page.waitForTimeout(500);
await map.click({ position: { x: 880, y: 420 } });
await page.waitForTimeout(1800);
await shot('4-planner');

await page.goto(`${BASE}/#/discover`);
await page.waitForTimeout(2500);
await shot('5-ontdek');

await page.goto(`${BASE}/#/stats`);
await page.waitForTimeout(900);
await shot('6-statistieken');

await page.goto(`${BASE}/#/activities`);
await page.waitForTimeout(900);
await shot('7-activiteiten');

// mobiel formaat
const mob = await (await browser.newContext({ viewport: { width: 390, height: 800 } })).newPage();
await mob.goto(`${BASE}/#/login`);
await mob.fill('input[type=email]', 'demo@gout.be');
await mob.fill('input[type=password]', 'demo1234');
await mob.click('button[type=submit]');
await mob.waitForSelector('.topbar');
await mob.goto(`${BASE}/#/route/1`);
await mob.waitForTimeout(2000);
await mob.screenshot({ path: `${OUT}/8-mobiel-route.png` });

await browser.close();
for (const p of procs) p.kill();
console.log('SHOTS OK');
