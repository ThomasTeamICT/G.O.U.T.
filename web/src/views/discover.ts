// Ontdek — openbare routebibliotheek. Tweeluik: zijpaneel met resultaten +
// zoekwerk links, kaart met previews rechts. Tabs: 'In dit gebied' | 'Top 10'.

import './discover.css';
import L from 'leaflet';
import { api, ApiError } from '../api';
import { navigate } from '../router';
import { createMap } from '../lib/map';
import {
  el, svgEl, icons, toast, debounce,
  fmtKm, fmtM, fmtDur, difficultyBadge, svgMinimap, sportIcon, SPORTS,
} from '../ui';
import type { RouteSummary, Sport } from '../types';

interface GeoResult { name: string; lat: number; lon: number }
type Tab = 'area' | 'top';

const AREA_EMPTY =
  'Geen openbare routes in dit gebied. Zoom uit of probeer een andere plek — of deel zelf de eerste!';
const TOP_EMPTY =
  'Er zijn nog geen openbare routes gedeeld. Wees de eerste en deel jouw favoriete route!';

export function discoverView(container: HTMLElement): () => void {
  const routeColor =
    getComputedStyle(document.documentElement).getPropertyValue('--route').trim() || '#3557e0';

  // --- toestand ---
  let tab: Tab = 'area';
  let sport: Sport | null = null;
  let ready = false;         // pas na eerste zoekactie op moveend reageren
  let suppressMove = false;  // eigen (programmatische) kaartbewegingen negeren
  const polyById = new Map<number, L.Polyline>();

  // --- paneel-DOM ---
  const searchInput = el('input', {
    class: 'input input-search', type: 'text',
    placeholder: 'Zoek een plaats…', autocomplete: 'off',
  }) as HTMLInputElement;
  const dropdown = el('div', { class: 'discover-dropdown', hidden: true });
  const searchWrap = el('div', { class: 'discover-search-wrap' }, searchInput, dropdown);

  const filters = el('div', { class: 'discover-filters' });
  const tabAreaBtn = el('button', {}, 'In dit gebied');
  const tabTopBtn = el('button', {}, 'Top 10');
  const tabs = el('div', { class: 'tabs' }, tabAreaBtn, tabTopBtn);

  const resultsEl = el('div', { class: 'discover-results' });

  const panel = el('aside', { class: 'discover-panel' },
    el('div', { class: 'discover-head' },
      el('h2', {}, 'Ontdek routes'),
      searchWrap,
      filters,
      tabs,
    ),
    resultsEl,
  );

  // --- kaart-DOM ---
  const mapHolder = el('div', { class: 'map-holder' });
  const main = el('main', { class: 'page-wide discover' }, panel, mapHolder);
  container.append(main);

  const map = createMap(mapHolder);
  const previewLayer = L.layerGroup().addTo(map);

  const searchHereBtn = el('button', {
    class: 'btn btn-primary discover-search-here', hidden: true,
    onclick: () => runSearch({ fit: false }),
  }, svgEl(icons.search), 'In dit gebied zoeken') as HTMLButtonElement;
  mapHolder.append(searchHereBtn);

  const hideSearchHere = () => { searchHereBtn.hidden = true; };

  map.on('moveend', () => {
    if (!ready) return;
    if (suppressMove) { suppressMove = false; return; }
    if (tab === 'area') searchHereBtn.hidden = false;
  });

  // --- sport-filterchips ---
  const chipDefs: { key: Sport | null; label: string }[] = [
    { key: null, label: 'Alle' },
    ...SPORTS.map((s) => ({ key: s.key as Sport | null, label: s.label })),
  ];
  const chipEls = new Map<Sport | null, HTMLElement>();
  for (const def of chipDefs) {
    const chip = el('button', {
      class: 'chip', onclick: () => {
        if (sport === def.key) return;
        sport = def.key;
        updateChips();
        refresh();
      },
    }, def.key ? svgEl(sportIcon(def.key)) : null, def.label);
    chipEls.set(def.key, chip);
    filters.append(chip);
  }
  function updateChips() {
    for (const [key, elm] of chipEls) elm.classList.toggle('active', key === sport);
  }
  updateChips();

  // --- tabs ---
  function updateTabs() {
    tabAreaBtn.classList.toggle('active', tab === 'area');
    tabTopBtn.classList.toggle('active', tab === 'top');
  }
  tabAreaBtn.addEventListener('click', () => {
    if (tab === 'area') return;
    tab = 'area'; updateTabs(); hideSearchHere(); runSearch({ fit: false });
  });
  tabTopBtn.addEventListener('click', () => {
    if (tab === 'top') return;
    tab = 'top'; updateTabs(); hideSearchHere(); loadTop();
  });
  updateTabs();

  function refresh() {
    if (tab === 'top') loadTop();
    else runSearch({ fit: false });
  }

  // --- kaart-previews ---
  function drawPreviews(routes: RouteSummary[]) {
    previewLayer.clearLayers();
    polyById.clear();
    for (const r of routes) {
      if (!r.preview || r.preview.length < 2) continue;
      const latlngs = r.preview.map(([lon, lat]) => [lat, lon] as [number, number]);
      const line = L.polyline(latlngs, { color: routeColor, weight: 2.5, opacity: 0.55 });
      line.on('click', () => navigate('/route/' + r.id));
      line.on('mouseover', () => highlight(r.id, true));
      line.on('mouseout', () => highlight(r.id, false));
      line.addTo(previewLayer);
      polyById.set(r.id, line);
    }
  }

  function highlight(id: number, on: boolean) {
    const line = polyById.get(id);
    if (!line) return;
    if (on) { line.setStyle({ weight: 5, opacity: 1 }); line.bringToFront(); }
    else line.setStyle({ weight: 2.5, opacity: 0.55 });
  }

  function fitToResults(routes: RouteSummary[]) {
    const pts: [number, number][] = [];
    for (const r of routes) for (const [lon, lat] of r.preview || []) pts.push([lat, lon]);
    if (!pts.length) return;
    suppressMove = true;
    map.fitBounds(L.latLngBounds(pts).pad(0.15));
  }

  // --- resultaatweergave ---
  function showSpinner() {
    resultsEl.replaceChildren(el('div', { class: 'spinner' }));
  }

  function renderResults(routes: RouteSummary[], opts: { ranked: boolean; emptyMsg: string }) {
    resultsEl.replaceChildren();
    if (!routes.length) {
      resultsEl.append(
        el('div', { class: 'empty' }, svgEl(icons.compass), el('p', {}, opts.emptyMsg)),
      );
      return;
    }
    routes.forEach((r, i) => resultsEl.append(renderCard(r, opts.ranked ? i + 1 : undefined)));
  }

  function renderError(msg: string) {
    resultsEl.replaceChildren(el('div', { class: 'discover-error' }, msg));
  }

  function ownerText(r: RouteSummary): string {
    let t = `door ${r.ownerName ?? 'onbekend'}`;
    if (r.region) t += ` · ${r.region}`;
    return t;
  }

  function renderCard(r: RouteSummary, rank?: number): HTMLElement {
    const likeBtn = el('button', {
      class: 'dc-like' + (r.liked ? ' liked' : ''),
      title: r.liked ? 'Niet meer leuk vinden' : 'Vind ik leuk',
      onclick: (e: MouseEvent) => { e.stopPropagation(); toggleLike(r, likeBtn); },
    },
      svgEl(r.liked ? icons.heartFill : icons.heart),
      el('span', {}, String(r.likes)),
    ) as HTMLButtonElement;

    return el('div', {
      class: 'discover-card',
      onclick: () => navigate('/route/' + r.id),
      onmouseenter: () => highlight(r.id, true),
      onmouseleave: () => highlight(r.id, false),
    },
      rank !== undefined
        ? el('div', { class: 'dc-rank' + (rank <= 3 ? ' top3' : '') }, String(rank))
        : null,
      el('div', { class: 'dc-thumb' }, svgMinimap(r.preview, routeColor)),
      el('div', { class: 'dc-body' },
        el('div', { class: 'dc-title' },
          el('span', { class: 'dc-name' }, r.name),
          difficultyBadge(r.difficulty),
        ),
        el('div', { class: 'statline' },
          el('span', {}, fmtDur(r.durationS)),
          el('span', { class: 'sep' }, '·'),
          el('span', {}, fmtKm(r.distanceM)),
          el('span', { class: 'sep' }, '·'),
          el('span', { class: 'dc-asc' }, svgEl(icons.up), fmtM(r.ascentM)),
        ),
        el('div', { class: 'dc-owner' }, ownerText(r)),
      ),
      likeBtn,
    );
  }

  async function toggleLike(r: RouteSummary, btn: HTMLButtonElement) {
    try {
      const res = r.liked
        ? await api.del<{ likes: number; liked: boolean }>(`/api/routes/${r.id}/like`)
        : await api.post<{ likes: number; liked: boolean }>(`/api/routes/${r.id}/like`);
      r.likes = res.likes;
      r.liked = res.liked;
      btn.className = 'dc-like' + (r.liked ? ' liked' : '');
      btn.title = r.liked ? 'Niet meer leuk vinden' : 'Vind ik leuk';
      btn.replaceChildren(svgEl(r.liked ? icons.heartFill : icons.heart), el('span', {}, String(r.likes)));
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Kon je waardering niet opslaan.', 'error');
    }
  }

  // --- zoekacties ---
  async function runSearch({ fit }: { fit: boolean }) {
    showSpinner();
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
      .map((n) => n.toFixed(6)).join(',');
    const params = new URLSearchParams({ bbox });
    if (sport) params.set('sport', sport);
    try {
      const { routes } = await api.get<{ routes: RouteSummary[] }>(`/api/discover?${params}`);
      drawPreviews(routes);
      renderResults(routes, { ranked: false, emptyMsg: AREA_EMPTY });
      if (fit) fitToResults(routes);
    } catch (e) {
      renderError('Kon routes niet laden. Probeer het opnieuw.');
      toast(e instanceof ApiError ? e.message : 'Kon routes niet laden.', 'error');
    } finally {
      hideSearchHere();
    }
  }

  async function loadTop() {
    showSpinner();
    const params = new URLSearchParams();
    if (sport) params.set('sport', sport);
    const qs = params.toString();
    try {
      const { routes } = await api.get<{ routes: RouteSummary[] }>(
        `/api/discover/top${qs ? '?' + qs : ''}`,
      );
      drawPreviews(routes);
      renderResults(routes, { ranked: true, emptyMsg: TOP_EMPTY });
      fitToResults(routes);
    } catch (e) {
      renderError('Kon de top 10 niet laden. Probeer het opnieuw.');
      toast(e instanceof ApiError ? e.message : 'Kon de top 10 niet laden.', 'error');
    }
  }

  // --- plaatsnaam-zoeker (geocode) ---
  function closeDropdown() { dropdown.hidden = true; dropdown.replaceChildren(); }

  function showDropdown(results: GeoResult[]) {
    dropdown.replaceChildren();
    if (!results.length) {
      dropdown.append(el('div', { class: 'discover-drop-empty' }, 'Geen plaatsen gevonden'));
    } else {
      for (const g of results) {
        dropdown.append(el('button', {
          type: 'button', class: 'discover-drop-item',
          onclick: () => selectPlace(g),
        }, svgEl(icons.locate), el('span', {}, g.name)));
      }
    }
    dropdown.hidden = false;
  }

  const onSearchInput = debounce(async () => {
    const q = searchInput.value.trim();
    if (q.length < 2) { closeDropdown(); return; }
    try {
      const { results } = await api.get<{ results: GeoResult[] }>(
        `/api/geocode?q=${encodeURIComponent(q)}`,
      );
      showDropdown(results);
    } catch {
      closeDropdown();
    }
  }, 300);
  searchInput.addEventListener('input', onSearchInput);
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDropdown(); });

  function selectPlace(g: GeoResult) {
    searchInput.value = g.name;
    closeDropdown();
    if (tab !== 'area') { tab = 'area'; updateTabs(); }
    hideSearchHere();
    suppressMove = true;
    map.setView([g.lat, g.lon], 12, { animate: false });
    runSearch({ fit: true });
  }

  const onOutside = (e: MouseEvent) => {
    if (!searchWrap.contains(e.target as Node)) closeDropdown();
  };
  document.addEventListener('mousedown', onOutside);

  // --- opstart: kaart op maat + eerste zoekactie op huidig gebied ---
  setTimeout(async () => {
    map.invalidateSize();
    await runSearch({ fit: false });
    ready = true;
  }, 0);

  // --- opruimen ---
  return () => {
    document.removeEventListener('mousedown', onOutside);
    map.remove();
  };
}
