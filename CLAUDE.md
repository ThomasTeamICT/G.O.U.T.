# G.O.U.T. — instructies voor Claude

Lichte, zelfgehoste Komoot-vervanger: routeplanner + GPX-editor voor wandelen,
fietsen en MTB. Alle UI-teksten in het **Nederlands** (Vlaams, "je"-vorm).

## Architectuur

- `server/` — Express (ESM JS) + `node:sqlite`. Auth: scrypt + sessiecookie.
  Routing via BRouter-proxy (`server/proxy.js`). GPX-generatie in `server/gpx.js`.
  API-antwoorden ALTIJD via `server/serialize.js` (camelCase-vormen).
- `web/` — Vite + vanilla TypeScript + Leaflet, hash-router (`src/router.ts`),
  views in `src/views/`, gedeelde libs in `src/lib/`. DOM bouwen met `el()` uit
  `src/ui.ts` (strings → textContent; nooit innerHTML met gebruikersdata).
- **Bindend contract:** `docs/CONTRACT.md` (API-vormen, bestandseigendom, UX-regels).

## Regels

- GEEN nieuwe npm-dependencies zonder expliciete vraag; alles is bewust hand-gerold.
- SQL alleen met prepared statements.
- Formattering via de fmt-helpers in `src/ui.ts`; sport altijd met icoon.
- Types in `web/src/types.ts` zijn de bron van waarheid voor API-JSON.

## Commando's

```bash
npm run dev:mock   # ontwikkelen zonder internet (mock-BRouter)
npm test           # integratietests (verplicht groen vóór commit)
npm run typecheck  # tsc --noEmit
npm run build && npm run test:e2e   # Playwright-rooktest
```
