// Routeplanner — het hart van G.O.U.T. Kaart vult de pagina, met rustige
// zwevende panelen erop: sport + zoeken, knoppenrij, statsbalk met profiel.

import './plan.css';
import L from 'leaflet';
import { api } from '../api';
import { navigate } from '../router';
import {
  el, svgEl, icons, sportIcon, sportLabel, SPORTS,
  fmtKm, fmtM, fmtDur, difficultyBadge, toast, modal, confirmDialog, debounce,
} from '../ui';
import {
  createMap, trackToLatLngs, fitToTrack, waypointIcon, hoverMarker, positionIcon,
  ROUTE_STYLE, ROUTE_CASING, BEELINE_STYLE,
} from '../lib/map';
import { trackDistance, ascentDescent, simplify, haversine } from '../lib/geo';
import { estimateDuration, difficulty } from '../lib/estimate';
import { renderElevation, type ElevationProfile } from '../lib/elevation';
import { downloadGpx } from '../lib/gpx';
import { routeLeg, beelineLeg } from '../lib/brouter';
import type { Highlight, RouteFull, Sport, TrackPoint, Waypoint } from '../types';

// Bekende, populaire lange routes (snelkeuze in de 'Bekende routes'-modal).
const KNOWN_CHIPS = [
  'Camino Francés', 'Via Turonensis', 'Via Podiensis (GR65)',
  'GR 5', 'GR 12', 'GR 128 Vlaanderen',
];

export function planView(
  _container: HTMLElement,
  _params: Record<string, string>,
  query: URLSearchParams,
) {
  const container = _container;

  /* ------------------------------ staat ------------------------------ */
  let sport: Sport = 'wandelen';
  let waypoints: Waypoint[] = [];
  // legTracks[i] = het spoor van waypoint i naar i+1 (null = nog te berekenen).
  let legTracks: (TrackPoint[] | null)[] = [];
  let beelineMode = false;
  let gen = 0; // generatieteller om verouderde async-resultaten te negeren
  let ignoreNextMapClick = false;

  let editId: number | null = null;
  let editMeta: { name: string; description: string; visibility: 'private' | 'public' } = {
    name: '', description: '', visibility: 'private',
  };

  // 'Geladen route'-modus: een kant-en-klare GR/camino uit de bibliotheek,
  // zonder bewerkbare waypoints (enkel de volledige geometrie, opslaan & GPX).
  let loadedRoute: { name: string; ref: string | null; track: TrackPoint[] } | null = null;

  let elevProfile: ElevationProfile | null = null;
  let elevOpen = false;

  // GPS-positie ('jij bent hier').
  let gpsOn = false;
  let gpsWatchId: number | null = null;
  let gpsMarker: L.Marker | null = null;
  let gpsCircle: L.Circle | null = null;
  let gpsCentered = false;

  // Highlights-overlay (community-toppertjes).
  let hlOn = false;
  let hlLayer: L.LayerGroup | null = null;

  const undoStack: Waypoint[][] = [];
  const redoStack: Waypoint[][] = [];

  const LOADING_STYLE: L.PolylineOptions = { color: '#8f8c7f', weight: 2.5, opacity: 0.75, dashArray: '4 8' };
  const HL_STYLE: L.PolylineOptions = { color: '#e8590c', weight: 4, opacity: 0.7 };

  /* ------------------------------ DOM ------------------------------ */
  const mapEl = el('div', { style: 'position:absolute;inset:0;' });
  const holder = el('div', { class: 'map-holder' }, mapEl);
  const root = el('main', { class: 'page-wide plan-page' }, holder);
  container.append(root);

  const map = createMap(mapEl);
  const legLayer = L.layerGroup().addTo(map);
  const markerLayer = L.layerGroup().addTo(map);
  const hover = hoverMarker(map);

  // sport-picker
  const sportBtns = new Map<Sport, HTMLButtonElement>();
  const sportPicker = el('div', { class: 'sport-picker' },
    SPORTS.map(({ key, label }) => {
      const b = el('button', { type: 'button', title: label, onclick: () => setSport(key) },
        svgEl(sportIcon(key)), el('span', { class: 'sp-label' }, label));
      sportBtns.set(key, b);
      return b;
    }),
  );

  // 'Bekende routes'-knop (GR's & camino's) — links, bij het zoekveld.
  const knownBtn = el('button', {
    type: 'button', class: 'btn plan-known', onclick: openKnownRoutes,
    title: 'Bekende routes (GR’s & camino’s)',
  }, svgEl(icons.map), el('span', { class: 'plan-known-label' }, 'Bekende routes'));

  // zoeken
  const searchInput = el('input', {
    class: 'input input-search', type: 'search', placeholder: 'Zoek een plaats…', autocomplete: 'off',
  });
  const searchResults = el('div', { class: 'plan-results', style: 'display:none' });
  const searchWrap = el('div', { class: 'plan-search' }, searchInput, searchResults);

  const runSearch = debounce(async (q: string) => {
    if (q.trim().length < 2) { searchResults.style.display = 'none'; searchResults.replaceChildren(); return; }
    try {
      const { results } = await api.get<{ results: { name: string; lat: number; lon: number }[] }>(
        `/api/geocode?q=${encodeURIComponent(q)}`);
      searchResults.replaceChildren();
      if (!results.length) {
        searchResults.append(el('div', { class: 'plan-result plan-result-empty' }, 'Geen plaatsen gevonden'));
      } else {
        for (const r of results) {
          searchResults.append(el('div', {
            class: 'plan-result',
            onclick: () => {
              map.setView([r.lat, r.lon], 14);
              searchInput.value = r.name;
              searchResults.style.display = 'none';
            },
          }, svgEl(icons.compass), el('span', {}, r.name)));
        }
      }
      searchResults.style.display = '';
    } catch {
      searchResults.style.display = 'none';
    }
  }, 350);
  searchInput.addEventListener('input', () => runSearch(searchInput.value));
  searchInput.addEventListener('focus', () => { if (searchResults.children.length) searchResults.style.display = ''; });

  // knoppenrij
  const iconBtn = (icon: string, title: string, onclick: () => void) =>
    el('button', { type: 'button', class: 'btn btn-icon', title, onclick }, svgEl(icon));
  const undoBtn = iconBtn(icons.undo, 'Ongedaan maken (Ctrl+Z)', undo);
  const redoBtn = iconBtn(icons.redo, 'Opnieuw (Ctrl+Shift+Z)', redo);
  const reverseBtn = iconBtn(icons.reverse, 'Route omkeren', reverseRoute);
  const beelineBtn = iconBtn(icons.route, 'Nieuwe segmenten hemelsbreed aan/uit', toggleBeeline);
  const gpsBtn = iconBtn(icons.locate, 'Toon mijn positie (GPS)', toggleGps);
  const hlBtn = iconBtn(icons.flag, 'Highlights tonen', toggleHighlights);
  const loopBtn = iconBtn(icons.route, 'Sluit de lus', () => closeLoop(true));
  const clearBtn = iconBtn(icons.trash, 'Alles wissen', clearAll);
  const actions = el('div', { class: 'plan-actions' },
    undoBtn, redoBtn, reverseBtn, beelineBtn, gpsBtn, hlBtn, loopBtn, clearBtn);

  // statsbalk + hoogteprofiel
  const distV = el('b', {}, '0 km');
  const durV = el('span', {}, '0 min');
  const upV = el('span', {}, '0 m');
  const downV = el('span', {}, '0 m');
  const diffHolder = el('span', { class: 'plan-diff' });
  const statline = el('div', { class: 'statline' },
    distV,
    el('span', { class: 'sep' }, '·'),
    el('span', { class: 'stat-ico', title: 'Geschatte tijd' }, svgEl(icons.clock), durV),
    el('span', { class: 'sep' }, '·'),
    el('span', { class: 'stat-ico', title: 'Stijgen' }, svgEl(icons.up), upV),
    el('span', { class: 'stat-ico', title: 'Dalen' }, svgEl(icons.down), downV),
    diffHolder,
  );

  const saveBtn = el('button', { type: 'button', class: 'btn btn-primary', onclick: openSaveModal, disabled: true },
    svgEl(icons.save), 'Opslaan');
  const gpxBtn = el('button', { type: 'button', class: 'btn', onclick: exportGpx, disabled: true, title: 'Download als GPX' },
    svgEl(icons.download), 'GPX');
  const elevChevron = el('button', { type: 'button', class: 'btn btn-icon plan-chevron', title: 'Hoogteprofiel tonen', 'aria-label': 'Hoogteprofiel tonen', onclick: toggleElev },
    svgEl(icons.chevronD));
  const elevBox = el('div', { class: 'plan-elev', style: 'display:none' });

  const statsCard = el('div', { class: 'card plan-stats' },
    el('div', { class: 'plan-stats-row' },
      statline,
      el('div', { class: 'plan-stats-actions' }, elevChevron, gpxBtn, saveBtn),
    ),
    elevBox,
  );

  const hint = el('div', { class: 'plan-hint' },
    svgEl(icons.map),
    el('div', {}, 'Klik op de kaart om je route te beginnen'),
  );
  // De hint vervaagt na 8 s vanzelf (of verdwijnt meteen bij het eerste punt).
  let hintTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => hint.classList.add('faded'), 8000);

  const topleft = el('div', { class: 'plan-topleft' }, knownBtn, searchWrap, sportPicker);
  holder.append(
    topleft,
    el('div', { class: 'plan-topright' }, actions),
    hint,
    statsCard,
  );

  // panelen mogen de kaart niet aansturen
  for (const p of [knownBtn, searchWrap, sportPicker, actions, statsCard]) {
    L.DomEvent.disableClickPropagation(p);
    L.DomEvent.disableScrollPropagation(p);
  }

  map.on('click', async (e: L.LeafletMouseEvent) => {
    if (ignoreNextMapClick) { ignoreNextMapClick = false; return; }
    if (loadedRoute) {
      const ok = await confirmDialog('Geladen route vervangen?',
        'Wil je de geladen route vervangen door een eigen route? Je begint dan met een leeg plan.', 'Ja, eigen route');
      if (!ok) return;
      exitLoadedMode();
    }
    addPoint(e.latlng.lng, e.latlng.lat);
  });

  setTimeout(() => map.invalidateSize(), 0);

  /* ------------------------- undo / redo ------------------------- */
  const snapshot = (): Waypoint[] => waypoints.map((w) => ({ ...w }));
  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    applyWaypoints(undoStack.pop()!);
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    applyWaypoints(redoStack.pop()!);
  }
  function applyWaypoints(w: Waypoint[]) {
    waypoints = w;
    legTracks = new Array(Math.max(0, waypoints.length - 1)).fill(null);
    afterChange();
  }

  /* ------------------------- mutaties ------------------------- */
  function addPoint(lon: number, lat: number) {
    pushUndo();
    const wp: Waypoint = { lon, lat };
    if (waypoints.length >= 1 && beelineMode) wp.beeline = true;
    waypoints.push(wp);
    if (waypoints.length >= 2) legTracks.push(null);
    afterChange();
  }

  function insertVia(legIndex: number, lon: number, lat: number) {
    if (legIndex < 0 || legIndex >= waypoints.length - 1) return;
    pushUndo();
    const wasBeeline = !!waypoints[legIndex + 1].beeline;
    const wp: Waypoint = { lon, lat };
    if (wasBeeline) wp.beeline = true;
    waypoints.splice(legIndex + 1, 0, wp);
    legTracks.splice(legIndex, 1, null, null);
    afterChange();
  }

  function removeWaypoint(i: number) {
    pushUndo();
    const oldLen = waypoints.length;
    waypoints.splice(i, 1);
    if (oldLen <= 1) legTracks = [];
    else if (i === 0) legTracks.shift();
    else if (i === oldLen - 1) legTracks.pop();
    else legTracks.splice(i - 1, 2, null); // buurlegs samenvoegen
    afterChange();
  }

  function onDragEnd(i: number, m: L.Marker) {
    const ll = m.getLatLng();
    pushUndo();
    waypoints[i] = { lon: ll.lng, lat: ll.lat, beeline: waypoints[i].beeline };
    if (i - 1 >= 0) legTracks[i - 1] = null;
    if (i < waypoints.length - 1) legTracks[i] = null;
    afterChange();
  }

  function reverseRoute() {
    const n = waypoints.length;
    if (n < 2) return;
    pushUndo();
    const attrs: boolean[] = [];
    for (let k = 1; k < n; k++) attrs.push(!!waypoints[k].beeline);
    attrs.reverse();
    const newWps: Waypoint[] = waypoints.slice().reverse().map((w) => ({ lon: w.lon, lat: w.lat }));
    for (let j = 1; j < n; j++) if (attrs[j - 1]) newWps[j].beeline = true;
    const newLegs: (TrackPoint[] | null)[] = [];
    for (let j = 0; j < n - 1; j++) {
      const old = legTracks[n - 2 - j];
      newLegs.push(old ? old.slice().reverse() : null);
    }
    waypoints = newWps;
    legTracks = newLegs;
    afterChange();
  }

  // Lus sluiten: voeg een eindpunt toe op de startcoördinaat.
  function loopClosed(): boolean {
    if (waypoints.length < 2) return true;
    const a = waypoints[0], b = waypoints[waypoints.length - 1];
    return haversine(a.lon, a.lat, b.lon, b.lat) < 30;
  }

  function closeLoop(fromButton = false) {
    if (loadedRoute || waypoints.length < 2) return;
    if (loopClosed()) { if (!fromButton) toast('De lus is al gesloten.'); return; }
    pushUndo();
    const a = waypoints[0];
    const wp: Waypoint = { lon: a.lon, lat: a.lat };
    if (beelineMode) wp.beeline = true;
    waypoints.push(wp);
    legTracks.push(null);
    afterChange();
    toast('Lus gesloten.');
  }

  function setSport(s: Sport) {
    if (s === sport) return;
    sport = s;
    for (const [k, b] of sportBtns) b.classList.toggle('active', k === s);
    for (let i = 0; i < legTracks.length; i++) if (!waypoints[i + 1].beeline) legTracks[i] = null;
    if (hlOn) loadHighlights();
    afterChange();
  }

  function toggleBeeline() {
    beelineMode = !beelineMode;
    beelineBtn.classList.toggle('active', beelineMode);
    beelineBtn.title = beelineMode ? 'Hemelsbreed staat aan' : 'Nieuwe segmenten hemelsbreed aan/uit';
  }

  /* ------------------------- GPS-positie ------------------------- */
  function toggleGps() {
    if (gpsOn) stopGps();
    else startGps(true);
  }

  function startGps(center: boolean) {
    if (!navigator.geolocation) { toast('Je toestel ondersteunt geen locatiebepaling.', 'error'); return; }
    gpsOn = true;
    gpsCentered = !center;
    gpsBtn.classList.add('active');
    gpsBtn.title = 'Mijn positie verbergen';
    try { localStorage.setItem('gout.plannerGps', '1'); } catch { /* privémodus */ }
    gpsWatchId = navigator.geolocation.watchPosition(onGpsFix, onGpsError,
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
  }

  function onGpsFix(pos: GeolocationPosition) {
    const { latitude, longitude, accuracy } = pos.coords;
    if (!gpsMarker) {
      gpsMarker = L.marker([latitude, longitude], { icon: positionIcon(), interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(map);
    } else {
      gpsMarker.setLatLng([latitude, longitude]);
    }
    if (!gpsCircle) {
      gpsCircle = L.circle([latitude, longitude], { radius: accuracy, color: '#2b6fe0', weight: 1, opacity: 0.5, fillColor: '#2b6fe0', fillOpacity: 0.12, interactive: false }).addTo(map);
    } else {
      gpsCircle.setLatLng([latitude, longitude]);
      gpsCircle.setRadius(accuracy);
    }
    if (!gpsCentered) {
      map.setView([latitude, longitude], Math.max(map.getZoom(), 14));
      gpsCentered = true;
    }
  }

  function onGpsError() {
    toast('Je locatie kon niet bepaald worden.', 'error');
    stopGps();
  }

  function stopGps() {
    gpsOn = false;
    gpsBtn.classList.remove('active');
    gpsBtn.title = 'Toon mijn positie (GPS)';
    try { localStorage.setItem('gout.plannerGps', '0'); } catch { /* privémodus */ }
    if (gpsWatchId !== null && navigator.geolocation) { navigator.geolocation.clearWatch(gpsWatchId); gpsWatchId = null; }
    if (gpsMarker) { gpsMarker.remove(); gpsMarker = null; }
    if (gpsCircle) { gpsCircle.remove(); gpsCircle = null; }
    gpsCentered = false;
  }

  /* ------------------------- highlights-overlay ------------------------- */
  const flagIcon = L.divIcon({ className: '', iconSize: [24, 24], iconAnchor: [12, 22], html: `<div class="hl-flag">${icons.flag}</div>` });

  function toggleHighlights() {
    hlOn = !hlOn;
    hlBtn.classList.toggle('active', hlOn);
    hlBtn.title = hlOn ? 'Highlights verbergen' : 'Highlights tonen';
    try { localStorage.setItem('gout.plannerHl', hlOn ? '1' : '0'); } catch { /* privémodus */ }
    if (hlOn) {
      if (!hlLayer) hlLayer = L.layerGroup().addTo(map);
      loadHighlights();
      map.on('moveend', hlMoveHandler);
    } else {
      map.off('moveend', hlMoveHandler);
      if (hlLayer) hlLayer.clearLayers();
    }
  }

  const hlMoveHandler = debounce(() => { if (hlOn) loadHighlights(); }, 600);

  async function loadHighlights() {
    if (!hlOn) return;
    const b = map.getBounds();
    const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
    try {
      const { highlights } = await api.get<{ highlights: Highlight[] }>(
        `/api/highlights?bbox=${encodeURIComponent(bbox)}&sport=${encodeURIComponent(sport)}`);
      if (hlOn) drawHighlights(highlights);
    } catch { /* stil: highlights zijn niet essentieel */ }
  }

  function drawHighlights(list: Highlight[]) {
    if (!hlLayer) return;
    hlLayer.clearLayers();
    for (const h of list) {
      if (!h.track || h.track.length < 2) continue;
      L.polyline(trackToLatLngs(h.track), HL_STYLE).addTo(hlLayer);
      const mid = h.track[Math.floor(h.track.length / 2)];
      L.marker([mid[1], mid[0]], { icon: flagIcon }).bindPopup(hlPopup(h)).addTo(hlLayer);
    }
  }

  function hlPopup(h: Highlight): HTMLElement {
    const ic = h.sport === 'alle' ? icons.flag : sportIcon(h.sport);
    const lbl = h.sport === 'alle' ? 'Alle sporten' : sportLabel(h.sport);
    return el('div', { class: 'hl-popup' },
      el('strong', { class: 'hl-pop-name' }, h.name),
      el('div', { class: 'hl-pop-meta' },
        svgEl(ic), el('span', {}, lbl),
        el('span', { class: 'hl-pop-sep' }, '·'),
        el('span', {}, `${h.votes} ${h.votes === 1 ? 'stem' : 'stemmen'}`),
      ),
      h.description ? el('p', { class: 'hl-pop-desc' }, h.description) : null,
      h.ownerName ? el('div', { class: 'hl-pop-owner' }, 'door ' + h.ownerName) : null,
    );
  }

  async function clearAll() {
    if (loadedRoute) {
      const ok = await confirmDialog('Alles wissen?',
        'De geladen route wordt van de kaart gehaald.', 'Wissen');
      if (!ok) return;
      exitLoadedMode();
      afterChange();
      return;
    }
    if (!waypoints.length) return;
    const ok = await confirmDialog('Alles wissen?',
      'Je hele route wordt gewist. Je kan dit terugdraaien met Ctrl+Z.', 'Wissen');
    if (!ok) return;
    pushUndo();
    waypoints = [];
    legTracks = [];
    afterChange();
  }

  /* ------------------------- legs berekenen ------------------------- */
  async function computeMissing() {
    const myGen = ++gen;
    // beeline-legs kunnen we meteen invullen
    for (let i = 0; i < waypoints.length - 1; i++) {
      if (legTracks[i]) continue;
      if (waypoints[i + 1].beeline) legTracks[i] = beelineLeg(waypoints[i], waypoints[i + 1]);
    }
    redraw();
    // routed legs ophalen (cache-hits gaan meteen)
    for (let i = 0; i < waypoints.length - 1; i++) {
      if (legTracks[i]) continue;
      try {
        const leg = await routeLeg(waypoints[i], waypoints[i + 1], sport);
        if (myGen !== gen) return; // ingehaald door een nieuwere actie
        legTracks[i] = leg;
      } catch (err: any) {
        if (myGen !== gen) return;
        toast(err?.message || 'Deze leg kon niet berekend worden — hemelsbreed getekend.', 'error');
        waypoints[i + 1].beeline = true;
        legTracks[i] = beelineLeg(waypoints[i], waypoints[i + 1]);
      }
      redraw();
      updateStats();
      updateElevation();
    }
    updateStats();
    updateElevation();
  }

  /* ------------------------- track & stats ------------------------- */
  function assembleTrack(): TrackPoint[] {
    const out: TrackPoint[] = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
      const leg = legTracks[i] || beelineLeg(waypoints[i], waypoints[i + 1]);
      if (out.length === 0) out.push(...leg);
      else out.push(...leg.slice(1)); // naadpunt overslaan
    }
    if (out.length === 0 && waypoints.length === 1) out.push([waypoints[0].lon, waypoints[0].lat]);
    return out;
  }

  function currentTrack(): TrackPoint[] {
    return loadedRoute ? loadedRoute.track : assembleTrack();
  }

  function updateStats() {
    if (loadedRoute) {
      distV.textContent = fmtKm(trackDistance(loadedRoute.track));
      durV.textContent = '—'; durV.title = 'Geen hoogtedata: tijd niet te schatten';
      upV.textContent = '—'; upV.title = 'Geen hoogtedata beschikbaar voor bekende routes';
      downV.textContent = '—'; downV.title = 'Geen hoogtedata beschikbaar voor bekende routes';
      diffHolder.replaceChildren(
        el('span', { class: 'badge badge-neutral plan-loaded-badge', title: 'Geladen route uit de bibliotheek — bewaar of download' },
          'Geladen: ' + loadedRoute.name + (loadedRoute.ref ? ' · ' + loadedRoute.ref : '')),
      );
      return;
    }
    durV.title = ''; upV.title = ''; downV.title = '';
    const track = assembleTrack();
    const distM = track.length >= 2 ? trackDistance(track) : 0;
    const { ascent, descent } = ascentDescent(track);
    const durS = distM > 0 ? estimateDuration(sport, distM, ascent) : 0;
    distV.textContent = fmtKm(distM);
    durV.textContent = fmtDur(durS);
    upV.textContent = fmtM(ascent);
    downV.textContent = fmtM(descent);
    diffHolder.replaceChildren();
    if (distM > 0) diffHolder.append(difficultyBadge(difficulty(sport, distM, ascent)));
  }

  function updateButtons() {
    undoBtn.disabled = undoStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;
    const enough = waypoints.length >= 2;
    saveBtn.disabled = !(enough || loadedRoute);
    gpxBtn.disabled = !(enough || loadedRoute);
    reverseBtn.disabled = !enough;
    clearBtn.disabled = waypoints.length === 0 && !loadedRoute;
    loopBtn.disabled = !enough || loopClosed();
  }

  function updateElevation() {
    if (!elevOpen) return;
    elevProfile?.destroy();
    elevProfile = null;
    elevBox.replaceChildren();
    const track = currentTrack();
    if (track.length < 2) {
      elevBox.append(el('div', { class: 'plan-elev-empty' }, 'Voeg minstens twee punten toe voor het hoogteprofiel.'));
      return;
    }
    const inner = el('div', {});
    elevBox.append(inner);
    elevProfile = renderElevation(inner, track, {
      height: 120,
      onHover: (p) => { if (p) hover.show(p.lat, p.lon); else hover.hide(); },
    });
  }

  function toggleElev() {
    elevOpen = !elevOpen;
    elevBox.style.display = elevOpen ? '' : 'none';
    elevChevron.classList.toggle('open', elevOpen);
    elevChevron.title = elevOpen ? 'Hoogteprofiel verbergen' : 'Hoogteprofiel tonen';
    elevChevron.setAttribute('aria-label', elevOpen ? 'Hoogteprofiel verbergen' : 'Hoogteprofiel tonen');
    if (elevOpen) updateElevation();
    else { elevProfile?.destroy(); elevProfile = null; hover.hide(); }
  }

  function exportGpx() {
    const track = currentTrack();
    if (track.length < 2) { toast('Voeg eerst minstens twee punten toe.', 'error'); return; }
    downloadGpx((loadedRoute ? loadedRoute.name : editMeta.name) || 'Mijn route', track, sport);
  }

  /* ------------------------- tekenen ------------------------- */
  function afterChange() {
    hint.style.display = (waypoints.length === 0 && !loadedRoute) ? '' : 'none';
    if (hint.style.display === 'none' && hintTimer) { clearTimeout(hintTimer); hintTimer = undefined; }
    redraw();
    updateStats();
    updateButtons();
    updateElevation();
    if (!loadedRoute) computeMissing();
  }

  function attachLegClick(poly: L.Polyline, i: number) {
    poly.on('click', (e: L.LeafletMouseEvent) => {
      ignoreNextMapClick = true;
      queueMicrotask(() => { ignoreNextMapClick = false; });
      insertVia(i, e.latlng.lng, e.latlng.lat);
    });
  }

  function redraw() {
    legLayer.clearLayers();
    markerLayer.clearLayers();

    if (loadedRoute) {
      const t = loadedRoute.track;
      // Niet-interactief zodat een klik op de lijn de kaart-klik (vervangen) bereikt.
      L.polyline(trackToLatLngs(t), { ...ROUTE_CASING, interactive: false }).addTo(legLayer);
      L.polyline(trackToLatLngs(t), { ...ROUTE_STYLE, interactive: false }).addTo(legLayer);
      const a = t[0], b = t[t.length - 1];
      L.marker([a[1], a[0]], { icon: waypointIcon('start'), interactive: false }).addTo(markerLayer);
      L.marker([b[1], b[0]], { icon: waypointIcon('end'), interactive: false }).addTo(markerLayer);
      return;
    }

    const n = waypoints.length;

    for (let i = 0; i < n - 1; i++) {
      const a = waypoints[i], b = waypoints[i + 1];
      const leg = legTracks[i];
      if (!leg) {
        const straight: L.LatLngExpression[] = [[a.lat, a.lon], [b.lat, b.lon]];
        L.polyline(straight, LOADING_STYLE).addTo(legLayer);
        continue;
      }
      const latlngs = trackToLatLngs(leg);
      if (b.beeline) {
        attachLegClick(L.polyline(latlngs, BEELINE_STYLE).addTo(legLayer), i);
      } else {
        L.polyline(latlngs, ROUTE_CASING).addTo(legLayer);
        attachLegClick(L.polyline(latlngs, ROUTE_STYLE).addTo(legLayer), i);
      }
    }

    let viaN = 0;
    for (let i = 0; i < n; i++) {
      const kind: 'start' | 'end' | 'via' = i === 0 ? 'start' : i === n - 1 ? 'end' : 'via';
      const label = kind === 'via' ? String(++viaN) : '';
      const center: L.LatLngExpression = [waypoints[i].lat, waypoints[i].lon];
      const m = L.marker(center, { icon: waypointIcon(kind, label), draggable: true, autoPan: true });
      m.on('dragend', () => onDragEnd(i, m));
      m.on('click', () => {
        ignoreNextMapClick = true;
        queueMicrotask(() => { ignoreNextMapClick = false; });
        // Klik op de START met >=2 punten sluit de lus; enkel bij exact 1 punt
        // verwijdert een klik het startpunt nog.
        if (i === 0 && waypoints.length >= 2) { closeLoop(false); return; }
        removeWaypoint(i);
      });
      m.addTo(markerLayer);
    }
  }

  /* ------------------------- bekende routes ------------------------- */
  function openKnownRoutes() {
    const info = el('p', { class: 'kr-info' }, 'Vind een GR of camino en laad ze in één klik als route.');
    const input = el('input', { class: 'input input-search', type: 'search', placeholder: 'Zoek een route (bv. GR 5)…', autocomplete: 'off' });
    const chipsWrap = el('div', { class: 'kr-chips' },
      KNOWN_CHIPS.map((c) => el('button', { type: 'button', class: 'chip', onclick: () => { input.value = c; showSpinner(); doKnownSearch(c); } }, c)),
    );
    const list = el('div', { class: 'kr-results' },
      el('div', { class: 'kr-empty' }, 'Typ hierboven of kies een route om te beginnen.'));
    const box = el('div', { class: 'kr-modal' },
      el('h2', {}, 'Bekende routes'), info, input, chipsWrap, list);
    const close = modal(box);
    setTimeout(() => input.focus(), 0);

    function showSpinner() { list.replaceChildren(el('div', { class: 'spinner' })); }

    const runKnown = debounce((q: string) => doKnownSearch(q), 400);
    input.addEventListener('input', () => {
      const q = input.value.trim();
      if (q.length < 2) { list.replaceChildren(el('div', { class: 'kr-empty' }, 'Typ minstens twee letters.')); return; }
      showSpinner();
      runKnown(q);
    });

    async function doKnownSearch(q: string) {
      if (q.trim().length < 2) return;
      try {
        const { routes } = await api.get<{ routes: { id: number; name: string; ref: string | null; group: string | null }[] }>(
          `/api/knownroutes?q=${encodeURIComponent(q)}&sport=${encodeURIComponent(sport)}`);
        if (!routes.length) {
          list.replaceChildren(el('div', { class: 'kr-empty' }, 'Niets gevonden. Probeer een andere zoekterm.'));
          return;
        }
        list.replaceChildren(
          ...routes.map((r) => el('button', { type: 'button', class: 'kr-result', onclick: () => loadKnown(r.id) },
            el('span', { class: 'kr-name' }, r.name),
            r.ref ? el('span', { class: 'badge badge-neutral kr-ref' }, r.ref) : null,
          )),
        );
      } catch (err: any) {
        list.replaceChildren(el('div', { class: 'kr-empty' }, err?.message || 'Zoeken lukte niet. Probeer opnieuw.'));
      }
    }

    async function loadKnown(id: number) {
      if (waypoints.length >= 1 || loadedRoute) {
        const ok = await confirmDialog('Route vervangen?',
          'Je huidige plan wordt vervangen door de gekozen route.', 'Vervangen');
        if (!ok) return;
      }
      input.disabled = true;
      list.replaceChildren(el('div', { class: 'kr-loading' },
        el('div', { class: 'spinner' }),
        el('p', {}, 'Route ophalen — lange routes kunnen even duren…'),
      ));
      try {
        const data = await api.get<{ name: string; ref: string | null; track: [number, number][]; note: string }>(
          `/api/knownroutes/${id}?sport=${encodeURIComponent(sport)}`);
        if (!data.track || data.track.length < 2) throw new Error('Deze route bevat geen bruikbare geometrie.');
        close();
        enterLoadedMode(data.name, data.ref, data.track.map((p) => [p[0], p[1]] as TrackPoint));
        toast('Route geladen: ' + data.name);
      } catch (err: any) {
        input.disabled = false;
        const msg = err?.message || 'Kon de route niet ophalen. Probeer opnieuw.';
        list.replaceChildren(el('div', { class: 'kr-empty' }, msg));
        toast(msg, 'error');
      }
    }
  }

  function enterLoadedMode(name: string, ref: string | null, track: TrackPoint[]) {
    gen++; // eventuele hangende leg-berekeningen negeren
    stopBeelineIfNeeded();
    loadedRoute = { name, ref, track };
    waypoints = [];
    legTracks = [];
    undoStack.length = 0;
    redoStack.length = 0;
    editId = null;
    editMeta = { name, description: '', visibility: 'private' };
    afterChange();
    fitToTrack(map, track);
  }

  function stopBeelineIfNeeded() {
    if (beelineMode) toggleBeeline();
  }

  function exitLoadedMode() {
    loadedRoute = null;
    legLayer.clearLayers();
    markerLayer.clearLayers();
    editMeta = { name: '', description: '', visibility: 'private' };
  }

  /* ------------------------- opslaan ------------------------- */
  function openSaveModal() {
    if (currentTrack().length < 2) { toast('Voeg minstens twee punten toe.', 'error'); return; }

    const nameInput = el('input', { class: 'input', type: 'text', maxlength: '120', value: editMeta.name, placeholder: 'bv. Ronde van het Hallerbos' });
    const descInput = el('textarea', { class: 'input', maxlength: '2000', placeholder: 'Optioneel: wat maakt deze route bijzonder?' });
    descInput.value = editMeta.description;
    const visSelect = el('select', { class: 'input' },
      el('option', { value: 'private' }, 'Privé — alleen voor jou'),
      el('option', { value: 'public' }, 'Openbaar — zichtbaar in Ontdek'),
    );
    visSelect.value = editMeta.visibility;
    const errP = el('p', { style: 'color:var(--danger);font-weight:600;min-height:1.2em;margin:.2rem 0 0;font-size:.85rem' });
    const submitBtn = el('button', { type: 'button', class: 'btn btn-primary' }, editId ? 'Opslaan' : 'Route opslaan');

    const box = el('div', {},
      el('h2', {}, editId ? 'Route bijwerken' : 'Route opslaan'),
      loadedRoute ? el('p', { class: 'kr-info' }, 'Bekende route uit de bibliotheek. Je bewaart ze als je eigen route.') : null,
      el('label', { class: 'field' }, el('span', {}, 'Naam'), nameInput),
      el('label', { class: 'field' }, el('span', {}, 'Beschrijving'), descInput),
      el('label', { class: 'field' }, el('span', {}, 'Zichtbaarheid'), visSelect),
      errP,
      el('div', { class: 'modal-actions' },
        el('button', { type: 'button', class: 'btn', onclick: () => close() }, 'Annuleren'),
        submitBtn,
      ),
    );
    const close = modal(box);
    setTimeout(() => nameInput.focus(), 0);

    submitBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) { errP.textContent = 'Geef je route een naam.'; nameInput.focus(); return; }
      submitBtn.disabled = true;
      submitBtn.textContent = 'Bezig…';
      try {
        const track = currentTrack();
        const wps = loadedRoute ? null : waypoints.map((w) => (w.beeline ? { lon: w.lon, lat: w.lat, beeline: true } : { lon: w.lon, lat: w.lat }));
        const startLat = loadedRoute ? loadedRoute.track[0][1] : waypoints[0].lat;
        const startLon = loadedRoute ? loadedRoute.track[0][0] : waypoints[0].lon;
        let region: string | null = null;
        try {
          const r = await api.get<{ region: string | null }>(`/api/revgeocode?lat=${startLat}&lon=${startLon}`);
          region = r.region;
        } catch { /* stil: regio is best-effort */ }
        const visibility = visSelect.value === 'public' ? 'public' : 'private';
        const description = descInput.value.trim();

        let route: RouteFull;
        if (editId) {
          ({ route } = await api.put<{ route: RouteFull }>(`/api/routes/${editId}`, {
            name, description, sport, waypoints: wps, track, region, visibility,
          }));
        } else {
          ({ route } = await api.post<{ route: RouteFull }>('/api/routes', {
            name, description, sport, waypoints: wps, track, region,
          }));
          if (visibility === 'public') {
            try { ({ route } = await api.put<{ route: RouteFull }>(`/api/routes/${route.id}`, { visibility })); }
            catch { /* blijft privé als dit faalt */ }
          }
        }
        close();
        toast(editId ? 'Route bijgewerkt.' : 'Route opgeslagen.');
        navigate('/route/' + route.id);
      } catch (err: any) {
        errP.textContent = err?.message || 'Opslaan mislukt.';
        submitBtn.disabled = false;
        submitBtn.textContent = editId ? 'Opslaan' : 'Route opslaan';
      }
    });
  }

  /* ------------------------- bewerkmodus ------------------------- */
  function trackToWaypoints(track: TrackPoint[]): Waypoint[] {
    if (track.length <= 30) return track.map((p) => ({ lon: p[0], lat: p[1] }));
    let tol = 0.0004;
    let pts = simplify(track, tol);
    let guard = 0;
    while (pts.length > 30 && guard < 40) { tol *= 1.6; pts = simplify(track, tol); guard++; }
    if (pts.length > 30) {
      const step = Math.ceil(pts.length / 30);
      pts = pts.filter((_, idx) => idx % step === 0 || idx === pts.length - 1);
    }
    return pts.map((p) => ({ lon: p[0], lat: p[1] }));
  }

  async function loadEdit(id: number) {
    try {
      const { route } = await api.get<{ route: RouteFull }>(`/api/routes/${id}`);
      editId = route.id;
      sport = route.sport;
      editMeta = { name: route.name, description: route.description || '', visibility: route.visibility };
      for (const [k, b] of sportBtns) b.classList.toggle('active', k === sport);

      if (route.waypoints && route.waypoints.length >= 2) {
        waypoints = route.waypoints.map((w) => (w.beeline ? { lon: w.lon, lat: w.lat, beeline: true } : { lon: w.lon, lat: w.lat }));
        legTracks = new Array(waypoints.length - 1).fill(null);
      } else {
        toast('Deze route is geïmporteerd; we zetten ze om naar bewerkbare punten.');
        waypoints = trackToWaypoints(route.track);
        legTracks = new Array(Math.max(0, waypoints.length - 1)).fill(null);
      }
      afterChange();
      if (route.track && route.track.length >= 2) fitToTrack(map, route.track);
      else if (waypoints.length) map.setView([waypoints[0].lat, waypoints[0].lon], 13);
    } catch (err: any) {
      toast(err?.message || 'Route kon niet geladen worden.', 'error');
    }
  }

  /* ------------------------- toetsenbord ------------------------- */
  function isTyping(): boolean {
    const a = document.activeElement as HTMLElement | null;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
  }
  function onKey(e: KeyboardEvent) {
    if (isTyping()) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (ctrl && !e.shiftKey && k === 'z') { e.preventDefault(); undo(); }
    else if (ctrl && ((e.shiftKey && k === 'z') || k === 'y')) { e.preventDefault(); redo(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && waypoints.length) { e.preventDefault(); removeWaypoint(waypoints.length - 1); }
  }
  function onDocDown(e: MouseEvent) {
    if (!searchWrap.contains(e.target as Node)) searchResults.style.display = 'none';
  }
  document.addEventListener('keydown', onKey);
  document.addEventListener('mousedown', onDocDown);

  /* ------------------------- start ------------------------- */
  sportBtns.get(sport)!.classList.add('active');
  updateButtons();
  const editParam = query.get('edit');
  if (editParam && /^\d+$/.test(editParam)) loadEdit(Number(editParam));
  else afterChange();

  // Voorkeuren herstellen: GPS-positie en highlights-overlay.
  try {
    if (localStorage.getItem('gout.plannerGps') === '1' && navigator.geolocation) {
      startGps(!(editParam && /^\d+$/.test(editParam)));
    }
  } catch { /* privémodus */ }
  try {
    if (localStorage.getItem('gout.plannerHl') === '1') toggleHighlights();
  } catch { /* privémodus */ }

  return () => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('mousedown', onDocDown);
    if (hintTimer) clearTimeout(hintTimer);
    stopGps();
    map.off('moveend', hlMoveHandler);
    elevProfile?.destroy();
    hover.remove();
    map.remove();
  };
}
