import type { Camera, LatLng } from "@/types";

/**
 * "Police here" spots you mark yourself, like a radar detector's memory.
 *
 * Kept in localStorage on this device only and never sent anywhere. They show
 * up as live incidents, so they draw on the map, alert you on the way back
 * and list in Overwatch, then drop off once they're too old to mean anything.
 */
const KEY = "alpr.policeReports";
/** A parked cruiser rarely stays put longer than this. */
export const REPORT_TTL_MS = 20 * 60 * 1000;

export interface PoliceReport {
  id: string;
  lat: number;
  lon: number;
  at: number;
  onFoot: boolean;
}

function load(): PoliceReport[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as PoliceReport[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function save(list: PoliceReport[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Private mode or full storage: the report still lasts this session.
  }
}

let reports = load();

export function listReports(now = Date.now()): PoliceReport[] {
  const live = reports.filter((r) => now - r.at < REPORT_TTL_MS);
  if (live.length !== reports.length) {
    reports = live;
    save(reports);
  }
  return reports;
}

export function addReport(point: LatLng, onFoot = false): PoliceReport {
  const r: PoliceReport = {
    id: `police/${Date.now()}`,
    lat: point.lat,
    lon: point.lon,
    at: Date.now(),
    onFoot,
  };
  reports = [...listReports(), r];
  save(reports);
  return r;
}

export function updateReport(id: string, patch: Partial<Pick<PoliceReport, "onFoot">>) {
  reports = listReports().map((r) => (r.id === id ? { ...r, ...patch } : r));
  save(reports);
}

export function removeReport(id: string) {
  reports = listReports().filter((r) => r.id !== id);
  save(reports);
}

/** How fresh a report is, in the words the app uses everywhere. */
export function freshness(ageMs: number): "live" | "recent" | "stale" {
  if (ageMs < 2 * 60 * 1000) return "live";
  if (ageMs < 10 * 60 * 1000) return "recent";
  return "stale";
}

/** Reports as map points, so every layer and alert path handles them. */
export function reportsAsCameras(now = Date.now()): Camera[] {
  return listReports(now).map((r) => {
    const mins = Math.max(0, Math.round((now - r.at) / 60000));
    return {
      id: r.id,
      lat: r.lat,
      lon: r.lon,
      kind: "incident",
      brand: "Other",
      name: r.onFoot ? "Police on foot" : "Police",
      operator: "Your report",
      source: "Your report",
      reportedAt: new Date(r.at).toISOString(),
      directions: [],
      omni: true,
      purpose: `You marked this ${mins < 1 ? "just now" : `${mins} min ago`} (${freshness(now - r.at)}). Clears after 20 min.`,
      fovHalfAngle: 180,
      policeReport: true,
    };
  });
}
