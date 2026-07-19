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
 * Avoidance explores road-snapped parallel corridors (like a human picking an
 * alternate arterial), not random field offsets. Rank: fewest cameras, then
 * shortest time among those.
 */

const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";
const OSRM_NEAREST = "https://router.project-osrm.org/nearest/v1/driving";
const PHOTON_BASE = "https://photon.komoot.io/api/";
/** How close a camera must be to the path to "count" (~500 ft). */
const CORRIDOR_METERS = feetToMeters(500);
const PARALLEL_OSRM = 5;
/** Max route evaluations while searching for a better avoidance path. */
const MAX_ROUTE_EVALS = 200;

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
  /** false = allow sharp turns at vias (needed for parallel-road detours). */
  continueStraight = false,
): Promise<OsrmRoute[]> {
  if (points.length < 2) return [];
  const coords = points.map((p) => `${p.lon},${p.lat}`).join(";");
  const url =
    `${OSRM_BASE}/${coords}` +
    `?overview=full&geometries=geojson&steps=true` +
    `&alternatives=${alternatives ? "true" : "false"}` +
    `&continue_straight=${continueStraight ? "true" : "false"}`;

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

/** Snap a lat/lon onto the nearest drivable road (rejects far snaps). */
async function snapToRoad(point: LatLng): Promise<LatLng | null> {
  try {
    const url = `${OSRM_NEAREST}/${point.lon},${point.lat}?number=1`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const wp = json.waypoints?.[0];
    if (!wp?.location || typeof wp.distance !== "number") return null;
    // If nearest road is >400m away, this isn't a useful via.
    if (wp.distance > 400) return null;
    const [lon, lat] = wp.location as [number, number];
    return { lat, lon };
  } catch {
    return null;
  }
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

/** Fewest cameras, then fastest — the tradeoff you actually want when driving. */
function pickBest(scored: ScoredRoute[]): ScoredRoute {
  return [...scored].sort(
    (a, b) =>
      a.cameraCount - b.cameraCount ||
      a.durationSeconds - b.durationSeconds ||
      a.distanceMeters - b.distanceMeters,
  )[0];
}

function viaKey(v: LatLng): string {
  return `${v.lat.toFixed(4)},${v.lon.toFixed(4)}`;
}

/** Min distance from a point to any camera. */
function clearanceMeters(point: LatLng, cameras: Camera[]): number {
  let best = Infinity;
  for (const c of cameras) {
    const d = haversineMeters(point, c);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Candidate vias along parallel corridors: sample along the straight line and
 * along the fastest path, offset left/right onto nearby roads.
 */
function rawCorridorSeeds(
  origin: LatLng,
  destination: LatLng,
  fastestCoords: [number, number][],
): LatLng[] {
  const seeds: LatLng[] = [];
  const tripBearing = bearingDeg(origin, destination);
  const left = (tripBearing + 270) % 360;
  const right = (tripBearing + 90) % 360;
  // Tighter + wider bands — catch the next block over AND farther arterials.
  const offsets = [250, 450, 700, 1000, 1400, 1900, 2600, 3500];
  const fracs = [0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85];

  // Straight-line corridors (parallel arterials humans pick by eye).
  const tripDist = haversineMeters(origin, destination);
  for (const f of fracs) {
    const along = destinationPoint(origin, tripDist * f, tripBearing);
    for (const o of offsets) {
      seeds.push(destinationPoint(along, o, left));
      seeds.push(destinationPoint(along, o, right));
    }
  }

  // Offsets from the fastest route itself (escape onto a parallel street).
  if (fastestCoords.length > 4) {
    for (const f of fracs) {
      const idx = Math.min(
        fastestCoords.length - 1,
        Math.max(1, Math.floor(f * (fastestCoords.length - 1))),
      );
      const pt = {
        lat: fastestCoords[idx][1],
        lon: fastestCoords[idx][0],
      };
      const prev = {
        lat: fastestCoords[Math.max(0, idx - 1)][1],
        lon: fastestCoords[Math.max(0, idx - 1)][0],
      };
      const brg = bearingDeg(prev, pt);
      for (const o of [300, 550, 900, 1400, 2000, 2800]) {
        seeds.push(destinationPoint(pt, o, (brg + 270) % 360));
        seeds.push(destinationPoint(pt, o, (brg + 90) % 360));
      }
    }
  }

  return seeds;
}

/**
 * Continuous parallel bands: 2–3 vias along the same offset so OSRM stays on
 * that arterial for the middle of the trip (what you "see" on the map).
 */
function rawParallelBands(
  origin: LatLng,
  destination: LatLng,
): LatLng[][] {
  const tripBearing = bearingDeg(origin, destination);
  const tripDist = haversineMeters(origin, destination);
  const bands: LatLng[][] = [];
  const sides = [(tripBearing + 270) % 360, (tripBearing + 90) % 360];
  const offsets = [400, 800, 1200, 1800, 2500, 3400];
  const chainFracs = [
    [0.3, 0.55, 0.75],
    [0.25, 0.5, 0.7],
    [0.35, 0.65],
  ];

  for (const side of sides) {
    for (const o of offsets) {
      for (const fracs of chainFracs) {
        bands.push(
          fracs.map((f) => {
            const along = destinationPoint(origin, tripDist * f, tripBearing);
            return destinationPoint(along, o, side);
          }),
        );
      }
    }
  }
  return bands;
}

/** Extra seeds that dodge specific cameras still on the current best path. */
function rawCameraEscapeSeeds(
  coordinates: [number, number][],
  cameras: Camera[],
): LatLng[] {
  const onRoute = camerasNearRoute(coordinates, cameras);
  if (!onRoute.length) return [];
  // Spread along route
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
    if (picked.length >= 10) break;
    if (picked.some((p) => haversineMeters(p, cam) < 180)) continue;
    picked.push(cam);
  }

  const seeds: LatLng[] = [];
  for (const cam of picked) {
    let bearing = 0;
    let best = Infinity;
    for (let i = 1; i < coordinates.length; i++) {
      const a = { lat: coordinates[i - 1][1], lon: coordinates[i - 1][0] };
      const b = { lat: coordinates[i][1], lon: coordinates[i][0] };
      const d = distanceToSegment(cam, a, b);
      if (d < best) {
        best = d;
        bearing = bearingDeg(a, b);
      }
    }
    for (const o of [600, 1000, 1600, 2400]) {
      seeds.push(destinationPoint(cam, o, (bearing + 270) % 360));
      seeds.push(destinationPoint(cam, o, (bearing + 90) % 360));
      seeds.push(destinationPoint(cam, o, (bearing + 225) % 360));
      seeds.push(destinationPoint(cam, o, (bearing + 135) % 360));
    }
  }
  return seeds;
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

  const baseRoutes = await fetchOsrmWaypoints([origin, destination], true, true);
  if (!baseRoutes.length) {
    throw new Error(
      "No driving route found between those points. Try a more specific address.",
    );
  }

  const candidates: ScoredRoute[] = baseRoutes.map((r) =>
    scoreRoute(r, cameras),
  );
  // OSRM returns fastest first among alternatives — keep that as the baseline.
  const fastest = [...candidates].sort(
    (a, b) => a.durationSeconds - b.durationSeconds,
  )[0];
  let best = pickBest(candidates);

  if (cameras.length === 0 || best.cameraCount === 0) {
    return {
      fastest,
      avoidance: best,
      camerasOnFastest: fastest.cameraCount,
      camerasUnavoidable: best.cameraCount,
    };
  }

  const maxDuration = fastest.durationSeconds * 2.8;
  let evals = 0;
  const seen = new Set<string>();

  const accept = (scored: ScoredRoute): boolean => {
    if (scored.durationSeconds > maxDuration) return false;
    const fewestSoFar = Math.min(...candidates.map((c) => c.cameraCount));
    // Drop obvious losers: more cameras than we've already cleared, or same
    // cameras but much slower than a known peer.
    if (scored.cameraCount > fewestSoFar + 1) return false;
    const peer = candidates.find((c) => c.cameraCount === scored.cameraCount);
    if (peer && scored.durationSeconds > peer.durationSeconds * 1.45) {
      return false;
    }
    candidates.push(scored);
    if (scored.cameraCount < best.cameraCount) best = scored;
    else if (
      scored.cameraCount === best.cameraCount &&
      scored.durationSeconds < best.durationSeconds
    ) {
      best = scored;
    }
    return true;
  };

  // 1) Continuous parallel bands first — closest to "take that other road".
  const bands = rawParallelBands(origin, destination);
  const bandHits = await mapPool(bands, PARALLEL_OSRM, async (band) => {
    if (evals >= MAX_ROUTE_EVALS) return null;
    evals++;
    try {
      const snappedPts = await mapPool(band, 3, snapToRoad);
      const vias = snappedPts.filter((p): p is LatLng => !!p);
      if (vias.length < 2) return null;
      // Drop vias that snapped onto the same spot or back near cameras.
      const clean: LatLng[] = [];
      for (const v of vias) {
        if (haversineMeters(v, origin) < 180) continue;
        if (haversineMeters(v, destination) < 180) continue;
        if (clean.some((c) => haversineMeters(c, v) < 120)) continue;
        clean.push(v);
      }
      if (clean.length < 2) return null;
      const routes = await fetchOsrmWaypoints(
        [origin, ...clean, destination],
        false,
        false,
      );
      if (!routes.length) return null;
      return scoreRoute(routes[0], cameras);
    } catch {
      return null;
    }
  });
  for (const scored of bandHits) {
    if (scored) accept(scored);
  }
  best = pickBest(candidates);

  // 2) Corridor + camera-escape point vias, snapped to road, high clearance first.
  const rawSeeds = [
    ...rawCorridorSeeds(origin, destination, fastest.coordinates),
    ...rawCameraEscapeSeeds(best.coordinates, cameras),
  ].filter(
    (p) =>
      haversineMeters(p, origin) > 200 &&
      haversineMeters(p, destination) > 200,
  );

  const snapped = await mapPool(rawSeeds, PARALLEL_OSRM, snapToRoad);
  const viaPool: { via: LatLng; clearance: number }[] = [];
  for (const s of snapped) {
    if (!s) continue;
    const key = viaKey(s);
    if (seen.has(key)) continue;
    seen.add(key);
    if (haversineMeters(s, origin) < 180) continue;
    if (haversineMeters(s, destination) < 180) continue;
    viaPool.push({ via: s, clearance: clearanceMeters(s, cameras) });
  }
  viaPool.sort((a, b) => b.clearance - a.clearance);

  // 3) Single-via routes through clear parallel points.
  const singleVias = viaPool.slice(0, 80).map((v) => v.via);
  const singleHits = await mapPool(singleVias, PARALLEL_OSRM, async (via) => {
    if (evals >= MAX_ROUTE_EVALS) return null;
    evals++;
    try {
      const routes = await fetchOsrmWaypoints(
        [origin, via, destination],
        false,
        false,
      );
      if (!routes.length) return null;
      return { scored: scoreRoute(routes[0], cameras), via };
    } catch {
      return null;
    }
  });

  const goodSingles: { scored: ScoredRoute; via: LatLng }[] = [];
  for (const hit of singleHits) {
    if (!hit) continue;
    if (!accept(hit.scored)) continue;
    goodSingles.push(hit);
  }
  best = pickBest(candidates);

  // 4) Two-via combos (cut over, then cut back).
  goodSingles.sort(
    (a, b) =>
      a.scored.cameraCount - b.scored.cameraCount ||
      a.scored.durationSeconds - b.scored.durationSeconds,
  );
  const comboAnchors = [
    ...goodSingles.slice(0, 10).map((g) => g.via),
    ...viaPool.slice(0, 14).map((v) => v.via),
  ];
  const anchorKeys = new Set<string>();
  const anchors: LatLng[] = [];
  for (const a of comboAnchors) {
    const k = viaKey(a);
    if (anchorKeys.has(k)) continue;
    anchorKeys.add(k);
    anchors.push(a);
  }

  const pairJobs: LatLng[][] = [];
  for (let i = 0; i < anchors.length; i++) {
    for (let j = i + 1; j < anchors.length; j++) {
      const di = haversineMeters(anchors[i], origin);
      const dj = haversineMeters(anchors[j], origin);
      pairJobs.push(
        di <= dj ? [anchors[i], anchors[j]] : [anchors[j], anchors[i]],
      );
      if (pairJobs.length >= 70) break;
    }
    if (pairJobs.length >= 70) break;
  }

  const pairBatch = pairJobs.slice(
    0,
    Math.max(0, MAX_ROUTE_EVALS - evals),
  );
  const pairHits = await mapPool(pairBatch, PARALLEL_OSRM, async (pair) => {
    evals++;
    try {
      const routes = await fetchOsrmWaypoints(
        [origin, pair[0], pair[1], destination],
        false,
        false,
      );
      if (!routes.length) return null;
      return scoreRoute(routes[0], cameras);
    } catch {
      return null;
    }
  });
  for (const scored of pairHits) {
    if (scored) accept(scored);
  }

  // 5) Escape remaining cameras on the current best avoidance path.
  best = pickBest(candidates);
  if (best.cameraCount > 0 && evals < MAX_ROUTE_EVALS) {
    const escapeRaw = rawCameraEscapeSeeds(best.coordinates, cameras);
    const escapeSnapped = await mapPool(
      escapeRaw.slice(0, 48),
      PARALLEL_OSRM,
      snapToRoad,
    );
    const escapeVias: LatLng[] = [];
    for (const s of escapeSnapped) {
      if (!s) continue;
      const k = viaKey(s);
      if (seen.has(k)) continue;
      seen.add(k);
      if (clearanceMeters(s, cameras) < 200) continue;
      escapeVias.push(s);
    }

    const more = await mapPool(
      escapeVias.slice(0, MAX_ROUTE_EVALS - evals),
      PARALLEL_OSRM,
      async (via) => {
        evals++;
        try {
          const routes = await fetchOsrmWaypoints(
            [origin, via, destination],
            false,
            false,
          );
          if (!routes.length) return null;
          return scoreRoute(routes[0], cameras);
        } catch {
          return null;
        }
      },
    );
    for (const scored of more) {
      if (scored) accept(scored);
    }
  }

  best = pickBest(candidates);

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
