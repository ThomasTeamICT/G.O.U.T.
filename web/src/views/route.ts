// Routedetail met kaart, hoogteprofiel, delen en live volgen (voor onderweg).

import './routes.css';
import L from 'leaflet';
import { api, ApiError } from '../api';
import {
  el, svgEl, icons, toast, modal, confirmDialog,
  fmtKm, fmtM, fmtDur, fmtSpeed, fmtDate,
  difficultyBadge, sportIcon, sportLabel,
} from '../ui';
import { navigate } from '../router';
import { session } from '../main';
import {
  createMap, drawTrack, fitToTrack, positionIcon, trackToLatLngs,
  hoverMarker, waypointIcon, TRACK_DONE_STYLE,
} from '../lib/map';
import { renderElevation } from '../lib/elevation';
import { cumulative, ascentDescent, nearestPointIndex, haversine } from '../lib/geo';
import { estimateDuration } from '../lib/estimate';
import type { RouteFull, RouteSummary, TrackPoint } from '../types';

/* =========================================================================
   Deelmodal — herbruikt door de detailpagina en de kaartjes in 'Mijn routes'.
   ========================================================================= */

export function openShareModal(
  route: Pick<RouteSummary, 'id' | 'name' | 'visibility' | 'shareToken'>,
  opts: { onVisibilityChange?: (v: 'private' | 'public') => void } = {},
): void {
  let visibility = route.visibility;
  let token = route.shareToken;
  const body = el('div', {});
  const close = modal(body);

  async function setVisibility(v: 'private' | 'public') {
    if (v === visibility) return;
    try {
      await api.put(`/api/routes/${route.id}`, { visibility: v });
      visibility = v;
      route.visibility = v;
      opts.onVisibilityChange?.(v);
      toast(v === 'public' ? 'Route staat nu openbaar.' : 'Route is weer privé.');
      render();
    } catch (e) {
      toast((e as ApiError)?.message || 'Kon zichtbaarheid niet wijzigen.', 'error');
    }
  }

  async function makeLink() {
    try {
      const r = await api.post<{ shareToken: string }>(`/api/routes/${route.id}/share`);
      token = r.shareToken;
      route.shareToken = token;
      render();
    } catch (e) {
      toast((e as ApiError)?.message || 'Kon geen deellink maken.', 'error');
    }
  }

  async function stopSharing() {
    try {
      await api.del(`/api/routes/${route.id}/share`);
      token = null;
      route.shareToken = null;
      toast('Delen gestopt.');
      render();
    } catch (e) {
      toast((e as ApiError)?.message || 'Kon delen niet stoppen.', 'error');
    }
  }

  function visOption(v: 'private' | 'public', label: string, hint: string) {
    const input = el('input', { type: 'radio', name: 'vis', checked: visibility === v });
    const opt = el('label', { class: `radio-option${visibility === v ? ' active' : ''}` },
      input,
      el('div', {},
        el('div', { class: 'ro-label' }, label),
        el('div', { class: 'ro-hint' }, hint),
      ),
    );
    input.addEventListener('change', () => setVisibility(v));
    return opt;
  }

  function linkSection() {
    const link = `${location.origin}/#/s/${token}`;
    const input = el('input', { class: 'input', type: 'text', readonly: true, value: link });
    const copyBtn = el('button', { class: 'btn btn-icon', title: 'Kopieer link', onclick: async () => {
      try {
        await navigator.clipboard.writeText(link);
        toast('Link gekopieerd.');
      } catch {
        input.select();
        toast('Selecteer en kopieer de link.', 'error');
      }
    } }, svgEl(icons.copy));
    return el('div', {},
      el('div', { class: 'share-link-label' }, 'Deellink (werkt zonder account)'),
      el('div', { class: 'share-link-row' }, input, copyBtn),
      el('button', { class: 'btn btn-danger btn-sm share-stop', onclick: stopSharing },
        svgEl(icons.close), 'Stop delen'),
    );
  }

  function render() {
    body.innerHTML = '';
    body.append(
      el('h2', {}, 'Route delen'),
      el('p', { class: 'share-p' },
        'Kies wie je route mag zien. Met een deellink kan iedereen de route bekijken en de GPX downloaden, ook zonder account.'),
      visOption('private', 'Privé', 'Alleen jij ziet deze route.'),
      visOption('public', 'Openbaar', 'Openbaar verschijnt in Ontdek voor iedereen.'),
      el('hr', { class: 'share-sep' }),
      token
        ? linkSection()
        : el('button', { class: 'btn btn-green', onclick: makeLink }, svgEl(icons.share), 'Maak een deellink'),
      el('div', { class: 'modal-actions' },
        el('button', { class: 'btn', onclick: () => close() }, 'Sluiten'),
      ),
    );
  }

  render();
}

/* =========================================================================
   Detailpagina
   ========================================================================= */

export function routeView(container: HTMLElement, params: Record<string, string>) {
  let map: L.Map | null = null;
  let elev: { destroy(): void } | null = null;
  let stopLive: (() => void) | null = null;

  const root = el('div', {});
  container.append(root);
  root.append(el('div', { class: 'spinner' }));

  (async () => {
    let route: RouteFull;
    try {
      const r = await api.get<{ route: RouteFull }>(`/api/routes/${encodeURIComponent(params.id)}`);
      route = r.route;
    } catch (e) {
      root.innerHTML = '';
      const notFound = (e as ApiError)?.status === 404;
      root.append(el('main', { class: 'page' },
        el('div', { class: 'empty' },
          svgEl(icons.route),
          el('p', {}, notFound ? 'Deze route bestaat niet (meer).' : 'Kon de route niet laden.'),
          el('a', { class: 'btn btn-primary', href: '#/routes' }, 'Naar mijn routes'),
        ),
      ));
      return;
    }
    build(route);
  })();

  function build(route: RouteFull) {
    const isOwner = route.isOwner;

    root.innerHTML = '';

    /* --- kaart bovenaan --- */
    const mapHolder = el('div', { class: 'map-holder' });
    const backBtn = el('button', { class: 'btn btn-icon back-fab', title: 'Terug', onclick: () => {
      if (history.length > 1) history.back(); else navigate('/routes');
    } }, svgEl(icons.chevronL));
    const mapSection = el('div', { class: 'map-sized detail-map' }, mapHolder, backBtn);
    root.append(mapSection);

    map = createMap(mapHolder, {});
    map.zoomControl.setPosition('topright');
    drawTrack(map, route.track);
    const a = route.track[0], b = route.track[route.track.length - 1];
    L.marker([a[1], a[0]], { icon: waypointIcon('start') }).addTo(map);
    L.marker([b[1], b[0]], { icon: waypointIcon('end') }).addTo(map);
    fitToTrack(map, route.track);
    const hover = hoverMarker(map);
    setTimeout(() => { map?.invalidateSize(); if (map) fitToTrack(map, route.track); }, 60);

    /* --- inhoud --- */
    const page = el('main', { class: 'page' });
    root.append(page);

    const badgesRow = el('div', { class: 'detail-badges' });
    const renderBadges = () => {
      badgesRow.innerHTML = '';
      badgesRow.append(difficultyBadge(route.difficulty));
      if (route.visibility === 'public')
        badgesRow.append(el('span', { class: 'badge badge-public' }, svgEl(icons.globe), 'Openbaar'));
      if (route.source === 'geimporteerd')
        badgesRow.append(el('span', { class: 'badge badge-neutral' }, 'Geïmporteerd'));
    };
    renderBadges();

    page.append(
      el('div', { class: 'detail-headline' }, el('h1', {}, route.name)),
      badgesRow,
      el('div', { class: 'detail-meta' },
        el('span', { class: 'sport' }, svgEl(sportIcon(route.sport)), sportLabel(route.sport)),
        route.region ? el('span', {}, '· ' + route.region) : null,
        el('span', {}, '· ' + fmtDate(route.createdAt)),
      ),
    );
    if (route.description) page.append(el('p', { class: 'detail-desc' }, route.description));

    /* --- statistieken --- */
    const speed = route.durationS > 0 ? fmtSpeed(route.distanceM / route.durationS) : '—';
    const stat = (v: Node | string, k: string) => el('div', { class: 'stat-block' },
      el('div', { class: 'v' }, v), el('div', { class: 'k' }, k));
    page.append(el('div', { class: 'stat-grid' },
      stat(fmtKm(route.distanceM), 'Afstand'),
      stat(fmtDur(route.durationS), 'Geschatte tijd'),
      stat(el('span', {}, svgEl(icons.up), fmtM(route.ascentM)), 'Stijgen'),
      stat(el('span', {}, svgEl(icons.down), fmtM(route.descentM)), 'Dalen'),
      stat(speed, 'Gem. snelheid'),
    ));

    /* --- hoogteprofiel --- */
    page.append(el('h3', { class: 'section-title' }, 'Hoogteprofiel'));
    const elevHolder = el('div', {});
    page.append(el('div', { class: 'card elev-card' }, elevHolder));
    elev = renderElevation(elevHolder, route.track, {
      onHover: (p) => { if (p) hover.show(p.lat, p.lon); else hover.hide(); },
    });

    /* --- acties --- */
    const actions = el('div', { class: 'detail-actions' });
    page.append(actions);

    if (isOwner) {
      actions.append(
        el('button', { class: 'btn', onclick: () => navigate(`/plan?edit=${route.id}`) },
          svgEl(icons.edit), 'Bewerken'),
        el('a', { class: 'btn', href: `/api/routes/${route.id}/gpx` },
          svgEl(icons.download), 'GPX downloaden'),
        el('button', { class: 'btn', onclick: () => openShareModal(route, { onVisibilityChange: () => renderBadges() }) },
          svgEl(icons.share), 'Delen'),
        el('button', { class: 'btn btn-green', onclick: () => {
          if (stopLive) return;
          stopLive = startLive(route, () => { stopLive = null; });
        } }, svgEl(icons.play), 'Start live'),
        el('button', { class: 'btn btn-danger', onclick: async () => {
          const ok = await confirmDialog('Route verwijderen?',
            `Wil je "${route.name}" definitief verwijderen?`);
          if (!ok) return;
          try {
            await api.del(`/api/routes/${route.id}`);
            toast('Route verwijderd.');
            navigate('/routes');
          } catch (e) {
            toast((e as ApiError)?.message || 'Verwijderen mislukt.', 'error');
          }
        } }, svgEl(icons.trash), 'Verwijderen'),
      );
    } else {
      let likes = route.likes;
      let liked = route.liked;
      const likeBtn = el('button', { class: 'btn like-btn' });
      const renderLike = () => {
        likeBtn.className = `btn like-btn${liked ? ' liked' : ''}`;
        likeBtn.innerHTML = '';
        likeBtn.append(svgEl(liked ? icons.heartFill : icons.heart), el('span', {}, String(likes)));
      };
      likeBtn.addEventListener('click', async () => {
        try {
          const r = liked
            ? await api.del<{ likes: number; liked: boolean }>(`/api/routes/${route.id}/like`)
            : await api.post<{ likes: number; liked: boolean }>(`/api/routes/${route.id}/like`);
          likes = r.likes; liked = r.liked; renderLike();
        } catch (e) {
          toast((e as ApiError)?.message || 'Kon niet liken.', 'error');
        }
      });
      renderLike();
      actions.append(
        likeBtn,
        el('a', { class: 'btn btn-primary', href: `/api/routes/${route.id}/gpx` },
          svgEl(icons.download), 'GPX downloaden'),
      );
      if (route.ownerName) page.append(el('p', { class: 'share-p' }, `Route van ${route.ownerName}`));
    }
  }

  return () => {
    stopLive?.();
    elev?.destroy();
    if (map) { map.remove(); map = null; }
  };
}

/* =========================================================================
   Live volgen — fullscreen overlay met GPS, voortgang en opname.
   ========================================================================= */

function startLive(route: RouteFull, onClose: () => void): () => void {
  const track = route.track;
  const cum = cumulative(track);
  const total = cum[cum.length - 1] || 0;

  const overlay = el('div', { class: 'live-overlay' });
  const mapEl = el('div', { class: 'live-map' });
  overlay.append(mapEl);
  document.body.append(overlay);
  document.body.classList.add('live-open'); // tilt toasts boven het voortgangspaneel

  const liveMap = createMap(mapEl, {});
  liveMap.zoomControl.setPosition('topright');
  drawTrack(liveMap, track);
  const a = track[0], b = track[track.length - 1];
  L.marker([a[1], a[0]], { icon: waypointIcon('start') }).addTo(liveMap);
  L.marker([b[1], b[0]], { icon: waypointIcon('end') }).addTo(liveMap);
  fitToTrack(liveMap, track);
  setTimeout(() => liveMap.invalidateSize(), 60);

  let posMarker: L.Marker | null = null;
  let accCircle: L.Circle | null = null;
  let doneLine: L.Polyline | null = null;

  let follow = true;
  let recording = false;
  let recorded: TrackPoint[] = [];
  let startedAt: string | null = null;
  let closed = false;
  let hasFix = false;         // ooit een geldige GPS-positie ontvangen?
  let warnedNoAccess = false; // 'geen toegang'-toast al één keer getoond?

  /* --- bovenbalk --- */
  const followBtn = el('button', { class: 'btn btn-icon live-follow active', title: 'Auto-volgen' },
    svgEl(icons.locate));
  followBtn.addEventListener('click', () => {
    follow = !follow;
    followBtn.classList.toggle('active', follow);
    if (follow && posMarker) liveMap.setView(posMarker.getLatLng());
  });
  const closeBtn = el('button', { class: 'btn btn-icon', title: 'Sluiten',
    onclick: () => close(true) }, svgEl(icons.close));
  overlay.append(el('div', { class: 'live-top' }, closeBtn, followBtn));

  const warn = el('div', { class: 'live-warn', style: 'display:none' });
  overlay.append(warn);

  /* --- voortgangspaneel --- */
  const fill = el('i', {});
  const vDone = el('div', { class: 'v' }, '0,0 km');
  const vTogo = el('div', { class: 'v' }, fmtKm(total));
  const vPct = el('div', { class: 'v' }, '0%');
  const vAsc = el('div', { class: 'v' }, fmtM(ascentDescent(track).ascent));
  const vEta = el('div', { class: 'v' }, fmtDur(estimateDuration(route.sport, total, ascentDescent(track).ascent)));

  const recBtn = el('button', { class: 'btn btn-green live-rec' }, svgEl(icons.play), 'Opnemen');
  recBtn.addEventListener('click', () => {
    if (!recording) {
      recording = true;
      recorded = [];
      startedAt = new Date().toISOString();
      recBtn.className = 'btn live-rec on';
      recBtn.innerHTML = '';
      recBtn.append(svgEl(icons.stop), 'Stop opname');
      toast('Opname gestart.');
    } else {
      finishRecording();
    }
  });

  const cell = (v: Node, k: string) => el('div', {}, v, el('div', { class: 'k' }, k));
  overlay.append(el('div', { class: 'live-panel' },
    el('div', { class: 'live-progress' }, fill),
    el('div', { class: 'live-stats' },
      cell(vDone, 'Afgelegd'),
      cell(vTogo, 'Te gaan'),
      cell(vPct, 'Voltooid'),
      cell(vAsc, 'Klim rest.'),
      cell(vEta, 'ETA'),
    ),
    recBtn,
  ));

  /* --- geolocatie --- */
  // Voortgang mag niet naar de heenweg terugspringen op heen-en-terug-stukken:
  // zoek rond de vorige positie en val alleen globaal terug als we ver van de route zijn.
  let lastProgressIdx = 0;
  function nearestOnRoute(lon: number, lat: number) {
    const start = Math.max(0, lastProgressIdx - 30);
    const end = Math.min(track.length - 1, lastProgressIdx + 400);
    let best = lastProgressIdx, bestD = Infinity;
    for (let i = start; i <= end; i++) {
      const d = haversine(track[i][0], track[i][1], lon, lat);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (bestD > 250) return nearestPointIndex(track, lon, lat);
    return { index: best, distM: bestD };
  }

  function onPos(pos: GeolocationPosition) {
    if (closed) return;
    hasFix = true;
    const lat = pos.coords.latitude, lon = pos.coords.longitude;
    const acc = pos.coords.accuracy || 12;
    const alt = pos.coords.altitude;

    if (!posMarker) posMarker = L.marker([lat, lon], { icon: positionIcon() }).addTo(liveMap);
    else posMarker.setLatLng([lat, lon]);
    if (!accCircle) accCircle = L.circle([lat, lon], { radius: acc, color: '#2b6fe0', weight: 1, fillColor: '#2b6fe0', fillOpacity: 0.12 }).addTo(liveMap);
    else { accCircle.setLatLng([lat, lon]); accCircle.setRadius(acc); }
    if (follow) liveMap.setView([lat, lon]);

    const { index, distM } = nearestOnRoute(lon, lat);
    lastProgressIdx = index;
    const done = cum[index];
    const togo = Math.max(0, total - done);
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const rest = track.slice(index);
    const restAsc = ascentDescent(rest).ascent;

    if (index > 0) {
      const donePts = trackToLatLngs(track.slice(0, index + 1));
      if (!doneLine) doneLine = L.polyline(donePts, TRACK_DONE_STYLE).addTo(liveMap);
      else doneLine.setLatLngs(donePts);
    }

    if (distM > 150) {
      warn.style.display = '';
      const afst = distM >= 1000 ? fmtKm(distM) : `${Math.round(distM)} m`;
      warn.textContent = `Je zit ${afst} naast de route.`;
    } else {
      warn.style.display = 'none';
    }

    fill.style.width = pct + '%';
    vDone.textContent = fmtKm(done);
    vTogo.textContent = fmtKm(togo);
    vPct.textContent = pct + '%';
    vAsc.textContent = fmtM(restAsc);
    vEta.textContent = fmtDur(estimateDuration(route.sport, togo, restAsc));

    if (recording) {
      const t = pos.timestamp ? Math.round(pos.timestamp / 1000) : Math.round(Date.now() / 1000);
      const last = recorded[recorded.length - 1];
      if (!last || haversine(last[0], last[1], lon, lat) >= 2) {
        const ele = typeof alt === 'number' && !Number.isNaN(alt) ? Math.round(alt * 10) / 10 : undefined;
        recorded.push([lon, lat, ele, t]);
      }
    }
  }

  function onErr(err: GeolocationPositionError) {
    if (closed) return;
    if (hasFix) {
      // Er is al een werkende positie. Een time-out is een tijdelijke hapering: negeren.
      if (err.code === 3 /* TIMEOUT */) return;
      // Andere fouten rustig in de kaartbanner tonen, niet als storende toast.
      warn.style.display = '';
      warn.textContent = 'Locatie even kwijt…';
      return;
    }
    // Nog nooit een positie gehad (bv. permissie geweigerd): één duidelijke toast.
    if (warnedNoAccess) return;
    warnedNoAccess = true;
    toast('Geen toegang tot je locatie. Zet locatie aan en probeer opnieuw.', 'error');
  }

  let watchId: number | null = null;
  if (!('geolocation' in navigator)) {
    toast('Je toestel ondersteunt geen locatie.', 'error');
  } else {
    watchId = navigator.geolocation.watchPosition(onPos, onErr, {
      enableHighAccuracy: true, maximumAge: 2000, timeout: 20000,
    });
  }

  async function finishRecording() {
    const rec = recorded;
    const started = startedAt;
    recording = false;
    recorded = [];
    recBtn.className = 'btn btn-green live-rec';
    recBtn.innerHTML = '';
    recBtn.append(svgEl(icons.play), 'Opnemen');
    if (rec.length < 2) { toast('Te weinig punten opgenomen om te bewaren.', 'error'); return; }
    const ok = await confirmDialog('Opslaan als activiteit?',
      'Wil je deze opname bewaren als activiteit in je logboek?', 'Opslaan');
    if (!ok) return;
    try {
      const name = `${route.name} — ${fmtDate(new Date().toISOString())}`;
      await api.post('/api/activities', {
        name, sport: route.sport, track: rec, routeId: route.id, startedAt: started,
      });
      toast('Activiteit opgeslagen.');
    } catch (e) {
      toast((e as ApiError)?.message || 'Opslaan mislukt.', 'error');
    }
  }

  function close(save: boolean) {
    if (closed) return;
    closed = true;
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    if (save && recording) finishRecording();
    document.body.classList.remove('live-open');
    liveMap.remove();
    overlay.remove();
    onClose();
  }

  return () => close(false);
}
