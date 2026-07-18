import type { Camera, CameraDataset } from "@/types";
import { cameraFromFeatureProps, cameraFromTags } from "@/services/cameraParse";
import { saveCameras } from "@/services/storage";

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
  const res = await fetch(OVERPASS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(OVERPASS_QUERY)}`,
  });
  if (!res.ok) throw new Error(`Overpass error ${res.status}`);
  const json = await res.json();
  const cameras = (json.elements as OverpassElement[])
    .filter((el) => el.lat != null && el.lon != null)
    .map((el) =>
      cameraFromTags(`node/${el.id}`, el.lat!, el.lon!, el.tags ?? {}),
    );
  return {
    generatedAt: new Date().toISOString(),
    count: cameras.length,
    cameras,
  };
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
