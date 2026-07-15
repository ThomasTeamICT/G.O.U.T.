// DOM-helpers, formattering, iconen, toasts en modals.

import type { Difficulty, Sport } from './types';

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, any> = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v; // alleen voor vertrouwde (eigen) SVG-strings!
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'value' && 'value' in node) (node as any).value = v;
    else if (k === 'checked' && 'checked' in node) (node as any).checked = !!v;
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function svgEl(svg: string, cls?: string): HTMLElement {
  const span = document.createElement('span');
  span.style.display = 'contents';
  if (cls) span.className = cls;
  span.innerHTML = svg;
  return span;
}

/* ---------- formattering ---------- */

export function fmtKm(m: number): string {
  const km = m / 1000;
  return `${km < 10 ? km.toFixed(1).replace('.', ',') : Math.round(km)} km`;
}

export function fmtM(m: number): string {
  return `${Math.round(m)} m`;
}

export function fmtDur(s: number): string {
  const totalMin = Math.round(s / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  return `${h}:${String(m).padStart(2, '0')} u`;
}

export function fmtSpeed(mPerS: number): string {
  return `${(mPerS * 3.6).toFixed(1).replace('.', ',')} km/u`;
}

export function fmtPace(sPerKm: number): string {
  const m = Math.floor(sPerKm / 60);
  const s = Math.round(sPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')} /km`;
}

const MONTHS = ['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];
export function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso.includes('T') || iso.includes(' ') ? iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z') : iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ---------- sport & moeilijkheid ---------- */

export const SPORTS: { key: Sport; label: string }[] = [
  { key: 'wandelen', label: 'Wandelen' },
  { key: 'fietsen', label: 'Fietsen' },
  { key: 'mtb', label: 'Mountainbike' },
];

export function sportLabel(s: Sport): string {
  return SPORTS.find((x) => x.key === s)?.label || s;
}

export function difficultyBadge(d: Difficulty): HTMLElement {
  const labels: Record<Difficulty, string> = { makkelijk: 'Makkelijk', gemiddeld: 'Gemiddeld', zwaar: 'Zwaar' };
  return el('span', { class: `badge badge-${d}` }, labels[d] || d);
}

/* ---------- iconen (24px, stroke) ---------- */

const I = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

export const icons = {
  walk: I('<circle cx="13" cy="4.5" r="1.8" fill="currentColor" stroke="none"/><path d="M12.5 8l-2.2 5.2M12.5 8l2.6 2 2.4.8M12.5 8l-3.2 1-1.8 2.5M10.3 13.2l1.9 2.3-1 5M10.3 13.2l4 .9 1.2 5.4"/>'),
  bike: I('<circle cx="6" cy="16.5" r="3.5"/><circle cx="18" cy="16.5" r="3.5"/><path d="M6 16.5 9.5 9h5.2M18 16.5 14.7 9M9.5 9 12 16.5h-6M13.5 6.5h2.8"/>'),
  mtb: I('<circle cx="5.5" cy="17" r="3.2"/><circle cx="18.5" cy="17" r="3.2"/><path d="M5.5 17 9 10.5h5L18.5 17M9 10.5 11.8 17H5.5M13 7.5h3l1.5 3M2.5 11l3-2M21.5 11.5l-2.5-2"/>'),
  route: I('<circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M8.5 19H15a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h6.5" stroke-dasharray="0"/>'),
  map: I('<path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4zM9 4v14M15 6v14"/>'),
  compass: I('<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z" fill="currentColor" stroke="none"/>'),
  download: I('<path d="M12 4v10m0 0 4-4m-4 4-4-4M4.5 19.5h15"/>'),
  upload: I('<path d="M12 14V4m0 0L8 8m4-4 4 4M4.5 19.5h15"/>'),
  share: I('<circle cx="6" cy="12" r="2.6"/><circle cx="17.5" cy="5.5" r="2.6"/><circle cx="17.5" cy="18.5" r="2.6"/><path d="m8.4 10.8 6.8-4M8.4 13.2l6.8 4"/>'),
  edit: I('<path d="m4 20 .8-3.2L16.4 5.2a2 2 0 0 1 2.8 0l-.4-.4a2 2 0 0 1 0 2.8L7.2 19.2 4 20z"/>'),
  trash: I('<path d="M4.5 6.5h15M9.5 6V4.5h5V6M6.5 6.5l.8 13h9.4l.8-13M10 10.5v5.5M14 10.5v5.5"/>'),
  plus: I('<path d="M12 5v14M5 12h14"/>'),
  close: I('<path d="M6 6l12 12M18 6 6 18"/>'),
  chevronL: I('<path d="m14.5 5.5-6.5 6.5 6.5 6.5"/>'),
  chevronD: I('<path d="m6 9.5 6 6 6-6"/>'),
  undo: I('<path d="M8 5 3.5 9.5 8 14M4 9.5h10a6 6 0 0 1 0 12h-3"/>'),
  redo: I('<path d="m16 5 4.5 4.5L16 14M20 9.5H10a6 6 0 0 0 0 12h3"/>'),
  reverse: I('<path d="M4 7.5h13l-3-3M20 16.5H7l3 3"/>'),
  save: I('<path d="M5 4.5h11l3.5 3.5V19a.5.5 0 0 1-.5.5H5a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5zM8 4.5V9h7V4.5M8 19v-5.5h8V19"/>'),
  heart: I('<path d="M12 20s-7.5-4.7-7.5-10A4.3 4.3 0 0 1 12 7.2 4.3 4.3 0 0 1 19.5 10c0 5.3-7.5 10-7.5 10z"/>'),
  heartFill: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 20s-7.5-4.7-7.5-10A4.3 4.3 0 0 1 12 7.2 4.3 4.3 0 0 1 19.5 10c0 5.3-7.5 10-7.5 10z"/></svg>`,
  lock: I('<rect x="5.5" y="10.5" width="13" height="9" rx="1.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>'),
  globe: I('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.4 3.8 5.4 3.8 8.5s-1.3 6.1-3.8 8.5c-2.5-2.4-3.8-5.4-3.8-8.5s1.3-6.1 3.8-8.5z"/>'),
  play: I('<path d="M7.5 5.5v13l10-6.5-10-6.5z" fill="currentColor" stroke-linejoin="round"/>'),
  stop: I('<rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor"/>'),
  locate: I('<circle cx="12" cy="12" r="3.5"/><path d="M12 2.5V6M12 18v3.5M21.5 12H18M6 12H2.5"/>'),
  search: I('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  user: I('<circle cx="12" cy="8" r="3.8"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>'),
  stats: I('<path d="M4.5 19.5v-6M10 19.5V8M15.5 19.5v-9M21 19.5v-15" transform="translate(-0.75,0)"/>'),
  logout: I('<path d="M14 4.5H6a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h8M10.5 12H21m0 0-3.5-3.5M21 12l-3.5 3.5"/>'),
  flag: I('<path d="M5.5 21V4a1 1 0 0 1 1-1c4 0 6.5 2.5 10.5 1.5V13c-4 1-6.5-1.5-10.5-1.5"/>'),
  mountain: I('<path d="m2.5 19 6.5-11 4 6.5L16 11l5.5 8h-19zM9 8l1.5-2.5L13 9"/>'),
  loop: I('<path d="M4.5 12a7.5 7.5 0 0 1 12.9-5.2M19.5 12a7.5 7.5 0 0 1-12.9 5.2"/><path d="M17.6 3.2v3.8h-3.8M6.4 20.8V17h3.8"/>'),
  layers: I('<path d="m12 3.5 9 5-9 5-9-5 9-5zM4.5 13 12 17l7.5-4M6 15.7 12 19l6-3.3"/>'),
  copy: I('<rect x="9" y="9" width="11" height="11" rx="1.5"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>'),
  check: I('<path d="m4.5 12.5 5 5L19.5 7"/>'),
  clock: I('<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.5l3.5 2"/>'),
  up: I('<path d="m5 17 6.5-10L18 17"/><path d="M14 7.5h5.5"/>'),
  down: I('<path d="m5 7 6.5 10L18 7"/><path d="M14 16.5h5.5"/>'),
};

export function sportIcon(s: Sport): string {
  return s === 'wandelen' ? icons.walk : s === 'mtb' ? icons.mtb : icons.bike;
}

/* ---------- toasts ---------- */

let toastHolder: HTMLElement | null = null;
export function toast(msg: string, type: 'ok' | 'error' = 'ok') {
  if (!toastHolder) {
    toastHolder = el('div', { class: 'toasts' });
    document.body.append(toastHolder);
  }
  const t = el('div', { class: `toast${type === 'error' ? ' error' : ''}` }, msg);
  toastHolder.append(t);
  setTimeout(() => t.remove(), 3800);
}

/* ---------- modals ---------- */

export function modal(content: HTMLElement, opts: { onClose?: () => void } = {}): () => void {
  const panel = el('div', { class: 'modal', tabindex: '-1' }, content);
  const backdrop = el('div', { class: 'modal-backdrop' }, panel);
  const opener = document.activeElement as HTMLElement | null;

  const focusables = () => Array.from(panel.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  )).filter((n) => !n.hasAttribute('disabled') && n.offsetParent !== null);

  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    opener?.focus?.();
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { close(); return; }
    // Focus binnen de modal houden (cyclische Tab)
    if (e.key === 'Tab') {
      const f = focusables();
      if (!f.length) { e.preventDefault(); panel.focus(); return; }
      const first = f[0], last = f[f.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!active || !panel.contains(active)) { e.preventDefault(); first.focus(); return; }
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    }
  };
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  const f = focusables();
  (f.find((n) => n.matches('input, select, textarea')) || f[0] || panel).focus();
  return close;
}

export function confirmDialog(title: string, text: string, confirmLabel = 'Verwijderen'): Promise<boolean> {
  return new Promise((resolve) => {
    const box = el('div', {});
    const close = modal(box, { onClose: () => resolve(false) });
    box.append(
      el('h2', {}, title),
      el('p', {}, text),
      el('div', { class: 'modal-actions' },
        el('button', { class: 'btn', onclick: () => { close(); resolve(false); } }, 'Annuleren'),
        el('button', { class: 'btn btn-primary', onclick: () => { resolve(true); close(); } }, confirmLabel),
      ),
    );
  });
}

/* ---------- minimap (SVG-preview van een track) ---------- */

export function svgMinimap(points: [number, number][], stroke = '#3557e0'): HTMLElement {
  const holder = el('div', { style: 'width:100%;height:100%;' });
  if (!points || points.length < 2) {
    holder.style.background = 'var(--surface-2)';
    return holder;
  }
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of points) {
    if (x < w) w = x; if (x > e) e = x;
    if (y < s) s = y; if (y > n) n = y;
  }
  const latMid = (s + n) / 2;
  const kx = Math.cos((latMid * Math.PI) / 180);
  const spanX = Math.max((e - w) * kx, 1e-5);
  const spanY = Math.max(n - s, 1e-5);
  const span = Math.max(spanX, spanY) * 1.15;
  const cx = ((w + e) / 2) * kx;
  const cy = latMid;
  const size = 100;
  const pts = points.map(([x, y]) => {
    const px = ((x * kx - cx) / span + 0.5) * size;
    const py = ((cy - y) / span + 0.5) * size;
    return `${px.toFixed(1)},${py.toFixed(1)}`;
  }).join(' ');
  const [x0, y0] = pts.split(' ')[0].split(',').map(Number);
  holder.innerHTML =
    `<svg viewBox="0 0 ${size} ${size}" preserveAspectRatio="xMidYMid meet">` +
    `<polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>` +
    `<circle cx="${x0}" cy="${y0}" r="3.4" fill="#3d5a3c" stroke="#fff" stroke-width="1.4"/>` +
    `</svg>`;
  return holder;
}
