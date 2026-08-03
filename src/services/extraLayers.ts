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

/**
 * Live road incidents. Unlike the other layers this changes by the minute, so
 * it is read from the tip of main (raw GitHub / jsDelivr) rather than the
 * deployed copy — a Pages redeploy every 10 minutes would be absurd. The
 * deployed file is the offline fallback.
 */
const INCIDENT_URLS = [
  "https://raw.githubusercontent.com/OneRedPanda99/sc-alpr-radar/main/public/data/live-incidents.json",
  "https://cdn.jsdelivr.net/gh/OneRedPanda99/sc-alpr-radar@main/public/data/live-incidents.json",
];

/** Hide anything older than this even if the feed still lists it. */
const INCIDENT_MAX_AGE_MS = 3 * 60 * 60 * 1000;

interface RawIncident {
  id: string;
  lat: number;
  lon: number;
  source: string;
  headline: string;
  description?: string;
  road?: string | null;
  reportedAt?: string | null;
}

function incidentToCamera(r: RawIncident): Camera {
  const where = r.description || r.road || "";
  return {
    id: r.id,
    lat: r.lat,
    lon: r.lon,
    kind: "incident",
    brand: "Other",
    rawBrand: r.source,
    name: r.headline,
    operator: r.source,
    directions: [],
    omni: true,
    purpose: where
      ? `${r.headline} — ${where} (via ${r.source})`
      : `${r.headline} (via ${r.source})`,
    fovHalfAngle: 180,
    source: r.source,
    reportedAt: r.reportedAt ?? undefined,
  };
}

export async function fetchLiveIncidents(
  baseUrl = import.meta.env.BASE_URL,
): Promise<Camera[] | null> {
  const urls = [...INCIDENT_URLS, `${baseUrl}data/live-incidents.json`];
  for (const url of urls) {
    try {
      const sep = url.includes("?") ? "&" : "?";
      const res = await fetch(`${url}${sep}t=${Date.now()}`, {
        cache: "no-store",
      });
      if (!res.ok) continue;
      const json = await res.json();
      const now = Date.now();
      const out: Camera[] = [];
      for (const r of (json.incidents ?? []) as RawIncident[]) {
        if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
        if (r.reportedAt) {
          const age = now - new Date(r.reportedAt).getTime();
          if (Number.isFinite(age) && age > INCIDENT_MAX_AGE_MS) continue;
        }
        out.push(incidentToCamera(r));
      }
      return out;
    } catch {
      // try the next mirror
    }
  }
  return null;
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
