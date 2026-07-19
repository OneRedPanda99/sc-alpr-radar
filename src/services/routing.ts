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
 * Avoidance is thorough and slow on purpose: iteratively stack via-points
 * around every camera still on the path until camera count stops improving.
 * Duration is almost ignored — fewer cameras always wins.
 */

const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";
const PHOTON_BASE = "https://photon.komoot.io/api/";
/** How close a camera must be to the path to "count" (~500 ft). */
const CORRIDOR_METERS = feetToMeters(500);
/** Cameras considered per search round (spread along the route). */
const MAX_DETOUR_CAMERAS = 14;
/** Deep search budget — user prefers max avoidance over speed. */
const MAX_DETOUR_REQUESTS = 240;
const MAX_REQUESTS_PER_ROUND = 48;
const MAX_AVOID_ROUNDS = 18;
const PARALLEL_OSRM = 6;

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

/** Index of the path vertex nearest to a point. */
function nearestPathIndex(
  coordinates: [number, number][],
  point: LatLng,
): number {
  let bestI = 0;
  let bestD = Infinity;
  for (let i = 0; i < coordinates.length; i++) {
    const d = haversineMeters(point, {
      lat: coordinates[i][1],
      lon: coordinates[i][0],
    });
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  }
  return bestI;
}

/** Spread cameras along the route so we don't detour the same cluster twice. */
function pickDetourTargets(
  coordinates: [number, number][],
  cameras: Camera[],
  max = MAX_DETOUR_CAMERAS,
): Camera[] {
  const onRoute = camerasNearRoute(coordinates, cameras);
  if (!onRoute.length) return [];

  const ranked = onRoute
    .map((cam) => ({ cam, bestI: nearestPathIndex(coordinates, cam) }))
    .sort((a, b) => a.bestI - b.bestI);

  const picked: Camera[] = [];
  for (const { cam } of ranked) {
    if (picked.length >= max) break;
    // Tight cluster merge — still try each dense pocket separately.
    const tooClose = picked.some((p) => haversineMeters(p, cam) < 140);
    if (!tooClose) picked.push(cam);
  }
  return picked;
}

/** Many via points around a camera — near and far, both sides. */
function detourVias(camera: Camera, routeBearing: number): LatLng[] {
  const angles = [
    (routeBearing + 270) % 360, // left
    (routeBearing + 90) % 360, // right
    (routeBearing + 225) % 360,
    (routeBearing + 135) % 360,
    (routeBearing + 240) % 360,
    (routeBearing + 120) % 360,
    (routeBearing + 300) % 360,
    (routeBearing + 60) % 360,
  ];
  const distances = [350, 550, 800, 1200, 1800, 2600];
  const out: LatLng[] = [];
  for (const d of distances) {
    for (const a of angles) {
      out.push(destinationPoint(camera, d, a));
    }
  }
  return out;
}

/** Keep vias ordered along the route and drop near-duplicates. */
function mergeViasAlongRoute(
  existing: LatLng[],
  next: LatLng,
  routeCoords: [number, number][],
): LatLng[] {
  const all = [...existing, next];
  const ranked = all
    .map((v) => ({ v, i: nearestPathIndex(routeCoords, v) }))
    .sort((a, b) => a.i - b.i);
  const out: LatLng[] = [];
  for (const { v } of ranked) {
    if (!out.some((p) => haversineMeters(p, v) < 120)) out.push(v);
  }
  return out.slice(0, 10); // OSRM waypoint practical limit
}

function viaKey(v: LatLng): string {
  return `${v.lat.toFixed(4)},${v.lon.toFixed(4)}`;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return out;
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

  const candidates: ScoredRoute[] = baseRoutes.map((r) =>
    scoreRoute(r, cameras),
  );
  const fastest = candidates[0];
  let best = pickBest(candidates);
  let committedVias: LatLng[] = [];
  let requests = 0;
  const triedVias = new Set<string>();

  // Deep iterative avoidance: each round finds a via that lowers camera count,
  // commits it, and repeats until zero cameras or no further improvement.
  for (
    let round = 0;
    round < MAX_AVOID_ROUNDS &&
    best.cameraCount > 0 &&
    cameras.length > 0 &&
    requests < MAX_DETOUR_REQUESTS;
    round++
  ) {
    const targets = pickDetourTargets(best.coordinates, cameras);
    if (!targets.length) break;

    // Build via candidates per camera, then round-robin so every camera gets
    // tries before we burn the whole budget on one cluster.
    const perCamVias: LatLng[][] = targets.map((cam) => {
      const bearing = routeBearingNear(best.coordinates, cam);
      return detourVias(cam, bearing).filter((via) => {
        if (haversineMeters(via, origin) < 150) return false;
        if (haversineMeters(via, destination) < 150) return false;
        const key = viaKey(via);
        if (triedVias.has(key)) return false;
        triedVias.add(key);
        return true;
      });
    });

    const viaJobs: LatLng[] = [];
    for (let i = 0; i < 64; i++) {
      let added = false;
      for (const list of perCamVias) {
        if (i < list.length) {
          viaJobs.push(list[i]);
          added = true;
        }
      }
      if (!added) break;
    }

    if (!viaJobs.length) break;

    const budget = Math.min(
      viaJobs.length,
      MAX_REQUESTS_PER_ROUND,
      MAX_DETOUR_REQUESTS - requests,
    );
    const batch = viaJobs.slice(0, budget);
    requests += batch.length;

    const scoredBatch = await mapPool(batch, PARALLEL_OSRM, async (via) => {
      const points = [origin, ...committedVias, via, destination];
      if (points.length > 12) return null;
      try {
        const routes = await fetchOsrmWaypoints(points, false);
        if (!routes.length) return null;
        return { scored: scoreRoute(routes[0], cameras), via };
      } catch {
        return null;
      }
    });

    let roundBest = best;
    let roundVia: LatLng | null = null;
    for (const hit of scoredBatch) {
      if (!hit) continue;
      candidates.push(hit.scored);
      // Fewer cameras always wins — ignore how long the detour is.
      if (hit.scored.cameraCount < roundBest.cameraCount) {
        roundBest = hit.scored;
        roundVia = hit.via;
      }
    }

    if (roundVia && roundBest.cameraCount < best.cameraCount) {
      committedVias = mergeViasAlongRoute(
        committedVias,
        roundVia,
        roundBest.coordinates,
      );
      best = roundBest;
      continue;
    }

    // No single-via improvement — try pairing vias around the two worst cams.
    if (targets.length >= 2 && requests < MAX_DETOUR_REQUESTS) {
      const b0 = routeBearingNear(best.coordinates, targets[0]);
      const b1 = routeBearingNear(best.coordinates, targets[1]);
      const pairJobs: LatLng[][] = [];
      for (const d of [600, 1000, 1600]) {
        pairJobs.push([
          destinationPoint(targets[0], d, (b0 + 270) % 360),
          destinationPoint(targets[1], d, (b1 + 90) % 360),
        ]);
        pairJobs.push([
          destinationPoint(targets[0], d, (b0 + 90) % 360),
          destinationPoint(targets[1], d, (b1 + 270) % 360),
        ]);
        pairJobs.push([
          destinationPoint(targets[0], d, (b0 + 270) % 360),
          destinationPoint(targets[1], d, (b1 + 270) % 360),
        ]);
      }

      const pairBudget = Math.min(pairJobs.length, MAX_DETOUR_REQUESTS - requests);
      requests += pairBudget;
      const pairHits = await mapPool(
        pairJobs.slice(0, pairBudget),
        PARALLEL_OSRM,
        async (pair) => {
          const points = [origin, ...committedVias, ...pair, destination];
          if (points.length > 12) return null;
          try {
            const routes = await fetchOsrmWaypoints(points, false);
            if (!routes.length) return null;
            return {
              scored: scoreRoute(routes[0], cameras),
              pair,
            };
          } catch {
            return null;
          }
        },
      );

      let improved = false;
      for (const hit of pairHits) {
        if (!hit) continue;
        candidates.push(hit.scored);
        if (hit.scored.cameraCount < best.cameraCount) {
          best = hit.scored;
          committedVias = mergeViasAlongRoute(
            mergeViasAlongRoute(committedVias, hit.pair[0], hit.scored.coordinates),
            hit.pair[1],
            hit.scored.coordinates,
          );
          improved = true;
        }
      }
      if (improved) continue;
    }

    // Stalled — stop burning requests.
    break;
  }

  best = pickBest([best, ...candidates]);

  return {
    fastest,
    avoidance: best,
    camerasOnFastest: fastest.cameraCount,
    camerasUnavoidable: best.cameraCount,
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

function withScHint(query: string): string {
  const q = query.trim();
  if (/\b(sc|s\.?c\.?|south carolina)\b/i.test(q)) return q;
  return `${q}, SC`;
}

function parsePhotonFeatures(
  features: any[],
  fallback: string,
): { label: string; point: LatLng }[] {
  const out: { label: string; point: LatLng; sc: boolean }[] = [];
  for (const f of features ?? []) {
    const [lon, lat] = f.geometry?.coordinates ?? [];
    if (lon == null || lat == null) continue;
    const p = f.properties ?? {};
    if (p.country && p.country !== "United States" && p.countrycode !== "US") {
      continue;
    }
    const state = String(p.state ?? "");
    const sc = !state || /south carolina|^sc$/i.test(state);
    // Soft SC window — keep near-misses if nothing better, but prefer SC.
    if (
      Number(lat) < 31.5 ||
      Number(lat) > 35.8 ||
      Number(lon) < -84.0 ||
      Number(lon) > -78.0
    ) {
      continue;
    }
    out.push({
      label: formatPhotonLabel(p, fallback),
      point: { lat: Number(lat), lon: Number(lon) },
      sc,
    });
  }
  out.sort((a, b) => Number(b.sc) - Number(a.sc));
  return out.map(({ label, point }) => ({ label, point }));
}

async function geocodePhoton(
  query: string,
  near?: LatLng | null,
): Promise<{ label: string; point: LatLng }[]> {
  const bias = near ?? SC_CENTER;
  const params = new URLSearchParams({
    q: query,
    limit: "10",
    lat: String(bias.lat),
    lon: String(bias.lon),
  });
  const res = await fetch(`${PHOTON_BASE}?${params}`);
  if (!res.ok) throw new Error(`Address search failed (${res.status})`);
  const json = await res.json();
  return parsePhotonFeatures(json.features, query);
}

/**
 * Geocode an address / place. Tries several query shapes so street addresses
 * work even when Photon is picky about formatting.
 */
export async function geocode(
  query: string,
  near?: LatLng | null,
): Promise<{ label: string; point: LatLng }[]> {
  const raw = query.trim();
  if (!raw || raw.length < 2) return [];

  const attempts = [
    withScHint(raw),
    `${raw}, Columbia, SC`,
    raw,
    raw.replace(/\bstreet\b/gi, "St").replace(/\bavenue\b/gi, "Ave"),
  ];
  // Unique preserve order
  const seen = new Set<string>();
  const queries = attempts.filter((q) => {
    const k = q.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  for (const q of queries) {
    try {
      const results = await geocodePhoton(q, near);
      if (results.length) {
        // Dedupe by rounded coords
        const uniq: { label: string; point: LatLng }[] = [];
        const keys = new Set<string>();
        for (const r of results) {
          const k = `${r.point.lat.toFixed(5)},${r.point.lon.toFixed(5)}`;
          if (keys.has(k)) continue;
          keys.add(k);
          uniq.push(r);
        }
        return uniq;
      }
    } catch {
      // try next shape
    }
  }
  return [];
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
