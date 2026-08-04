import type { Camera, CameraDataset } from "@/types";
import { cameraFromFeatureProps, cameraFromTags } from "@/services/cameraParse";
import { saveCameras } from "@/services/storage";

/**
 * Bump when the pack gains new kinds or fields. v2 added police stations and
 * gunshot detectors; v3 added live HLS stream URLs.
 *
 * Forgetting to bump this is a silent failure — the app keeps a cached pack
 * that lacks the new field and quietly degrades — so `hydrate` also refreshes
 * the bundle in the background whenever `generatedAt` differs. This constant
 * is now just the fast path for a breaking change.
 */
export const PACK_SCHEMA_VERSION = 3;

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

// Must stay in sync with scripts/fetch-sc-cameras.mjs. Grab EVERY mapped
// surveillance node (all ALPRs are man_made=surveillance) plus speed cameras
// and police stations, then classify locally. Narrowing this query is what
// previously made "Update → Live" *shrink* the dataset.
const OVERPASS_QUERY = `[out:json][timeout:180];
area["name"="South Carolina"]["admin_level"="4"]->.sc;
(
  node["man_made"="surveillance"](area.sc);
  node["highway"="speed_camera"](area.sc);
  node["amenity"="police"](area.sc);
  way["amenity"="police"](area.sc);
);
out center;`;

type OverpassElement = {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

/**
 * Sources the browser cannot refresh on its own. SCDOT's 511 feed serves no
 * `Access-Control-Allow-Origin` header, so it is only ever baked in at build
 * time — a live Overpass update must carry these forward rather than drop them.
 */
function isBrowserUnfetchable(camera: Camera): boolean {
  return camera.id.startsWith("sc511/");
}

export function datasetFromGeoJSON(fc: any): CameraDataset {
  const cameras: Camera[] = [];
  for (const f of fc.features ?? []) {
    const [lon, lat] = f.geometry?.coordinates ?? [];
    if (lon == null || lat == null) continue;
    const p = f.properties ?? {};
    cameras.push(
      cameraFromFeatureProps(String(p.id ?? `${lat},${lon}`), lat, lon, p),
    );
  }
  return {
    generatedAt: fc.generatedAt ?? new Date().toISOString(),
    count: cameras.length,
    cameras,
    schemaVersion: PACK_SCHEMA_VERSION,
  };
}

export async function fetchBundledDataset(
  baseUrl = import.meta.env.BASE_URL,
): Promise<CameraDataset> {
  const res = await fetch(`${baseUrl}data/sc-cameras.geojson`, {
    cache: "no-cache",
  });
  if (!res.ok) throw new Error(`Bundled data unavailable (${res.status})`);
  return datasetFromGeoJSON(await res.json());
}

export async function fetchLiveDataset(): Promise<CameraDataset> {
  const body = `data=${encodeURIComponent(OVERPASS_QUERY)}`;
  let lastError = "";

  for (const endpoint of OVERPASS_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 190_000);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        lastError =
          res.status === 429
            ? `${new URL(endpoint).host} rate-limited this device — wait a minute`
            : `${new URL(endpoint).host} returned ${res.status}`;
        continue;
      }
      const json = await res.json();
      const cameras = (json.elements as OverpassElement[])
        .map((el) => {
          const lat = el.lat ?? el.center?.lat;
          const lon = el.lon ?? el.center?.lon;
          if (lat == null || lon == null) return null;
          return cameraFromTags(
            `${el.type}/${el.id}`,
            lat,
            lon,
            el.tags ?? {},
          );
        })
        .filter((c): c is Camera => c != null);
      if (cameras.length === 0) {
        lastError = "Overpass returned no cameras — try again shortly";
        continue;
      }
      return {
        generatedAt: new Date().toISOString(),
        count: cameras.length,
        cameras,
        schemaVersion: PACK_SCHEMA_VERSION,
      };
    } catch (e) {
      clearTimeout(timer);
      lastError =
        (e as Error).name === "AbortError"
          ? `${new URL(endpoint).host} timed out`
          : `${new URL(endpoint).host}: ${(e as Error).message}`;
    }
  }

  throw new Error(
    `Live update failed (${lastError}). Using the bundled pack still works offline.`,
  );
}

/**
 * A live update refreshes everything OSM knows about, then re-attaches the
 * build-time-only sources (SCDOT 511) from the bundled pack so the camera count
 * only ever goes up.
 */
async function fetchLiveMergedDataset(): Promise<CameraDataset> {
  const live = await fetchLiveDataset();

  let carriedOver: Camera[] = [];
  try {
    const bundled = await fetchBundledDataset();
    carriedOver = bundled.cameras.filter(isBrowserUnfetchable);
  } catch {
    // Bundled pack unreachable (offline / first run). Ship what OSM gave us.
  }

  const seen = new Set(live.cameras.map((c) => c.id));
  const cameras = [
    ...live.cameras,
    ...carriedOver.filter((c) => !seen.has(c.id)),
  ];

  return {
    generatedAt: live.generatedAt,
    count: cameras.length,
    cameras,
    schemaVersion: PACK_SCHEMA_VERSION,
  };
}

export async function updateCameras(
  source: "bundled" | "live",
): Promise<CameraDataset> {
  const dataset =
    source === "live"
      ? await fetchLiveMergedDataset()
      : await fetchBundledDataset();
  dataset.syncedAt = new Date().toISOString();
  await saveCameras(dataset);
  return dataset;
}
