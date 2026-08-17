// GPX parsen (DOMParser) en bouwen (string) in de browser.

import type { TrackPoint } from '../types';

export interface ParsedGpx {
  name: string | null;
  track: TrackPoint[];
  hasTime: boolean;
  hasEle: boolean;
}

export function parseGpx(text: string): ParsedGpx {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Dit is geen geldig GPX-bestand.');

  const name =
    doc.querySelector('trk > name')?.textContent?.trim() ||
    doc.querySelector('metadata > name')?.textContent?.trim() ||
    doc.querySelector('rte > name')?.textContent?.trim() || null;

  const track: TrackPoint[] = [];
  let hasTime = false, hasEle = false;

  // trkpt heeft voorrang; rtept en wpt als fallback (sommige planners
  // exporteren routes i.p.v. tracks).
  let pts = Array.from(doc.querySelectorAll('trkpt'));
  if (pts.length === 0) pts = Array.from(doc.querySelectorAll('rtept'));
  if (pts.length === 0) pts = Array.from(doc.querySelectorAll('wpt'));

  for (const pt of pts) {
    // Een punt zonder lat- of lon-attribuut is ongeldig: overslaan (anders werd
    // een ontbrekend attribuut via Number(null)=0 stil een (0,0)-punt, wat een
    // geïmporteerde route de halve wereld rond stuurde).
    if (!pt.hasAttribute('lat') || !pt.hasAttribute('lon')) continue;
    const lat = Number(pt.getAttribute('lat'));
    const lon = Number(pt.getAttribute('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    // Buiten het geldige bereik = ook overslaan.
    if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) continue;
    const p: TrackPoint = [lon, lat];
    const eleText = pt.querySelector('ele')?.textContent;
    if (eleText != null && eleText !== '') {
      const ele = Number(eleText);
      if (Number.isFinite(ele)) { p[2] = ele; hasEle = true; }
    }
    const timeText = pt.querySelector('time')?.textContent;
    if (timeText) {
      const t = Date.parse(timeText);
      if (!Number.isNaN(t)) {
        p[3] = Math.round(t / 1000);
        hasTime = true;
      }
    }
    track.push(p);
  }

  if (track.length < 2) throw new Error('Geen trackpunten gevonden in dit GPX-bestand.');
  return { name, track, hasTime, hasEle };
}

const esc = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export function buildGpx(name: string, track: TrackPoint[], sport = ''): string {
  const pts = track.map((p) => {
    const ele = typeof p[2] === 'number' && !Number.isNaN(p[2]) ? `<ele>${Math.round(p[2] * 10) / 10}</ele>` : '';
    const time = typeof p[3] === 'number' ? `<time>${new Date(p[3] * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')}</time>` : '';
    return `      <trkpt lat="${p[1]}" lon="${p[0]}">${ele}${time}</trkpt>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="G.O.U.T. - gewoon op uw tempo" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(name)}</name></metadata>
  <trk><name>${esc(name)}</name>${sport ? `<type>${esc(sport)}</type>` : ''}<trkseg>
${pts}
  </trkseg></trk>
</gpx>
`;
}

export function downloadGpx(name: string, track: TrackPoint[], sport = '') {
  const blob = new Blob([buildGpx(name, track, sport)], { type: 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-') || 'route'}.gpx`;
  a.click();
  URL.revokeObjectURL(a.href);
}
