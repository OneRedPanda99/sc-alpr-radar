import type { Camera, CameraDataset } from "@/types";
import { cameraFromFeatureProps, cameraFromTags } from "@/services/cameraParse";
import { saveCameras } from "@/services/storage";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const OVERPASS_QUERY = `[out:json][timeout:90];
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
    const timer = setTimeout(() => controller.abort(), 100_000);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        lastError = `${new URL(endpoint).host} returned ${res.status}`;
        continue;
      }
      const json = await res.json();
      const cameras = (json.elements as OverpassElement[])
        .filter((el) => el.lat != null && el.lon != null)
        .map((el) =>
          cameraFromTags(`node/${el.id}`, el.lat!, el.lon!, el.tags ?? {}),
        );
      if (cameras.length === 0) {
        lastError = "Overpass returned no cameras — try again shortly";
        continue;
      }
      return {
        generatedAt: new Date().toISOString(),
        count: cameras.length,
        cameras,
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

export async function updateCameras(
  source: "bundled" | "live",
): Promise<CameraDataset> {
  const dataset =
    source === "live" ? await fetchLiveDataset() : await fetchBundledDataset();
  dataset.syncedAt = new Date().toISOString();
  await saveCameras(dataset);
  return dataset;
}
