import type { Camera, CameraDataset } from "@/types";
import { normalizeBrand } from "@/services/brand";
import { saveCameras } from "@/services/storage";

/**
 * The app ships with a pre-generated pack at public/data/sc-cameras.geojson
 * (built by scripts/fetch-sc-cameras.mjs). "Update" re-pulls that bundled file,
 * which the service worker keeps fresh from the network when online.
 *
 * A live refresh straight from Overpass is also supported for when you want the
 * newest data without redeploying, but the bundled file is the offline default.
 */

const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";
const OVERPASS_QUERY = `[out:json][timeout:120];
area["name"="South Carolina"]["admin_level"="4"]->.sc;
(
  node["surveillance:type"="ALPR"](area.sc);
);
out body;`;

type OverpassElement = {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
};

function parseDirections(tags: Record<string, string>): number[] {
  const raw = tags["direction"] ?? tags["camera:direction"] ?? "";
  if (!raw) return [];
  return raw
    .split(";")
    .map((s) => Number.parseFloat(s.trim()))
    .filter((n) => Number.isFinite(n));
}

function isOmni(tags: Record<string, string>): boolean {
  return (
    tags["camera:type"] === "dome" ||
    tags["surveillance:zone"] === "town" ||
    tags["direction"]?.trim() === "360"
  );
}

function elementToCamera(el: OverpassElement): Camera | null {
  if (el.lat == null || el.lon == null) return null;
  const tags = el.tags ?? {};
  const rawBrand =
    tags["manufacturer"] ?? tags["brand"] ?? tags["operator"] ?? tags["name"];
  return {
    id: `node/${el.id}`,
    lat: el.lat,
    lon: el.lon,
    brand: normalizeBrand(rawBrand),
    rawBrand,
    directions: parseDirections(tags),
    omni: isOmni(tags),
  };
}

/** Convert the bundled GeoJSON FeatureCollection into our dataset shape. */
export function datasetFromGeoJSON(fc: any): CameraDataset {
  const cameras: Camera[] = [];
  for (const f of fc.features ?? []) {
    const [lon, lat] = f.geometry?.coordinates ?? [];
    if (lon == null || lat == null) continue;
    const p = f.properties ?? {};
    cameras.push({
      id: String(p.id ?? `${lat},${lon}`),
      lat,
      lon,
      brand: p.brand ?? normalizeBrand(p.rawBrand),
      rawBrand: p.rawBrand,
      directions: Array.isArray(p.directions) ? p.directions : [],
      omni: Boolean(p.omni),
    });
  }
  return {
    generatedAt: fc.generatedAt ?? new Date().toISOString(),
    count: cameras.length,
    cameras,
  };
}

/** Load the packaged offline dataset shipped with the app. */
export async function fetchBundledDataset(baseUrl = import.meta.env.BASE_URL): Promise<CameraDataset> {
  const res = await fetch(`${baseUrl}data/sc-cameras.geojson`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Bundled data unavailable (${res.status})`);
  return datasetFromGeoJSON(await res.json());
}

/** Pull fresh data directly from Overpass (requires network). */
export async function fetchLiveDataset(): Promise<CameraDataset> {
  const res = await fetch(OVERPASS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(OVERPASS_QUERY)}`,
  });
  if (!res.ok) throw new Error(`Overpass error ${res.status}`);
  const json = await res.json();
  const cameras = (json.elements as OverpassElement[])
    .map(elementToCamera)
    .filter((c): c is Camera => c !== null);
  return {
    generatedAt: new Date().toISOString(),
    count: cameras.length,
    cameras,
  };
}

/** Update local storage from the chosen source and stamp syncedAt. */
export async function updateCameras(source: "bundled" | "live"): Promise<CameraDataset> {
  const dataset =
    source === "live" ? await fetchLiveDataset() : await fetchBundledDataset();
  dataset.syncedAt = new Date().toISOString();
  await saveCameras(dataset);
  return dataset;
}
