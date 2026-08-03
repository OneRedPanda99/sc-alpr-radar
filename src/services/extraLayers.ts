import type { Camera } from "@/types";
import { cameraFromFeatureProps } from "@/services/cameraParse";

/**
 * Layers that ship as their own GeoJSON file rather than inside the camera
 * pack, because they refresh on completely different cadences: licensed radio
 * towers essentially never move, while WiGLE candidates change whenever someone
 * drives a new road.
 */
async function fetchLayer(
  file: string,
  baseUrl: string,
  decorate: (cam: Camera, p: Record<string, unknown>) => Camera,
): Promise<Camera[] | null> {
  try {
    const res = await fetch(`${baseUrl}data/${file}`, { cache: "no-cache" });
    if (!res.ok) return null;
    const fc = await res.json();
    const out: Camera[] = [];
    for (const f of fc.features ?? []) {
      const [lon, lat] = f.geometry?.coordinates ?? [];
      if (lon == null || lat == null) continue;
      const p = (f.properties ?? {}) as Record<string, unknown>;
      out.push(decorate(cameraFromFeatureProps(String(p.id), lat, lon, p), p));
    }
    return out;
  } catch {
    return null;
  }
}

/** Licensed public-safety radio transmitter sites (FCC ULS). */
export function fetchRadioSites(
  baseUrl = import.meta.env.BASE_URL,
): Promise<Camera[] | null> {
  return fetchLayer("sc-radio-sites.geojson", baseUrl, (cam, p) => ({
    ...cam,
    frequencies: Array.isArray(p.frequencies)
      ? (p.frequencies as number[])
      : undefined,
  }));
}

/** Unconfirmed cameras inferred from WiGLE WiFi signatures. */
export function fetchWigleCandidates(
  baseUrl = import.meta.env.BASE_URL,
): Promise<Camera[] | null> {
  return fetchLayer("sc-wigle-candidates.geojson", baseUrl, (cam, p) => ({
    ...cam,
    unconfirmed: true,
    evidence: typeof p.evidence === "string" ? p.evidence : undefined,
  }));
}
