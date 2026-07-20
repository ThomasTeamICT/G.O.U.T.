// Gedeelde geo-berekeningen (server). Track = [[lon, lat, ele?, t?], ...]
// t = epoch-seconden (alleen bij activiteiten).

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

export function haversine(lon1, lat1, lon2, lat2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function trackDistance(track) {
  let d = 0;
  for (let i = 1; i < track.length; i++) {
    d += haversine(track[i - 1][0], track[i - 1][1], track[i][0], track[i][1]);
  }
  return d;
}

// Stijgen/dalen met drempel tegen GPS-ruis: hoogteverschillen tellen pas
// mee zodra ze cumulatief > 3 m bedragen.
export function ascentDescent(track) {
  let up = 0, down = 0, ref = null;
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

export function bboxOf(track) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of track) {
    if (p[0] < w) w = p[0];
    if (p[0] > e) e = p[0];
    if (p[1] < s) s = p[1];
    if (p[1] > n) n = p[1];
  }
  return [w, s, e, n];
}

// Geschatte duur in seconden. Wandelen volgens Naismith-achtige regel,
// fietsen/mtb met klimtoeslag.
export function estimateDuration(sport, distanceM, ascentM) {
  const km = distanceM / 1000;
  let hours;
  if (sport === 'wandelen') hours = km / 4.3 + ascentM / 600;
  else if (sport === 'mtb') hours = km / 11 + ascentM / 480;
  else hours = km / 17 + ascentM / 600;
  return Math.round(hours * 3600);
}

export function difficulty(sport, distanceM, ascentM) {
  const km = distanceM / 1000;
  let effort;
  if (sport === 'wandelen') effort = km + ascentM / 50;
  else if (sport === 'mtb') effort = km / 2 + ascentM / 80;
  else effort = km / 3 + ascentM / 100;
  if (effort <= 10) return 'makkelijk';
  if (effort <= 22) return 'gemiddeld';
  return 'zwaar';
}

// Douglas-Peucker vereenvoudiging (op graden, goed genoeg voor previews).
export function simplify(track, tolerance = 0.0004) {
  if (track.length <= 2) return track.slice();
  const keep = new Uint8Array(track.length);
  keep[0] = keep[track.length - 1] = 1;
  const stack = [[0, track.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0, idx = -1;
    const [ax, ay] = track[a], [bx, by] = track[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = track[i];
      let d;
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
  const out = [];
  for (let i = 0; i < track.length; i++) if (keep[i]) out.push(track[i]);
  return out;
}

// Compacte preview voor lijstkaartjes/minimaps: max ~120 punten, alleen lon/lat.
// Douglas-Peucker (simplify) is O(n^2) in de worst case: een zigzag-track van
// 100k punten (toegelaten door de validatie) laat de server minutenlang
// blokkeren, en preview() draait synchroon bij elke POST/PUT/import. Voor een
// minimap is meer detail zinloos, dus dunnen we de invoer eerst in O(n) uit tot
// hoogstens ~2000 punten vóór Douglas-Peucker (worst case dan ~2000^2, dus
// verwaarloosbaar). We doen dat NIET met naïeve stride-sampling (die aliast een
// hoogfrequente zigzag weg tot een rechte lijn), maar door per venster de
// extreme punten (min/max lon én lat) te bewaren; zo blijft de vorm/amplitude
// behouden. Begin- en eindpunt blijven altijd staan. Tracks <=2000 punten gaan
// ongewijzigd door Douglas-Peucker (identiek resultaat als voorheen).
export function preview(track) {
  let input = track;
  const MAX_IN = 2000;
  if (input.length > MAX_IN) {
    const WINDOWS = 400;
    const size = Math.ceil(input.length / WINDOWS);
    const idxSet = new Set([0, input.length - 1]);
    for (let w = 0; w < input.length; w += size) {
      const end = Math.min(w + size, input.length);
      let iMinLon = w, iMaxLon = w, iMinLat = w, iMaxLat = w;
      for (let i = w + 1; i < end; i++) {
        const p = input[i];
        if (p[0] < input[iMinLon][0]) iMinLon = i;
        if (p[0] > input[iMaxLon][0]) iMaxLon = i;
        if (p[1] < input[iMinLat][1]) iMinLat = i;
        if (p[1] > input[iMaxLat][1]) iMaxLat = i;
      }
      idxSet.add(iMinLon); idxSet.add(iMaxLon); idxSet.add(iMinLat); idxSet.add(iMaxLat);
    }
    input = [...idxSet].sort((a, b) => a - b).map((i) => input[i]);
  }
  let t = simplify(input, 0.0004);
  if (t.length > 120) {
    const step = Math.ceil(t.length / 120);
    t = t.filter((_, i) => i % step === 0 || i === t.length - 1);
  }
  return t.map((p) => [
    Math.round(p[0] * 1e5) / 1e5,
    Math.round(p[1] * 1e5) / 1e5,
  ]);
}

// Volledige route-statistieken in één keer.
export function routeStats(sport, track) {
  const distance = trackDistance(track);
  const { ascent, descent } = ascentDescent(track);
  return {
    distance_m: Math.round(distance),
    ascent_m: ascent,
    descent_m: descent,
    duration_s: estimateDuration(sport, distance, ascent),
    difficulty: difficulty(sport, distance, ascent),
    bbox: bboxOf(track),
    start_lon: track[0]?.[0] ?? null,
    start_lat: track[0]?.[1] ?? null,
  };
}

// Statistieken voor activiteiten, incl. bewegingstijd uit timestamps (index 3).
export function activityStats(track) {
  const distance = trackDistance(track);
  const { ascent, descent } = ascentDescent(track);
  let moving = 0, elapsed = 0;
  const first = track.find((p) => typeof p[3] === 'number');
  const last = [...track].reverse().find((p) => typeof p[3] === 'number');
  if (first && last && last[3] > first[3]) {
    elapsed = last[3] - first[3];
    let prev = null;
    for (const p of track) {
      if (typeof p[3] !== 'number') continue;
      if (prev) {
        const dt = p[3] - prev[3];
        if (dt > 0 && dt <= 900) {
          const dd = haversine(prev[0], prev[1], p[0], p[1]);
          if (dd / dt > 0.5) moving += dt;
        }
      }
      prev = p;
    }
  }
  return {
    distance_m: Math.round(distance),
    ascent_m: ascent,
    descent_m: descent,
    moving_s: Math.round(moving),
    elapsed_s: Math.round(elapsed),
    bbox: bboxOf(track),
    start_lon: track[0]?.[0] ?? null,
    start_lat: track[0]?.[1] ?? null,
  };
}
