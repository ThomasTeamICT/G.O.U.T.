// Hoogteprofiel als hand-getekende SVG met hover-synchronisatie naar de kaart.

import { cumulative } from './geo';
import type { TrackPoint } from '../types';

export interface ElevationProfile {
  destroy(): void;
}

export function renderElevation(
  container: HTMLElement,
  track: TrackPoint[],
  opts: { onHover?: (p: { lat: number; lon: number; distM: number; ele: number } | null) => void; height?: number } = {}
): ElevationProfile {
  container.classList.add('elev');
  container.innerHTML = '';
  const H = opts.height ?? 130;
  container.style.height = `${H}px`;

  const eles = track.map((p) => (typeof p[2] === 'number' && !Number.isNaN(p[2]) ? p[2] : null));
  const known = eles.filter((e): e is number => e !== null);
  if (known.length < 2) {
    container.innerHTML = `<div style="display:grid;place-items:center;height:100%;color:var(--muted);font-size:.85rem">Geen hoogtedata beschikbaar</div>`;
    return { destroy() { container.innerHTML = ''; } };
  }

  const cum = cumulative(track);
  const total = cum[cum.length - 1] || 1;
  let min = Math.min(...known), max = Math.max(...known);
  if (max - min < 20) { const mid = (max + min) / 2; min = mid - 10; max = mid + 10; }
  const pad = (max - min) * 0.12;
  min -= pad; max += pad;

  const W = 800;
  const X = (d: number) => (d / total) * W;
  const Y = (e: number) => H - ((e - min) / (max - min)) * (H - 22) - 4;

  // Ontbrekende hoogtes lineair opvullen voor een doorlopende lijn.
  const fill: number[] = eles.map((e) => e ?? NaN);
  let lastIdx = -1;
  for (let i = 0; i < fill.length; i++) {
    if (!Number.isNaN(fill[i])) {
      if (lastIdx >= 0 && i - lastIdx > 1) {
        for (let j = lastIdx + 1; j < i; j++) {
          fill[j] = fill[lastIdx] + ((fill[i] - fill[lastIdx]) * (j - lastIdx)) / (i - lastIdx);
        }
      } else if (lastIdx < 0) {
        for (let j = 0; j < i; j++) fill[j] = fill[i];
      }
      lastIdx = i;
    }
  }
  for (let j = lastIdx + 1; j < fill.length; j++) fill[j] = fill[lastIdx];

  // Tekenresolutie beperken: meer dan ~2 punten per pixel is onzichtbaar,
  // en een camino van 6000 punten geeft anders een SVG-pad van ~70 kB.
  const MAX_DRAW = 1600;
  const drawIdx: number[] = [];
  if (track.length <= MAX_DRAW) {
    for (let i = 0; i < track.length; i++) drawIdx.push(i);
  } else {
    const step = (track.length - 1) / (MAX_DRAW - 1);
    for (let i = 0; i < MAX_DRAW; i++) drawIdx.push(Math.round(i * step));
  }
  let line = '', area = '';
  for (let k = 0; k < drawIdx.length; k++) {
    const i = drawIdx[k];
    const x = X(cum[i]).toFixed(1), y = Y(fill[i]).toFixed(1);
    line += (k === 0 ? 'M' : 'L') + x + ',' + y;
  }
  area = line + `L${W},${H} L0,${H} Z`;

  const gridLines: string[] = [];
  const step = niceStep(max - min);
  for (let e = Math.ceil(min / step) * step; e < max; e += step) {
    gridLines.push(
      `<line x1="0" y1="${Y(e).toFixed(1)}" x2="${W}" y2="${Y(e).toFixed(1)}" stroke="#e3dccc" stroke-width="1"/>` +
      `<text x="6" y="${(Y(e) - 4).toFixed(1)}" font-size="11" fill="#7d7a6c">${Math.round(e)} m</text>`
    );
  }

  container.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
    `<defs><linearGradient id="elevg" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#7fa05a" stop-opacity=".55"/><stop offset="1" stop-color="#7fa05a" stop-opacity=".08"/>` +
    `</linearGradient></defs>` +
    gridLines.join('') +
    `<path d="${area}" fill="url(#elevg)"/>` +
    `<path d="${line}" fill="none" stroke="#4c7a34" stroke-width="2"/>` +
    `<line class="cursor" x1="-10" y1="0" x2="-10" y2="${H}" stroke="#e8590c" stroke-width="1.5"/>` +
    `</svg>`;

  const tip = document.createElement('div');
  tip.className = 'elev-tip';
  tip.style.display = 'none';
  container.append(tip);

  const svg = container.querySelector('svg')!;
  const cursor = svg.querySelector<SVGLineElement>('.cursor')!;

  function locate(clientX: number) {
    const rect = svg.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const distM = frac * total;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= distM) lo = mid; else hi = mid; }
    const i = distM - cum[lo] < cum[hi] - distM ? lo : hi;
    return { i, frac, distM, rect };
  }

  const onMove = (ev: MouseEvent) => {
    const { i, frac, distM, rect } = locate(ev.clientX);
    const x = frac * W;
    cursor.setAttribute('x1', String(x));
    cursor.setAttribute('x2', String(x));
    tip.style.display = '';
    tip.style.left = `${frac * rect.width}px`;
    tip.style.top = `14px`;
    const km = (distM / 1000).toFixed(1).replace('.', ',');
    tip.textContent = `${km} km · ${Math.round(fill[i])} m`;
    opts.onHover?.({ lat: track[i][1], lon: track[i][0], distM, ele: fill[i] });
  };
  const onLeave = () => {
    cursor.setAttribute('x1', '-10');
    cursor.setAttribute('x2', '-10');
    tip.style.display = 'none';
    opts.onHover?.(null);
  };
  svg.addEventListener('mousemove', onMove);
  svg.addEventListener('mouseleave', onLeave);

  return {
    destroy() {
      svg.removeEventListener('mousemove', onMove);
      svg.removeEventListener('mouseleave', onLeave);
      container.innerHTML = '';
    },
  };
}

function niceStep(range: number): number {
  const raw = range / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (raw <= m * pow) return m * pow;
  return 10 * pow;
}
