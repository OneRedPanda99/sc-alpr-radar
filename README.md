# SC ALPR Radar

Personal, offline-first phone PWA for South Carolina. Shows DeFlock / OpenStreetMap
ALPR cameras (Flock and other brands), warns you like a radar detector as you
approach them, draws field-of-view cones, and plans camera-avoidance routes with
turn-by-turn directions.

> Awareness tool only. Does not alter, obscure, jam, or interfere with any camera
> or your license plate. Keep your plate legible and drive attentively.

## Live site (GitHub Pages)

After the first successful Actions deploy:

**https://oneredpanda99.github.io/sc-alpr-radar/**

(Repo: https://github.com/OneRedPanda99/sc-alpr-radar)

Enable Pages once: **Settings → Pages → Source: GitHub Actions**.

## Is anything paid?

**No.** The whole stack is free and keyless:

| Piece | Service | Cost |
|---|---|---|
| Camera data | OpenStreetMap / Overpass (DeFlock tags) | Free |
| Map tiles | OpenFreeMap | Free |
| Search | Photon (Komoot) | Free |
| Routing + directions | Public OSRM demo | Free |
| Hosting | GitHub Pages | Free |

Public OSRM / Photon have fair-use rate limits — fine for personal use.

## Features

- **Drive mode** — follow-me map, FOV cones, brand-colored markers, rich proximity
  card (name, brand, facing, purpose, photo), radar beep, wake lock
- **Route mode** — origin + destination, fastest vs avoid-cameras, highlighted
  route line, turn-by-turn list, save into Drive
- **Offline** — update camera pack on Wi-Fi; alerts + saved routes work offline
- **Settings** — alert distance, mute, escalate, Flock-only, FOV toggle

## Local setup

Needs Node 18+.

```bash
npm install
npm run fetch:cameras   # refresh SC ALPR pack from Overpass
npm run dev -- --host   # http://localhost:5173
```

Production build:

```bash
npm run build
npm run preview -- --host
```

## Updating camera data

- `npm run fetch:cameras` regenerates `public/data/sc-cameras.geojson`
- In-app: **Settings → Update cameras** (bundled pack or live Overpass)

To add/fix a camera for everyone, use the [DeFlock app](https://deflock.me).

## Tech

Vite + React + TypeScript, MapLibre GL, Zustand, idb, vite-plugin-pwa.
