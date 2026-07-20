// Ontdek — openbare routebibliotheek. Tweeluik: zijpaneel met resultaten +
// zoekwerk links, kaart met previews rechts. Tabs: 'In dit gebied' | 'Top 10'.
// Onder de community-resultaten: 'Aanbevolen bewegwijzerd (OpenStreetMap)' —
// live de beste bewegwijzerde OSM-routes voor het gezochte gebied.

import './discover.css';
import L from 'leaflet';
import { api, ApiError } from '../api';
import { navigate } from '../router';
import { createMap, drawTrack, fitToTrack } from '../lib/map';
import { trackDistance } from '../lib/geo';
import { downloadGpx } from '../lib/gpx';
import {
  el, svgEl, icons, toast, debounce, confirmDialog,
  fmtKm, fmtM, fmtDur, difficultyBadge, svgMinimap, sportIcon, sportLabel, SPORTS,
} from '../ui';
import type { RouteSummary, RouteFull, Sport, Highlight, TrackPoint } from '../types';

interface GeoResult { name: string; lat: number; lon: number }
type Tab = 'area' | 'top';

// Aanbevolen bewegwijzerde route (grondstof uit OpenStreetMap).
interface RecItem { id: number; name: string | null; ref: string | null; distanceKm: number | null; vanCentrumKm: number | null; sport: Sport }
interface AanbevolenResponse { aanbevolen: { wandelen: RecItem[]; mtb: RecItem[] } }
interface KnownRoute { name: string; ref: string | null; track: TrackPoint[]; note?: string }

const AREA_EMPTY =
  'Geen openbare routes in dit gebied. Zoom uit of probeer een andere plek — of deel zelf de eerste!';
const TOP_EMPTY =
  'Er zijn nog geen openbare routes gedeeld. Wees de eerste en deel jouw favoriete route!';

// Paneeltekst boven de resultatenlijst, afhankelijk van de tab.
const AREA_SUB = 'De best gewaardeerde routes in dit gebied';
const TOP_SUB = 'De 10 best gewaardeerde routes wereldwijd';

// Vaste POI-categorieën → NL-labels voor markers en popups.
const CATEGORY_LABELS: Record<string, string> = {
  uitzicht: 'Uitzicht',
  rustpunt: 'Rustpunt',
  horeca: 'Café/horeca',
  bezienswaardig: 'Bezienswaardig',
  trail: 'Toffe trail',
};
function categoryLabel(cat: string | null): string | null {
  return cat ? (CATEGORY_LABELS[cat] ?? null) : null;
}

const HL_EMPTY_HINT =
  'Nog geen highlights in dit gebied. Markeer er zelf één via een route → Highlight markeren.';

export function discoverView(container: HTMLElement): () => void {
  const routeColor =
    getComputedStyle(document.documentElement).getPropertyValue('--route').trim() || '#3557e0';

  // --- toestand ---
  let tab: Tab = 'area';
  let sport: Sport | null = null;
  let ready = false;         // pas na eerste zoekactie op moveend reageren
  let suppressMove = false;  // eigen (programmatische) kaartbewegingen negeren
  let showHighlights = localStorage.getItem('gout.discoverHighlights') === '1';
  let destroyed = false;     // view verlaten: laat debounced werk niet meer op de kaart komen
  let searchSeq = 0;         // volgnummer om verlate (stale) resultaten te negeren
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

  // Community-resultaten en aanbevolen sectie leven samen in de scrollende lijst.
  const communityEl = el('div', { class: 'discover-community' });
  const aanbevolenEl = el('div', { class: 'discover-aanbevolen' });
  const resultsEl = el('div', { class: 'discover-results' }, communityEl, aanbevolenEl);
  const resultsHint = el('div', { class: 'discover-sub' }, AREA_SUB);

  const panel = el('aside', { class: 'discover-panel' },
    el('div', { class: 'discover-head' },
      el('h2', {}, 'Ontdek routes'),
      searchWrap,
      filters,
      tabs,
    ),
    resultsHint,
    resultsEl,
  );

  // --- kaart-DOM ---
  const mapHolder = el('div', { class: 'map-holder' });
  const main = el('main', { class: 'page-wide discover' }, panel, mapHolder);
  container.append(main);

  const map = createMap(mapHolder);
  const previewLayer = L.layerGroup().addTo(map);
  const highlightLayer = L.layerGroup().addTo(map); // boven de previews
  const reloadHighlights = debounce(() => { if (showHighlights) loadHighlights(); }, 600);

  // Geladen bewegwijzerde route (lijn + zwevend paneel).
  let recLayer: L.LayerGroup | null = null;
  let recPanel: HTMLElement | null = null;

  const searchHereBtn = el('button', {
    class: 'btn btn-primary discover-search-here', hidden: true,
    onclick: () => runSearch({ fit: false }),
  }, svgEl(icons.search), 'In dit gebied zoeken') as HTMLButtonElement;
  mapHolder.append(searchHereBtn);

  const hideSearchHere = () => { searchHereBtn.hidden = true; };

  map.on('moveend', () => {
    if (showHighlights) reloadHighlights();
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

  // --- highlights-toggle ---
  const hlChip = el('button', {
    class: 'chip hl-chip', onclick: () => {
      showHighlights = !showHighlights;
      localStorage.setItem('gout.discoverHighlights', showHighlights ? '1' : '0');
      hlChip.classList.toggle('active', showHighlights);
      if (showHighlights) loadHighlights();
      else clearHighlights();
    },
  }, svgEl(icons.flag), 'Highlights');
  hlChip.classList.toggle('active', showHighlights);
  filters.append(hlChip);

  // --- tabs ---
  function updateTabs() {
    tabAreaBtn.classList.toggle('active', tab === 'area');
    tabTopBtn.classList.toggle('active', tab === 'top');
    resultsHint.textContent = tab === 'top' ? TOP_SUB : AREA_SUB;
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
    if (showHighlights) loadHighlights();
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
    communityEl.replaceChildren(el('div', { class: 'spinner' }));
  }

  function renderResults(routes: RouteSummary[], opts: { ranked: boolean; emptyMsg: string }) {
    communityEl.replaceChildren();
    if (!routes.length) {
      communityEl.append(
        el('div', { class: 'empty' }, svgEl(icons.compass), el('p', {}, opts.emptyMsg),
          el('button', { class: 'btn btn-primary', onclick: () => navigate('/plan') },
            svgEl(icons.plus), 'Route plannen'),
        ),
      );
      return;
    }
    routes.forEach((r, i) => communityEl.append(renderCard(r, opts.ranked ? i + 1 : undefined)));
  }

  function renderError(msg: string) {
    communityEl.replaceChildren(el('div', { class: 'discover-error' }, msg));
  }

  function ownerText(r: RouteSummary): string {
    let t = `door ${r.ownerName ?? 'onbekend'}`;
    if (r.region) t += ` · ${r.region}`;
    return t;
  }

  function renderCard(r: RouteSummary, rank?: number): HTMLElement {
    // Eigen routes kan je niet liken; toon dan enkel het aantal.
    const likeBtn = r.isOwner
      ? el('span', { class: 'dc-like', title: 'Jouw route' },
          svgEl(icons.heart), el('span', {}, String(r.likes))) as unknown as HTMLButtonElement
      : el('button', {
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
          r.curated ? el('span', { class: 'badge badge-aanbevolen' }, 'Aanbevolen') : null,
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

  // --- Aanbevolen bewegwijzerd (OpenStreetMap) ---
  function renderAanbevolen(groups: AanbevolenResponse['aanbevolen']) {
    aanbevolenEl.replaceChildren();
    const items = [...(groups.wandelen ?? []), ...(groups.mtb ?? [])];
    if (!items.length) return; // lege sectie = verbergen
    aanbevolenEl.append(
      el('div', { class: 'discover-aanbevolen-head' },
        el('h3', {}, 'Aanbevolen bewegwijzerd'),
        el('span', { class: 'discover-aanbevolen-src' }, '(OpenStreetMap)'),
      ),
    );
    for (const rec of items) aanbevolenEl.append(renderRecCard(rec));
  }

  function renderRecCard(rec: RecItem): HTMLElement {
    const naam = rec.name || 'Bewegwijzerde route';
    const card = el('div', {
      class: 'rec-card', title: naam,
      onclick: () => loadRec(rec, card),
    },
      el('span', { class: 'rec-sport' }, svgEl(sportIcon(rec.sport))),
      el('div', { class: 'rec-body' },
        el('div', { class: 'rec-title' },
          el('span', { class: 'rec-name' }, naam),
          rec.ref ? el('span', { class: 'badge badge-neutral rec-ref' }, rec.ref) : null,
        ),
        rec.distanceKm != null || rec.vanCentrumKm != null
          ? el('div', { class: 'rec-dist' }, [
              rec.distanceKm != null ? `± ${String(rec.distanceKm).replace('.', ',')} km` : null,
              rec.vanCentrumKm != null ? `op ${String(rec.vanCentrumKm).replace('.', ',')} km` : null,
            ].filter(Boolean).join(' · '))
          : null,
      ),
    );
    return card;
  }

  async function loadAanbevolen(bbox: string, seq: number) {
    const params = new URLSearchParams({ bbox });
      const c = map.getCenter();
      params.set('center', `${c.lng.toFixed(5)},${c.lat.toFixed(5)}`);
    if (sport) params.set('sport', sport);
    try {
      const { aanbevolen } = await api.get<AanbevolenResponse>(`/api/discover/aanbevolen?${params}`);
      if (destroyed || seq !== searchSeq) return;
      renderAanbevolen(aanbevolen);
    } catch {
      // Aanbevolen is aanvullende grondstof: bij een fout de sectie stil verbergen.
      if (seq === searchSeq) aanbevolenEl.replaceChildren();
    }
  }

  // Eén aanbeveling laden: geometrie ophalen, tekenen en paneel tonen.
  async function loadRec(rec: RecItem, card: HTMLElement) {
    if (card.classList.contains('loading')) return;
    card.classList.add('loading');
    const vorigeTitel = card.title;
    card.title = 'Even geduld…';
    const spin = el('span', { class: 'rec-spin' });
    card.append(spin);
    try {
      const params = new URLSearchParams();
      if (rec.sport) params.set('sport', rec.sport);
      const data = await api.get<KnownRoute>(`/api/knownroutes/${rec.id}?${params}`);
      if (destroyed) return;
      showRec(rec, data);
    } catch (e) {
      // 429-boodschap van de server (Overpass vraagt rust) tonen zoals hij is.
      toast(e instanceof ApiError ? e.message : 'Kon de bewegwijzerde route niet laden.', 'error');
    } finally {
      card.classList.remove('loading');
      card.title = vorigeTitel;
      spin.remove();
    }
  }

  function showRec(rec: RecItem, data: KnownRoute) {
    clearRec();
    const track = data.track || [];
    if (track.length < 2) { toast('Deze route heeft geen bruikbare geometrie.', 'error'); return; }
    // Gewone routestijl (met witte casing), opacity .9 uit ROUTE_STYLE.
    recLayer = drawTrack(map, track);
    suppressMove = true;
    fitToTrack(map, track);

    const naam = rec.name || data.name || 'Bewegwijzerde route';
    const dist = trackDistance(track);
    recPanel = el('div', { class: 'rec-panel' },
      el('button', { class: 'btn-icon rec-panel-close', title: 'Sluiten', onclick: clearRec }, svgEl(icons.close)),
      el('div', { class: 'rec-panel-name' }, svgEl(sportIcon(rec.sport)), el('span', {}, naam)),
      el('div', { class: 'rec-panel-dist' }, `${sportLabel(rec.sport)} · ${fmtKm(dist)}`),
      el('div', { class: 'rec-panel-actions' },
        el('button', { class: 'btn btn-primary btn-sm', onclick: () => saveRec(rec, track, naam) },
          svgEl(icons.save), 'Bewaar in Mijn routes'),
        el('button', { class: 'btn btn-ghost btn-sm', onclick: () => downloadGpx(naam, track, rec.sport) },
          svgEl(icons.download), 'GPX'),
      ),
    );
    mapHolder.append(recPanel);
  }

  function clearRec() {
    if (recLayer) { recLayer.remove(); recLayer = null; }
    if (recPanel) { recPanel.remove(); recPanel = null; }
  }

  async function saveRec(rec: RecItem, track: TrackPoint[], naam: string) {
    try {
      const { route } = await api.post<{ route: RouteFull }>('/api/routes', {
        name: naam, sport: rec.sport, track, waypoints: null, region: null,
      });
      toast('Bewaard in Mijn routes.');
      navigate('/route/' + route.id);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Kon de route niet bewaren.', 'error');
    }
  }

  // --- highlights-overlay ---
  function flagIcon(): L.DivIcon {
    return L.divIcon({
      className: '', iconSize: [18, 18], iconAnchor: [9, 9],
      html: `<div class="hl-flag">${icons.flag}</div>`,
    });
  }

  function clearHighlights() { highlightLayer.clearLayers(); }

  // Vlag-marker op een punt; title = categorie-label (indien gekend).
  function flagMarker(h: Highlight, lat: number, lon: number): L.Marker {
    const title = categoryLabel(h.category);
    const marker = L.marker([lat, lon], title ? { icon: flagIcon(), title } : { icon: flagIcon() });
    marker.on('click', () => openHighlightPopup(h, L.latLng(lat, lon)));
    return marker;
  }

  function drawHighlights(list: Highlight[]) {
    highlightLayer.clearLayers();
    for (const h of list) {
      if (!h.track || h.track.length < 1) continue;
      if (h.track.length === 1) {
        // Punt-highlight (POI): enkel een vlag-marker, geen lijn.
        const [lon, lat] = h.track[0];
        flagMarker(h, lat, lon).addTo(highlightLayer);
        continue;
      }
      const latlngs = h.track.map(([lon, lat]) => [lat, lon] as [number, number]);
      const line = L.polyline(latlngs, { color: '#e8590c', weight: 4, opacity: 0.7 });
      line.on('click', (e: L.LeafletMouseEvent) => openHighlightPopup(h, e.latlng));
      line.addTo(highlightLayer);
      const mid = h.track[Math.floor(h.track.length / 2)];
      flagMarker(h, mid[1], mid[0]).addTo(highlightLayer);
    }
  }

  async function loadHighlights() {
    if (destroyed || !showHighlights) return;
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
      .map((n) => n.toFixed(6)).join(',');
    const params = new URLSearchParams({ bbox });
    if (sport) params.set('sport', sport);
    try {
      const { highlights } = await api.get<{ highlights: Highlight[] }>(`/api/highlights?${params}`);
      if (!showHighlights) return;
      drawHighlights(highlights);
      // Lege staat: staat de toggle aan en levert deze laadbeurt 0 highlights op,
      // dan éénmaal per sessie een vriendelijke hint tonen.
      if (highlights.length === 0 && !sessionStorage.getItem('gout.hlEmptyHinted')) {
        sessionStorage.setItem('gout.hlEmptyHinted', '1');
        toast(HL_EMPTY_HINT);
      }
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Kon highlights niet laden.', 'error');
    }
  }

  function hlSportIcon(s: Sport | 'alle'): string {
    return s === 'alle' ? icons.compass : sportIcon(s);
  }
  function hlSportLabel(s: Sport | 'alle'): string {
    return s === 'alle' ? 'Alle sporten' : sportLabel(s);
  }

  function openHighlightPopup(h: Highlight, latlng: L.LatLng) {
    L.popup({ className: 'hl-popup', maxWidth: 260, autoPan: true })
      .setLatLng(latlng)
      .setContent(buildHighlightPopup(h))
      .openOn(map);
  }

  function buildHighlightPopup(h: Highlight): HTMLElement {
    let votes = h.votes;
    let voted = h.voted;

    const box = el('div', { class: 'hl-pop' });
    box.append(el('div', { class: 'hl-pop-name' }, h.name));
    const catLabel = categoryLabel(h.category);
    if (catLabel) box.append(el('div', { class: 'hl-pop-cat' }, catLabel));
    box.append(
      el('div', { class: 'hl-pop-sport' }, svgEl(hlSportIcon(h.sport)), hlSportLabel(h.sport)),
      el('div', { class: 'hl-pop-owner' }, `door ${h.ownerName ?? 'onbekend'}`),
    );

    const desc = (h.description || '').trim();
    if (desc) {
      const short = desc.length > 150 ? desc.slice(0, 150).trimEnd() + '…' : desc;
      box.append(el('p', { class: 'hl-pop-desc' }, short));
    }

    const foot = el('div', { class: 'hl-pop-foot' });
    if (h.isOwner) {
      foot.append(
        el('span', { class: 'hl-pop-votes' }, svgEl(icons.heart), el('span', {}, String(votes))),
        el('span', { class: 'hl-pop-own' }, 'jouw highlight'),
        el('button', {
          class: 'btn-icon hl-pop-del', title: 'Verwijderen', onclick: async () => {
            const okd = await confirmDialog('Highlight verwijderen?', `Wil je "${h.name}" verwijderen?`);
            if (!okd) return;
            try {
              await api.del(`/api/highlights/${h.id}`);
              toast('Highlight verwijderd.');
              map.closePopup();
              if (showHighlights) loadHighlights();
            } catch (e) {
              toast(e instanceof ApiError ? e.message : 'Kon highlight niet verwijderen.', 'error');
            }
          },
        }, svgEl(icons.trash)),
      );
    } else {
      const voteBtn = el('button', { class: 'hl-vote' });
      const renderVote = () => {
        voteBtn.className = 'hl-vote' + (voted ? ' voted' : '');
        voteBtn.title = voted ? 'Stem intrekken' : 'Stem op deze highlight';
        voteBtn.replaceChildren(svgEl(voted ? icons.heartFill : icons.heart), el('span', {}, String(votes)));
      };
      voteBtn.addEventListener('click', async () => {
        try {
          const r = voted
            ? await api.del<{ votes: number; voted: boolean }>(`/api/highlights/${h.id}/vote`)
            : await api.post<{ votes: number; voted: boolean }>(`/api/highlights/${h.id}/vote`);
          votes = r.votes; voted = r.voted; h.votes = votes; h.voted = voted; renderVote();
        } catch (e) {
          toast(e instanceof ApiError ? e.message : 'Kon je stem niet opslaan.', 'error');
        }
      });
      renderVote();
      foot.append(voteBtn);
    }
    box.append(foot);
    return box;
  }

  // --- zoekacties ---
  async function runSearch({ fit }: { fit: boolean }) {
    const seq = ++searchSeq;
    showSpinner();
    aanbevolenEl.replaceChildren(); // oude aanbevelingen wissen tijdens het laden
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
      .map((n) => n.toFixed(6)).join(',');
    const params = new URLSearchParams({ bbox });
    if (sport) params.set('sport', sport);
    try {
      const { routes } = await api.get<{ routes: RouteSummary[] }>(`/api/discover?${params}`);
      if (seq !== searchSeq) return;
      drawPreviews(routes);
      renderResults(routes, { ranked: false, emptyMsg: AREA_EMPTY });
      if (fit) fitToResults(routes);
    } catch (e) {
      if (seq === searchSeq) {
        renderError('Kon routes niet laden. Probeer het opnieuw.');
        toast(e instanceof ApiError ? e.message : 'Kon routes niet laden.', 'error');
      }
    } finally {
      hideSearchHere();
    }
    // Aanbevolen bewegwijzerde routes voor hetzelfde gebied (zelfde moment als de
    // community-zoek; NIET bij elke moveend, alleen bij expliciete zoekacties).
    if (seq === searchSeq) void loadAanbevolen(bbox, seq);
  }

  async function loadTop() {
    showSpinner();
    aanbevolenEl.replaceChildren(); // geen aanbevolen sectie in de top-tab
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
    if (showHighlights) loadHighlights();
  }, 0);

  // --- opruimen ---
  return () => {
    destroyed = true;
    document.removeEventListener('mousedown', onOutside);
    clearRec();
    map.remove();
  };
}
