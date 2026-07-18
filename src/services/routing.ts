import type { Camera, LatLng, RouteStep, SavedRoute } from "@/types";
import { haversineMeters, feetToMeters } from "@/services/geo";

/**
 * Free routing stack (no API keys / no paid services):
 *  - Geocode: Photon (Komoot) — CORS-friendly, OSM-based
 *  - Directions: public OSRM demo — geometries + turn-by-turn steps
 *
 * Avoidance = pick the OSRM alternative with the fewest cameras in a corridor.
 */

const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";
const PHOTON_BASE = "https://photon.komoot.io/api/";
const CORRIDOR_METERS = feetToMeters(280);

// Rough SC bias for Photon results.
const SC_CENTER = { lat: 33.8361, lon: -81.1637 };

interface OsrmManeuver {
  type?: string;
  modifier?: string;
  location?: [number, number];
  bearing_after?: number;
}

interface OsrmStep {
  distance: number;
  duration: number;
  name?: string;
  maneuver?: OsrmManeuver;
  mode?: string;
}

interface OsrmLeg {
  steps?: OsrmStep[];
}

interface OsrmRoute {
  geometry: { coordinates: [number, number][] };
  distance: number;
  duration: number;
  legs?: OsrmLeg[];
}

interface ScoredRoute {
  coordinates: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
  cameraCount: number;
  steps: RouteStep[];
}

function distanceToSegment(p: LatLng, a: LatLng, b: LatLng): number {
  const latRef = (a.lat + b.lat) / 2;
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((latRef * Math.PI) / 180);
  const ax = a.lon * mPerDegLon;
  const ay = a.lat * mPerDegLat;
  const bx = b.lon * mPerDegLon;
  const by = b.lat * mPerDegLat;
  const px = p.lon * mPerDegLon;
  const py = p.lat * mPerDegLat;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function camerasNearRoute(
  coordinates: [number, number][],
  cameras: Camera[],
  corridorMeters = CORRIDOR_METERS,
): Camera[] {
  const path: LatLng[] = coordinates.map(([lon, lat]) => ({ lat, lon }));
  if (path.length < 2) return [];

  let minLat = Infinity,
    maxLat = -Infinity,
    minLon = Infinity,
    maxLon = -Infinity;
  for (const pt of path) {
    minLat = Math.min(minLat, pt.lat);
    maxLat = Math.max(maxLat, pt.lat);
    minLon = Math.min(minLon, pt.lon);
    maxLon = Math.max(maxLon, pt.lon);
  }
  const pad = corridorMeters / 111320 + 0.005;
  const hits: Camera[] = [];
  for (const cam of cameras) {
    if (
      cam.lat < minLat - pad ||
      cam.lat > maxLat + pad ||
      cam.lon < minLon - pad ||
      cam.lon > maxLon + pad
    )
      continue;
    for (let i = 1; i < path.length; i++) {
      if (distanceToSegment(cam, path[i - 1], path[i]) <= corridorMeters) {
        hits.push(cam);
        break;
      }
    }
  }
  return hits;
}

function maneuverInstruction(step: OsrmStep): string {
  const m = step.maneuver ?? {};
  const type = m.type ?? "continue";
  const mod = m.modifier ?? "";
  const road = step.name?.trim() || "the road";

  const turn = (dir: string) =>
    `Turn ${dir}${road !== "the road" ? ` onto ${road}` : ""}`;

  switch (type) {
    case "depart":
      return `Head out${road !== "the road" ? ` on ${road}` : ""}`;
    case "arrive":
      return "Arrive at destination";
    case "roundabout":
    case "rotary":
      return `Enter roundabout${road !== "the road" ? `, exit onto ${road}` : ""}`;
    case "merge":
      return `Merge${mod ? ` ${mod}` : ""}${road !== "the road" ? ` onto ${road}` : ""}`;
    case "fork":
      return `Keep ${mod || "straight"} at the fork${road !== "the road" ? ` onto ${road}` : ""}`;
    case "end of road":
      return turn(mod || "left");
    case "new name":
      return `Continue onto ${road}`;
    case "notification":
      return `Continue on ${road}`;
    case "on ramp":
      return `Take the ramp${mod ? ` ${mod}` : ""}${road !== "the road" ? ` onto ${road}` : ""}`;
    case "off ramp":
      return `Take the exit${mod ? ` ${mod}` : ""}${road !== "the road" ? ` onto ${road}` : ""}`;
    case "turn":
      return turn(mod || "ahead");
    case "continue":
    default:
      if (mod && mod !== "straight") return turn(mod);
      return `Continue${road !== "the road" ? ` on ${road}` : ""}`;
  }
}

function extractSteps(route: OsrmRoute): RouteStep[] {
  const steps: RouteStep[] = [];
  for (const leg of route.legs ?? []) {
    for (const s of leg.steps ?? []) {
      // Skip tiny unnamed continues that clutter the list.
      if (
        (s.maneuver?.type === "continue" || s.maneuver?.type === "new name") &&
        s.distance < 25
      )
        continue;
      steps.push({
        instruction: maneuverInstruction(s),
        name: s.name ?? "",
        distanceMeters: s.distance,
        durationSeconds: s.duration,
        maneuverType: s.maneuver?.type ?? "continue",
        location: (s.maneuver?.location ?? [0, 0]) as [number, number],
      });
    }
  }
  return steps;
}

async function fetchOsrm(origin: LatLng, destination: LatLng): Promise<OsrmRoute[]> {
  const coords = `${origin.lon},${origin.lat};${destination.lon},${destination.lat}`;
  const url =
    `${OSRM_BASE}/${coords}` +
    `?overview=full&geometries=geojson&alternatives=true&steps=true&continue_straight=true`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Routing server error (${res.status}). Check your connection and try again.`,
    );
  }
  const json = await res.json();
  if (json.code !== "Ok" || !json.routes?.length) {
    throw new Error(
      "No driving route found between those points. Try a more specific address.",
    );
  }
  return json.routes as OsrmRoute[];
}

export interface RoutePlan {
  fastest: ScoredRoute;
  avoidance: ScoredRoute;
  camerasOnFastest: number;
  camerasUnavoidable: number;
}

export async function planRoute(
  origin: LatLng,
  destination: LatLng,
  cameras: Camera[],
): Promise<RoutePlan> {
  const dist = haversineMeters(origin, destination);
  if (dist < 40) {
    throw new Error("Origin and destination are too close together.");
  }

  const routes = await fetchOsrm(origin, destination);

  const scored: ScoredRoute[] = routes.map((r) => ({
    coordinates: r.geometry.coordinates,
    distanceMeters: r.distance,
    durationSeconds: r.duration,
    cameraCount: camerasNearRoute(r.geometry.coordinates, cameras).length,
    steps: extractSteps(r),
  }));

  const fastest = scored[0];
  const avoidance = [...scored].sort(
    (a, b) =>
      a.cameraCount - b.cameraCount || a.durationSeconds - b.durationSeconds,
  )[0];

  return {
    fastest,
    avoidance,
    camerasOnFastest: fastest.cameraCount,
    camerasUnavoidable: avoidance.cameraCount,
  };
}

export function planToSavedRoute(
  plan: RoutePlan,
  origin: LatLng,
  destination: LatLng,
  destinationLabel: string,
): SavedRoute {
  return {
    id: `route-${Date.now()}`,
    createdAt: new Date().toISOString(),
    origin,
    destination,
    destinationLabel,
    coordinates: plan.avoidance.coordinates,
    distanceMeters: plan.avoidance.distanceMeters,
    durationSeconds: plan.avoidance.durationSeconds,
    camerasOnFastest: plan.camerasOnFastest,
    camerasUnavoidable: plan.camerasUnavoidable,
    steps: plan.avoidance.steps,
  };
}

/** Photon geocoder — works from browsers (unlike Nominatim's UA policy). */
export async function geocode(
  query: string,
  near?: LatLng | null,
): Promise<{ label: string; point: LatLng }[]> {
  const q = query.trim();
  if (!q) return [];

  const bias = near ?? SC_CENTER;
  const params = new URLSearchParams({
    q,
    limit: "6",
    lat: String(bias.lat),
    lon: String(bias.lon),
    // Prefer US results; Photon uses osm_tag filters differently — bias is enough.
  });

  const res = await fetch(`${PHOTON_BASE}?${params}`);
  if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
  const json = await res.json();

  return (json.features as any[])
    .map((f) => {
      const [lon, lat] = f.geometry?.coordinates ?? [];
      if (lon == null || lat == null) return null;
      const p = f.properties ?? {};
      // Soft filter: keep US / nearby when country is present.
      if (p.country && p.country !== "United States" && p.countrycode !== "US") {
        return null;
      }
      const parts = [p.name, p.street, p.city || p.county, p.state, p.country]
        .filter(Boolean)
        .filter((v, i, arr) => arr.indexOf(v) === i);
      return {
        label: parts.join(", ") || q,
        point: { lat, lon },
      };
    })
    .filter(Boolean) as { label: string; point: LatLng }[];
}

export function formatDistance(m: number): string {
  const miles = m / 1609.344;
  if (miles < 0.1) return `${Math.round(m * 3.28084)} ft`;
  return `${miles.toFixed(miles < 10 ? 1 : 0)} mi`;
}

export function formatDuration(s: number): string {
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}
