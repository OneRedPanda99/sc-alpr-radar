import type { Camera } from "@/types";
import { cameraFromFeatureProps } from "@/services/cameraParse";

// Community-submitted cameras live in a plain JSON file in the repo so the
// dataset stays fully open source. We read it straight from GitHub (raw) so new
// submissions appear for everyone within ~a minute of the Action committing —
// no redeploy needed. Falls back to the deployed copy, then the cache.
const RAW_URL =
  "https://raw.githubusercontent.com/OneRedPanda99/sc-alpr-radar/main/public/data/community-cameras.json";

const DEPLOYED_URL = `${import.meta.env.BASE_URL}data/community-cameras.json`;

interface CommunityFile {
  updatedAt?: string;
  cameras?: Array<Record<string, unknown>>;
}

function toCameras(file: CommunityFile): Camera[] {
  const out: Camera[] = [];
  for (const raw of file.cameras ?? []) {
    const lat = Number(raw.lat);
    const lon = Number(raw.lon);
    const id = String(raw.id ?? "");
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const cam = cameraFromFeatureProps(id, lat, lon, raw);
    out.push({ ...cam, custom: false });
  }
  return out;
}

async function tryFetch(url: string, timeoutMs = 8000): Promise<Camera[] | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${url}?t=${Date.now()}`, {
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = (await res.json()) as CommunityFile;
    return toCameras(json);
  } catch {
    return null;
  }
}

/** Fetch community cameras, preferring the live GitHub copy. */
export async function fetchCommunityCameras(): Promise<Camera[] | null> {
  return (await tryFetch(RAW_URL)) ?? (await tryFetch(DEPLOYED_URL));
}

const REPO = "OneRedPanda99/sc-alpr-radar";

/**
 * Build a GitHub issue-form URL pre-filled from a camera. Submitting the issue
 * triggers the Action that adds it to the shared dataset for everyone.
 */
export function communitySubmitUrl(camera: Camera): string {
  const params = new URLSearchParams({
    template: "camera-submission.yml",
    title: `[camera] ${camera.name ?? camera.kind}`,
    lat: camera.lat.toFixed(6),
    lon: camera.lon.toFixed(6),
    kind: camera.kind,
  });
  if (camera.name) params.set("name", camera.name);
  return `https://github.com/${REPO}/issues/new?${params.toString()}`;
}
