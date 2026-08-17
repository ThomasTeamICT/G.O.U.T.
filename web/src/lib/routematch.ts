// Uniforme voortgang-matcher voor "live volgen".
//
// Principe: de voortgang mag NOOIT onverklaard vooruitspringen. Bij elke
// GPS-fix zoeken we het dichtstbijzijnde routepunt (afstand bestD) en
// verzamelen we ALLE kandidaten die binnen een kleine marge van bestD liggen.
// Die marge is gekoppeld aan de fix-nauwkeurigheid (acc): een scherpe fix geeft
// een strakke marge, een grovere fix verruimt ze wat. Uit die kandidaten kiezen
// we degene met de kleinste sprong in cumulatieve afstand t.o.v. de vorige
// positie (refIdx = lastProgressIdx); bij een (bijna) gelijke sprong wint de
// ECHT dichtstbijzijnde kandidaat (kleinste distM).
//
// Zo blijft bij een LUS (start ≈ einde) of een heen-en-terug-stuk (twee
// routepunten op exact dezelfde plek) vanzelf de juiste "tweeling" plakken:
// die met de kleinste voortgangssprong. Bij de allereerste fix is refIdx = 0,
// dus wint de startkant een start≈einde-tie automatisch. Echte beweging
// verandert de cumulatieve afstand maar met kleine stapjes per fix, zodat
// heen- en terugweg op dezelfde straat netjes uit elkaar blijven.
//
// De aan de nauwkeurigheid gekoppelde marge + de distM-tie-break lossen samen
// op dat de voortgang aan het einde van een rondje structureel ~50 m achterbleef
// (en zo nooit 100% haalde): de vroegere vaste 50 m-marge hield een punt vlak
// achter je binnen bereik, en "blijven staan" (sprong 0) won altijd van "een
// stapje vooruit". Nu valt dat punt-achter-je buiten de strakke marge en wint
// het punt dat écht het dichtst bij je ligt.

import type { TrackPoint } from '../types';
import { haversine } from './geo';

// Een volledige scan per fix is prima tot ~20.000 punten (<5 ms bij 1 fix/s).
// Daarboven gaan we grof-dan-fijn: ~10.000 grove samples, en lokaal verfijnen
// rond enkel de kandidaten die binnen de grove marge vallen.
const FULL_SCAN_LIMIT = 20000;
const COARSE_SAMPLES = 10000;

// Terugval-nauwkeurigheid (m) wanneer een aanroep er geen meegeeft.
const DEFAULT_ACC = 15;

// Kandidaatmarge rond het dichtstbijzijnde punt, gekoppeld aan de fix-
// nauwkeurigheid. Een scherpe fix (kleine acc) → strakke marge (~2·acc) zodat de
// voortgang tot op het eindpunt kan klimmen; een grovere fix verruimt ze. De
// bestD·1.3-term houdt de marge zinvol wanneer je even wat verder van de lijn
// zit. De additieve term is begrensd op 25 m zodat een matig-grove fix de marge
// niet laat ontsporen.
function marginOf(bestD: number, acc: number): number {
  return Math.max(bestD + Math.min(25, acc), bestD * 1.3);
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
// defaultAcc wordt gebruikt wanneer een aanroep zelf geen accuracy meegeeft.
export function makeRouteMatcher(
  track: TrackPoint[],
  cum: number[],
  defaultAcc: number = DEFAULT_ACC,
): (lon: number, lat: number, refIdx: number, acc?: number) => RouteMatch {
  const n = track.length;
  const dist = new Float64Array(Math.max(1, n));

  // Kies uit de gescande punten de kandidaat met de kleinste voortgangssprong;
  // bij een (bijna) gelijke sprong wint de dichtstbijzijnde (kleinste distM).
  function choose(scanned: number[] | null, refIdx: number, acc: number): RouteMatch {
    // 1) dichtstbijzijnde afstand
    let bestD = Infinity;
    if (scanned) {
      for (let s = 0; s < scanned.length; s++) { const d = dist[scanned[s]]; if (d < bestD) bestD = d; }
    } else {
      for (let i = 0; i < n; i++) { const d = dist[i]; if (d < bestD) bestD = d; }
    }
    const margin = marginOf(bestD, acc);
    const refCum = cum[refIdx] || 0;

    // 2) kleinste voortgangssprong binnen de marge
    let minJump = Infinity;
    if (scanned) {
      for (let s = 0; s < scanned.length; s++) {
        const i = scanned[s];
        if (dist[i] <= margin) { const j = progressJump(cum[i] - refCum); if (j < minJump) minJump = j; }
      }
    } else {
      for (let i = 0; i < n; i++) {
        if (dist[i] <= margin) { const j = progressJump(cum[i] - refCum); if (j < minJump) minJump = j; }
      }
    }

    // 3) tie-break: binnen een band (~marge breed) boven de kleinste sprong
    //    wint de ECHT dichtstbijzijnde kandidaat. De band is ruim genoeg om het
    //    dichtstbijzijnde punt binnen het kandidaatvenster te dekken, maar veel
    //    smaller dan de sprong naar een verre tweeling (lus/heen-en-terug), die
    //    dus niet meedingt.
    const jumpCeil = minJump + margin + 5;
    let index = refIdx, chosenD = Infinity;
    if (scanned) {
      for (let s = 0; s < scanned.length; s++) {
        const i = scanned[s]; const d = dist[i];
        if (d <= margin) { const j = progressJump(cum[i] - refCum); if (j <= jumpCeil && d < chosenD) { chosenD = d; index = i; } }
      }
    } else {
      for (let i = 0; i < n; i++) {
        const d = dist[i];
        if (d <= margin) { const j = progressJump(cum[i] - refCum); if (j <= jumpCeil && d < chosenD) { chosenD = d; index = i; } }
      }
    }
    return { index, distM: chosenD };
  }

  return function match(lon: number, lat: number, refIdx: number, acc: number = defaultAcc): RouteMatch {
    if (n === 0) return { index: 0, distM: Infinity };
    if (n === 1) return { index: 0, distM: haversine(track[0][0], track[0][1], lon, lat) };

    if (n <= FULL_SCAN_LIMIT) {
      for (let i = 0; i < n; i++) dist[i] = haversine(track[i][0], track[i][1], lon, lat);
      return choose(null, refIdx, acc);
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
    return choose(scanned, refIdx, acc);
  };
}
