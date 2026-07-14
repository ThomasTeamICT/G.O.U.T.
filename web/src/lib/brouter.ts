// BRouter-routering via de server-proxy, met per-leg cache zodat undo/redo
// en herberekenen nooit dubbel ophalen.

import { api } from '../api';
import type { Sport, TrackPoint, Waypoint } from '../types';

// Cache per leg: key = sport (of 'beeline') + afgeronde coördinaten.
const cache = new Map<string, TrackPoint[]>();

const co = (n: number) => n.toFixed(6);
function legKey(from: Waypoint, to: Waypoint, kind: Sport | 'beeline'): string {
  return `${kind}|${co(from.lon)},${co(from.lat)}|${co(to.lon)},${co(to.lat)}`;
}

// Hemelsbreed segment: een rechte lijn tussen twee punten.
export function beelineLeg(from: Waypoint, to: Waypoint): TrackPoint[] {
  const key = legKey(from, to, 'beeline');
  const hit = cache.get(key);
  if (hit) return hit;
  const leg: TrackPoint[] = [[from.lon, from.lat], [to.lon, to.lat]];
  cache.set(key, leg);
  return leg;
}

// Eén leg routeren via BRouter (server-proxy). Gooit een Error met een
// Nederlandse boodschap als het mislukt.
export async function routeLeg(from: Waypoint, to: Waypoint, sport: Sport): Promise<TrackPoint[]> {
  const key = legKey(from, to, sport);
  const hit = cache.get(key);
  if (hit) return hit;

  const lonlats = `${from.lon},${from.lat}|${to.lon},${to.lat}`;
  let data: any;
  try {
    data = await api.get<any>(`/api/routing?lonlats=${encodeURIComponent(lonlats)}&sport=${encodeURIComponent(sport)}`);
  } catch (err: any) {
    throw new Error(err?.message || 'De route kon niet berekend worden.');
  }

  const coords = data?.features?.[0]?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) {
    throw new Error('De routeserver gaf geen bruikbare route terug.');
  }

  const leg: TrackPoint[] = coords.map((c: number[]): TrackPoint => {
    const ele = typeof c[2] === 'number' && !Number.isNaN(c[2]) ? c[2] : undefined;
    return ele === undefined ? [c[0], c[1]] : [c[0], c[1], ele];
  });
  cache.set(key, leg);
  return leg;
}
