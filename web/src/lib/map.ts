// Leaflet-kaart met rustige basiskaarten en gedeelde stijlen/markers.

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { TrackPoint } from '../types';

export const ROUTE_STYLE: L.PolylineOptions = { color: '#3557e0', weight: 4.5, opacity: 0.9 };
export const ROUTE_CASING: L.PolylineOptions = { color: '#ffffff', weight: 8, opacity: 0.8 };
export const BEELINE_STYLE: L.PolylineOptions = { color: '#3557e0', weight: 3.5, opacity: 0.85, dashArray: '6 8' };
export const TRACK_DONE_STYLE: L.PolylineOptions = { color: '#e8590c', weight: 5, opacity: 0.95 };

export function createMap(container: HTMLElement, opts: { center?: [number, number]; zoom?: number } = {}): L.Map {
  const map = L.map(container, {
    center: opts.center || [50.93, 4.18], // Vlaanderen als vertrekpunt
    zoom: opts.zoom ?? 10,
    zoomControl: true,
  });

  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  });
  const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
    attribution: '&copy; OpenStreetMap, SRTM | kaartstijl &copy; <a href="https://opentopomap.org">OpenTopoMap</a>',
  });
  const cyclosm = L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap | stijl <a href="https://www.cyclosm.org">CyclOSM</a>',
  });

  // Bewegwijzerde routes (GR's, knooppuntnetwerken, jacobswegen, ...) als
  // aanvinkbare overlays — gratis tegels van waymarkedtrails.org (OSM-data).
  const wmt = (slug: string) =>
    L.tileLayer(`https://tile.waymarkedtrails.org/${slug}/{z}/{x}/{y}.png`, {
      maxZoom: 18,
      opacity: 0.85,
      attribution: 'routes &copy; <a href="https://waymarkedtrails.org">Waymarked Trails</a>',
    });

  osm.addTo(map);
  L.control.layers(
    { 'Standaard': osm, 'Topografisch': topo, 'Fiets & MTB': cyclosm },
    {
      'Bewegwijzerd: wandelen': wmt('hiking'),
      'Bewegwijzerd: fietsen': wmt('cycling'),
      'Bewegwijzerd: MTB': wmt('mtb'),
    },
    { position: 'topright' }
  ).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
  return map;
}

export function trackToLatLngs(track: TrackPoint[]): L.LatLngExpression[] {
  return track.map((p) => [p[1], p[0]] as [number, number]);
}

export function fitToTrack(map: L.Map, track: TrackPoint[], pad = 0.12) {
  if (track.length < 2) return;
  const b = L.latLngBounds(trackToLatLngs(track) as [number, number][]);
  map.fitBounds(b.pad(pad));
}

// Route tekenen met witte 'casing' eronder voor leesbaarheid op elke kaart.
export function drawTrack(map: L.Map, track: TrackPoint[]): L.LayerGroup {
  const group = L.layerGroup();
  L.polyline(trackToLatLngs(track), ROUTE_CASING).addTo(group);
  L.polyline(trackToLatLngs(track), ROUTE_STYLE).addTo(group);
  group.addTo(map);
  return group;
}

export function waypointIcon(kind: 'start' | 'end' | 'via', label = ''): L.DivIcon {
  const size = kind === 'via' ? 22 : 28;
  const cls = kind === 'start' ? 'wpt-start' : kind === 'end' ? 'wpt-end' : 'wpt-via';
  const text = kind === 'start' ? 'A' : kind === 'end' ? 'B' : label;
  return L.divIcon({
    className: '',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `<div class="wpt-icon ${cls}">${text}</div>`,
  });
}

export function positionIcon(): L.DivIcon {
  return L.divIcon({ className: '', iconSize: [18, 18], iconAnchor: [9, 9], html: '<div class="pos-dot"></div>' });
}

// Marker die de positie op het hoogteprofiel spiegelt op de kaart.
export function hoverMarker(map: L.Map): { show(lat: number, lon: number): void; hide(): void; remove(): void } {
  const m = L.circleMarker([0, 0], {
    radius: 7, color: '#fff', weight: 2.5, fillColor: '#e8590c', fillOpacity: 1,
  });
  let on = false;
  return {
    show(lat, lon) {
      m.setLatLng([lat, lon]);
      if (!on) { m.addTo(map); on = true; }
    },
    hide() { if (on) { m.remove(); on = false; } },
    remove() { if (on) m.remove(); },
  };
}
