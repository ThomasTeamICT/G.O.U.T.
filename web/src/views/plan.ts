// Routeplanner — het hart van G.O.U.T. Kaart vult de pagina, met rustige
// zwevende panelen erop: sport + zoeken, knoppenrij, statsbalk met profiel.

import './plan.css';
import L from 'leaflet';
import { api } from '../api';
import { navigate } from '../router';
import {
  el, svgEl, icons, sportIcon, SPORTS,
  fmtKm, fmtM, fmtDur, difficultyBadge, toast, modal, confirmDialog, debounce,
} from '../ui';
import {
  createMap, trackToLatLngs, fitToTrack, waypointIcon, hoverMarker,
  ROUTE_STYLE, ROUTE_CASING, BEELINE_STYLE,
} from '../lib/map';
import { trackDistance, ascentDescent, simplify } from '../lib/geo';
import { estimateDuration, difficulty } from '../lib/estimate';
import { renderElevation, type ElevationProfile } from '../lib/elevation';
import { downloadGpx } from '../lib/gpx';
import { routeLeg, beelineLeg } from '../lib/brouter';
import type { RouteFull, Sport, TrackPoint, Waypoint } from '../types';

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

  let elevProfile: ElevationProfile | null = null;
  let elevOpen = false;

  const undoStack: Waypoint[][] = [];
  const redoStack: Waypoint[][] = [];

  const LOADING_STYLE: L.PolylineOptions = { color: '#8f8c7f', weight: 2.5, opacity: 0.75, dashArray: '4 8' };

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
  const locateBtn = iconBtn(icons.locate, 'Naar mijn locatie', locateMe);
  const clearBtn = iconBtn(icons.trash, 'Alles wissen', clearAll);
  const actions = el('div', { class: 'plan-actions' },
    undoBtn, redoBtn, reverseBtn, beelineBtn, locateBtn, clearBtn);

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

  holder.append(
    el('div', { class: 'plan-topleft' }, searchWrap, sportPicker),
    el('div', { class: 'plan-topright' }, actions),
    hint,
    statsCard,
  );

  // panelen mogen de kaart niet aansturen
  for (const p of [searchWrap, sportPicker, actions, statsCard]) {
    L.DomEvent.disableClickPropagation(p);
    L.DomEvent.disableScrollPropagation(p);
  }

  map.on('click', (e: L.LeafletMouseEvent) => {
    if (ignoreNextMapClick) { ignoreNextMapClick = false; return; }
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

  function setSport(s: Sport) {
    if (s === sport) return;
    sport = s;
    for (const [k, b] of sportBtns) b.classList.toggle('active', k === s);
    for (let i = 0; i < legTracks.length; i++) if (!waypoints[i + 1].beeline) legTracks[i] = null;
    afterChange();
  }

  function toggleBeeline() {
    beelineMode = !beelineMode;
    beelineBtn.classList.toggle('active', beelineMode);
    beelineBtn.title = beelineMode ? 'Hemelsbreed staat aan' : 'Nieuwe segmenten hemelsbreed aan/uit';
  }

  function locateMe() {
    if (!navigator.geolocation) { toast('Je toestel ondersteunt geen locatiebepaling.', 'error'); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => map.setView([pos.coords.latitude, pos.coords.longitude], 14),
      () => toast('Je locatie kon niet bepaald worden.', 'error'),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }

  async function clearAll() {
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

  function updateStats() {
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
    saveBtn.disabled = !enough;
    gpxBtn.disabled = !enough;
    reverseBtn.disabled = !enough;
    clearBtn.disabled = waypoints.length === 0;
  }

  function updateElevation() {
    if (!elevOpen) return;
    elevProfile?.destroy();
    elevProfile = null;
    elevBox.replaceChildren();
    const track = assembleTrack();
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
    const track = assembleTrack();
    if (track.length < 2) { toast('Voeg eerst minstens twee punten toe.', 'error'); return; }
    downloadGpx(editMeta.name || 'Mijn route', track, sport);
  }

  /* ------------------------- tekenen ------------------------- */
  function afterChange() {
    hint.style.display = waypoints.length === 0 ? '' : 'none';
    redraw();
    updateStats();
    updateButtons();
    updateElevation();
    computeMissing();
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
        removeWaypoint(i);
      });
      m.addTo(markerLayer);
    }
  }

  /* ------------------------- opslaan ------------------------- */
  function openSaveModal() {
    if (assembleTrack().length < 2) { toast('Voeg minstens twee punten toe.', 'error'); return; }

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
        const track = assembleTrack();
        const wps = waypoints.map((w) => (w.beeline ? { lon: w.lon, lat: w.lat, beeline: true } : { lon: w.lon, lat: w.lat }));
        let region: string | null = null;
        try {
          const r = await api.get<{ region: string | null }>(`/api/revgeocode?lat=${waypoints[0].lat}&lon=${waypoints[0].lon}`);
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

  return () => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('mousedown', onDocDown);
    elevProfile?.destroy();
    hover.remove();
    map.remove();
  };
}
