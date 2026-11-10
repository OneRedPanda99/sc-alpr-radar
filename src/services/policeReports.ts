import type { Camera, LatLng } from "@/types";

/**
 * Spots you mark yourself with the Report button: police (like a radar
 * detector's memory) and road hazards.
 *
 * Kept in localStorage on this device only and never sent anywhere. They show
 * up as live incidents, so they draw on the map, alert you on the way back
 * and list in Overwatch, then drop off once they're too old to mean anything.
 */
const KEY = "alpr.policeReports";

export type ReportType = "police" | "foot" | "debris" | "water" | "pothole";

export const REPORT_TYPES: { type: ReportType; label: string; symbol: string }[] = [
  { type: "police", label: "Police", symbol: "🚔" },
  { type: "foot", label: "On foot", symbol: "👮" },
  { type: "debris", label: "Debris", symbol: "🪵" },
  { type: "water", label: "Water", symbol: "🌊" },
  { type: "pothole", label: "Pothole", symbol: "🕳️" },
];

/** A parked cruiser rarely stays put longer than 20 minutes; hazards linger. */
export function reportTtl(type: ReportType): number {
  return (type === "police" || type === "foot" ? 20 : 60) * 60 * 1000;
}

export function isPolice(type: ReportType): boolean {
  return type === "police" || type === "foot";
}

export interface UserReport {
  id: string;
  lat: number;
  lon: number;
  at: number;
  type: ReportType;
}

/** Older saves had `onFoot` instead of a type. */
type Stored = Partial<UserReport> & { onFoot?: boolean };

function load(): UserReport[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as Stored[]) : [];
    if (!Array.isArray(list)) return [];
    return list
      .filter((r) => r.id && Number.isFinite(r.lat) && Number.isFinite(r.lon) && r.at)
      .map((r) => ({
        id: r.id!,
        lat: r.lat!,
        lon: r.lon!,
        at: r.at!,
        type: r.type ?? (r.onFoot ? "foot" : "police"),
      }));
  } catch {
    return [];
  }
}

function save(list: UserReport[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Private mode or full storage: the report still lasts this session.
  }
}

let reports = load();

export function listReports(now = Date.now()): UserReport[] {
  const live = reports.filter((r) => now - r.at < reportTtl(r.type));
  if (live.length !== reports.length) {
    reports = live;
    save(reports);
  }
  return reports;
}

export function addReport(point: LatLng, type: ReportType = "police"): UserReport {
  const r: UserReport = {
    id: `report/${Date.now()}`,
    lat: point.lat,
    lon: point.lon,
    at: Date.now(),
    type,
  };
  reports = [...listReports(), r];
  save(reports);
  return r;
}

export function updateReport(id: string, patch: Partial<Pick<UserReport, "type">>) {
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

const NAMES: Record<ReportType, string> = {
  police: "Police",
  foot: "Police on foot",
  debris: "Debris in road",
  water: "Water on road",
  pothole: "Pothole",
};

/** Reports as map points, so every layer and alert path handles them. */
export function reportsAsCameras(now = Date.now()): Camera[] {
  return listReports(now).map((r) => {
    const mins = Math.max(0, Math.round((now - r.at) / 60000));
    const ttlMin = reportTtl(r.type) / 60000;
    return {
      id: r.id,
      lat: r.lat,
      lon: r.lon,
      kind: "incident",
      brand: "Other",
      name: NAMES[r.type],
      operator: "Your report",
      source: "Your report",
      reportedAt: new Date(r.at).toISOString(),
      directions: [],
      omni: true,
      purpose: `You marked this ${mins < 1 ? "just now" : `${mins} min ago`} (${freshness(now - r.at)}). Clears after ${ttlMin} min.`,
      fovHalfAngle: 180,
      myReport: true,
      policeReport: isPolice(r.type),
    };
  });
}

export function reportSymbol(name?: string): string | null {
  const t = (Object.keys(NAMES) as ReportType[]).find((k) => NAMES[k] === name);
  return t ? REPORT_TYPES.find((x) => x.type === t)!.symbol : null;
}
