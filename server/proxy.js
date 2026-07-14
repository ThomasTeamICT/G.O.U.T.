import { Router } from 'express';
import { requireAuth } from './auth.js';

// Routering loopt via de server zodat CORS geen probleem is en de
// BRouter-instantie configureerbaar blijft (zelf hosten kan ook).
const BROUTER_URL = process.env.BROUTER_URL || 'https://brouter.de/brouter';
const NOMINATIM_URL = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
const UA = 'G.O.U.T.-routeplanner/1.0 (zelfgehost, contact via beheerder)';

// BRouter-profielen per sport; overschrijfbaar via env-variabelen.
export const PROFILES = {
  wandelen: process.env.BROUTER_PROFILE_WANDELEN || 'hiking-beta',
  fietsen: process.env.BROUTER_PROFILE_FIETSEN || 'trekking',
  mtb: process.env.BROUTER_PROFILE_MTB || 'mtb',
};
// Als een (custom) profiel niet op de BRouter-server staat, val terug op:
const FALLBACK_PROFILE = 'trekking';

export const proxyRouter = Router();

const LONLATS_RE = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?(\|-?\d+(\.\d+)?,-?\d+(\.\d+)?)+$/;

proxyRouter.get('/routing', requireAuth, async (req, res) => {
  const { lonlats, sport } = req.query;
  if (typeof lonlats !== 'string' || !LONLATS_RE.test(lonlats) || lonlats.length > 2000)
    return res.status(400).json({ error: 'Ongeldige coördinaten.' });
  const profile = PROFILES[sport] || PROFILES.fietsen;

  const fetchRoute = async (prof) => {
    const url = `${BROUTER_URL}?lonlats=${encodeURIComponent(lonlats)}&profile=${encodeURIComponent(prof)}&alternativeidx=0&format=geojson`;
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25000) });
    return { ok: r.ok, status: r.status, text: await r.text() };
  };

  try {
    let result = await fetchRoute(profile);
    let usedProfile = profile;
    if (!result.ok && profile !== FALLBACK_PROFILE) {
      result = await fetchRoute(FALLBACK_PROFILE);
      usedProfile = FALLBACK_PROFILE;
    }
    if (!result.ok)
      return res.status(502).json({ error: 'Routeserver gaf een fout terug.', detail: result.text.slice(0, 300) });
    res.setHeader('X-Used-Profile', usedProfile);
    res.type('application/json').send(result.text);
  } catch {
    res.status(502).json({ error: 'Routeserver niet bereikbaar. Probeer zo dadelijk opnieuw.' });
  }
});

// Plaatsnaam zoeken (voor "Ontdek" en de planner).
proxyRouter.get('/geocode', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  if (q.length < 2) return res.json({ results: [] });
  try {
    const url = `${NOMINATIM_URL}/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`;
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return res.json({ results: [] });
    const data = await r.json();
    res.json({
      results: data.map((d) => ({
        name: d.display_name,
        lat: Number(d.lat),
        lon: Number(d.lon),
      })),
    });
  } catch {
    res.json({ results: [] });
  }
});

// Omgekeerd geocoderen: "Opwijk, België" bij het opslaan van een route.
proxyRouter.get('/revgeocode', requireAuth, async (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.json({ region: null });
  try {
    const url = `${NOMINATIM_URL}/reverse?format=jsonv2&zoom=10&lat=${lat}&lon=${lon}`;
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return res.json({ region: null });
    const d = await r.json();
    const a = d.address || {};
    const place = a.city || a.town || a.village || a.municipality || a.county || null;
    const region = place ? `${place}${a.country ? ', ' + a.country : ''}` : (d.display_name || null);
    res.json({ region });
  } catch {
    res.json({ region: null });
  }
});
