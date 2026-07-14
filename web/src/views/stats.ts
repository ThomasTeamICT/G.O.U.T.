// 'Statistieken' — totalen, per sport, maandgrafiek en persoonlijke records.

import './activities.css';
import { api, ApiError } from '../api';
import { el, svgEl, icons, fmtKm, fmtM, fmtDur, sportIcon, sportLabel } from '../ui';
import { navigate } from '../router';
import type { StatsResponse, ActivitySummary, Sport } from '../types';

const SPORT_COLORS: Record<Sport, string> = {
  wandelen: '#4c7a34', // var(--easy)
  fietsen: '#33586e',
  mtb: '#e8590c',       // var(--accent)
};
const SHORT_MONTHS = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const SPORT_ORDER: Sport[] = ['wandelen', 'fietsen', 'mtb'];

export function statsView(container: HTMLElement) {
  const root = el('main', { class: 'page' });
  container.append(root);
  root.append(el('div', { class: 'spinner' }));

  (async () => {
    let stats: StatsResponse;
    try {
      stats = await api.get<StatsResponse>('/api/stats');
    } catch (e) {
      root.innerHTML = '';
      root.append(
        el('h1', {}, 'Statistieken'),
        el('div', { class: 'empty' }, svgEl(icons.stats),
          el('p', {}, (e as ApiError)?.message || 'Kon je statistieken niet laden.')),
      );
      return;
    }
    render(stats);
  })();

  function render(stats: StatsResponse) {
    root.innerHTML = '';
    root.append(
      el('h1', {}, 'Statistieken'),
      el('p', { class: 'page-sub' }, 'Alles wat je al gedaan hebt, op een rijtje.'),
    );

    if (stats.totals.count === 0) {
      root.append(el('div', { class: 'empty' },
        svgEl(icons.stats),
        el('p', {}, 'Nog geen activiteiten. Je statistieken verschijnen zodra je je eerste tocht toevoegt.'),
        el('button', { class: 'btn btn-primary', onclick: () => navigate('/activities') },
          svgEl(icons.flag), 'Naar je activiteiten'),
      ));
      return;
    }

    /* --- totalen --- */
    const t = stats.totals;
    const stat = (v: Node | string, k: string) => el('div', { class: 'stat-block' },
      el('div', { class: 'v' }, v), el('div', { class: 'k' }, k));
    root.append(el('div', { class: 'stat-grid' },
      stat(String(t.count), 'Activiteiten'),
      stat(fmtKm(t.distanceM), 'Afstand'),
      stat(el('span', {}, svgEl(icons.up), fmtM(t.ascentM)), 'Hoogtemeters'),
      stat(fmtDur(t.movingS), 'Uren onderweg'),
    ));

    /* --- per sport --- */
    root.append(el('h2', { class: 'stats-section-title' }, 'Per sport'));
    const sportCards = el('div', { class: 'sport-cards' });
    for (const s of SPORT_ORDER) {
      const ps = stats.perSport[s];
      const row = (lbl: string, val: string) => el('div', { class: 'sc-row' },
        el('span', { class: 'lbl' }, lbl), el('span', { class: 'val' }, val));
      sportCards.append(el('div', { class: `sport-card${ps.count === 0 ? ' dim' : ''}` },
        el('div', { class: 'sc-head' },
          el('span', { class: 'sc-icon', style: `background:${SPORT_COLORS[s]}` }, svgEl(sportIcon(s))),
          el('span', { class: 'sc-title' }, sportLabel(s)),
        ),
        row('Activiteiten', String(ps.count)),
        row('Afstand', fmtKm(ps.distanceM)),
        row('Hoogtemeters', fmtM(ps.ascentM)),
      ));
    }
    root.append(sportCards);

    /* --- maandgrafiek --- */
    root.append(el('h2', { class: 'stats-section-title' }, 'Deze 12 maanden'));
    root.append(el('div', { class: 'card chart-card' },
      el('div', { class: 'chart-head' },
        el('div', { class: 'chart-legend' },
          ...SPORT_ORDER.map((s) => el('span', { class: 'lg' },
            el('span', { class: 'sw', style: `background:${SPORT_COLORS[s]}` }), sportLabel(s))),
        ),
        el('span', { style: 'color:var(--muted);font-size:.82rem' }, 'kilometers per maand'),
      ),
      buildChart(stats.monthly),
    ));

    /* --- records --- */
    const recCards = el('div', { class: 'record-cards' });
    if (stats.records.longest)
      recCards.append(recordCard('Langste tocht', stats.records.longest, fmtKm(stats.records.longest.distanceM), icons.route));
    if (stats.records.mostClimb)
      recCards.append(recordCard('Meeste hoogtemeters', stats.records.mostClimb, fmtM(stats.records.mostClimb.ascentM), icons.mountain));
    if (recCards.childElementCount > 0) {
      root.append(el('h2', { class: 'stats-section-title' }, 'Records'));
      root.append(recCards);
    }
  }

  function recordCard(kind: string, act: ActivitySummary, value: string, icon: string): HTMLElement {
    return el('div', { class: 'record-card', onclick: () => navigate(`/activity/${act.id}`) },
      el('span', { class: 'rc-ico' }, svgEl(icon)),
      el('div', { style: 'min-width:0' },
        el('div', { class: 'rc-k' }, kind),
        el('div', { class: 'rc-v' }, value),
        el('div', { class: 'rc-name', title: act.name }, act.name),
      ),
    );
  }
}

/* ---------- hand-gerolde SVG-staafgrafiek (gestapeld per sport) ---------- */

function buildChart(monthly: StatsResponse['monthly']): HTMLElement {
  const wrap = el('div', { class: 'chart-wrap' });
  const kmOf = (m: StatsResponse['monthly'][number]) => ({
    wandelen: m.wandelen / 1000, fietsen: m.fietsen / 1000, mtb: m.mtb / 1000,
  });
  const totals = monthly.map((m) => (m.wandelen + m.fietsen + m.mtb) / 1000);
  const maxKm = Math.max(0, ...totals);

  if (maxKm <= 0) {
    wrap.append(el('div', { class: 'empty', style: 'padding:2rem 1rem;border:none;margin:0' },
      svgEl(icons.stats),
      el('p', { style: 'margin:0' }, 'Nog geen afstand in de afgelopen 12 maanden.')));
    return wrap;
  }

  const step = niceStep(maxKm);
  const niceMax = Math.ceil(maxKm / step) * step;
  const dec = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  const kmAxis = (v: number) => (dec === 0 ? String(Math.round(v)) : v.toFixed(dec).replace('.', ','));
  const kmTitle = (v: number) => v.toFixed(1).replace('.', ',') + ' km';

  const W = 720, H = 250, padL = 40, padR = 12, padT = 12, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = monthly.length;
  const slot = plotW / n;
  const barW = Math.min(slot * 0.6, 42);
  const baseY = padT + plotH;
  const y = (v: number) => padT + plotH - (v / niceMax) * plotH;

  let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Afgelegde kilometers per maand">`;

  for (let v = 0; v <= niceMax + 1e-9; v += step) {
    const yy = y(v).toFixed(1);
    svg += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="#e3dccc" stroke-width="1"/>`;
    svg += `<text x="${padL - 6}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end" font-size="10.5" fill="#7d7a6c">${kmAxis(v)}</text>`;
  }

  for (let i = 0; i < n; i++) {
    const m = monthly[i];
    const km = kmOf(m);
    const x = padL + slot * i + (slot - barW) / 2;
    const moIdx = Number(m.month.slice(5, 7)) - 1;
    const monLabel = `${SHORT_MONTHS[moIdx]} ${m.month.slice(0, 4)}`;
    let top = baseY;
    for (const s of SPORT_ORDER) {
      const val = km[s];
      if (val <= 0) continue;
      const h = (val / niceMax) * plotH;
      const ry = top - h;
      svg += `<rect class="bar" x="${x.toFixed(1)}" y="${ry.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${SPORT_COLORS[s]}" rx="2">` +
        `<title>${monLabel} · ${sportLabel(s)}: ${kmTitle(val)}</title></rect>`;
      top = ry;
    }
    svg += `<text x="${(x + barW / 2).toFixed(1)}" y="${(baseY + 15).toFixed(1)}" text-anchor="middle" font-size="10.5" fill="#7d7a6c">${SHORT_MONTHS[moIdx]}</text>`;
  }
  svg += `</svg>`;
  wrap.innerHTML = svg; // alleen eigen SVG met getallen en maandlabels — geen gebruikersdata
  return wrap;
}

function niceStep(range: number): number {
  const raw = range / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (raw <= m * pow) return m * pow;
  return 10 * pow;
}
