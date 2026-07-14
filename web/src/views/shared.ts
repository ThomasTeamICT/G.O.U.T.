// Publieke deelpagina (#/s/:token) — bekijkbaar zonder account.

import './routes.css';
import { api, ApiError } from '../api';
import {
  el, svgEl, icons,
  fmtKm, fmtM, fmtDur, fmtSpeed, fmtDate,
  difficultyBadge, sportIcon, sportLabel,
} from '../ui';
import { createMap, drawTrack, fitToTrack, waypointIcon, hoverMarker } from '../lib/map';
import { renderElevation } from '../lib/elevation';
import type { RouteFull } from '../types';
import L from 'leaflet';

export function sharedView(container: HTMLElement, params: Record<string, string>) {
  let map: L.Map | null = null;
  let elev: { destroy(): void } | null = null;

  const header = el('div', { class: 'shared-header' },
    el('a', { class: 'logo', href: '#/login' }, el('b', {}, 'G.O.U.T.'), el('span', {}, 'gewoon op uw tempo')),
    el('a', { class: 'btn btn-primary btn-sm', href: '#/login' }, 'Zelf routes maken'),
  );
  container.append(header);

  const root = el('div', {});
  container.append(root);
  root.append(el('div', { class: 'spinner' }));

  (async () => {
    let route: RouteFull;
    try {
      const r = await api.get<{ route: RouteFull }>(`/api/shared/${encodeURIComponent(params.token)}`);
      route = r.route;
    } catch (e) {
      root.innerHTML = '';
      const notFound = (e as ApiError)?.status === 404;
      root.append(el('main', { class: 'page' },
        el('div', { class: 'empty' },
          svgEl(icons.compass),
          el('p', {}, notFound
            ? 'Deze deellink bestaat niet meer of werd ingetrokken.'
            : 'Kon deze route niet laden.'),
          el('a', { class: 'btn btn-primary', href: '#/login' }, 'Naar G.O.U.T.'),
        ),
      ));
      return;
    }
    build(route);
  })();

  function build(route: RouteFull) {
    root.innerHTML = '';

    const mapHolder = el('div', { class: 'map-holder' });
    root.append(el('div', { class: 'map-sized shared-map' }, mapHolder));

    map = createMap(mapHolder, {});
    map.zoomControl.setPosition('topright');
    drawTrack(map, route.track);
    const a = route.track[0], b = route.track[route.track.length - 1];
    L.marker([a[1], a[0]], { icon: waypointIcon('start') }).addTo(map);
    L.marker([b[1], b[0]], { icon: waypointIcon('end') }).addTo(map);
    fitToTrack(map, route.track);
    const hover = hoverMarker(map);
    setTimeout(() => { map?.invalidateSize(); if (map) fitToTrack(map, route.track); }, 60);

    const page = el('main', { class: 'page' });
    root.append(page);

    const badges = el('div', { class: 'detail-badges' }, difficultyBadge(route.difficulty));
    if (route.source === 'geimporteerd')
      badges.append(el('span', { class: 'badge badge-neutral' }, 'Geïmporteerd'));

    page.append(
      el('div', { class: 'detail-headline' }, el('h1', {}, route.name)),
      badges,
      el('div', { class: 'detail-meta' },
        el('span', { class: 'sport' }, svgEl(sportIcon(route.sport)), sportLabel(route.sport)),
        route.region ? el('span', {}, '· ' + route.region) : null,
        route.ownerName ? el('span', {}, '· door ' + route.ownerName) : null,
      ),
    );
    if (route.description) page.append(el('p', { class: 'detail-desc' }, route.description));

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

    page.append(el('h3', { class: 'section-title' }, 'Hoogteprofiel'));
    const elevHolder = el('div', {});
    page.append(el('div', { class: 'card elev-card' }, elevHolder));
    elev = renderElevation(elevHolder, route.track, {
      onHover: (p) => { if (p) hover.show(p.lat, p.lon); else hover.hide(); },
    });

    page.append(el('div', { class: 'shared-cta' },
      el('a', { class: 'btn btn-primary', href: `/api/shared/${encodeURIComponent(params.token)}/gpx`, style: 'flex:1' },
        svgEl(icons.download), 'GPX downloaden'),
    ));
  }

  return () => {
    elev?.destroy();
    if (map) { map.remove(); map = null; }
    header.remove();
  };
}
