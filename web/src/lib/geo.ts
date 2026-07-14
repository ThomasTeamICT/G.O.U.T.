// Geo-berekeningen (browser). Track = [lon, lat, ele?, t?][]

import type { TrackPoint } from '../types';

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversine(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function trackDistance(track: TrackPoint[]): number {
  let d = 0;
  for (let i = 1; i < track.length; i++) {
    d += haversine(track[i - 1][0], track[i - 1][1], track[i][0], track[i][1]);
  }
  return d;
}

// Cumulatieve afstanden per punt (voor hoogteprofiel en live-modus).
export function cumulative(track: TrackPoint[]): number[] {
  const out = new Array<number>(track.length);
  out[0] = 0;
  for (let i = 1; i < track.length; i++) {
    out[i] = out[i - 1] + haversine(track[i - 1][0], track[i - 1][1], track[i][0], track[i][1]);
  }
  return out;
}

export function ascentDescent(track: TrackPoint[]): { ascent: number; descent: number } {
  let up = 0, down = 0;
  let ref: number | null = null;
  for (const p of track) {
    const e = p[2];
    if (typeof e !== 'number' || Number.isNaN(e)) continue;
    if (ref === null) { ref = e; continue; }
    const diff = e - ref;
    if (diff > 3) { up += diff; ref = e; }
    else if (diff < -3) { down -= diff; ref = e; }
  }
  return { ascent: Math.round(up), descent: Math.round(down) };
}

export function bboxOf(track: TrackPoint[]): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of track) {
    if (p[0] < w) w = p[0];
    if (p[0] > e) e = p[0];
    if (p[1] < s) s = p[1];
    if (p[1] > n) n = p[1];
  }
  return [w, s, e, n];
}

// Douglas-Peucker op graden; tolerance ~0.0004 ≈ 40 m.
export function simplify(track: TrackPoint[], tolerance = 0.0004): TrackPoint[] {
  if (track.length <= 2) return track.slice();
  const keep = new Uint8Array(track.length);
  keep[0] = keep[track.length - 1] = 1;
  const stack: [number, number][] = [[0, track.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = 0, idx = -1;
    const ax = track[a][0], ay = track[a][1];
    const bx = track[b][0], by = track[b][1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const px = track[i][0], py = track[i][1];
      let d: number;
      if (len2 === 0) d = Math.hypot(px - ax, py - ay);
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tolerance && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out: TrackPoint[] = [];
  for (let i = 0; i < track.length; i++) if (keep[i]) out.push(track[i]);
  return out;
}

// Dichtstbijzijnde punt op de track (index + afstand er naartoe), voor
// live volgen en hoogteprofiel-synchronisatie. Grof maar snel: per punt.
export function nearestPointIndex(track: TrackPoint[], lon: number, lat: number): { index: number; distM: number } {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < track.length; i++) {
    const d = haversine(track[i][0], track[i][1], lon, lat);
    if (d < bestD) { bestD = d; best = i; }
  }
  return { index: best, distM: bestD };
}

// Interpoleer een punt op afstand `atM` langs de track.
export function pointAtDistance(track: TrackPoint[], cum: number[], atM: number): TrackPoint {
  if (atM <= 0) return track[0];
  const total = cum[cum.length - 1];
  if (atM >= total) return track[track.length - 1];
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= atM) lo = mid; else hi = mid;
  }
  const t = (atM - cum[lo]) / Math.max(cum[hi] - cum[lo], 1e-9);
  const a = track[lo], b = track[hi];
  const ele = typeof a[2] === 'number' && typeof b[2] === 'number'
    ? a[2] + (b[2] - a[2]) * t : undefined;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, ele];
}
