// Statistieken-API: totalen, per sport, laatste 12 maanden en records.
// Alles op basis van de activiteiten van de ingelogde gebruiker.

import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import { activitySummary } from '../serialize.js';

export const statsRouter = Router();

const SPORTS = ['wandelen', 'fietsen', 'mtb'];

// Laatste n kalendermaanden t/m nu, als 'YYYY-MM' (oudste eerst). UTC, zodat
// het spoort met de opslag (started_at is ISO-UTC, created_at is datetime('now')).
function lastMonths(n) {
  const now = new Date();
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

const zeroSport = () => ({ count: 0, distanceM: 0, ascentM: 0, movingS: 0 });

statsRouter.get('/', requireAuth, (req, res) => {
  const uid = req.user.id;

  // Totalen over alles.
  const t = db.prepare(`
    SELECT COUNT(*) AS count,
           COALESCE(SUM(distance_m), 0) AS distanceM,
           COALESCE(SUM(ascent_m), 0)   AS ascentM,
           COALESCE(SUM(moving_s), 0)   AS movingS
    FROM activities WHERE user_id = ?
  `).get(uid);
  const totals = {
    count: t.count,
    distanceM: t.distanceM,
    ascentM: t.ascentM,
    movingS: t.movingS,
  };

  // Per sport (ontbrekende sport = nullen).
  const perSport = { wandelen: zeroSport(), fietsen: zeroSport(), mtb: zeroSport() };
  const bySport = db.prepare(`
    SELECT sport,
           COUNT(*) AS count,
           COALESCE(SUM(distance_m), 0) AS distanceM,
           COALESCE(SUM(ascent_m), 0)   AS ascentM,
           COALESCE(SUM(moving_s), 0)   AS movingS
    FROM activities WHERE user_id = ? GROUP BY sport
  `).all(uid);
  for (const r of bySport) {
    if (SPORTS.includes(r.sport)) {
      perSport[r.sport] = {
        count: r.count, distanceM: r.distanceM, ascentM: r.ascentM, movingS: r.movingS,
      };
    }
  }

  // Maandelijkse afstand per sport (meters), laatste 12 kalendermaanden.
  const months = lastMonths(12);
  const monthMap = new Map();
  for (const m of months) monthMap.set(m, { month: m, wandelen: 0, fietsen: 0, mtb: 0 });
  const rows = db.prepare(`
    SELECT substr(COALESCE(started_at, created_at), 1, 7) AS ym,
           sport,
           COALESCE(SUM(distance_m), 0) AS dist
    FROM activities WHERE user_id = ?
    GROUP BY ym, sport
  `).all(uid);
  for (const r of rows) {
    const entry = monthMap.get(r.ym);
    if (entry && SPORTS.includes(r.sport)) entry[r.sport] = r.dist;
  }
  const monthly = months.map((m) => monthMap.get(m));

  // Records: langste tocht (afstand) en meeste hoogtemeters (klim).
  const longestRow = db.prepare(
    'SELECT * FROM activities WHERE user_id = ? ORDER BY distance_m DESC, id DESC LIMIT 1'
  ).get(uid);
  const climbRow = db.prepare(
    'SELECT * FROM activities WHERE user_id = ? ORDER BY ascent_m DESC, id DESC LIMIT 1'
  ).get(uid);
  const records = {
    longest: longestRow ? activitySummary(longestRow) : null,
    mostClimb: climbRow ? activitySummary(climbRow) : null,
  };

  res.json({ totals, perSport, monthly, records });
});
