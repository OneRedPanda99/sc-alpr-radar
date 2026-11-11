import { openDB, type IDBPDatabase } from "idb";
import type { Bbox } from "@/services/osmRules";

/**
 * Statewide map-detail tiles, prebuilt weekly (scripts/build-osm-tiles.mjs)
 * and served with the site from GitHub's CDN.
 *
 * Opening the map reads index.json once, then for each layer you have on
 * fetches only the tiles on screen, all at once. Tiles you've seen before come
 * from this device (memory, then IndexedDB) with no network at all, and each
 * layer is handed back the moment its tiles are in, so the map fills in
 * progressively instead of waiting for the slowest layer.
 */
const BASE = `${import.meta.env.BASE_URL}osm/`;

interface TileIndex {
  generatedAt: string;
  zoom: number;
  layers: Record<string, string[]>;
}

interface LoadedIndex extends TileIndex {
  sets: Map<string, Set<string>>;
  /** Every tile any layer has: where the prebuilt data covers. */
  covered: Set<string>;
}

let indexPromise: Promise<LoadedIndex | null> | null = null;

/** The tile list, or null when the site has no prebuilt tiles. */
export function tileIndex(): Promise<LoadedIndex | null> {
  indexPromise ??= fetch(`${BASE}index.json`, { cache: "no-cache" })
    .then((r) => (r.ok ? (r.json() as Promise<TileIndex>) : null))
    .then((ix) => {
      if (!ix?.layers) return null;
      const sets = new Map(Object.entries(ix.layers).map(([k, v]) => [k, new Set(v)]));
      const covered = new Set<string>();
      for (const s of sets.values()) for (const t of s) covered.add(t);
      return { ...ix, sets, covered };
    })
    .catch(() => null);
  return indexPromise;
}

// --- tile maths -----------------------------------------------------------------
function tileX(lon: number, z: number) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}
function tileY(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

/** "x/y" keys covering a box, optionally grown by `ring` tiles each way. */
export function tilesFor(view: Bbox, z: number, ring = 0): string[] {
  const [s, w, n, e] = view;
  const out: string[] = [];
  for (let x = tileX(w, z) - ring; x <= tileX(e, z) + ring; x++) {
    for (let y = tileY(n, z) - ring; y <= tileY(s, z) + ring; y++) out.push(`${x}/${y}`);
  }
  return out;
}

// --- device cache ---------------------------------------------------------------
type Features = GeoJSON.Feature[];
const memory = new Map<string, Features>();
let dbPromise: Promise<IDBPDatabase> | null = null;
function db() {
  dbPromise ??= openDB("sc-alpr-osm", 1, {
    upgrade(d) {
      d.createObjectStore("tiles");
      d.createObjectStore("meta");
    },
  });
  return dbPromise;
}

/** A new weekly build replaces the old tiles on the device. */
let freshChecked = false;
async function dropStale(generatedAt: string) {
  if (freshChecked) return;
  freshChecked = true;
  try {
    const d = await db();
    if ((await d.get("meta", "generatedAt")) !== generatedAt) {
      await d.clear("tiles");
      await d.put("meta", generatedAt, "generatedAt");
    }
  } catch {
    // No IndexedDB (private mode): memory cache only.
  }
}

/** Requests in flight, so a second load during a pan reuses them. */
const pending = new Map<string, Promise<Features>>();

function getTile(layer: string, key: string, priority: "high" | "low" = "high"): Promise<Features> {
  const id = `${layer}/${key}`;
  const hit = memory.get(id);
  if (hit) return Promise.resolve(hit);
  let p = pending.get(id);
  if (!p) {
    p = fetchTile(id, priority).finally(() => pending.delete(id));
    pending.set(id, p);
  }
  return p;
}

async function fetchTile(id: string, priority: "high" | "low"): Promise<Features> {
  try {
    const stored = (await (await db()).get("tiles", id)) as Features | undefined;
    if (stored) {
      memory.set(id, stored);
      return stored;
    }
  } catch {
    // Fall through to the network.
  }
  // Not tied to any one view's AbortSignal: a pan shouldn't throw away a
  // tile that's nearly downloaded and about to be needed again.
  const res = await fetch(`${BASE}${id}.json`, { priority } as RequestInit);
  if (!res.ok) throw new Error(`tile ${id}: ${res.status}`);
  const features = ((await res.json()) as GeoJSON.FeatureCollection).features;
  memory.set(id, features);
  void db()
    .then((d) => d.put("tiles", features, id))
    .catch(() => {});
  return features;
}

/** Lines sit in every tile they cross; keep one copy of each piece. */
function dedupe(features: Features): Features {
  const seen = new Set<string>();
  return features.filter((f) => {
    const p = f.properties ?? {};
    const g = f.geometry as GeoJSON.Point | GeoJSON.LineString;
    const first = g.type === "Point" ? g.coordinates : g.coordinates[0];
    const k = `${p.category}|${p.osmType}${p.osmId}|${first?.join(",")}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Load `layers` for the view from the prebuilt tiles. Calls `onLayer` once per
 * layer as soon as that layer is ready. Returns false when the view isn't
 * covered by prebuilt tiles (outside SC, or none published), so the caller can
 * use the live servers instead.
 */
export async function loadTiles(
  layers: string[],
  view: Bbox,
  onLayer: (layer: string, features: Features) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  const ix = await tileIndex();
  if (!ix) return false;
  const visible = tilesFor(view, ix.zoom);
  if (!visible.some((t) => ix.covered.has(t))) return false;
  await dropStale(ix.generatedAt);

  await Promise.all(
    layers.map(async (layer) => {
      const have = ix.sets.get(layer);
      const keys = have ? visible.filter((t) => have.has(t)) : [];
      const parts = await Promise.all(keys.map((k) => getTile(layer, k).catch(() => [])));
      if (signal?.aborted) return;
      onLayer(layer, dedupe(parts.flat()));
    }),
  );

  // Once the view has settled, warm the ring around it so panning stays
  // instant. Low priority, and skipped if you've already moved on.
  setTimeout(() => {
    if (signal?.aborted) return;
    const ring = tilesFor(view, ix.zoom, 1).filter((t) => !visible.includes(t));
    for (const layer of layers) {
      const have = ix.sets.get(layer);
      for (const k of ring) if (have?.has(k)) void getTile(layer, k, "low").catch(() => {});
    }
  }, 1500);
  return true;
}
