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
import { trackDistance, ascentDescent, simplify, haversine, cumulative, nearestPointIndex } from '../lib/geo';
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

// Wisselende Vlaamse statusregels tijdens het laden van een (lange) bekende route.
const KNOWN_LOAD_STATUS = [
  'Route aan het opsnorren bij OpenStreetMap…',
  'Alle bochten en kronkels aan het verzamelen…',
  'Zijpaadjes en varianten aan het wegknippen…',
  'De kilometers aan het natellen…',
  'Bijna klaar — de laatste hectometers…',
];
// Kronkelend routepad voor het laadanimatietje (zelfde d als de CSS offset-path).
const KNOWN_LOAD_PATH = 'M12,58 C40,20 62,68 92,44 C120,22 150,64 188,34';
const KNOWN_LOAD_SVG =
  '<svg class="kr-svg" viewBox="0 0 200 80" width="200" height="80" fill="none">' +
  `<path d="${KNOWN_LOAD_PATH}" stroke="#fff" stroke-width="7" stroke-linecap="round"/>` +
  `<path class="kr-line" d="${KNOWN_LOAD_PATH}" stroke="var(--route)" stroke-width="3.5" stroke-linecap="round"/>` +
  '<circle cx="12" cy="58" r="7" fill="var(--green)" stroke="#fff" stroke-width="2"/>' +
  '<text x="12" y="60.5" text-anchor="middle" font-size="8" font-weight="700" fill="#fff">A</text>' +
  '</svg>';

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

  // Takken: sommige bekende routes hebben meerdere volwaardige armen (bv. de
  // GR 655/Via Turonensis met een west-tak via Chartres en een oost-tak via
  // Orleans). branches (>=2) vult de takkenbalk; leeg = gewone enkele route.
  // De actieve tak (branches[activeBranch].track) is altijd loadedRoute.track.
  type Branch = { track: TrackPoint[]; distanceM: number };
  let branches: Branch[] = [];
  let activeBranch = 0;

  // Referentie naar de open 'Bekende routes'-modal (met haar laadtimers + fetch),
  // zodat de view-cleanup ze bij wegnavigeren netjes opruimt: geen weesmodal die
  // over de volgende pagina blijft hangen, geen tikkende timers, fetch afgebroken.
  let closeKnownModal: (() => void) | null = null;

  // Dagetappes (camino-workflow): een deel kiezen (A/B) en in dagen splitsen.
  type PickState = 'idle' | 'a' | 'b';
  let pickState: PickState = 'idle';
  let pickA: number | null = null;   // index in loadedRoute.track
  let pickB: number | null = null;
  let subTrack: TrackPoint[] | null = null; // gekozen deel (null = hele geladen route)
  let splits: number[] = [];         // gesorteerde interne split-indices in de actieve track
  let lastEtapEdit: 'km' | 'days' = 'km';

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
  const DIM_STYLE: L.PolylineOptions = { color: '#3557e0', weight: 3, opacity: 0.25 };
  // Niet-actieve takken (bv. de west-arm terwijl je de oost-arm bekijkt):
  // zelfde blauw, iets dunner en fel gedempt, maar klikbaar om te activeren.
  const BRANCH_DIM_STYLE: L.PolylineOptions = { color: '#3557e0', weight: 3.5, opacity: 0.3 };

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
  const loopBtn = iconBtn(icons.loop, 'Sluit de lus', () => closeLoop(true));
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

  // 'Kies je deel' (dagetappes) — in de statsbalk bij de 'Geladen: …'-badge.
  const partBtn = el('button', { type: 'button', class: 'btn btn-sm plan-part-btn', style: 'display:none', onclick: () => onPartBtn() },
    svgEl(icons.flag), 'Kies je deel');

  // Takkenbalk: bij een geladen route met meerdere takken kies je hier (of op de
  // kaart) de actieve tak. Boven de 'Geladen: …'-zone in de statsbalk; op mobiel
  // valt hij mee als volle-breedte-rij boven de cijfers.
  const branchLabel = el('span', { class: 'plan-branch-label' });
  const branchChips = el('div', { class: 'plan-branch-chips' });
  const branchBar = el('div', { class: 'plan-branchbar', style: 'display:none' }, branchLabel, branchChips);

  // Dagenlijst bij etappe-markers: 'Dag 1 — 24,3 km · Dag 2 — …' (enkel bij >=1 etappe-marker).
  const daysBar = el('div', { class: 'plan-days', style: 'display:none' });

  const statsCard = el('div', { class: 'card plan-stats' },
    branchBar,
    el('div', { class: 'plan-stats-row' },
      statline,
      el('div', { class: 'plan-stats-actions' }, partBtn, elevChevron, gpxBtn, saveBtn),
    ),
    daysBar,
    elevBox,
  );

  const hint = el('div', { class: 'plan-hint' },
    svgEl(icons.map),
    el('div', {}, 'Klik op de kaart om je route te beginnen'),
  );
  // De hint vervaagt na 8 s vanzelf (of verdwijnt meteen bij het eerste punt).
  let hintTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => hint.classList.add('faded'), 8000);

  // ----- dagetappepaneel (deel kiezen → dagen) -----
  const kmInput = el('input', { class: 'input', type: 'number', min: '5', step: '1', value: '25', inputmode: 'numeric' }) as HTMLInputElement;
  const daysInput = el('input', { class: 'input', type: 'number', min: '1', step: '1', placeholder: 'bv. 3', inputmode: 'numeric' }) as HTMLInputElement;
  kmInput.addEventListener('input', () => { lastEtapEdit = 'km'; });
  daysInput.addEventListener('input', () => { lastEtapEdit = 'days'; });
  const autoBtn = el('button', { type: 'button', class: 'btn btn-sm etap-auto', onclick: () => autoDistribute() }, svgEl(icons.route), 'Verdeel automatisch');
  const etapList = el('div', { class: 'etap-list' });
  const etapTotal = el('div', { class: 'etap-total' });
  const fullChk = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const etapSaveBtn = el('button', { type: 'button', class: 'btn btn-primary etap-save', onclick: () => saveEtappes() }, svgEl(icons.save), 'Bewaar route');
  const etapPanel = el('div', { class: 'card plan-etap', style: 'display:none' },
    el('div', { class: 'etap-head' },
      el('strong', {}, 'Dagetappes'),
      el('span', { class: 'etap-sub' }, 'Verdeel je route in dagen'),
    ),
    el('div', { class: 'etap-inputs' },
      el('label', { class: 'field etap-field' }, el('span', {}, 'km per dag'), kmInput),
      el('label', { class: 'field etap-field' }, el('span', {}, 'aantal dagen'), daysInput),
    ),
    autoBtn,
    el('p', { class: 'etap-tip' }, 'Klik op de lijn om zelf een splitsing te zetten; klik een splitsmarker om ze te verwijderen.'),
    etapList,
    etapTotal,
    el('label', { class: 'etap-chk' }, fullChk, el('span', {}, 'Ook de volledige route bewaren')),
    etapSaveBtn,
  );

  // Hint tijdens het kiezen van A/B (los van de gewone begin-hint).
  const pickHintText = el('div', {}, '');
  const pickHint = el('div', { class: 'plan-hint plan-pickhint', style: 'display:none' }, svgEl(icons.flag), pickHintText);

  const topleft = el('div', { class: 'plan-topleft' }, knownBtn, searchWrap, sportPicker);
  holder.append(
    topleft,
    el('div', { class: 'plan-topright' }, actions),
    hint,
    pickHint,
    statsCard,
    etapPanel,
  );

  // panelen mogen de kaart niet aansturen
  for (const p of [knownBtn, searchWrap, sportPicker, actions, statsCard, etapPanel]) {
    L.DomEvent.disableClickPropagation(p);
    L.DomEvent.disableScrollPropagation(p);
  }

  map.on('click', async (e: L.LeafletMouseEvent) => {
    if (ignoreNextMapClick) { ignoreNextMapClick = false; return; }
    if (pickingActive()) { handlePickClick(e.latlng.lng, e.latlng.lat); return; }
    if (loadedRoute) {
      const ok = await confirmDialog('Geladen route vervangen?',
        'Wil je de geladen route vervangen door een eigen route? Je begint dan met een leeg plan.', 'Ja, eigen route');
      if (!ok) return;
      exitLoadedMode();
    }
    // Bewerken i.p.v. bouwen: klik je vlakbij de bestaande route (< 1 km),
    // dan bedoel je vrijwel zeker een TUSSENSTOP — niet een nieuw eindpunt.
    // Shift+klik forceert altijd een nieuw eindpunt.
    if (waypoints.length >= 2 && !e.originalEvent.shiftKey) {
      const buurt = dichtsteLeg(e.latlng.lng, e.latlng.lat);
      // Tolerantie schaalt mee met het zoomniveau: wat er op het SCHERM
      // dichtbij uitziet (±35 px), telt als dichtbij — ingezoomd op een dorp
      // is dat ~100 m, uitgezoomd op de hele tocht gerust een paar km.
      const mPerPx = 40075016.686 * Math.abs(Math.cos((e.latlng.lat * Math.PI) / 180)) /
        Math.pow(2, map.getZoom() + 8);
      const tolM = Math.min(20000, Math.max(1000, 35 * mPerPx));
      if (buurt && buurt.distM < tolM) {
        insertVia(buurt.leg, e.latlng.lng, e.latlng.lat);
        toast('Tussenstop toegevoegd. (Shift+klik = nieuw eindpunt)');
        return;
      }
    }
    addPoint(e.latlng.lng, e.latlng.lat);
  });

  // Dichtstbijzijnde leg (berekend spoor) bij een kaartpunt.
  function dichtsteLeg(lon: number, lat: number): { leg: number; distM: number } | null {
    let best: { leg: number; distM: number } | null = null;
    for (let i = 0; i < legTracks.length; i++) {
      const t = legTracks[i];
      if (!t || t.length < 2) continue;
      const { distM } = nearestPointIndex(t, lon, lat);
      if (!best || distM < best.distM) best = { leg: i, distM };
    }
    return best;
  }

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
    const prev = waypoints[i];
    const wp: Waypoint = { lon: ll.lng, lat: ll.lat };
    if (prev.beeline) wp.beeline = true;
    if (prev.etappe) wp.etappe = true;
    waypoints[i] = wp;
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
    const newWps: Waypoint[] = waypoints.slice().reverse().map((w) => {
      const o: Waypoint = { lon: w.lon, lat: w.lat };
      if (w.etappe) o.etappe = true;
      return o;
    });
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

  function catLabel(cat: string | null): string | null {
    switch (cat) {
      case 'uitzicht': return 'Uitzicht';
      case 'rustpunt': return 'Rustpunt';
      case 'horeca': return 'Café/horeca';
      case 'bezienswaardig': return 'Bezienswaardig';
      case 'trail': return 'Toffe trail';
      default: return null;
    }
  }

  function drawHighlights(list: Highlight[]) {
    if (!hlLayer) return;
    hlLayer.clearLayers();
    let shown = 0;
    for (const h of list) {
      if (!h.track || h.track.length < 1) continue;
      if (h.track.length === 1) {
        // Punt-highlight (POI): enkel het vlag-markertje op het punt.
        const p = h.track[0];
        L.marker([p[1], p[0]], { icon: flagIcon, title: catLabel(h.category) || h.name })
          .bindPopup(hlPopup(h)).addTo(hlLayer);
      } else {
        // Segment: oranje lijn met een vlag op het middelpunt.
        L.polyline(trackToLatLngs(h.track), HL_STYLE).addTo(hlLayer);
        const mid = h.track[Math.floor(h.track.length / 2)];
        L.marker([mid[1], mid[0]], { icon: flagIcon, title: catLabel(h.category) || h.name })
          .bindPopup(hlPopup(h)).addTo(hlLayer);
      }
      shown++;
    }
    maybeEmptyHint(shown);
  }

  // Eenmalige hint per sessie wanneer de toggle aan staat maar het gebied leeg is.
  function maybeEmptyHint(count: number) {
    if (!hlOn || count > 0) return;
    let already = false;
    try { already = sessionStorage.getItem('gout.hlEmptyHint') === '1'; } catch { /* privémodus */ }
    if (already) return;
    try { sessionStorage.setItem('gout.hlEmptyHint', '1'); } catch { /* privémodus */ }
    toast('Nog geen highlights in dit gebied. Markeer er zelf één via een route → Highlight markeren.');
  }

  // 'Voeg toe aan route': punt-highlight = 1 waypoint, segment = begin/midden/eind (3),
  // met de richting zo gekozen dat het beginpunt het dichtst bij het huidige route-einde ligt.
  function addHighlightToRoute(h: Highlight) {
    if (loadedRoute) { toast('Verlaat eerst de geladen route om highlights toe te voegen.', 'error'); return; }
    const track = h.track;
    if (!track || track.length < 1) return;
    const pts: [number, number][] = [];
    if (track.length === 1) {
      pts.push([track[0][0], track[0][1]]);
    } else {
      const a = track[0];
      const b = track[track.length - 1];
      const mid = track[Math.floor(track.length / 2)];
      let ordered: TrackPoint[] = [a, mid, b];
      const end = waypoints.length ? waypoints[waypoints.length - 1] : null;
      if (end) {
        const dA = haversine(end.lon, end.lat, a[0], a[1]);
        const dB = haversine(end.lon, end.lat, b[0], b[1]);
        if (dB < dA) ordered = [b, mid, a];
      }
      for (const p of ordered) pts.push([p[0], p[1]]);
    }
    pushUndo(); // één undo-stap voor de hele toevoeging
    for (const [lon, lat] of pts) {
      const wp: Waypoint = { lon, lat };
      if (waypoints.length >= 1 && beelineMode) wp.beeline = true;
      waypoints.push(wp);
      if (waypoints.length >= 2) legTracks.push(null);
    }
    afterChange();
    toast('Highlight opgenomen in je route.');
  }

  function hlPopup(h: Highlight): HTMLElement {
    const ic = h.sport === 'alle' ? icons.flag : sportIcon(h.sport);
    const lbl = h.sport === 'alle' ? 'Alle sporten' : sportLabel(h.sport);
    const cat = catLabel(h.category);
    return el('div', { class: 'hl-popup' },
      el('strong', { class: 'hl-pop-name' }, h.name),
      cat ? el('div', { class: 'hl-pop-cat' }, cat) : null,
      el('div', { class: 'hl-pop-meta' },
        svgEl(ic), el('span', {}, lbl),
        el('span', { class: 'hl-pop-sep' }, '·'),
        el('span', {}, `${h.votes} ${h.votes === 1 ? 'stem' : 'stemmen'}`),
      ),
      h.description ? el('p', { class: 'hl-pop-desc' }, h.description) : null,
      el('button', { type: 'button', class: 'btn btn-primary btn-sm hl-pop-add',
        onclick: () => { addHighlightToRoute(h); map.closePopup(); } }, svgEl(icons.plus), 'Voeg toe aan route'),
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
    return loadedRoute ? etappeTrack() : assembleTrack();
  }

  /* ---- etappe-markers: een gewone via promoveren tot dagetappe-einde ---- */
  // Indices van de middenwaypoints die als dagetappe-einde zijn gemarkeerd.
  function etappeIndices(): number[] {
    const out: number[] = [];
    for (let i = 1; i < waypoints.length - 1; i++) if (waypoints[i].etappe) out.push(i);
    return out;
  }

  // Afstand per dag = som van de leg-afstanden tussen de grenzen; laatste dag tot B.
  // Een dag met een nog-ladende leg (null) geeft null → '…' in de dagenlijst.
  function dayDistances(): (number | null)[] {
    const idx = etappeIndices();
    if (!idx.length) return [];
    const bounds = [0, ...idx, waypoints.length - 1];
    const out: (number | null)[] = [];
    for (let d = 0; d < bounds.length - 1; d++) {
      let sum = 0; let loading = false;
      for (let leg = bounds[d]; leg < bounds[d + 1]; leg++) {
        const t = legTracks[leg];
        if (!t || t.length < 2) { loading = true; break; }
        sum += trackDistance(t);
      }
      out.push(loading ? null : sum);
    }
    return out;
  }

  function renderDaysBar() {
    const dists = dayDistances();
    if (dists.length < 2) { daysBar.style.display = 'none'; daysBar.replaceChildren(); return; }
    const parts: Node[] = [];
    dists.forEach((d, i) => {
      if (i > 0) parts.push(el('span', { class: 'plan-days-sep' }, '·'));
      parts.push(el('span', { class: 'plan-day' },
        el('b', {}, 'Dag ' + (i + 1)), ' — ' + (d === null ? '…' : fmtKm(d))));
    });
    daysBar.replaceChildren(...parts);
    daysBar.style.display = '';
  }

  // Track van één dag: de samengestelde legs tussen twee waypoint-grenzen.
  function assembleDayTrack(bStart: number, bEnd: number): TrackPoint[] {
    const out: TrackPoint[] = [];
    for (let i = bStart; i < bEnd; i++) {
      const leg = legTracks[i] || beelineLeg(waypoints[i], waypoints[i + 1]);
      if (out.length === 0) out.push(...leg);
      else out.push(...leg.slice(1));
    }
    return out;
  }

  // Opslaan als losse dagroutes: per dag een route '{naam} — dag {i}'.
  async function saveDayRoutes(baseName: string) {
    const idx = etappeIndices();
    const bounds = [0, ...idx, waypoints.length - 1];
    const n = bounds.length - 1;
    let saved = 0;
    let region: string | null = null;
    try {
      for (let d = 0; d < n; d++) {
        const bStart = bounds[d], bEnd = bounds[d + 1];
        const track = assembleDayTrack(bStart, bEnd);
        if (track.length < 2) throw new Error('lege dag');
        // Grenspunt = eindpunt van dag d én startpunt van dag d+1; de etappe-vlag
        // gaat NIET mee de dagroute in. beeline hoort bij de inkomende leg, dus
        // die valt weg op het startpunt (k === 0) van elke dagroute.
        const dayWps = waypoints.slice(bStart, bEnd + 1).map((w, k) => {
          const o: Waypoint = { lon: w.lon, lat: w.lat };
          if (k > 0 && w.beeline) o.beeline = true;
          return o;
        });
        if (d === 0) region = await bestRegion(track[0][0], track[0][1]);
        const suffix = ` — dag ${d + 1}`;
        const base = baseName.slice(0, Math.max(1, 120 - suffix.length));
        await api.post<{ route: RouteFull }>('/api/routes', {
          name: base + suffix, sport, waypoints: dayWps, track, region: d === 0 ? region : null,
        });
        saved++;
      }
    } catch {
      toast(`${saved} van ${n} dagroutes bewaard; opslaan is onderweg misgelopen.`, 'error');
      if (saved > 0) navigate('/routes');
      return;
    }
    toast(`${n} dagroutes bewaard.`);
    navigate('/routes');
  }

  function updateStats() {
    if (loadedRoute) {
      distV.textContent = fmtKm(trackDistance(etappeTrack()));
      durV.textContent = '—'; durV.title = 'Geen hoogtedata: tijd niet te schatten';
      upV.textContent = '—'; upV.title = 'Geen hoogtedata beschikbaar voor bekende routes';
      downV.textContent = '—'; downV.title = 'Geen hoogtedata beschikbaar voor bekende routes';
      diffHolder.replaceChildren(
        el('span', { class: 'badge badge-neutral plan-loaded-badge', title: 'Geladen route uit de bibliotheek — bewaar of download' },
          'Geladen: ' + loadedRoute.name + (loadedRoute.ref ? ' · ' + loadedRoute.ref : '') + (subTrack ? ' · deel' : '')),
      );
      daysBar.style.display = 'none';
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
    renderDaysBar();
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
    updateBranchBar();
    updateEtapUi();
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

  // Etappe-marker: oranje 'mini-eindpunt' met het dagnummer (iets groter dan een via).
  function etappeIcon(day: number): L.DivIcon {
    const size = 25;
    return L.divIcon({
      className: '',
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      html: `<div class="wpt-icon wpt-etappe">${day}</div>`,
    });
  }

  // Mini-menu op een via-marker: promoveren/degraderen tot dagetappe-einde of wissen.
  function openViaMenu(i: number, m: L.Marker) {
    const isEt = !!waypoints[i].etappe;
    const menu = el('div', { class: 'plan-wpt-menu' },
      el('button', { type: 'button', class: 'plan-wpt-menu-btn', onclick: () => {
        map.closePopup();
        pushUndo();
        if (isEt) delete waypoints[i].etappe; else waypoints[i].etappe = true;
        afterChange();
      } }, svgEl(icons.flag), isEt ? 'Maak gewone tussenstop' : 'Maak einde dagetappe'),
      el('button', { type: 'button', class: 'plan-wpt-menu-btn plan-wpt-menu-danger', onclick: () => {
        map.closePopup();
        removeWaypoint(i);
      } }, svgEl(icons.trash), 'Verwijder punt'),
    );
    L.popup({ closeButton: false, className: 'plan-wpt-popup', offset: [0, -6] })
      .setLatLng(m.getLatLng())
      .setContent(menu)
      .openOn(map);
  }

  function redraw() {
    legLayer.clearLayers();
    markerLayer.clearLayers();

    if (loadedRoute) {
      const full = loadedRoute.track;
      const active = etappeTrack();
      const canEdit = !pickingActive(); // buiten de kies-modus is de lijn klikbaar voor splits

      // Niet-actieve takken gedimd tekenen; klikken activeert die tak. Tijdens
      // het A/B-kiezen staan ze op non-interactive zodat de klik niet botst.
      if (branches.length >= 2) {
        branches.forEach((b, i) => {
          if (i === activeBranch) return;
          const poly = L.polyline(trackToLatLngs(b.track), { ...BRANCH_DIM_STYLE, interactive: canEdit }).addTo(legLayer);
          if (canEdit) {
            poly.on('click', () => {
              ignoreNextMapClick = true;
              queueMicrotask(() => { ignoreNextMapClick = false; });
              switchBranch(i);
            });
          }
        });
      }

      // Buiten het gekozen deel blijft de volledige lijn gedimd zichtbaar.
      if (subTrack) {
        L.polyline(trackToLatLngs(full), { ...DIM_STYLE, interactive: false }).addTo(legLayer);
      }
      // Actieve route (deel of volledige geladen route) met witte casing.
      L.polyline(trackToLatLngs(active), { ...ROUTE_CASING, interactive: false }).addTo(legLayer);
      const line = L.polyline(trackToLatLngs(active), { ...ROUTE_STYLE, interactive: canEdit }).addTo(legLayer);
      if (canEdit) {
        line.on('click', (e: L.LeafletMouseEvent) => {
          ignoreNextMapClick = true;
          queueMicrotask(() => { ignoreNextMapClick = false; });
          addSplitAt(e.latlng.lng, e.latlng.lat);
        });
      }

      if (canEdit) {
        const a0 = active[0], b0 = active[active.length - 1];
        L.marker([a0[1], a0[0]], { icon: waypointIcon('start'), interactive: false }).addTo(markerLayer);
        L.marker([b0[1], b0[0]], { icon: waypointIcon('end'), interactive: false }).addTo(markerLayer);
        // Genummerde splitmarkers (via-stijl) — klik = verwijderen.
        splits.forEach((idx, i) => {
          if (idx <= 0 || idx >= active.length - 1) return;
          const p = active[idx];
          const m = L.marker([p[1], p[0]], { icon: waypointIcon('via', String(i + 1)) });
          m.on('click', () => {
            ignoreNextMapClick = true;
            queueMicrotask(() => { ignoreNextMapClick = false; });
            removeSplit(i);
          });
          m.addTo(markerLayer);
        });
      } else if (pickA !== null) {
        // Tijdens het kiezen: toon enkel de reeds gekozen A.
        const pa = full[pickA];
        L.marker([pa[1], pa[0]], { icon: waypointIcon('start'), interactive: false }).addTo(markerLayer);
      }
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
    let dayN = 0;
    for (let i = 0; i < n; i++) {
      const isStart = i === 0;
      const isEnd = i === n - 1;
      const isEtappe = !isStart && !isEnd && !!waypoints[i].etappe;
      let icon: L.DivIcon;
      if (isStart) icon = waypointIcon('start');
      else if (isEnd) icon = waypointIcon('end');
      else if (isEtappe) icon = etappeIcon(++dayN);
      else icon = waypointIcon('via', String(++viaN));
      const center: L.LatLngExpression = [waypoints[i].lat, waypoints[i].lon];
      const m = L.marker(center, { icon, draggable: true, autoPan: true });
      m.on('dragend', () => onDragEnd(i, m));
      m.on('click', () => {
        ignoreNextMapClick = true;
        queueMicrotask(() => { ignoreNextMapClick = false; });
        // Klik op de START met >=2 punten sluit de lus; enkel bij exact 1 punt
        // verwijdert een klik het startpunt nog.
        if (isStart && waypoints.length >= 2) { closeLoop(false); return; }
        // Via's (gewoon of etappe) openen een mini-menu i.p.v. meteen te wissen.
        if (!isStart && !isEnd) { openViaMenu(i, m); return; }
        removeWaypoint(i);
      });
      m.addTo(markerLayer);
    }
  }

  /* ------------------------- dagetappes (deel kiezen + verdelen) ------------------------- */
  function etappeTrack(): TrackPoint[] {
    if (!loadedRoute) return [];
    return subTrack || loadedRoute.track;
  }

  function pickingActive(): boolean {
    return pickState === 'a' || pickState === 'b';
  }

  function resetEtappe() {
    pickState = 'idle';
    pickA = null; pickB = null;
    subTrack = null;
    splits = [];
    lastEtapEdit = 'km';
    kmInput.value = '25';
    daysInput.value = '';
    fullChk.checked = false;
    pickHint.style.display = 'none';
  }

  function setPickHint(text: string) {
    pickHintText.textContent = text;
    pickHint.style.display = '';
  }

  function onPartBtn() {
    if (!loadedRoute) return;
    if (pickingActive()) cancelPick();
    else startPick();
  }

  function startPick() {
    pickState = 'a';
    pickA = null; pickB = null;
    subTrack = null;
    splits = [];
    setPickHint('Klik het beginpunt van jouw stuk');
    afterChange();
  }

  function cancelPick() {
    pickState = 'idle';
    pickA = null; pickB = null;
    pickHint.style.display = 'none';
    afterChange();
  }

  function handlePickClick(lon: number, lat: number) {
    if (!loadedRoute) return;
    const idx = nearestPointIndex(loadedRoute.track, lon, lat).index;
    if (pickState === 'a') {
      pickA = idx;
      pickState = 'b';
      setPickHint('Klik het eindpunt');
      afterChange();
    } else if (pickState === 'b') {
      if (pickA === null || idx === pickA) { toast('Kies een eindpunt verder van het begin.'); return; }
      pickB = idx;
      finalizePick();
    }
  }

  function finalizePick() {
    if (!loadedRoute || pickA === null || pickB === null) return;
    const track = loadedRoute.track;
    const lo = Math.min(pickA, pickB);
    const hi = Math.max(pickA, pickB);
    let slice = track.slice(lo, hi + 1);
    if (pickA > pickB) slice = slice.slice().reverse();
    subTrack = slice;
    splits = [];
    pickState = 'idle';
    pickA = null; pickB = null;
    pickHint.style.display = 'none';
    afterChange();
    toast('Deel gekozen: ' + fmtKm(trackDistance(slice)) + '.');
  }

  // Dichtstbijzijnde trackpunt-index bij een cumulatieve afstand.
  function indexAtDistance(cum: number[], atM: number): number {
    if (atM <= 0) return 0;
    const last = cum.length - 1;
    if (atM >= cum[last]) return last;
    let lo = 0, hi = last;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= atM) lo = mid; else hi = mid;
    }
    return (atM - cum[lo] <= cum[hi] - atM) ? lo : hi;
  }

  function addSplitAt(lon: number, lat: number) {
    const active = etappeTrack();
    if (active.length < 3) return;
    const idx = nearestPointIndex(active, lon, lat).index;
    if (idx <= 0 || idx >= active.length - 1) return;
    if (splits.includes(idx)) return;
    splits = [...splits, idx].sort((a, b) => a - b);
    afterChange();
  }

  function removeSplit(i: number) {
    if (i < 0 || i >= splits.length) return;
    splits = splits.filter((_, k) => k !== i);
    afterChange();
  }

  function autoDistribute() {
    const active = etappeTrack();
    if (active.length < 2) { toast('Er is nog geen route om te verdelen.', 'error'); return; }
    const cum = cumulative(active);
    const total = cum[cum.length - 1];
    let n: number;
    if (lastEtapEdit === 'days') {
      n = Math.max(1, Math.floor(Number(daysInput.value) || 1));
    } else {
      const per = Math.max(5, Number(kmInput.value) || 25) * 1000;
      n = Math.max(1, Math.round(total / per));
    }
    const MIN = 2000; // geen splits < 2 km van elkaar of van begin/eind
    const out: number[] = [];
    let lastM = 0;
    for (let k = 1; k < n; k++) {
      const idx = indexAtDistance(cum, (total * k) / n);
      if (idx <= 0 || idx >= active.length - 1) continue;
      const dM = cum[idx];
      if (dM - lastM < MIN || total - dM < MIN) continue;
      if (out.length && idx === out[out.length - 1]) continue;
      out.push(idx);
      lastM = dM;
    }
    splits = out;
    const days = splits.length + 1;
    daysInput.value = String(days);
    kmInput.value = String(Math.max(1, Math.round(total / days / 1000)));
    afterChange();
  }

  function etapBoundaries(): number[] {
    const active = etappeTrack();
    if (active.length < 2) return [];
    return [0, ...splits, active.length - 1];
  }

  function etapSlices(): TrackPoint[][] {
    const active = etappeTrack();
    const b = etapBoundaries();
    const out: TrackPoint[][] = [];
    for (let i = 0; i < b.length - 1; i++) out.push(active.slice(b[i], b[i + 1] + 1));
    return out;
  }

  function renderEtapList() {
    const active = etappeTrack();
    etapList.replaceChildren();
    if (active.length < 2) { etapTotal.replaceChildren(); return; }
    const cum = cumulative(active);
    const b = etapBoundaries();
    let total = 0;
    for (let i = 0; i < b.length - 1; i++) {
      const distM = cum[b[i + 1]] - cum[b[i]];
      total += distM;
      etapList.append(el('div', { class: 'etap-row' },
        el('span', { class: 'etap-day' }, 'Dag ' + (i + 1)),
        el('span', { class: 'etap-km' }, fmtKm(distM)),
      ));
    }
    const days = b.length - 1;
    etapTotal.replaceChildren(
      el('span', {}, days + (days === 1 ? ' dag' : ' dagen')),
      el('span', {}, 'Totaal ' + fmtKm(total)),
    );
  }

  function positionEtapPanel() {
    if (etapPanel.style.display === 'none') return;
    if (window.matchMedia('(max-width: 760px)').matches) {
      const h = statsCard.getBoundingClientRect().height;
      etapPanel.style.bottom = (h > 0 ? h + 8 : 96) + 'px';
    } else {
      etapPanel.style.bottom = '';
    }
  }

  function updateEtapUi() {
    if (!loadedRoute) {
      partBtn.style.display = 'none';
      etapPanel.style.display = 'none';
      return;
    }
    partBtn.style.display = '';
    partBtn.replaceChildren(svgEl(icons.flag),
      pickingActive() ? 'Stop kiezen' : subTrack ? 'Opnieuw kiezen' : 'Kies je deel');
    partBtn.classList.toggle('active', pickingActive());
    // Tijdens het A/B-kiezen wijkt het dagetappepaneel: anders bedekt het (vooral
    // op mobiel) de onderste kaart en de kies-hint. Het komt terug zodra het deel
    // gekozen of het kiezen geannuleerd is.
    if (pickingActive()) { etapPanel.style.display = 'none'; return; }
    etapPanel.style.display = '';
    renderEtapList();
    const n = splits.length + 1;
    etapSaveBtn.replaceChildren(svgEl(icons.save), n === 1 ? 'Bewaar route' : ('Bewaar ' + n + ' dagetappes'));
    positionEtapPanel();
  }

  async function bestRegion(lon: number, lat: number): Promise<string | null> {
    try {
      const r = await api.get<{ region: string | null }>(`/api/revgeocode?lat=${lat}&lon=${lon}`);
      return r.region;
    } catch { return null; }
  }

  async function saveEtappes() {
    if (!loadedRoute) return;
    const slices = etapSlices();
    if (!slices.length || slices.some((s) => s.length < 2)) {
      toast('Er is nog geen bruikbare route om te bewaren.', 'error');
      return;
    }
    const n = slices.length;
    const routeName = loadedRoute.name;
    const cum = cumulative(etappeTrack());
    const b = etapBoundaries();
    const lines: string[] = [];
    for (let i = 0; i < n; i++) lines.push(`Dag ${i + 1}: ${fmtKm(cum[b[i + 1]] - cum[b[i]])}`);
    const shown = lines.slice(0, 8).join('\n') + (lines.length > 8 ? '\n…' : '');
    const summary = (n === 1 ? 'Je bewaart deze route als één route.' : `Je bewaart ${n} dagetappes als aparte routes.`)
      + '\n\n' + shown
      + (fullChk.checked ? '\n\n+ de volledige route apart.' : '');
    const confirmLabel = n === 1 ? 'Bewaar route' : `Bewaar ${n} dagetappes`;
    const ok = await confirmDialog(n === 1 ? 'Route bewaren?' : `${n} dagetappes bewaren?`, summary, confirmLabel);
    if (!ok) return;

    etapSaveBtn.disabled = true;
    etapSaveBtn.replaceChildren('Bezig met bewaren…');

    let saved = 0;
    let region: string | null = null;
    try {
      for (let i = 0; i < n; i++) {
        const slice = slices[i];
        if (i === 0) region = await bestRegion(slice[0][0], slice[0][1]);
        const suffix = ` — dag ${i + 1}`;
        const base = routeName.slice(0, Math.max(1, 120 - suffix.length));
        const name = n === 1 ? routeName.slice(0, 120) : base + suffix;
        await api.post<{ route: RouteFull }>('/api/routes', {
          name, sport, waypoints: null, track: slice, region: i === 0 ? region : null,
        });
        saved++;
      }
    } catch {
      etapSaveBtn.disabled = false;
      updateEtapUi();
      toast(`${saved} van ${n} dagetappe(s) bewaard; opslaan is onderweg misgelopen.`, 'error');
      if (saved > 0) navigate('/routes');
      return;
    }

    if (fullChk.checked) {
      try {
        const full = loadedRoute.track;
        const fullRegion = await bestRegion(full[0][0], full[0][1]);
        await api.post<{ route: RouteFull }>('/api/routes', {
          name: routeName.slice(0, 120), sport, waypoints: null, track: full, region: fullRegion,
        });
      } catch {
        toast('De dagetappes zijn bewaard, maar de volledige route niet.', 'error');
      }
    }

    toast(n === 1 ? 'Route bewaard.' : `${n} dagetappes bewaard.`);
    navigate('/routes');
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
    let loadStatusTimer: ReturnType<typeof setInterval> | undefined;
    let loadSecTimer: ReturnType<typeof setInterval> | undefined;
    let loadAbort: AbortController | null = null;
    function stopLoadingTimers() {
      if (loadStatusTimer) { clearInterval(loadStatusTimer); loadStatusTimer = undefined; }
      if (loadSecTimer) { clearInterval(loadSecTimer); loadSecTimer = undefined; }
    }
    const close = modal(box, { onClose: () => { stopLoadingTimers(); loadAbort?.abort(); closeKnownModal = null; } });
    // Voor de view-cleanup: bij wegnavigeren tijdens het laden sluit dit de modal,
    // breekt de fetch af en stopt de tikkende timers (geen weesmodal/timers).
    closeKnownModal = () => { stopLoadingTimers(); loadAbort?.abort(); close(); };
    // Sluitknop onderaan, consistent met de andere modals.
    box.append(el('div', { class: 'modal-actions' },
      el('button', { type: 'button', class: 'btn', onclick: () => close() }, 'Sluiten')));
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

    function backToResults() {
      const q = input.value.trim();
      if (q.length >= 2) { showSpinner(); doKnownSearch(q); }
      else list.replaceChildren(el('div', { class: 'kr-empty' }, 'Typ hierboven of kies een route om te beginnen.'));
    }

    // Verzorgd laadpaneel: kronkelende route-animatie + wisselende statusregels
    // + secondenteller. Puur CSS-animatie; hier enkel de tekst-intervallen.
    function showLoadingPanel() {
      const statusP = el('p', { class: 'kr-load-status' }, KNOWN_LOAD_STATUS[0]);
      const timerP = el('span', { class: 'kr-load-timer' }, 'al 0s bezig');
      const walker = el('div', { class: 'kr-walker' }, svgEl(icons.walk));
      list.replaceChildren(el('div', { class: 'kr-loading' },
        el('div', { class: 'kr-anim', html: KNOWN_LOAD_SVG }, walker),
        statusP,
        el('p', { class: 'kr-load-note' },
          'Lange routes zoals een camino kunnen tot een minuut duren. Eenmaal geladen gaat het daarna in één tel.'),
        timerP,
        el('button', { type: 'button', class: 'btn btn-ghost kr-load-cancel', onclick: () => loadAbort?.abort() }, 'Annuleren'),
      ));
      const startedAt = Date.now();
      let si = 0;
      loadStatusTimer = setInterval(() => {
        if (si < KNOWN_LOAD_STATUS.length - 1) { si++; statusP.textContent = KNOWN_LOAD_STATUS[si]; }
      }, 4000);
      loadSecTimer = setInterval(() => {
        timerP.textContent = `al ${Math.round((Date.now() - startedAt) / 1000)}s bezig`;
      }, 1000);
    }

    function showLoadError(id: number, msg: string) {
      list.replaceChildren(el('div', { class: 'kr-load-error' },
        el('p', { class: 'kr-load-errmsg' }, msg),
        el('div', { class: 'kr-load-erractions' },
          el('button', { type: 'button', class: 'btn btn-ghost', onclick: backToResults }, 'Terug'),
          el('button', { type: 'button', class: 'btn btn-primary', onclick: () => loadKnown(id) }, 'Probeer opnieuw'),
        ),
      ));
    }

    async function loadKnown(id: number) {
      if (waypoints.length >= 1 || loadedRoute) {
        const ok = await confirmDialog('Route vervangen?',
          'Je huidige plan wordt vervangen door de gekozen route.', 'Vervangen');
        if (!ok) return;
      }
      input.disabled = true;
      stopLoadingTimers();
      loadAbort = new AbortController();
      showLoadingPanel();
      try {
        const res = await fetch(`/api/knownroutes/${id}?sport=${encodeURIComponent(sport)}`, { signal: loadAbort.signal });
        const text = await res.text();
        let data: any = null;
        try { data = text ? JSON.parse(text) : null; } catch { /* geen JSON */ }
        if (!res.ok) throw new Error(data?.error || `Serverfout (${res.status})`);
        if (!data || !Array.isArray(data.track) || data.track.length < 2) {
          throw new Error('Deze route bevat geen bruikbare geometrie.');
        }
        stopLoadingTimers();
        loadAbort = null;
        close();
        const loadedTrack = (data.track as [number, number][]).map((p) => [p[0], p[1]] as TrackPoint);
        const loadedChains: Branch[] | undefined = Array.isArray(data.chains)
          ? (data.chains as { track: [number, number][]; distanceM: number }[])
              .filter((c) => c && Array.isArray(c.track) && c.track.length >= 2)
              .map((c) => ({
                track: c.track.map((p) => [p[0], p[1]] as TrackPoint),
                distanceM: Number(c.distanceM) || 0,
              }))
          : undefined;
        enterLoadedMode(data.name, data.ref, loadedTrack, loadedChains);
        toast('Route geladen: ' + data.name);
      } catch (err: any) {
        stopLoadingTimers();
        input.disabled = false;
        const aborted = err?.name === 'AbortError';
        loadAbort = null;
        if (aborted) { backToResults(); return; }
        const msg = err?.message || 'Kon de route niet ophalen. Probeer opnieuw.';
        showLoadError(id, msg);
        toast(msg, 'error');
      }
    }
  }

  /* ------------------------- takken (bv. west/oost-armen) ------------------------- */
  function updateBranchBar() {
    if (!loadedRoute || branches.length < 2) {
      branchBar.style.display = 'none';
      branchChips.replaceChildren();
      return;
    }
    branchBar.style.display = '';
    branchLabel.textContent = `Deze route heeft ${branches.length} takken:`;
    branchChips.replaceChildren(
      ...branches.map((b, i) => el('button', {
        type: 'button',
        class: 'chip plan-branch-chip' + (i === activeBranch ? ' active' : ''),
        onclick: () => switchBranch(i),
      }, `Tak ${i + 1} · ${fmtKm(b.distanceM)}`)),
    );
  }

  async function switchBranch(i: number) {
    if (!loadedRoute || i < 0 || i >= branches.length || i === activeBranch) return;
    // Van tak wisselen wist een gekozen deel en de dagetappe-splits: even bevestigen.
    if (subTrack || splits.length) {
      const ok = await confirmDialog('Van tak wisselen?',
        'Je gekozen deel en dagetappes worden gewist.', 'Wisselen');
      if (!ok) return;
    }
    if (!loadedRoute || i === activeBranch) return; // kan intussen veranderd zijn
    activeBranch = i;
    loadedRoute.track = branches[i].track;
    resetEtappe();
    afterChange();
    fitToTrack(map, loadedRoute.track);
  }

  function enterLoadedMode(name: string, ref: string | null, track: TrackPoint[], chains?: Branch[]) {
    gen++; // eventuele hangende leg-berekeningen negeren
    stopBeelineIfNeeded();
    branches = (chains && chains.length >= 2) ? chains : [];
    activeBranch = 0;
    // Tak 1 (langste) is de actieve tak; loadedRoute.track = de actieve tak.
    loadedRoute = { name, ref, track: branches.length ? branches[0].track : track };
    waypoints = [];
    legTracks = [];
    undoStack.length = 0;
    redoStack.length = 0;
    editId = null;
    editMeta = { name, description: '', visibility: 'private' };
    resetEtappe();
    afterChange();
    // Bij meerdere takken: toon ze allemaal zodat je meteen kan kiezen; anders de route zelf.
    fitToTrack(map, branches.length >= 2 ? branches.flatMap((b) => b.track) : loadedRoute.track);
  }

  function stopBeelineIfNeeded() {
    if (beelineMode) toggleBeeline();
  }

  function exitLoadedMode() {
    loadedRoute = null;
    branches = [];
    activeBranch = 0;
    resetEtappe();
    updateBranchBar();
    legLayer.clearLayers();
    markerLayer.clearLayers();
    editMeta = { name: '', description: '', visibility: 'private' };
  }

  /* ------------------------- opslaan ------------------------- */
  function openSaveModal() {
    if (currentTrack().length < 2) { toast('Voeg minstens twee punten toe.', 'error'); return; }

    // Bij >=1 etappe-marker (gewone waypoint-route) mag je als losse dagroutes bewaren.
    const dayCount = loadedRoute ? 1 : etappeIndices().length + 1;
    const hasEtappes = dayCount >= 2;

    const nameInput = el('input', { class: 'input', type: 'text', maxlength: '120', value: editMeta.name, placeholder: 'bv. Ronde van het Hallerbos' });
    const descInput = el('textarea', { class: 'input', maxlength: '2000', placeholder: 'Optioneel: wat maakt deze route bijzonder?' });
    descInput.value = editMeta.description;
    const visSelect = el('select', { class: 'input' },
      el('option', { value: 'private' }, 'Privé — alleen voor jou'),
      el('option', { value: 'public' }, 'Openbaar — zichtbaar in Ontdek'),
    );
    visSelect.value = editMeta.visibility;

    // Keuze bij etappe-markers: als één route of als losse dagroutes bewaren.
    const radioOne = el('input', { type: 'radio', name: 'gout-savemode', checked: true }) as HTMLInputElement;
    const radioDays = el('input', { type: 'radio', name: 'gout-savemode' }) as HTMLInputElement;
    const modeField = hasEtappes ? el('div', { class: 'field plan-savemode' },
      el('span', {}, 'Hoe wil je bewaren?'),
      el('label', { class: 'plan-savemode-opt' }, radioOne, el('span', {}, 'Als één route bewaren')),
      el('label', { class: 'plan-savemode-opt' }, radioDays, el('span', {}, `Als ${dayCount} dagroutes bewaren`)),
    ) : null;

    const errP = el('p', { style: 'color:var(--danger);font-weight:600;min-height:1.2em;margin:.2rem 0 0;font-size:.85rem' });
    const submitBtn = el('button', { type: 'button', class: 'btn btn-primary' }, editId ? 'Opslaan' : 'Route opslaan');

    const box = el('div', {},
      el('h2', {}, editId ? 'Route bijwerken' : 'Route opslaan'),
      loadedRoute ? el('p', { class: 'kr-info' }, 'Bekende route uit de bibliotheek. Je bewaart ze als je eigen route.') : null,
      el('label', { class: 'field' }, el('span', {}, 'Naam'), nameInput),
      el('label', { class: 'field' }, el('span', {}, 'Beschrijving'), descInput),
      el('label', { class: 'field' }, el('span', {}, 'Zichtbaarheid'), visSelect),
      modeField,
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
      if (hasEtappes && radioDays.checked) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Bezig…';
        close();
        await saveDayRoutes(name);
        return;
      }
      submitBtn.disabled = true;
      submitBtn.textContent = 'Bezig…';
      try {
        const track = currentTrack();
        const wps = loadedRoute ? null : waypoints.map((w) => {
          const o: Waypoint = { lon: w.lon, lat: w.lat };
          if (w.beeline) o.beeline = true;
          if (w.etappe) o.etappe = true;
          return o;
        });
        const startLat = loadedRoute ? track[0][1] : waypoints[0].lat;
        const startLon = loadedRoute ? track[0][0] : waypoints[0].lon;
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
        waypoints = route.waypoints.map((w) => {
          const o: Waypoint = { lon: w.lon, lat: w.lat };
          if (w.beeline) o.beeline = true;
          if (w.etappe) o.etappe = true;
          return o;
        });
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
    if (e.key === 'Escape' && pickingActive()) { e.preventDefault(); cancelPick(); return; }
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
  window.addEventListener('resize', positionEtapPanel);

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
    window.removeEventListener('resize', positionEtapPanel);
    closeKnownModal?.(); // sluit een open bekende-routes-modal, stopt timers, breekt fetch af
    if (hintTimer) clearTimeout(hintTimer);
    stopGps();
    map.off('moveend', hlMoveHandler);
    elevProfile?.destroy();
    hover.remove();
    map.remove();
  };
}
