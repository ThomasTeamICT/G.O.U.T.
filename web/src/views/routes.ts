// 'Mijn routes' — overzicht met zoeken, filteren, sorteren en GPX-import.

import './routes.css';
import { api, ApiError } from '../api';
import {
  el, svgEl, icons, toast, modal, confirmDialog, debounce,
  fmtKm, fmtM, fmtDur, fmtDate,
  difficultyBadge, sportIcon, svgMinimap, SPORTS,
} from '../ui';
import { navigate } from '../router';
import { parseGpx } from '../lib/gpx';
import type { ParsedGpx } from '../lib/gpx';
import type { RouteSummary, Sport } from '../types';
import { openShareModal } from './route';

type SortKey = 'new' | 'name' | 'distance';

export function routesView(container: HTMLElement, _params: Record<string, string>, query: URLSearchParams) {
  let all: RouteSummary[] = [];
  let sport: '' | Sport = '';
  let sort: SortKey = 'new';
  let q = '';

  // Gefaseerd renderen + tonen/verbergen bij zoeken (geen herbouw per toets).
  let cards: { r: RouteSummary; node: HTMLElement }[] = [];
  let rafId = 0;
  let destroyed = false;

  const grid = el('div', { class: 'grid-list' });
  const noResultsP = el('p', {});
  const noResults = el('div', { class: 'empty' }, svgEl(icons.search), noResultsP);
  noResults.style.display = 'none';

  const root = el('main', { class: 'page' });
  container.append(root);

  const sub = el('p', { class: 'page-sub' }, 'Laden…');
  const listHolder = el('div', {});

  const searchInput = el('input', {
    class: 'input input-search', type: 'search', placeholder: 'Zoeken op routenaam',
  });
  searchInput.addEventListener('input', debounce(() => { q = searchInput.value.trim(); applyFilter(); }, 180));

  const chipbar = el('div', { class: 'filterbar' });
  const sortSelect = el('select', { class: 'input', style: 'width:auto;margin-left:auto' },
    el('option', { value: 'new' }, 'Nieuwste eerst'),
    el('option', { value: 'name' }, 'Naam'),
    el('option', { value: 'distance' }, 'Afstand'),
  );
  sortSelect.addEventListener('change', () => { sort = sortSelect.value as SortKey; load(); });

  function renderChips() {
    chipbar.innerHTML = '';
    const opts: { key: '' | Sport; label: string }[] = [
      { key: '', label: 'Alle sporten' },
      { key: 'wandelen', label: 'Wandelen' },
      { key: 'fietsen', label: 'Fietsen' },
      { key: 'mtb', label: 'MTB' },
    ];
    for (const o of opts) {
      const chip = el('button', { class: `chip${sport === o.key ? ' active' : ''}`, onclick: () => {
        sport = o.key; renderChips(); load();
      } }, o.key ? svgEl(sportIcon(o.key as Sport)) : null, o.label);
      chipbar.append(chip);
    }
    chipbar.append(sortSelect);
  }

  root.append(
    el('div', { class: 'page-head' },
      el('h1', {}, 'Mijn routes'),
      el('div', { class: 'head-actions' },
        el('button', { class: 'btn btn-primary', onclick: () => openImportModal() },
          svgEl(icons.upload), el('span', { class: 'lbl' }, 'Importeer een GPX-bestand')),
        el('button', { class: 'btn btn-green', onclick: () => navigate('/plan') },
          svgEl(icons.plus), el('span', { class: 'lbl' }, 'Route plannen')),
      ),
    ),
    sub,
    searchInput,
    chipbar,
    listHolder,
  );
  renderChips();

  function card(r: RouteSummary): HTMLElement {
    const thumb = el('div', { class: 'thumb' },
      svgMinimap(r.preview),
      el('span', { class: 'sporticon' }, svgEl(sportIcon(r.sport))),
    );
    const statline = el('div', { class: 'statline' },
      el('span', {}, fmtDur(r.durationS)),
      el('span', { class: 'sep' }, '·'),
      el('span', {}, fmtKm(r.distanceM)),
      el('span', { class: 'sep' }, '·'),
      el('span', {}, svgEl(icons.up), fmtM(r.ascentM)),
      el('span', { class: 'sep' }, '·'),
      el('span', {}, svgEl(icons.down), fmtM(r.descentM)),
    );
    const meta = el('div', { class: 'rc-meta' },
      el('span', {}, fmtDate(r.createdAt)),
      r.region ? el('span', {}, '· ' + r.region) : null,
      r.source === 'geimporteerd' ? el('span', { class: 'badge badge-neutral' }, 'Geïmporteerd') : null,
      r.visibility === 'public' ? el('span', { class: 'badge badge-public' }, svgEl(icons.globe), 'Openbaar') : null,
    );

    const dl = el('a', { class: 'btn btn-icon', href: `/api/routes/${r.id}/gpx`, title: 'GPX downloaden',
      onclick: (e: MouseEvent) => e.stopPropagation() }, svgEl(icons.download));
    const share = el('button', { class: 'btn btn-icon', title: 'Delen', onclick: (e: MouseEvent) => {
      e.stopPropagation();
      openShareModal(r, { onVisibilityChange: () => refreshCard(r) });
    } }, svgEl(icons.share));
    const del = el('button', { class: 'btn btn-icon', title: 'Verwijderen', onclick: async (e: MouseEvent) => {
      e.stopPropagation();
      const ok = await confirmDialog('Route verwijderen?', `Wil je "${r.name}" definitief verwijderen?`);
      if (!ok) return;
      try {
        await api.del(`/api/routes/${r.id}`);
        all = all.filter((x) => x.id !== r.id);
        removeCard(r.id);
        toast('Route verwijderd.');
      } catch (ex) {
        toast((ex as ApiError)?.message || 'Verwijderen mislukt.', 'error');
      }
    } }, svgEl(icons.trash));

    return el('div', { class: 'route-card', onclick: () => navigate(`/route/${r.id}`) },
      thumb,
      el('div', {},
        el('div', { class: 'card-badges' }, difficultyBadge(r.difficulty)),
        el('h3', {}, r.name),
        statline,
        meta,
      ),
      el('div', { class: 'actions' }, dl, share, del),
    );
  }

  function matchesQ(r: RouteSummary): boolean {
    return !q || r.name.toLowerCase().includes(q.toLowerCase());
  }

  // Zoekbalk: toon/verberg bestaande kaartjes (geen herbouw van de grid).
  function applyFilter() {
    for (const c of cards) c.node.style.display = matchesQ(c.r) ? '' : 'none';
    updateCount();
  }

  function updateCount() {
    let n = 0;
    for (const c of cards) if (matchesQ(c.r)) n++;
    sub.textContent = `${n} ${n === 1 ? 'route' : 'routes'}`;
    const none = all.length > 0 && n === 0;
    noResults.style.display = none ? '' : 'none';
    if (none) noResultsP.textContent = `Geen routes gevonden voor "${q}".`;
  }

  // Eén kaartje weghalen na verwijderen (val terug op de lege staat bij 0 routes).
  function removeCard(id: number) {
    const i = cards.findIndex((c) => c.r.id === id);
    if (i >= 0) { cards[i].node.remove(); cards.splice(i, 1); }
    if (all.length === 0) rebuildList();
    else updateCount();
  }

  // Eén kaartje vervangen (bv. na een zichtbaarheidswijziging via de deelmodal).
  function refreshCard(r: RouteSummary) {
    const i = cards.findIndex((c) => c.r.id === r.id);
    if (i < 0) return;
    const node = card(r);
    if (!matchesQ(r)) node.style.display = 'none';
    cards[i].node.replaceWith(node);
    cards[i] = { r, node };
  }

  function cancelRaf() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  }

  // Herbouw de grid bij NIEUWE data. Gefaseerd: eerste lichting meteen, de rest
  // in batches per requestAnimationFrame zodat de main thread niet lang blokkeert.
  function rebuildList() {
    cancelRaf();
    cards = [];
    grid.innerHTML = '';
    listHolder.innerHTML = '';

    if (all.length === 0) {
      sub.textContent = '0 routes';
      listHolder.append(el('div', { class: 'empty' },
        svgEl(icons.route),
        el('p', {}, 'Nog geen routes. Plan er eentje of importeer een GPX-bestand.'),
        el('div', { class: 'head-actions', style: 'justify-content:center;display:flex;gap:.5rem;flex-wrap:wrap' },
          el('button', { class: 'btn btn-green', onclick: () => navigate('/plan') }, svgEl(icons.plus), 'Route plannen'),
          el('button', { class: 'btn btn-primary', onclick: () => openImportModal() }, svgEl(icons.upload), 'Importeer een GPX-bestand'),
        ),
      ));
      return;
    }

    listHolder.append(grid, noResults);

    const FIRST = 40; // eerste lichting meteen (blijft < 50 ms long-task-drempel)
    const FRAME_BUDGET = 8; // ms — voeg per frame kaartjes toe tot dit budget op is
    const total = all.length;

    const addCard = (r: RouteSummary): HTMLElement => {
      const node = card(r);
      if (!matchesQ(r)) node.style.display = 'none';
      cards.push({ r, node });
      return node;
    };

    const firstFrag = document.createDocumentFragment();
    for (let i = 0; i < Math.min(FIRST, total); i++) firstFrag.append(addCard(all[i]));
    grid.append(firstFrag);
    updateCount();

    if (total > FIRST) {
      let i = FIRST;
      const step = () => {
        rafId = 0;
        if (destroyed) return; // view opgeruimd: geen batches meer toevoegen
        const start = performance.now();
        const frag = document.createDocumentFragment();
        // Tijdgebaseerd i.p.v. een vaste batchgrootte: zo blijft elk frame onder
        // het budget, ongeacht hoe zwaar/licht een kaartje rendert (Fix 11).
        while (i < total && performance.now() - start < FRAME_BUDGET) frag.append(addCard(all[i++]));
        grid.append(frag);
        updateCount();
        if (i < total) rafId = requestAnimationFrame(step);
      };
      rafId = requestAnimationFrame(step);
    }
  }

  async function load() {
    cancelRaf();
    listHolder.innerHTML = '';
    listHolder.append(el('div', { class: 'spinner' }));
    try {
      const params = new URLSearchParams();
      if (sport) params.set('sport', sport);
      params.set('sort', sort);
      const r = await api.get<{ routes: RouteSummary[] }>(`/api/routes?${params.toString()}`);
      all = r.routes;
      rebuildList();
    } catch (e) {
      listHolder.innerHTML = '';
      listHolder.append(el('div', { class: 'empty' },
        svgEl(icons.route),
        el('p', {}, (e as ApiError)?.message || 'Kon je routes niet laden.'),
      ));
      sub.textContent = '';
    }
  }

  /* ---------- GPX-import ---------- */

  function openImportModal() {
    const body = el('div', {});
    const close = modal(body);
    let parsed: ParsedGpx | null = null;
    let gpxText = '';
    let fileName = '';

    const fileInput = el('input', {
      type: 'file', accept: '.gpx,application/gpx+xml,application/xml',
      style: 'display:none',
    });
    const drop = el('label', { class: 'import-drop' },
      svgEl(icons.upload),
      el('div', {}, el('b', {}, 'Kies een GPX-bestand'), ' of sleep het hierheen'),
      fileInput,
    );

    async function handleFile(f: File | undefined | null) {
      if (!f) return;
      fileName = f.name.replace(/\.gpx$/i, '');
      try {
        gpxText = await f.text();
        parsed = parseGpx(gpxText);
        renderForm();
      } catch (e) {
        toast((e as Error)?.message || 'Kon dit GPX-bestand niet lezen.', 'error');
      }
    }

    fileInput.addEventListener('change', () => handleFile(fileInput.files?.[0]));
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.style.borderColor = 'var(--green)';
      drop.style.background = 'var(--surface-2)';
    });
    drop.addEventListener('dragleave', () => {
      drop.style.borderColor = '';
      drop.style.background = '';
    });
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.style.borderColor = '';
      drop.style.background = '';
      handleFile(e.dataTransfer?.files?.[0]);
    });

    function renderStart() {
      body.innerHTML = '';
      body.append(
        el('h2', {}, 'GPX importeren'),
        el('p', { class: 'import-hint' }, 'Laad een route of activiteit uit een GPX-bestand van bijvoorbeeld Komoot, Strava of je gps-toestel.'),
        drop,
        el('div', { class: 'modal-actions' }, el('button', { class: 'btn', onclick: () => close() }, 'Annuleren')),
      );
    }

    function renderForm() {
      if (!parsed) return;
      body.innerHTML = '';
      const nameInput = el('input', { class: 'input', type: 'text', value: parsed.name || fileName || 'Geïmporteerde route' });
      const sportSel = el('select', { class: 'input' },
        ...SPORTS.map((s) => el('option', { value: s.key }, s.label)));

      const asRoute = el('input', { type: 'radio', name: 'kind', checked: true });
      const asAct = el('input', { type: 'radio', name: 'kind' });
      const actDisabled = !parsed.hasTime;
      if (actDisabled) asAct.disabled = true;

      const routeOpt = el('label', { class: 'radio-option active' },
        asRoute,
        el('div', {}, el('div', { class: 'ro-label' }, 'Als route'),
          el('div', { class: 'ro-hint' }, 'Om te plannen, delen en later te volgen.')));
      const actOpt = el('label', { class: `radio-option${actDisabled ? ' disabled' : ''}` },
        asAct,
        el('div', {}, el('div', { class: 'ro-label' }, 'Als activiteit'),
          el('div', { class: 'ro-hint' }, actDisabled ? 'Niet mogelijk: geen tijdsdata in dit bestand.' : 'Voegt de rit/wandeling toe aan je logboek.')));

      const syncOpt = () => {
        routeOpt.classList.toggle('active', asRoute.checked);
        actOpt.classList.toggle('active', asAct.checked && !actDisabled);
      };
      asRoute.addEventListener('change', syncOpt);
      asAct.addEventListener('change', syncOpt);

      const saveBtn = el('button', { class: 'btn btn-primary' }, svgEl(icons.save), 'Importeren');
      saveBtn.addEventListener('click', async () => {
        const name = nameInput.value.trim();
        if (!name) { toast('Geef de route een naam.', 'error'); return; }
        const chosenSport = sportSel.value as Sport;
        saveBtn.disabled = true;
        const region = await revgeocode(parsed!.track[0]);
        try {
          if (asAct.checked && !actDisabled) {
            const r = await api.post<{ activity: { id: number } }>('/api/activities', {
              name, sport: chosenSport, track: parsed!.track, gpx: gpxText, region,
            });
            toast('Activiteit geïmporteerd.');
            close();
            navigate(`/activity/${r.activity.id}`);
          } else {
            const r = await api.post<{ route: { id: number } }>('/api/routes/import', {
              name, sport: chosenSport, track: parsed!.track, gpx: gpxText, region,
            });
            toast('Route geïmporteerd.');
            close();
            navigate(`/route/${r.route.id}`);
          }
        } catch (e) {
          saveBtn.disabled = false;
          toast((e as ApiError)?.message || 'Importeren mislukt.', 'error');
        }
      });

      body.append(
        el('h2', {}, 'GPX importeren'),
        el('label', { class: 'field' }, el('span', {}, 'Naam'), nameInput),
        el('label', { class: 'field' }, el('span', {}, 'Sport'), sportSel),
        el('div', { style: 'margin:.4rem 0 .2rem;font-weight:600;font-size:.85rem;color:var(--ink-soft)' }, 'Importeren als'),
        routeOpt,
        actOpt,
        el('div', { class: 'modal-actions' },
          el('button', { class: 'btn', onclick: () => close() }, 'Annuleren'),
          saveBtn,
        ),
      );
    }

    renderStart();
  }

  async function revgeocode(p: [number, number, (number | undefined)?, (number | undefined)?]): Promise<string | undefined> {
    try {
      const r = await api.get<{ region: string | null }>(`/api/revgeocode?lat=${p[1]}&lon=${p[0]}`);
      return r.region || undefined;
    } catch {
      return undefined;
    }
  }

  load();
  if (query.get('import') === '1') {
    history.replaceState(null, '', '#/routes');
    openImportModal();
  }

  return () => { destroyed = true; cancelRaf(); };
}
