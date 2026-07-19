import type { Camera, LatLng, RouteStep, SavedRoute } from "@/types";
import {
  bearingDeg,
  destinationPoint,
  feetToMeters,
  haversineMeters,
} from "@/services/geo";

/**
 * Free routing stack (no API keys / no paid services):
 *  - Geocode: Photon (Komoot) — CORS-friendly, OSM-based
 *  - Directions: public OSRM demo — geometries + turn-by-turn steps
 *
 * Avoidance: score OSRM alternatives, then actively detour around cameras on
 * the best path by injecting via-points offset from each camera and re-routing.
 */

const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";
const PHOTON_BASE = "https://photon.komoot.io/api/";
/** How close a camera must be to the path to "count" (~400 ft). */
const CORRIDOR_METERS = feetToMeters(400);
/** Max cameras we'll try to steer around in one plan. */
const MAX_DETOUR_CAMERAS = 5;
/** Max via-point detour requests (keeps public OSRM happy). */
const MAX_DETOUR_REQUESTS = 16;

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

async function fetchOsrmWaypoints(
  points: LatLng[],
  alternatives: boolean,
): Promise<OsrmRoute[]> {
  if (points.length < 2) return [];
  const coords = points.map((p) => `${p.lon},${p.lat}`).join(";");
  const url =
    `${OSRM_BASE}/${coords}` +
    `?overview=full&geometries=geojson&steps=true` +
    `&alternatives=${alternatives ? "true" : "false"}` +
    `&continue_straight=true`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Routing server error (${res.status}). Check your connection and try again.`,
    );
  }
  const json = await res.json();
  if (json.code !== "Ok" || !json.routes?.length) {
    return [];
  }
  return json.routes as OsrmRoute[];
}

function scoreRoute(route: OsrmRoute, cameras: Camera[]): ScoredRoute {
  return {
    coordinates: route.geometry.coordinates,
    distanceMeters: route.distance,
    durationSeconds: route.duration,
    cameraCount: camerasNearRoute(route.geometry.coordinates, cameras).length,
    steps: extractSteps(route),
  };
}

function pickBest(scored: ScoredRoute[]): ScoredRoute {
  return [...scored].sort(
    (a, b) =>
      a.cameraCount - b.cameraCount ||
      a.durationSeconds - b.durationSeconds ||
      a.distanceMeters - b.distanceMeters,
  )[0];
}

/** Bearing of the route segment nearest to a camera. */
function routeBearingNear(
  coordinates: [number, number][],
  camera: Camera,
): number {
  let best = Infinity;
  let bearing = 0;
  for (let i = 1; i < coordinates.length; i++) {
    const a = { lat: coordinates[i - 1][1], lon: coordinates[i - 1][0] };
    const b = { lat: coordinates[i][1], lon: coordinates[i][0] };
    const d = distanceToSegment(camera, a, b);
    if (d < best) {
      best = d;
      bearing = bearingDeg(a, b);
    }
  }
  return bearing;
}

/** Spread cameras along the route so we don't detour the same cluster twice. */
function pickDetourTargets(
  coordinates: [number, number][],
  cameras: Camera[],
): Camera[] {
  const onRoute = camerasNearRoute(coordinates, cameras);
  if (!onRoute.length) return [];

  // Order by progress along the route (nearest path vertex index).
  const ranked = onRoute
    .map((cam) => {
      let bestI = 0;
      let bestD = Infinity;
      for (let i = 0; i < coordinates.length; i++) {
        const d = haversineMeters(cam, {
          lat: coordinates[i][1],
          lon: coordinates[i][0],
        });
        if (d < bestD) {
          bestD = d;
          bestI = i;
        }
      }
      return { cam, bestI };
    })
    .sort((a, b) => a.bestI - b.bestI);

  const picked: Camera[] = [];
  for (const { cam } of ranked) {
    if (picked.length >= MAX_DETOUR_CAMERAS) break;
    const tooClose = picked.some((p) => haversineMeters(p, cam) < 250);
    if (!tooClose) picked.push(cam);
  }
  return picked;
}

/** Via points that try to send the driver around a camera. */
function detourVias(camera: Camera, routeBearing: number): LatLng[] {
  const left = (routeBearing + 270) % 360;
  const right = (routeBearing + 90) % 360;
  const diagL = (routeBearing + 225) % 360;
  const diagR = (routeBearing + 135) % 360;
  return [
    destinationPoint(camera, 450, left),
    destinationPoint(camera, 450, right),
    destinationPoint(camera, 750, left),
    destinationPoint(camera, 750, right),
    destinationPoint(camera, 550, diagL),
    destinationPoint(camera, 550, diagR),
  ];
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

  const baseRoutes = await fetchOsrmWaypoints([origin, destination], true);
  if (!baseRoutes.length) {
    throw new Error(
      "No driving route found between those points. Try a more specific address.",
    );
  }

  const candidates: ScoredRoute[] = baseRoutes.map((r) => scoreRoute(r, cameras));
  const fastest = candidates[0];
  let avoidance = pickBest(candidates);

  // Actively steer around cameras still on the best path.
  if (avoidance.cameraCount > 0 && cameras.length > 0) {
    const targets = pickDetourTargets(avoidance.coordinates, cameras);
    let requests = 0;

    for (const cam of targets) {
      if (avoidance.cameraCount === 0 || requests >= MAX_DETOUR_REQUESTS) break;
      const bearing = routeBearingNear(avoidance.coordinates, cam);
      const vias = detourVias(cam, bearing);

      for (const via of vias) {
        if (requests >= MAX_DETOUR_REQUESTS) break;
        // Skip vias that land too close to origin/dest (useless).
        if (haversineMeters(via, origin) < 120) continue;
        if (haversineMeters(via, destination) < 120) continue;
        requests++;
        try {
          const detours = await fetchOsrmWaypoints(
            [origin, via, destination],
            false,
          );
          for (const r of detours) {
            const scored = scoreRoute(r, cameras);
            // Reject absurdly long detours (>2.5× fastest duration).
            if (scored.durationSeconds > fastest.durationSeconds * 2.5) continue;
            candidates.push(scored);
          }
        } catch {
          // Ignore individual detour failures; keep what we have.
        }
      }

      avoidance = pickBest(candidates);
    }

    // Second pass: if still cameras left, try a two-via detour around the
    // first two remaining targets (left of first + right of second).
    if (avoidance.cameraCount > 0 && requests < MAX_DETOUR_REQUESTS) {
      const remaining = pickDetourTargets(avoidance.coordinates, cameras);
      if (remaining.length >= 2) {
        const b0 = routeBearingNear(avoidance.coordinates, remaining[0]);
        const b1 = routeBearingNear(avoidance.coordinates, remaining[1]);
        const viaA = destinationPoint(remaining[0], 600, (b0 + 270) % 360);
        const viaB = destinationPoint(remaining[1], 600, (b1 + 90) % 360);
        try {
          const detours = await fetchOsrmWaypoints(
            [origin, viaA, viaB, destination],
            false,
          );
          for (const r of detours) {
            const scored = scoreRoute(r, cameras);
            if (scored.durationSeconds > fastest.durationSeconds * 2.8) continue;
            candidates.push(scored);
          }
          avoidance = pickBest(candidates);
        } catch {
          // ignore
        }
      }
    }
  }

  avoidance = pickBest(candidates);

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

function formatPhotonLabel(p: Record<string, unknown>, fallback: string): string {
  const street = [p.housenumber, p.street].filter(Boolean).join(" ");
  const parts = [p.name, street, p.city || p.county, p.state]
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i);
  return parts.join(", ") || fallback;
}

/** Bias free-text toward South Carolina when the user omits it. */
function withScHint(query: string): string {
  const q = query.trim();
  if (/\b(sc|s\.?c\.?|south carolina)\b/i.test(q)) return q;
  return `${q}, South Carolina`;
}

function parsePhotonFeatures(
  features: any[],
  fallback: string,
  preferSc: boolean,
): { label: string; point: LatLng }[] {
  return (features ?? [])
    .map((f) => {
      const [lon, lat] = f.geometry?.coordinates ?? [];
      if (lon == null || lat == null) return null;
      const p = f.properties ?? {};
      if (p.country && p.country !== "United States" && p.countrycode !== "US") {
        return null;
      }
      if (
        preferSc &&
        p.state &&
        !/south carolina|^sc$/i.test(String(p.state))
      ) {
        return null;
      }
      return {
        label: formatPhotonLabel(p, fallback),
        point: { lat: Number(lat), lon: Number(lon) },
      };
    })
    .filter(Boolean) as { label: string; point: LatLng }[];
}

async function geocodePhoton(
  query: string,
  near?: LatLng | null,
  useBbox = true,
): Promise<{ label: string; point: LatLng }[]> {
  const bias = near ?? SC_CENTER;
  const params = new URLSearchParams({
    q: query,
    limit: "8",
    lat: String(bias.lat),
    lon: String(bias.lon),
  });
  // Prefer SC results when possible; retry without bbox if empty.
  if (useBbox) params.set("bbox", "-83.6,32.0,-78.4,35.3");

  const res = await fetch(`${PHOTON_BASE}?${params}`);
  if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
  const json = await res.json();
  return parsePhotonFeatures(json.features, query, useBbox);
}

/** Geocode an address / place via Photon (Komoot), biased to South Carolina. */
export async function geocode(
  query: string,
  near?: LatLng | null,
): Promise<{ label: string; point: LatLng }[]> {
  const raw = query.trim();
  if (!raw) return [];

  const q = withScHint(raw);
  let results = await geocodePhoton(q, near, true);
  if (!results.length) results = await geocodePhoton(q, near, false);
  if (!results.length && q !== raw) results = await geocodePhoton(raw, near, false);
  return results;
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
