# G.O.U.T. — Gewoon Op Uw Tempo

Een **lichte, zelfgehoste routeplanner & GPX-editor** voor wandelen, fietsen en
mountainbike. Gebouwd uit frustratie met de commercialisering van de grote
platformen: **je eigen GPX-bestanden downloaden is hier altijd gratis** — het
zijn tenslotte jouw routes.

## Wat kan het?

- 🗺️ **Routes plannen** zoals je gewend bent: klik punten op de kaart, de route
  volgt automatisch wegen en paden (via [BRouter](https://brouter.de)), met
  profielen voor wandelen, fietsen en MTB. Hemelsbrede segmenten kunnen ook.
- ⛰️ **Hoogteprofiel, afstand, stijgen/dalen, tijdschatting en moeilijkheid** —
  live tijdens het plannen.
- 📁 **GPX importeren en exporteren**, onbeperkt en gratis. Geïmporteerde
  bestanden blijven byte-voor-byte bewaard zolang je de route niet bewerkt.
- 📍 **Live volgen**: open een route op je telefoon, zie je positie, voortgang,
  resterende kilometers/hoogtemeters en ETA. Neem onderweg je tocht op en
  bewaar hem als activiteit. Ideaal voor een meerdaagse zoals de camino.
- 🏃 **Voltooide activiteiten** met bewegingstijd, snelheid en tempo.
- 📊 **Statistieken**: totalen, per sport, maandoverzicht en records.
- 🔗 **Delen**: privé deellink voor vrienden, of zet een route openbaar.
- 🧭 **Ontdek**: openbare routes zoeken op de kaart ("In dit gebied zoeken")
  plus een top-10 van de best gewaardeerde routes.
- 🚫 Géén collecties, géén bijdragen, géén bergtoppen-verzamelen, géén betaalmuur.

## Snel starten

Vereist: Node.js ≥ 22 (geen andere systeemdependencies — SQLite zit ingebouwd).

```bash
npm install
npm run build      # frontend bouwen
npm start          # draait op http://localhost:3000
```

Optioneel demodata (account demo@gout.be / demo1234 + voorbeeldroutes):

```bash
npm run seed
```

### Ontwikkelen

```bash
npm run dev        # API op :3000 + Vite met hot reload op :5173
npm run dev:mock   # idem, maar met een lokale mock-BRouter (offline werken)
npm test           # integratietests tegen het API-contract
npm run test:e2e   # Playwright-rooktest (vereist npm run build)
```

## Configuratie (omgevingsvariabelen)

| Variabele | Standaard | Uitleg |
|---|---|---|
| `PORT` | `3000` | HTTP-poort |
| `GOUT_DATA_DIR` | `./data` | Map voor de SQLite-databank |
| `BROUTER_URL` | `https://brouter.de/brouter` | BRouter-instantie (zelf hosten kan) |
| `BROUTER_PROFILE_WANDELEN` | `hiking-beta` | BRouter-profiel voor wandelen |
| `BROUTER_PROFILE_FIETSEN` | `trekking` | BRouter-profiel voor fietsen |
| `BROUTER_PROFILE_MTB` | `mtb` | BRouter-profiel voor MTB (valt terug op `trekking` als het profiel niet bestaat) |
| `NOMINATIM_URL` | `https://nominatim.openstreetmap.org` | Geocoder voor plaatsnamen |

## Deployen

**Docker:**

```bash
docker build -t gout .
docker run -d -p 3000:3000 -v gout-data:/app/data --name gout gout
```

**Kale VPS:** `npm ci && npm run build`, en draai `node server/index.js` onder
systemd of pm2 achter een reverse proxy met HTTPS (Caddy is in twee regels
klaar). De hele staat zit in één SQLite-bestand (`data/gout.db`) — back-uppen is
dat ene bestand kopiëren.

> **Let op:** de kaarttegels (OpenStreetMap, OpenTopoMap, CyclOSM), BRouter en
> Nominatim zijn gratis publieke diensten. Wees er zuinig op; voor intensief
> gebruik host je BRouter zelf en/of neem je een tegel-abonnement.

## Techniek

Bewust licht gehouden:

- **Server:** Express + `node:sqlite` (ingebouwd in Node 22) — één runtime-dependency.
- **Web:** Vite + vanilla TypeScript + Leaflet. Geen framework, geen chart-libs;
  het hoogteprofiel en de grafieken zijn handgetekende SVG.
- **Routering:** BRouter (GeoJSON mét hoogtedata per punt, dus het
  hoogteprofiel komt gratis mee).

```
server/          Express-API (ESM), auth met scrypt + sessies, GPX-generatie
web/src/         SPA met hash-router, views per pagina, gedeelde libs
docs/CONTRACT.md API-contract en bouwafspraken
```
