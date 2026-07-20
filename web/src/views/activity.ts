// Activiteitdetail: kaart, statistieken, hoogteprofiel, hernoemen en verwijderen.

import './activities.css';
import L from 'leaflet';
import { api, ApiError } from '../api';
import {
  el, svgEl, icons, toast, modal, confirmDialog,
  fmtKm, fmtM, fmtDur, fmtSpeed, fmtPace, fmtDate,
  sportIcon, sportLabel, SPORTS,
} from '../ui';
import { navigate } from '../router';
import {
  createMap, drawTrack, fitToTrack, waypointIcon, hoverMarker,
} from '../lib/map';
import { renderElevation } from '../lib/elevation';
import type { ActivityFull, Sport } from '../types';

export function activityView(container: HTMLElement, params: Record<string, string>) {
  let map: L.Map | null = null;
  let elev: { destroy(): void } | null = null;
  let destroyed = false; // view verlaten tijdens de fetch: geen kaart meer bouwen

  const root = el('div', {});
  container.append(root);
  root.append(el('div', { class: 'spinner' }));

  (async () => {
    let act: ActivityFull;
    try {
      const r = await api.get<{ activity: ActivityFull }>(`/api/activities/${encodeURIComponent(params.id)}`);
      if (destroyed) return; // weggenavigeerd terwijl de fetch liep
      act = r.activity;
    } catch (e) {
      if (destroyed) return;
      root.innerHTML = '';
      const notFound = (e as ApiError)?.status === 404;
      root.append(el('main', { class: 'page' },
        el('div', { class: 'empty' },
          svgEl(icons.flag),
          el('p', {}, notFound ? 'Deze activiteit bestaat niet (meer).' : 'Kon de activiteit niet laden.'),
          el('a', { class: 'btn btn-primary', href: '#/activities' }, 'Naar je activiteiten'),
        ),
      ));
      return;
    }
    build(act);
  })();

  function build(act: ActivityFull) {
    root.innerHTML = '';

    /* --- kaart bovenaan --- */
    const mapHolder = el('div', { class: 'map-holder' });
    const backBtn = el('button', {
      class: 'btn btn-icon back-fab', title: 'Terug',
      onclick: () => { if (history.length > 1) history.back(); else navigate('/activities'); },
    }, svgEl(icons.chevronL));
    root.append(el('div', { class: 'map-sized detail-map' }, mapHolder, backBtn));

    map = createMap(mapHolder, {});
    map.zoomControl.setPosition('topright');
    drawTrack(map, act.track);
    const a = act.track[0], b = act.track[act.track.length - 1];
    L.marker([a[1], a[0]], { icon: waypointIcon('start') }).addTo(map);
    L.marker([b[1], b[0]], { icon: waypointIcon('end') }).addTo(map);
    fitToTrack(map, act.track);
    const hover = hoverMarker(map);
    setTimeout(() => { map?.invalidateSize(); if (map) fitToTrack(map, act.track); }, 60);

    /* --- inhoud --- */
    const page = el('main', { class: 'page' });
    root.append(page);

    const h1 = el('h1', {}, act.name);
    const editBtn = el('button', { class: 'btn btn-icon', title: 'Hernoemen', onclick: () => openRenameModal() },
      svgEl(icons.edit));
    page.append(el('div', { class: 'detail-headline' }, h1, editBtn));

    const meta = el('div', { class: 'detail-meta' });
    const renderMeta = () => {
      meta.innerHTML = '';
      const parts: Node[] = [
        el('span', { class: 'sport' }, svgEl(sportIcon(act.sport)), sportLabel(act.sport)),
      ];
      if (act.startedAt) parts.push(el('span', {}, '· ' + fmtDate(act.startedAt)));
      if (act.region) parts.push(el('span', {}, '· ' + act.region));
      if (act.routeId != null)
        parts.push(el('span', {}, '· ', el('a', { href: `#/route/${act.routeId}` }, 'Bekijk route')));
      meta.append(...parts);
    };
    renderMeta();
    page.append(meta);

    /* --- statistieken --- */
    const hasTime = act.movingS > 0;
    const speed = hasTime ? fmtSpeed(act.distanceM / act.movingS) : '—';
    const pace = hasTime && act.distanceM > 0
      ? fmtPace((act.movingS * 1000) / act.distanceM) : '—';
    const stat = (v: Node | string, k: string) => el('div', { class: 'stat-block' },
      el('div', { class: 'v' }, v), el('div', { class: 'k' }, k));

    const blocks: HTMLElement[] = [
      stat(fmtKm(act.distanceM), 'Afstand'),
      stat(hasTime ? fmtDur(act.movingS) : '—', 'Bewegingstijd'),
      stat(act.elapsedS > 0 ? fmtDur(act.elapsedS) : '—', 'Totale tijd'),
      stat(speed, 'Gem. snelheid'),
    ];
    if (act.sport === 'wandelen') blocks.push(stat(pace, 'Tempo'));
    blocks.push(
      stat(el('span', {}, svgEl(icons.up), fmtM(act.ascentM)), 'Stijgen'),
      stat(el('span', {}, svgEl(icons.down), fmtM(act.descentM)), 'Dalen'),
    );
    page.append(el('div', { class: 'stat-grid' }, ...blocks));

    /* --- hoogteprofiel --- */
    page.append(el('h3', { class: 'section-title' }, 'Hoogteprofiel'));
    const elevHolder = el('div', {});
    page.append(el('div', { class: 'card elev-card' }, elevHolder));
    elev = renderElevation(elevHolder, act.track, {
      onHover: (p) => { if (p) hover.show(p.lat, p.lon); else hover.hide(); },
    });

    /* --- acties --- */
    page.append(el('div', { class: 'detail-actions' },
      el('a', { class: 'btn', href: `/api/activities/${act.id}/gpx` },
        svgEl(icons.download), 'GPX downloaden'),
      el('button', {
        class: 'btn btn-danger',
        onclick: async () => {
          const ok = await confirmDialog('Activiteit verwijderen?', `Wil je "${act.name}" definitief verwijderen?`);
          if (!ok) return;
          try {
            await api.del(`/api/activities/${act.id}`);
            toast('Activiteit verwijderd.');
            navigate('/activities');
          } catch (e) {
            toast((e as ApiError)?.message || 'Verwijderen mislukt.', 'error');
          }
        },
      }, svgEl(icons.trash), 'Verwijderen'),
    ));

    /* --- hernoemmodal --- */
    function openRenameModal() {
      const boxBody = el('div', {});
      const close = modal(boxBody);
      const nameInput = el('input', { class: 'input', type: 'text', value: act.name });
      const sportSel = el('select', { class: 'input' },
        ...SPORTS.map((s) => el('option', { value: s.key, selected: s.key === act.sport }, s.label)));
      const saveBtn = el('button', { class: 'btn btn-primary' }, svgEl(icons.save), 'Opslaan');
      saveBtn.addEventListener('click', async () => {
        const name = nameInput.value.trim();
        if (!name) { toast('Geef de activiteit een naam.', 'error'); return; }
        saveBtn.disabled = true;
        try {
          const r = await api.put<{ activity: ActivityFull }>(`/api/activities/${act.id}`, {
            name, sport: sportSel.value as Sport,
          });
          act.name = r.activity.name;
          act.sport = r.activity.sport;
          h1.textContent = act.name;
          renderMeta();
          toast('Opgeslagen.');
          close();
        } catch (e) {
          saveBtn.disabled = false;
          toast((e as ApiError)?.message || 'Opslaan mislukt.', 'error');
        }
      });
      boxBody.append(
        el('h2', {}, 'Activiteit hernoemen'),
        el('label', { class: 'field' }, el('span', {}, 'Naam'), nameInput),
        el('label', { class: 'field' }, el('span', {}, 'Sport'), sportSel),
        el('div', { class: 'modal-actions' },
          el('button', { class: 'btn', onclick: () => close() }, 'Annuleren'),
          saveBtn,
        ),
      );
    }
  }

  return () => {
    destroyed = true;
    elev?.destroy();
    if (map) { map.stop(); map.remove(); map = null; }
  };
}
