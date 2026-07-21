// Uniforme voortgang-matcher voor "live volgen".
//
// Principe: de voortgang mag NOOIT onverklaard vooruitspringen. Bij elke
// GPS-fix zoeken we het dichtstbijzijnde routepunt (afstand bestD) en
// verzamelen we ALLE kandidaten die binnen een kleine marge van bestD liggen
// (d <= max(bestD + 50 m, bestD * 1.3)). Uit die kandidaten kiezen we degene
// met de kleinste sprong in cumulatieve afstand t.o.v. de vorige positie
// (refIdx = lastProgressIdx).
//
// Zo blijft bij een LUS (start ≈ einde) of een heen-en-terug-stuk (twee
// routepunten op exact dezelfde plek) vanzelf de juiste "tweeling" plakken:
// die met de kleinste voortgangssprong. Bij de allereerste fix is refIdx = 0,
// dus wint de startkant een start≈einde-tie automatisch. Echte beweging
// verandert de cumulatieve afstand maar met kleine stapjes per fix, zodat
// heen- en terugweg op dezelfde straat netjes uit elkaar blijven.

import type { TrackPoint } from '../types';
import { haversine } from './geo';

// Een volledige scan per fix is prima tot ~20.000 punten (<5 ms bij 1 fix/s).
// Daarboven gaan we grof-dan-fijn: ~10.000 grove samples, en lokaal verfijnen
// rond enkel de kandidaten die binnen de grove marge vallen.
const FULL_SCAN_LIMIT = 20000;
const COARSE_SAMPLES = 10000;

// Kandidaatmarge rond het dichtstbijzijnde punt.
function marginOf(bestD: number): number {
  return Math.max(bestD + 50, bestD * 1.3);
}

// Achteruit springen mag, maar bij een gelijke afstand kiezen we liever
// vooruit. Op een heen-en-terug-vouw (of lus-vouw) liggen de heen- en
// terug-tweeling exact even ver in voortgang; zonder deze lichte straf op
// achteruitgaan zou de matcher daar de terugweg als "terug de heenweg op"
// kunnen lezen en de voortgang laten dalen. Echte terugkeer (alleen een
// achterwaartse kandidaat in de buurt) blijft gewoon werken.
const BACKWARD_PENALTY = 1.25;
function progressJump(delta: number): number {
  return delta >= 0 ? delta : -delta * BACKWARD_PENALTY;
}

export interface RouteMatch { index: number; distM: number; }

// Maakt een matcher voor een vaste track + cumulatieve-afstandstabel. De
// afstandsbuffer wordt hergebruikt zodat er per fix geen GC-druk ontstaat.
export function makeRouteMatcher(
  track: TrackPoint[],
  cum: number[],
): (lon: number, lat: number, refIdx: number) => RouteMatch {
  const n = track.length;
  const dist = new Float64Array(Math.max(1, n));

  // Kies uit de gescande punten de kandidaat met de kleinste voortgangssprong.
  function choose(scanned: number[] | null, refIdx: number): RouteMatch {
    let bestD = Infinity;
    if (scanned) {
      for (let s = 0; s < scanned.length; s++) { const d = dist[scanned[s]]; if (d < bestD) bestD = d; }
    } else {
      for (let i = 0; i < n; i++) { const d = dist[i]; if (d < bestD) bestD = d; }
    }
    const margin = marginOf(bestD);
    const refCum = cum[refIdx] || 0;
    let index = refIdx, bestJump = Infinity, chosenD = bestD;
    if (scanned) {
      for (let s = 0; s < scanned.length; s++) {
        const i = scanned[s]; const d = dist[i];
        if (d <= margin) { const jump = progressJump(cum[i] - refCum); if (jump < bestJump) { bestJump = jump; index = i; chosenD = d; } }
      }
    } else {
      for (let i = 0; i < n; i++) {
        const d = dist[i];
        if (d <= margin) { const jump = progressJump(cum[i] - refCum); if (jump < bestJump) { bestJump = jump; index = i; chosenD = d; } }
      }
    }
    return { index, distM: chosenD };
  }

  return function match(lon: number, lat: number, refIdx: number): RouteMatch {
    if (n === 0) return { index: 0, distM: Infinity };
    if (n === 1) return { index: 0, distM: haversine(track[0][0], track[0][1], lon, lat) };

    if (n <= FULL_SCAN_LIMIT) {
      for (let i = 0; i < n; i++) dist[i] = haversine(track[i][0], track[i][1], lon, lat);
      return choose(null, refIdx);
    }

    // Grof-dan-fijn voor zeer lange tracks.
    const k = Math.max(1, Math.ceil(n / COARSE_SAMPLES));
    const scanned: number[] = [];
    let coarseBestD = Infinity;
    for (let i = 0; i < n; i += k) {
      const d = haversine(track[i][0], track[i][1], lon, lat);
      dist[i] = d; scanned.push(i);
      if (d < coarseBestD) coarseBestD = d;
    }
    if ((n - 1) % k !== 0) {
      const i = n - 1;
      const d = haversine(track[i][0], track[i][1], lon, lat);
      dist[i] = d; scanned.push(i);
      if (d < coarseBestD) coarseBestD = d;
    }
    // Verfijn rond elke grove kandidaat binnen een ruime marge, zodat het echte
    // dichtstbijzijnde punt tussen twee samples niet gemist wordt.
    const coarseMargin = Math.max(coarseBestD * 1.5, coarseBestD + 150);
    const coarseCount = scanned.length;
    for (let s = 0; s < coarseCount; s++) {
      const c = scanned[s];
      if (dist[c] > coarseMargin) continue;
      const lo = Math.max(0, c - k + 1), hi = Math.min(n - 1, c + k - 1);
      for (let i = lo; i <= hi; i++) {
        if (i % k === 0) continue;   // al grof gescand
        if (i === n - 1) continue;   // al apart gescand
        dist[i] = haversine(track[i][0], track[i][1], lon, lat);
        scanned.push(i);
      }
    }
    return choose(scanned, refIdx);
  };
}
