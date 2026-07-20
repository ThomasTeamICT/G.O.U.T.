// 'Voltooide activiteiten' — overzicht met filteren en GPX-upload.

import './activities.css';
import { api, ApiError } from '../api';
import {
  el, svgEl, icons, toast, modal, confirmDialog,
  fmtKm, fmtM, fmtDur, fmtSpeed, fmtDate,
  sportIcon, svgMinimap, SPORTS,
} from '../ui';
import { navigate } from '../router';
import { parseGpx } from '../lib/gpx';
import type { ParsedGpx } from '../lib/gpx';
import type { ActivitySummary, Sport, TrackPoint } from '../types';

export function activitiesView(container: HTMLElement) {
  let all: ActivitySummary[] = [];
  let sport: '' | Sport = '';

  // Gefaseerd renderen + tonen/verbergen bij filteren (geen herbouw per klik).
  let cards: { a: ActivitySummary; node: HTMLElement }[] = [];
  let rafId = 0;
  let destroyed = false;

  const grid = el('div', { class: 'grid-list' });
  const noResultsP = el('p', {}, 'Geen activiteiten voor deze sport.');
  const noResults = el('div', { class: 'empty' }, svgEl(icons.search), noResultsP);
  noResults.style.display = 'none';

  const root = el('main', { class: 'page' });
  container.append(root);

  const sub = el('p', { class: 'page-sub' }, 'Laden…');
  const listHolder = el('div', {});
  const chipbar = el('div', { class: 'filterbar' });

  function renderChips() {
    chipbar.innerHTML = '';
    const opts: { key: '' | Sport; label: string }[] = [
      { key: '', label: 'Alle sporten' },
      { key: 'wandelen', label: 'Wandelen' },
      { key: 'fietsen', label: 'Fietsen' },
      { key: 'mtb', label: 'MTB' },
    ];
    for (const o of opts) {
      chipbar.append(el('button', {
        class: `chip${sport === o.key ? ' active' : ''}`,
        onclick: () => { sport = o.key; renderChips(); applyFilter(); },
      }, o.key ? svgEl(sportIcon(o.key as Sport)) : null, o.label));
    }
  }

  root.append(
    el('div', { class: 'page-head' },
      el('h1', {}, 'Activiteiten'),
      el('div', { class: 'head-actions' },
        el('button', { class: 'btn btn-primary', onclick: () => openUploadModal() },
          svgEl(icons.upload), el('span', { class: 'lbl' }, 'Activiteit uploaden')),
      ),
    ),
    sub,
    chipbar,
    listHolder,
  );
  renderChips();

  function card(a: ActivitySummary): HTMLElement {
    const thumb = el('div', { class: 'thumb' },
      svgMinimap(a.preview, '#e8590c'),
      el('span', { class: 'sporticon' }, svgEl(sportIcon(a.sport))),
    );

    const statParts: (Node | null)[] = [el('span', {}, fmtKm(a.distanceM))];
    if (a.movingS > 0) {
      statParts.push(el('span', { class: 'sep' }, '·'), el('span', {}, svgEl(icons.clock), fmtDur(a.movingS)));
      statParts.push(el('span', { class: 'sep' }, '·'), el('span', {}, fmtSpeed(a.distanceM / a.movingS)));
    }
    statParts.push(el('span', { class: 'sep' }, '·'), el('span', {}, svgEl(icons.up), fmtM(a.ascentM)));
    const statline = el('div', { class: 'statline' }, ...statParts);

    const meta = el('div', { class: 'ac-meta' },
      el('span', {}, fmtDate(a.startedAt || a.createdAt)),
      a.region ? el('span', {}, '· ' + a.region) : null,
    );

    const dl = el('a', {
      class: 'btn btn-icon', href: `/api/activities/${a.id}/gpx`, title: 'GPX downloaden',
      onclick: (e: MouseEvent) => e.stopPropagation(),
    }, svgEl(icons.download));
    const del = el('button', {
      class: 'btn btn-icon', title: 'Verwijderen',
      onclick: async (e: MouseEvent) => {
        e.stopPropagation();
        const ok = await confirmDialog('Activiteit verwijderen?', `Wil je "${a.name}" definitief verwijderen?`);
        if (!ok) return;
        try {
          await api.del(`/api/activities/${a.id}`);
          all = all.filter((x) => x.id !== a.id);
          removeCard(a.id);
          toast('Activiteit verwijderd.');
        } catch (ex) {
          toast((ex as ApiError)?.message || 'Verwijderen mislukt.', 'error');
        }
      },
    }, svgEl(icons.trash));

    return el('div', { class: 'route-card act-card', onclick: () => navigate(`/activity/${a.id}`) },
      thumb,
      el('div', {},
        el('h3', {}, a.name),
        statline,
        meta,
      ),
      el('div', { class: 'actions' }, dl, del),
    );
  }

  function matchesSport(a: ActivitySummary): boolean {
    return !sport || a.sport === sport;
  }

  // Sportfilter: toon/verberg bestaande kaartjes (geen herbouw van de grid).
  function applyFilter() {
    for (const c of cards) c.node.style.display = matchesSport(c.a) ? '' : 'none';
    updateCount();
  }

  function updateCount() {
    let n = 0;
    for (const c of cards) if (matchesSport(c.a)) n++;
    sub.textContent = `${n} ${n === 1 ? 'activiteit' : 'activiteiten'}`;
    noResults.style.display = (all.length > 0 && n === 0) ? '' : 'none';
  }

  // Eén kaartje weghalen na verwijderen (val terug op de lege staat bij 0).
  function removeCard(id: number) {
    const i = cards.findIndex((c) => c.a.id === id);
    if (i >= 0) { cards[i].node.remove(); cards.splice(i, 1); }
    if (all.length === 0) rebuildList();
    else updateCount();
  }

  function cancelRaf() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  }

  // Herbouw bij NIEUWE data. Gefaseerd: eerste lichting meteen, de rest per rAF-batch.
  function rebuildList() {
    cancelRaf();
    cards = [];
    grid.innerHTML = '';
    listHolder.innerHTML = '';

    if (all.length === 0) {
      sub.textContent = '0 activiteiten';
      listHolder.append(el('div', { class: 'empty' },
        svgEl(icons.flag),
        el('p', {}, 'Nog geen activiteiten. Upload een GPX van je tocht of neem er eentje op via een route > Start live.'),
        el('button', { class: 'btn btn-primary', onclick: () => openUploadModal() },
          svgEl(icons.upload), 'Activiteit uploaden'),
      ));
      return;
    }

    listHolder.append(grid, noResults);

    const FIRST = 40; // eerste lichting meteen (blijft < 50 ms long-task-drempel)
    const BATCH = 30; // rest per animatieframe, ook telkens < 50 ms
    const total = all.length;

    const addCard = (a: ActivitySummary): HTMLElement => {
      const node = card(a);
      if (!matchesSport(a)) node.style.display = 'none';
      cards.push({ a, node });
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
        const end = Math.min(i + BATCH, total);
        const frag = document.createDocumentFragment();
        for (; i < end; i++) frag.append(addCard(all[i]));
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
      const r = await api.get<{ activities: ActivitySummary[] }>('/api/activities');
      all = r.activities;
      rebuildList();
    } catch (e) {
      listHolder.innerHTML = '';
      listHolder.append(el('div', { class: 'empty' },
        svgEl(icons.flag),
        el('p', {}, (e as ApiError)?.message || 'Kon je activiteiten niet laden.'),
      ));
      sub.textContent = '';
    }
  }

  /* ---------- GPX-upload ---------- */

  function openUploadModal() {
    const body = el('div', {});
    const close = modal(body);
    let parsed: ParsedGpx | null = null;
    let gpxText = '';
    let fileName = '';

    const fileInput = el('input', {
      type: 'file', accept: '.gpx,application/gpx+xml,application/xml', class: 'input up-file',
    });
    const drop = el('label', { class: 'up-drop' },
      svgEl(icons.upload),
      el('div', {}, el('b', {}, 'Kies een GPX-bestand'), ' of sleep het hierheen'),
      fileInput,
    );

    fileInput.addEventListener('change', async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      fileName = f.name.replace(/\.gpx$/i, '');
      try {
        gpxText = await f.text();
        parsed = parseGpx(gpxText);
        renderForm();
      } catch (e) {
        toast((e as Error)?.message || 'Kon dit GPX-bestand niet lezen.', 'error');
      }
    });

    function renderStart() {
      body.innerHTML = '';
      body.append(
        el('h2', {}, 'Activiteit uploaden'),
        el('p', { class: 'up-hint' }, 'Laad een tocht uit een GPX-bestand van je gps-toestel, horloge of app zoals Strava of Komoot.'),
        drop,
        el('div', { class: 'modal-actions' }, el('button', { class: 'btn', onclick: () => close() }, 'Annuleren')),
      );
    }

    function renderForm() {
      if (!parsed) return;
      body.innerHTML = '';
      const nameInput = el('input', {
        class: 'input', type: 'text', value: parsed.name || fileName || 'Mijn activiteit',
      });
      const sportSel = el('select', { class: 'input' },
        ...SPORTS.map((s) => el('option', { value: s.key }, s.label)));

      const saveBtn = el('button', { class: 'btn btn-primary' }, svgEl(icons.upload), 'Uploaden');
      saveBtn.addEventListener('click', async () => {
        const name = nameInput.value.trim();
        if (!name) { toast('Geef de activiteit een naam.', 'error'); return; }
        saveBtn.disabled = true;
        const region = await revgeocode(parsed!.track[0]);
        try {
          const r = await api.post<{ activity: { id: number } }>('/api/activities', {
            name, sport: sportSel.value as Sport, track: parsed!.track, gpx: gpxText, region,
          });
          toast('Activiteit toegevoegd.');
          close();
          navigate(`/activity/${r.activity.id}`);
        } catch (e) {
          saveBtn.disabled = false;
          toast((e as ApiError)?.message || 'Uploaden mislukt.', 'error');
        }
      });

      const children: Node[] = [
        el('h2', {}, 'Activiteit uploaden'),
        el('label', { class: 'field' }, el('span', {}, 'Naam'), nameInput),
        el('label', { class: 'field' }, el('span', {}, 'Sport'), sportSel),
      ];
      if (!parsed.hasTime) {
        children.push(el('div', { class: 'up-notime' },
          svgEl(icons.clock),
          el('span', {}, 'Geen tijdsdata gevonden — tijden en snelheid blijven leeg')));
      }
      children.push(el('div', { class: 'modal-actions' },
        el('button', { class: 'btn', onclick: () => close() }, 'Annuleren'),
        saveBtn,
      ));
      body.append(...children);
    }

    renderStart();
  }

  async function revgeocode(p: TrackPoint): Promise<string | undefined> {
    try {
      const r = await api.get<{ region: string | null }>(`/api/revgeocode?lat=${p[1]}&lon=${p[0]}`);
      return r.region || undefined;
    } catch {
      return undefined;
    }
  }

  load();

  return () => { destroyed = true; cancelRaf(); };
}
