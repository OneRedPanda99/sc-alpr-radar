# SC ALPR Radar

Personal, offline-first phone PWA for South Carolina. Maps ALPR / plate-reader
cameras (Flock and other brands), live SCDOT traffic cameras, and city/police
CCTV, warns you like a radar detector as you approach them, draws field-of-view
cones, and plans camera-avoidance routes with turn-by-turn directions.

> Awareness tool only. Does not alter, obscure, jam, or interfere with any camera
> or your license plate. Keep your plate legible and drive attentively.

## Live site (GitHub Pages)

**https://oneredpanda99.github.io/sc-alpr-radar/**

(Repo: https://github.com/OneRedPanda99/sc-alpr-radar)

Enable Pages once: **Settings → Pages → Source: GitHub Actions**.

## Is anything paid?

**No.** The whole stack is free and keyless:

| Piece | Service | Cost |
|---|---|---|
| Plate readers (ALPR) | OpenStreetMap / Overpass (DeFlock tags) | Free |
| Traffic cameras | SCDOT 511 (Iteris ATIS public feed) | Free |
| City / police CCTV | OpenStreetMap / Overpass | Free |
| Community dataset | JSON file in this repo + GitHub Actions | Free |
| Map tiles | OpenFreeMap (streets) + Esri World Imagery (satellite) | Free |
| Search | Photon (Komoot) | Free |
| Routing + directions | Public OSRM demo | Free |
| Hosting | GitHub Pages | Free |

Public OSRM / Photon have fair-use rate limits — fine for personal use.

## Camera sources & coverage

The offline pack (`public/data/sc-cameras.geojson`) merges three feeds:

- **~1,600 ALPR / plate readers** — from OpenStreetMap / DeFlock (`surveillance:type=ALPR`).
- **~760 SCDOT traffic cameras** — the state's live 511 network (all of SC's
  public traffic cams are SCDOT's, including the Columbia area). Includes road
  name, travel-direction cones, and a live snapshot image.
- **~120 city / county / police CCTV + speed cameras** — every other mapped
  `man_made=surveillance` node in OSM.

Cameras are color-coded: ALPR by brand (Flock red, etc.), traffic blue, speed
amber. Traffic cameras are **visual-only by default** — they don't beep unless
you enable it in Settings.

## Features

- **Drive mode** — follow-me map, FOV cones, category-colored markers, rich
  proximity card (name, brand/type, facing, purpose, live photo), radar beep,
  wake lock. Bottom-left chips toggle **Plate / Traffic** layers, **Map/Satellite**,
  and **+ Add camera**.
- **Route mode** — origin + destination, fastest vs avoid-cameras (avoidance
  weighs plate readers only), highlighted route line, turn-by-turn list, save
  into Drive.
- **Add your own cameras** — tap **+ Add camera**, pick plate vs traffic, tap the
  map. Saved on-device, works in alerts + routing, survives data refreshes, and
  can be deleted from its detail card.
- **Shared community dataset** — a **Share with everyone** button submits a camera
  to the open dataset (see below).
- **Satellite view** — toggle Esri World Imagery from the map chip or Settings.
- **Offline** — update the pack on Wi-Fi; alerts, custom cameras, and saved
  routes all work offline.
- **Settings** — alert distance, mute, escalate, Flock-only, beep-for-traffic,
  basemap, layer toggles, FOV toggle, heading-up.

## Community dataset (crowdsourced, open, moderated)

Cameras that aren't in OSM/DeFlock or SCDOT (e.g. a neighborhood Flock unit) can
be shared with everyone — no backend, no secrets, all in this repo:

- The shared list lives in **`public/data/community-cameras.json`**.
- The app fetches it live from GitHub and merges it for **all** users (cached for
  offline). New cameras appear within ~a minute of approval.
- Anyone can submit via the **Add a camera** issue form (the app's *Share with
  everyone* button pre-fills it).
- A **GitHub Action** validates each submission (inside SC, valid type, not a
  duplicate) and **queues it** with a `pending-approval` label. Nothing is
  published automatically.
- A maintainer publishes it by adding the **`approved`** label to the issue; the
  Action then commits it and closes the issue.

### Maintainer setup (one time)

1. **Settings → Actions → General → Workflow permissions → Read and write
   permissions.** (Lets the Action commit approved cameras.)
2. That's it — the `approved` / `pending-approval` labels auto-create on first use.

### Approving submissions

Open **Issues → filter by `pending-approval`**, check the coordinates/type, and
add the **`approved`** label. Invalid ones are auto-rejected with a comment.

## Local setup

Needs Node 18+.

```bash
npm install
npm run fetch:cameras   # refresh the SC pack (OSM ALPR/CCTV + SCDOT 511)
npm run dev -- --host   # http://localhost:5173
```

Production build:

```bash
npm run build
npm run preview -- --host
```

## Updating camera data

- `npm run fetch:cameras` regenerates `public/data/sc-cameras.geojson`
  (OSM via Overpass + SCDOT 511) and prints counts by kind/brand.
- In-app: **Settings → Update cameras** (bundled pack or live Overpass); this
  also refreshes the community dataset.

To add/fix an ALPR for everyone, use the [DeFlock app](https://deflock.me); it
flows into the pack on the next update.

## Project layout

```
scripts/fetch-sc-cameras.mjs      # build the offline pack (OSM + SCDOT 511)
scripts/apply-camera-issue.mjs    # validate/apply a community submission
.github/ISSUE_TEMPLATE/           # "Add a camera" issue form
.github/workflows/                # deploy + community-camera Actions
public/data/sc-cameras.geojson    # bundled offline pack
public/data/community-cameras.json# shared, approved community cameras
src/                              # React app (modes, components, services, store)
```

## Tech

Vite + React + TypeScript, MapLibre GL, Zustand, idb, vite-plugin-pwa.
