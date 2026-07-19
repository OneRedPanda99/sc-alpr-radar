import type { Camera } from "@/types";
import { cameraFromFeatureProps } from "@/services/cameraParse";

// Community-submitted cameras live in a plain JSON file in the repo so the
// dataset stays fully open source. We always prefer sources that track the tip
// of `main` (raw GitHub / jsDelivr) so approvals show up without waiting for a
// Pages redeploy. The deployed copy is only a last-resort offline fallback.
const COMMUNITY_URLS = [
  "https://raw.githubusercontent.com/OneRedPanda99/sc-alpr-radar/main/public/data/community-cameras.json",
  "https://cdn.jsdelivr.net/gh/OneRedPanda99/sc-alpr-radar@main/public/data/community-cameras.json",
  `${import.meta.env.BASE_URL}data/community-cameras.json`,
];

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
    const sep = url.includes("?") ? "&" : "?";
    const res = await fetch(`${url}${sep}t=${Date.now()}`, {
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

/** Fetch community cameras from the tip of main (raw / CDN), then deployed copy. */
export async function fetchCommunityCameras(): Promise<Camera[] | null> {
  for (const url of COMMUNITY_URLS) {
    const cams = await tryFetch(url);
    if (cams != null) return cams;
  }
  return null;
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
