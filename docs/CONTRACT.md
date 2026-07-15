# G.O.U.T. — Bouwcontract voor feature-agents

**G.O.U.T. (Gewoon Op Uw Tempo)** is een lichte, zelfgehoste Komoot-vervanger:
routes plannen/bewerken (GPX-editor), GPX importeren/exporteren (altijd gratis!),
activiteiten bijhouden, statistieken, routes delen en een top-10 bibliotheek.
Sporten: wandelen, fietsen, mtb. **Alle UI-teksten in het Nederlands (Vlaams, "je"-vorm).**

## Stack & regels

- Server: Express (ESM JS) + `node:sqlite`. Web: Vite + vanilla TypeScript + Leaflet.
- **GEEN nieuwe npm-dependencies.** Geen frameworks, geen chart-libs — alles hand-gerold.
- Je bewerkt ALLEEN de bestanden die aan jou zijn toegewezen. Fundamentbestanden zijn
  read-only; als je daar een wijziging nodig acht, meld dat in je eindrapport.
- Verifieer vóór je klaar bent: `npx tsc --noEmit -p web` (0 fouten) en
  `node --check server/api/<jouw bestand>.js`. Draai NIET `vite build` en NIET `npm install`.
- Test server-endpoints met curl tegen een eigen instantie:
  `GOUT_DB=:memory: PORT=<jouw poort> node --no-warnings server/index.js &`
- API-fouten: HTTP-status + `{ "error": "Nederlandse boodschap" }`.
- SQL altijd met prepared statements (`?`). Nooit string-concatenatie.
- Geen `innerHTML` met gebruikersdata; bouw DOM met `el()` (strings worden textContent).
  `html:`-attribuut en `svgEl()` alleen voor eigen icoon-SVG's.

## Bestandseigendom

| Agent | Bestanden |
|---|---|
| A planner | `web/src/views/plan.ts`, `web/src/lib/brouter.ts`, `web/src/views/plan.css` |
| B routes | `server/api/routes.js`, `web/src/views/routes.ts`, `web/src/views/route.ts`, `web/src/views/shared.ts`, `web/src/views/routes.css` |
| C activiteiten | `server/api/activities.js`, `server/api/stats.js`, `web/src/views/activities.ts`, `web/src/views/activity.ts`, `web/src/views/stats.ts`, `web/src/views/profile.ts`, `web/src/views/activities.css` |
| D ontdek | `server/api/discover.js`, `web/src/views/discover.ts`, `web/src/views/discover.css` |

Importeer je eigen CSS bovenaan je view: `import './routes.css';` (mag leeg blijven als onnodig).
View-bestanden zijn nu stubs; vervang de volledige inhoud maar **behoud de export-naam**
(bv. `export function routesView(container: HTMLElement, params: Record<string,string>, query: URLSearchParams)`).
Views zijn al geregistreerd in `main.ts` — registreer niets zelf.
Een view mag een cleanup-functie teruggeven (timers, watchers, kaarten opruimen: `map.remove()`).

## Databank (server/db.js — read-only)

users(id, email, name, pass_hash, avatar_color, created_at)
routes(id, user_id, name, description, sport, waypoints JSON?, track JSON,
  distance_m, ascent_m, descent_m, duration_s, difficulty, visibility 'private'|'public',
  share_token?, start_lat, start_lon, bbox JSON?, region?, source 'gepland'|'geimporteerd',
  preview JSON?, gpx?, created_at, updated_at)
route_likes(route_id, user_id, created_at)
activities(id, user_id, route_id?, name, sport, track JSON, distance_m, ascent_m,
  descent_m, moving_s, elapsed_s, started_at?, preview JSON?, region?, gpx?, created_at)

- `track` = JSON `[[lon,lat,ele?,t?],...]` (t = epoch-seconden, alleen activiteiten).
- `waypoints` = JSON `[{lon,lat,beeline?},...]` (alleen geplande routes; beeline = hemelsbreed segment NAAR dit punt).
- Bij create/update van track: zet `preview` = `JSON.stringify(preview(track))` (uit server/geo.js),
  en stats via `routeStats(sport, track)` resp. `activityStats(track)`.

## Server-fundament (read-only, importeer wat je nodig hebt)

- `server/db.js`: `db` (node:sqlite DatabaseSync; `db.prepare(...).run/get/all`)
- `server/auth.js`: `requireAuth` middleware (zet `req.user = {id,email,name,avatar_color}`; anders 401)
- `server/geo.js`: `routeStats(sport, track)` → `{distance_m, ascent_m, descent_m, duration_s, difficulty, bbox, start_lon, start_lat}`;
  `activityStats(track)` → idem met `moving_s`, `elapsed_s`; `preview(track)` → `[[lon,lat]×≤120]`; `simplify`, `haversine`, `trackDistance`
- `server/gpx.js`: `buildGpx({name, description?, track, sport?})` → GPX-string; `gpxFilename(name)`
- `server/serialize.js`: `routeSummary(row, viewerId?)`, `routeFull(row, viewerId?)`,
  `activitySummary(row)`, `activityFull(row)` — **gebruik ALTIJD deze serializers** voor API-antwoorden.
  Voor `ownerName`: join `users.name AS owner_name` in je query.
- `server/index.js` mount al: `/api/routes`→routesRouter, `/api/shared`→sharedRouter (beide uit api/routes.js),
  `/api/activities`, `/api/stats`, `/api/discover`. Exporteer exact die routernamen.
- Al beschikbaar (niet bouwen): `POST/GET /api/auth/*`, `GET /api/routing?lonlats=lon,lat|lon,lat&sport=`,
  `GET /api/geocode?q=` → `{results:[{name,lat,lon}]}`, `GET /api/revgeocode?lat=&lon=` → `{region}`.

## Web-fundament (read-only)

- `src/types.ts`: `Sport`, `Difficulty`, `TrackPoint`, `Waypoint`, `User`, `RouteSummary`,
  `RouteFull`, `ActivitySummary`, `ActivityFull`, `StatsResponse` — **API-JSON volgt exact deze vormen.**
- `src/api.ts`: `api.get/post/put/del<T>(url, body?)` — gooit `ApiError{status,message}`.
- `src/router.ts`: `navigate(path)` (zonder '#'), views zijn al geregistreerd.
- `src/main.ts`: `session.user`, `setUser(u)`.
- `src/ui.ts`: `el(tag, attrs, ...children)` (attrs: `class`, `onclick`/`oninput`/…, `value`, `html` alleen voor eigen SVG),
  `svgEl(iconString)`, `icons.{walk,bike,mtb,route,map,compass,download,upload,share,edit,trash,plus,close,chevronL,chevronD,undo,redo,reverse,save,heart,heartFill,lock,globe,play,stop,locate,search,user,stats,logout,flag,mountain,layers,copy,check,clock,up,down}`,
  `sportIcon(sport)`, `SPORTS`, `sportLabel`, `difficultyBadge(d)`, `svgMinimap(preview)`,
  `fmtKm(m)`, `fmtM(m)`, `fmtDur(s)`, `fmtSpeed(mPerS)`, `fmtPace(sPerKm)`, `fmtDate(iso)`,
  `toast(msg, 'ok'|'error')`, `modal(content, {onClose?}) → close()`, `confirmDialog(titel, tekst, knop?) → Promise<boolean>`, `debounce`.
- `src/lib/geo.ts`: `haversine`, `trackDistance`, `cumulative`, `ascentDescent`, `bboxOf`,
  `simplify`, `nearestPointIndex(track, lon, lat)`, `pointAtDistance(track, cum, atM)`.
- `src/lib/gpx.ts`: `parseGpx(text)` → `{name, track, hasTime, hasEle}` (gooit Error bij ongeldig GPX);
  `buildGpx(name, track, sport?)`; `downloadGpx(name, track, sport?)` (browser-download).
- `src/lib/estimate.ts`: `estimateDuration(sport, distM, ascentM)` (sec), `difficulty(sport, distM, ascentM)`.
- `src/lib/map.ts`: `createMap(el, {center?, zoom?})` → Leaflet-kaart met laagkeuze
  (Standaard/Topografisch/Fiets & MTB) + schaal; `trackToLatLngs`, `fitToTrack(map, track)`,
  `drawTrack(map, track)` → LayerGroup (met witte casing), `waypointIcon('start'|'end'|'via', label?)`,
  `positionIcon()`, `hoverMarker(map)` → `{show(lat,lon), hide(), remove()}`,
  stijlen: `ROUTE_STYLE`, `ROUTE_CASING`, `BEELINE_STYLE`, `TRACK_DONE_STYLE`.
- `src/lib/elevation.ts`: `renderElevation(container, track, {onHover?, height?})` → `{destroy()}`.
  Koppel `onHover` aan `hoverMarker` voor kaart-synchronisatie.

## CSS-klassen (src/style.css — read-only)

Layout: `main.page` (max-1060 gecentreerd), `main.page-wide` (flex, volle breedte voor kaartpagina's),
`.page-head`, `.page-sub`, `.map-holder` (kaartcontainer; Leaflet vult hem absoluut).
Componenten: `.btn` (+`-primary` oranje CTA, `-green`, `-ghost`, `-danger`, `-icon`, `-sm`),
`.input` (+`.input-search`), `label.field>span`, `.card`, `.route-card` (grid: `.thumb`(+`.sporticon`), inhoud, `.actions`),
`.statline` (+`.sep`), `.badge-{makkelijk,gemiddeld,zwaar,neutral,public}`, `.chip`(+`.active`),
`.filterbar`, `.grid-list`, `.empty`, `.stat-grid`>`.stat-block`(`.v`,`.k`), `.tabs`,
`.modal-actions` (in `modal()`), `.spinner`, `.sport-picker`, `.menu`.
Kaart-iconen: `.wpt-icon .wpt-start/.wpt-end/.wpt-via`, `.pos-dot` (via map.ts-helpers).
Kleurtokens: `var(--accent)` oranje, `var(--green)`, `var(--danger)`, `var(--muted)`, `var(--line)`, `var(--surface-2)`.

## API-contract (bindend)

### B — routes (`server/api/routes.js`: exporteer `routesRouter` én `sharedRouter`)

- `GET /api/routes?q=&sport=&sort=new|name|distance` (auth) → `{routes: RouteSummary[]}` — alleen eigen routes; q zoekt in naam (LIKE, case-insensitive).
- `POST /api/routes` (auth) `{name, description?, sport, waypoints?, track, region?}` → `{route: RouteFull}` (201). Server herberekent stats+preview; `source='gepland'`.
- `POST /api/routes/import` (auth) `{name, sport, track, gpx, region?}` → `{route: RouteFull}` (201). `source='geimporteerd'`, bewaar originele gpx-tekst.
- `GET /api/routes/:id` (auth) → `{route: RouteFull}` — eigenaar OF `visibility='public'`; anders 404 (geen 403: bestaan niet lekken).
- `PUT /api/routes/:id` (alleen eigenaar) `{name?, description?, sport?, waypoints?, track?, region?, visibility?}` → `{route: RouteFull}`. Bij track-wijziging: stats+preview herberekenen en `gpx=NULL` (origineel klopt niet meer). `updated_at` bijwerken.
- `DELETE /api/routes/:id` (eigenaar) → `{ok:true}`.
- `GET /api/routes/:id/gpx` (eigenaar of public) → GPX-download. Origineel `gpx` als dat er nog is, anders `buildGpx`. Headers: `Content-Type: application/gpx+xml`, `Content-Disposition: attachment; filename="..."` via `gpxFilename`.
- `POST /api/routes/:id/share` (eigenaar) → `{shareToken}` (maak `crypto.randomBytes(12).toString('base64url')` als er nog geen is).
- `DELETE /api/routes/:id/share` (eigenaar) → `{ok:true}` (token = NULL).
- `POST /api/routes/:id/like` en `DELETE .../like` (auth, alleen public routes) → `{likes, liked}`.
- `sharedRouter` (GEEN auth): `GET /api/shared/:token` → `{route: RouteFull}` (zonder shareToken-lek: serializer regelt dat), `GET /api/shared/:token/gpx` → download.
- Validatie: name 1–120 tekens; track = array van 2–100000 punten `[num,num,(num|null)?,(num)?]` met lon∈[-180,180], lat∈[-90,90]; sport enum; visibility enum; description ≤2000; waypoints ≤200 `{lon,lat,beeline?}`.

### C — activiteiten & statistieken

- `POST /api/activities` (auth) `{name, sport, track, gpx?, startedAt?, routeId?, region?}` → `{activity: ActivityFull}` (201). Stats via `activityStats`. `startedAt` ISO of afgeleid uit eerste t.
- `GET /api/activities` → `{activities: ActivitySummary[]}` (nieuwste eerst).
- `GET /api/activities/:id` → `{activity: ActivityFull}` (alleen eigenaar).
- `PUT /api/activities/:id` `{name?, sport?}` → `{activity: ActivityFull}`.
- `DELETE /api/activities/:id` → `{ok:true}`.
- `GET /api/activities/:id/gpx` → download (origineel of gebouwd, mét tijden).
- `GET /api/stats` → `StatsResponse` (zie types.ts): totalen, per sport, laatste 12 maanden
  (`month`: 'YYYY-MM', km per sport, lege maanden = 0), records (langste afstand, meeste hoogtemeters).

### D — ontdek

- `GET /api/discover?bbox=w,s,e,n&sport=&q=&limit=` (auth) → `{routes: RouteSummary[]}` —
  alleen `visibility='public'`, bbox-overlap (route-bbox ∩ query-bbox), q op naam/regio,
  sort: likes desc, dan nieuwste. limit default 30, max 100. Met `ownerName`.
- `GET /api/discover/top?sport=` (auth) → `{routes: RouteSummary[]}` — top 10 wereldwijd op likes, dan nieuwste. Met `ownerName`.

## UX-principes

- Rustig en helder: weinig knoppen tegelijk, veel witruimte, geen clutter (dat is het hele punt).
- Consistente formattering via de fmt-helpers; afstanden "23,4 km", hoogte "↗ 510 m" (gebruik `icons.up`/`icons.down`).
- Elke lijst heeft een verzorgde lege staat (`.empty` + icoon + één zin + primaire actie).
- Fouten: `toast(bericht, 'error')`; succes: korte toast.
- Destructief: altijd `confirmDialog`.
- Responsief tot 375px breed; kaartpagina's gebruiken `page-wide` + `map-holder`.
- Datums via `fmtDate`; sport altijd met icoon.

## Highlights ("toppertjes" — aanbevolen stukjes zoals bij Komoot)

Tabellen: `highlights` en `highlight_votes` (zie server/db.js). Serializer:
`highlightSummary(row, viewerId)` in server/serialize.js (join `users.name AS owner_name`).
Type: `Highlight` in web/src/types.ts. Sport kan ook `'alle'` zijn.

### API (`server/api/highlights.js`, gemount op /api/highlights, alles requireAuth)

- `GET /api/highlights?bbox=w,s,e,n&sport=` → `{highlights: Highlight[]}` — bbox verplicht,
  overlap-filter zoals discover; sport filtert op (sport OF 'alle'); sortering: votes desc, nieuwste.
  Limiet 200.
- `POST /api/highlights` `{name 1..80, description? ≤500, sport, track 2..2000 punten}` → 201 `{highlight}`.
  Server berekent bbox/start; region via niets (client stuurt niet mee — houd het licht).
- `PUT /:id` `{name?, description?, sport?}` (eigenaar) / `DELETE /:id` (eigenaar).
- `POST /:id/vote` en `DELETE /:id/vote` → `{votes, voted}` — niet op eigen highlight (400).

### UI

- **Aanmaken** (route.ts, detailpagina): knop 'Highlight markeren' (alleen eigenaar of publieke route,
  icons.flag) → markeer-modus: twee klikken op de routelijn kiezen begin- en eindpunt van het segment
  (visuele preview in oranje), dan modal (naam, sport, beschrijving) → POST met het track-segment.
- **Tonen** (plan.ts planner + discover.ts): toggle-knopje 'Highlights' (icons.flag). Aan = GET op huidige
  kaart-bbox, teken segmenten als oranje lijnen (#e8590c, weight 5, opacity .75) met een klein
  vlag-markertje op het middelpunt; klik → Leaflet-popup met naam, sport-icoon, stemmen, duim-knop
  (POST/DELETE vote; eigen highlight = geen knop), beschrijving en 'door {ownerName}'. Herladen bij
  moveend alleen als de toggle aan staat (debounce 600ms).
- Bewegwijzerde officiële routes (GR's, knooppunten) zitten al als overlay-tegellagen in de
  lagencontrole (map.ts) — highlights zijn het community-deel daarbovenop.

## Planner-extensies (bekende routes, GPS-positie, lus sluiten)

### Server (bestaat al — server/proxy.js)
- `GET /api/knownroutes?q=&sport=` → `{routes:[{id, name, ref, group}]}` (Waymarked Trails-zoek).
- `GET /api/knownroutes/:id?sport=` → `{name, ref, track:[[lon,lat],...], note}` (aaneengeregen, ≤6000 punten, GEEN hoogtedata).
- Custom BRouter-profielen: server/profiles/<sport>.brf wordt automatisch geüpload en gebruikt.

### UI (plan.ts)
- **Bekende routes-knop** (icons.map, naast het zoekveld): opent een modal "Bekende routes"
  met: zoekveld + snelkeuze-chips ('Camino Francés', 'Via Turonensis', 'Via Podiensis (GR65)',
  'GR 5', 'GR 12', 'GR 128 Vlaanderen') die het zoekveld invullen en meteen zoeken (query =
  chiptekst, sport = huidige sport). Resultatenlijst (naam + ref-badge); klik = geometrie laden
  → toon als track in de planner (aparte modus 'geladen route': volledige lijn, A/B-markers,
  stats zonder hoogte, hint-balk 'Geladen: {naam} — bewaar of download'), knoppen Opslaan
  (POST /api/routes, waypoints=null) en GPX. Duidelijke laad-spinner (lange GR's = even geduld)
  en nette foutafhandeling. Simpel voor leken: één knop, één zoekveld, klikken = klaar.
- **GPS-positie in de planner**: toggle-knop (icons.locate) in de knoppenrij: aan = watchPosition
  → klein blauw bolletje (positionIcon) + accuracy-cirkel op de kaart (GEEN auto-pan; eerste fix
  mag één keer centreren), uit = watcher stoppen en marker weg. Fout → toast, knop terug uit.
  Persistentie via localStorage ('gout.plannerGps' = '1') zodat de voorkeur bewaard blijft.
- **Lus sluiten**: klik op de START-marker met ≥2 punten sluit de lus (voegt eindpunt toe op de
  startcoördinaat, toast 'Lus gesloten'); start-marker verwijderen kan dan via de eerste
  via-klik-regel niet meer per ongeluk. Plus expliciete knop 'Sluit de lus' (icons.route) in de
  knoppenrij (disabled bij <2 punten of al gesloten).
- **Hint-kaart**: kleiner, onderaan-gecentreerd boven de statsbalk, pointer-events none, en
  verdwijnt automatisch (fade) na 8 s of bij het eerste punt.

## Highlights v2: punt-highlights (POI's) en betere vindbaarheid

- Kolom `highlights.category` (TEXT, nullable). Vaste categorieën:
  `uitzicht`, `rustpunt`, `horeca`, `bezienswaardig`, `trail` (NL-labels in de UI:
  Uitzicht, Rustpunt, Café/horeca, Bezienswaardig, Toffe trail). `null` = geen categorie.
- POST /api/highlights: `track` mag vanaf nu **1** punt bevatten (punt-highlight/POI);
  `category` optioneel, alleen bovenstaande waarden (anders 400). Serializer geeft `category` terug.
- UI markeer-flow (route.ts): eerst keuze 'Plek (één klik)' | 'Stuk route (twee klikken)',
  daarna klik(ken), modal met naam + categorie-select (verplicht bij Plek, optioneel bij Stuk) +
  sport + beschrijving.
- Weergave (plan.ts + discover.ts): punt-highlights = marker met categorie-embleem
  (vlag; title = categorie-label), segmenten = oranje lijn zoals nu; popup toont categorie-label.
- Lege staat: staat de highlights-toggle aan en zijn er 0 in beeld → eenmalige toast/hintbalk
  'Nog geen highlights in dit gebied. Markeer er zelf één via een route → Highlight markeren.'

## Ontdek: enkel de beste routes per gebied

- GET /api/discover: default limit **10** (max blijft 100); sortering blijft likes desc, nieuwste.
- UI: paneltekst boven de resultaten: 'De best gewaardeerde routes in dit gebied'; na
  plaatsnaam-zoek meteen zoeken (bestond al). Geen andere gedragswijzigingen.

## Highlights v2b: opnemen in je route + schermvullende detailkaart

- Planner-popup van een highlight krijgt een primaire knop **'Voeg toe aan route'**:
  punt-highlight → dat punt als waypoint (leeg = start, anders achteraan);
  segment-highlight → begin-, midden- en eindpunt als drie waypoints (richting gekozen
  op kortste aansluiting bij het huidige route-einde), zodat de routering het stuk volgt.
  Daarna toast 'Highlight opgenomen in je route.' en normale herberekening + undo.
- Routedetailpagina: kaart schermvullend (calc(100vh - topbar); mobiel ~85vh),
  info verschijnt na scrollen; subtiele chevron-knop op de kaart scrolt er naartoe.
- Seed voorziet enkele openbare voorbeeld-highlights zodat nieuwe installaties de
  functie meteen zien werken.
