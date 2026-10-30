import type {
  LatLng,
  PlanRoute,
  Trip,
  TripPlan,
  TripStop,
} from "@/types";
import type { MapStop } from "@/components/MapView";

/** Plan A is the app accent; B, C… get distinct, colour-blind-friendly hues. */
export const PLAN_COLORS = ["#16e0b8", "#4dd6ff", "#ff9f1c", "#c084fc", "#f472b6", "#facc15"];

export const planColor = (index: number) => PLAN_COLORS[index % PLAN_COLORS.length];
export const planLetter = (index: number) => String.fromCharCode(65 + index);

let seq = 0;
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function newStop(label = "", point: LatLng | null = null): TripStop {
  return { id: uid("stop"), label, point };
}

export function newPlan(index: number, stops?: TripStop[]): TripPlan {
  return {
    id: uid("plan"),
    name: `Plan ${planLetter(index)}`,
    stops: stops ?? [newStop(), newStop()],
    notes: "",
    prefer: "avoid",
  };
}

export function newTrip(): Trip {
  const now = new Date().toISOString();
  return {
    id: uid("trip"),
    name: "",
    createdAt: now,
    updatedAt: now,
    plans: [newPlan(0)],
  };
}

/** Copy a plan as the starting point for an alternative (new stop ids). */
export function duplicatePlan(plan: TripPlan, index: number): TripPlan {
  return {
    ...newPlan(index, plan.stops.map((s) => ({ ...s, id: uid("stop") }))),
    notes: plan.notes,
    prefer: plan.prefer,
  };
}

/** Identity of what a plan's route depends on; a mismatch means re-plan. */
export function planKey(plan: TripPlan, avoidKey: string): string {
  const pts = plan.stops
    .map((s) => (s.point ? `${s.point.lat.toFixed(5)},${s.point.lon.toFixed(5)}` : "-"))
    .join(";");
  return `${pts}|${avoidKey}`;
}

export function planReady(plan: TripPlan): boolean {
  return plan.stops.length >= 2 && plan.stops.every((s) => s.point);
}

export function chosenRoute(plan: TripPlan): PlanRoute | null {
  return plan.computed?.[plan.prefer] ?? null;
}

export function tripTitle(trip: Trip): string {
  if (trip.name.trim()) return trip.name.trim();
  const stops = trip.plans[0]?.stops ?? [];
  const end = stops[stops.length - 1];
  return end?.label ? `To ${shortLabel(end.label)}` : "Untitled trip";
}

/** First comma-separated chunk: "1600 Main St, Columbia, SC" → "1600 Main St". */
export function shortLabel(label: string): string {
  return label.split(",")[0].trim() || label;
}

/** A for start, B for destination, numbers for the stops in between. */
export function stopBadge(index: number, count: number): string {
  if (index === 0) return "A";
  if (index === count - 1) return "B";
  return String(index);
}

export function mapStops(plan: TripPlan): MapStop[] {
  const n = plan.stops.length;
  return plan.stops.flatMap((s, i) =>
    s.point
      ? [
          {
            id: s.id,
            point: s.point,
            label: s.label,
            role: i === 0 ? ("start" as const) : i === n - 1 ? ("end" as const) : ("stop" as const),
            checkpoint: s.checkpoint,
            badge: stopBadge(i, n),
          },
        ]
      : [],
  );
}

/** Wall-clock arrival if you left now, e.g. "3:42 PM". */
export function arrivalTime(durationSeconds: number, from = Date.now()): string {
  return new Date(from + durationSeconds * 1000).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

// --- Recent places (per-device convenience; fine to lose) -------------------

const RECENTS_KEY = "alpr.recentPlaces";

export interface RecentPlace {
  label: string;
  point: LatLng;
}

export function loadRecents(): RecentPlace[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    return raw ? (JSON.parse(raw) as RecentPlace[]) : [];
  } catch {
    return [];
  }
}

export function rememberPlace(place: RecentPlace) {
  if (place.label === "Current location") return;
  try {
    const next = [place, ...loadRecents().filter((p) => p.label !== place.label)].slice(0, 8);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // storage blocked: recents are a nicety
  }
}
