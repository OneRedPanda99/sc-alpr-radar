# SC ALPR Radar

A personal, offline-first phone PWA that shows where automated license plate
readers (ALPRs) — Flock Safety and other brands — are in **South Carolina**, warns
you like a radar detector as you approach them, and can plan a driving route that
avoids as many cameras as possible while telling you how many are unavoidable.

Camera locations come from [DeFlock](https://deflock.me) and
[OpenStreetMap](https://www.openstreetmap.org) contributors
(`surveillance:type=ALPR`, ODbL).

> This is an **awareness** tool. It does not alter, obscure, jam, or interfere
> with any camera or your license plate. Keep your plate legible, follow all
> traffic laws, and drive attentively. Mount your phone; don't interact while
> moving.

## Features

- **Drive mode** — full-screen follow-me map, camera dots (colored by brand),
  upcoming cameras highlighted, radar-style beep when a camera ahead enters your
  tunable alert range. Keeps the screen awake while driving.
- **Route mode** — enter a destination, compare the fastest route vs a
  camera-avoidance route, see how many cameras are unavoidable, and save the
  route for offline use in Drive mode.
- **Settings** — alert distance (feet), mute, escalate-as-you-approach,
  Flock-only filter, heading-up vs north-up, and camera-data updates.
- **Offline** — after you update the camera pack on Wi-Fi, alerts and saved
  routes work with no connection. Basemap tiles are cached as you use them.

## Requirements

Node.js 18+ (for `fetch` in the data script).

## Setup

```bash
npm install
npm run fetch:cameras   # pull live SC ALPR data into public/data/sc-cameras.geojson
npm run dev             # local dev at http://localhost:5173
```

Build a production PWA:

```bash
npm run build
npm run preview -- --host   # open on your phone via your PC's LAN IP
```

Install to your phone home screen from the browser's "Add to Home Screen".

## Updating camera data

- `npm run fetch:cameras` regenerates the bundled offline pack from Overpass.
- In the app, **Settings → Update cameras** re-pulls either the bundled pack or a
  live Overpass query. Do this on Wi-Fi at home/work; then drive offline.

Coverage is only as complete as the DeFlock/OSM community has mapped. To fix or
add a camera, use the [DeFlock app](https://deflock.me) so corrections flow back
to everyone.

## Tech

Vite + React + TypeScript, MapLibre GL, Zustand, Turf.js, `idb`, `vite-plugin-pwa`.
Routing via public OSRM; geocoding via Nominatim.

## Data & attribution

© OpenStreetMap contributors (ODbL). Camera dataset curated by the DeFlock
project. Basemap tiles by OpenFreeMap / OpenMapTiles.
