import type { Camera, LatLng, RouteStep, SavedRoute } from "@/types";
import {
  destinationPoint,
  feetToMeters,
  haversineMeters,
} from "@/services/geo";

/**
 * Free routing stack (no API keys):
 *  - Geocode: Photon (Komoot)
 *  - Directions: FOSSGIS Valhalla (exclude_polygons for real camera avoidance)
 *  - Fallback: public OSRM if Valhalla is unreachable
 *
 * Via-point hacks on OSRM caused dead-end U-turns and still missed cameras.
 * Valhalla can exclude road edges inside polygons around each camera.
 */

const VALHALLA_URL = "https://valhalla1.openstreetmap.de/route";
const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";
const PHOTON_BASE = "https://photon.komoot.io/api/";
/** How close a camera must be to the path to "count" (~550 ft). */
const CORRIDOR_METERS = feetToMeters(550);
/** Polygon radius around each camera so the road at the cam is blocked. */
const EXCLUDE_RADIUS_M = feetToMeters(500);
const EXCLUDE_RADIUS_LARGE_M = feetToMeters(750);

const SC_CENTER = { lat: 33.8361, lon: -81.1637 };

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

/** Valhalla polyline6 → [lon, lat][]. */
function decodePolyline6(encoded: string): [number, number][] {
  let index = 0;
  let lat = 0;
  let lon = 0;
  const coordinates: [number, number][] = [];
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;

    coordinates.push([lon / 1e6, lat / 1e6]);
  }
  return coordinates;
}

function cameraExcludeRing(cam: LatLng, radiusM: number): [number, number][] {
  const ring: [number, number][] = [];
  const sides = 12;
  for (let i = 0; i <= sides; i++) {
    const p = destinationPoint(cam, radiusM, (i * 360) / sides);
    ring.push([p.lon, p.lat]);
  }
  return ring;
}

function uniqueCameras(cams: Camera[]): Camera[] {
  const seen = new Set<string>();
  const out: Camera[] = [];
  for (const c of cams) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

/** Cameras near the trip corridor (not only the fastest road). */
function camerasInTripBand(
  origin: LatLng,
  destination: LatLng,
  cameras: Camera[],
  halfWidthM: number,
): Camera[] {
  const hits: Camera[] = [];
  for (const cam of cameras) {
    if (distanceToSegment(cam, origin, destination) <= halfWidthM) {
      hits.push(cam);
    }
  }
  return hits;
}

interface ValhallaManeuver {
  type?: number;
  instruction?: string;
  length?: number;
  time?: number;
  street_names?: string[];
  begin_shape_index?: number;
  end_shape_index?: number;
}

interface ValhallaLeg {
  shape?: string;
  maneuvers?: ValhallaManeuver[];
}

interface ValhallaTrip {
  legs?: ValhallaLeg[];
  summary?: { time?: number; length?: number };
}

function scoreCoords(
  coordinates: [number, number][],
  distanceMeters: number,
  durationSeconds: number,
  steps: RouteStep[],
  cameras: Camera[],
): ScoredRoute {
  return {
    coordinates,
    distanceMeters,
    durationSeconds,
    cameraCount: camerasNearRoute(coordinates, cameras).length,
    steps,
  };
}

function stepsFromValhalla(
  leg: ValhallaLeg,
  coordinates: [number, number][],
): RouteStep[] {
  const steps: RouteStep[] = [];
  for (const m of leg.maneuvers ?? []) {
    if (m.type === 4 /* destination */) {
      steps.push({
        instruction: m.instruction || "Arrive at destination",
        name: "",
        distanceMeters: 0,
        durationSeconds: 0,
        maneuverType: "arrive",
        location: coordinates[coordinates.length - 1] ?? [0, 0],
      });
      continue;
    }
    const idx = Math.min(
      coordinates.length - 1,
      Math.max(0, m.begin_shape_index ?? 0),
    );
    steps.push({
      instruction: m.instruction || "Continue",
      name: m.street_names?.[0] ?? "",
      distanceMeters: (m.length ?? 0) * 1000,
      durationSeconds: m.time ?? 0,
      maneuverType: m.type === 25 || m.type === 26 ? "uturn" : "turn",
      location: coordinates[idx] ?? [0, 0],
    });
  }
  return steps;
}

function parseValhallaTrip(
  trip: ValhallaTrip,
  cameras: Camera[],
): ScoredRoute | null {
  const leg = trip.legs?.[0];
  if (!leg?.shape) return null;
  const coordinates = decodePolyline6(leg.shape);
  if (coordinates.length < 2) return null;
  const distanceMeters = (trip.summary?.length ?? 0) * 1000;
  const durationSeconds = trip.summary?.time ?? 0;
  return scoreCoords(
    coordinates,
    distanceMeters,
    durationSeconds,
    stepsFromValhalla(leg, coordinates),
    cameras,
  );
}

async function valhallaPlan(
  origin: LatLng,
  destination: LatLng,
  cameras: Camera[],
  excludeCams: Camera[],
  radiusM: number,
  alternates = 2,
): Promise<ScoredRoute[]> {
  const body: Record<string, unknown> = {
    locations: [
      { lat: origin.lat, lon: origin.lon },
      { lat: destination.lat, lon: destination.lon },
    ],
    costing: "auto",
    directions_options: { units: "kilometers" },
    alternates,
  };
  if (excludeCams.length) {
    body.exclude_polygons = excludeCams.map((c) =>
      cameraExcludeRing(c, radiusM),
    );
  }

  const res = await fetch(VALHALLA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    if (res.status === 400 || res.status === 404) return [];
    throw new Error(
      `Routing server error (${res.status}). Check your connection and try again.`,
    );
  }
  const json = await res.json();
  const trips: ValhallaTrip[] = [];
  if (json.trip) trips.push(json.trip);
  for (const alt of json.alternates ?? []) {
    if (alt?.trip) trips.push(alt.trip);
  }
  const out: ScoredRoute[] = [];
  for (const trip of trips) {
    const s = parseValhallaTrip(trip, cameras);
    if (s) out.push(s);
  }
  return out;
}

// --- OSRM fallback (no via hacks — plain A→B only) ---

interface OsrmRoute {
  geometry: { coordinates: [number, number][] };
  distance: number;
  duration: number;
  legs?: {
    steps?: {
      distance: number;
      duration: number;
      name?: string;
      maneuver?: {
        type?: string;
        modifier?: string;
        location?: [number, number];
      };
    }[];
  }[];
}

function osrmSteps(route: OsrmRoute): RouteStep[] {
  const steps: RouteStep[] = [];
  for (const leg of route.legs ?? []) {
    for (const s of leg.steps ?? []) {
      const type = s.maneuver?.type ?? "continue";
      const mod = s.maneuver?.modifier ?? "";
      const road = s.name?.trim() || "the road";
      let instruction = `Continue on ${road}`;
      if (type === "arrive") instruction = "Arrive at destination";
      else if (type === "depart")
        instruction = `Head out${road !== "the road" ? ` on ${road}` : ""}`;
      else if (type === "turn")
        instruction = `Turn ${mod || "ahead"}${road !== "the road" ? ` onto ${road}` : ""}`;
      steps.push({
        instruction,
        name: s.name ?? "",
        distanceMeters: s.distance,
        durationSeconds: s.duration,
        maneuverType: type,
        location: (s.maneuver?.location ?? [0, 0]) as [number, number],
      });
    }
  }
  return steps;
}

async function osrmFallback(
  origin: LatLng,
  destination: LatLng,
  cameras: Camera[],
): Promise<ScoredRoute[]> {
  const coords = `${origin.lon},${origin.lat};${destination.lon},${destination.lat}`;
  const url =
    `${OSRM_BASE}/${coords}` +
    `?overview=full&geometries=geojson&steps=true&alternatives=true`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = await res.json();
  if (json.code !== "Ok" || !json.routes?.length) return [];
  return (json.routes as OsrmRoute[]).map((r) =>
    scoreCoords(
      r.geometry.coordinates,
      r.distance,
      r.duration,
      osrmSteps(r),
      cameras,
    ),
  );
}

function pickBest(scored: ScoredRoute[]): ScoredRoute {
  return [...scored].sort(
    (a, b) =>
      a.cameraCount - b.cameraCount ||
      a.durationSeconds - b.durationSeconds ||
      a.distanceMeters - b.distanceMeters,
  )[0];
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

  let fastestRoutes: ScoredRoute[] = [];
  let useValhalla = true;
  try {
    fastestRoutes = await valhallaPlan(origin, destination, cameras, [], 0, 3);
  } catch {
    useValhalla = false;
  }
  if (!fastestRoutes.length) {
    useValhalla = false;
    fastestRoutes = await osrmFallback(origin, destination, cameras);
  }
  if (!fastestRoutes.length) {
    throw new Error(
      "No driving route found between those points. Try a more specific address.",
    );
  }

  const fastest = [...fastestRoutes].sort(
    (a, b) => a.durationSeconds - b.durationSeconds,
  )[0];
  const candidates: ScoredRoute[] = [...fastestRoutes];
  let best = pickBest(candidates);

  if (!cameras.length || best.cameraCount === 0 || !useValhalla) {
    // Without Valhalla we cannot truly exclude cameras — return best plain route.
    return {
      fastest,
      avoidance: best,
      camerasOnFastest: fastest.cameraCount,
      camerasUnavoidable: best.cameraCount,
    };
  }

  // Never try to exclude cameras sitting on the start/end pin — Valhalla
  // cannot leave/arrive if those edges are blocked.
  const avoidable = cameras.filter(
    (c) =>
      haversineMeters(c, origin) > 90 && haversineMeters(c, destination) > 90,
  );

  // Seed: cameras on the fastest path + others in a wide trip band (so we
  // don't "dodge" onto a parallel road that also has ALPRs).
  let exclude = uniqueCameras([
    ...camerasNearRoute(fastest.coordinates, avoidable),
    ...camerasInTripBand(origin, destination, avoidable, 2500),
  ]);
  // Cap polygon count so the public server stays happy.
  if (exclude.length > 80) {
    exclude = uniqueCameras([
      ...camerasNearRoute(fastest.coordinates, avoidable),
      ...camerasInTripBand(origin, destination, avoidable, 1200),
    ]).slice(0, 80);
  }

  const radii = [EXCLUDE_RADIUS_M, EXCLUDE_RADIUS_LARGE_M];

  for (const radiusM of radii) {
    for (let pass = 0; pass < 5; pass++) {
      if (!exclude.length) break;
      let routes: ScoredRoute[] = [];
      try {
        routes = await valhallaPlan(
          origin,
          destination,
          cameras,
          exclude,
          radiusM,
          3,
        );
      } catch {
        break;
      }

      if (!routes.length) {
        // Excludes blocked every path — drop band cams, keep on-route cores.
        if (exclude.length <= 1) break;
        const core = new Set(
          camerasNearRoute(fastest.coordinates, avoidable).map((c) => c.id),
        );
        exclude = exclude.filter((c) => core.has(c.id));
        if (!exclude.length) break;
        continue;
      }

      for (const r of routes) candidates.push(r);
      best = pickBest(candidates);
      if (best.cameraCount === 0) {
        return {
          fastest,
          avoidance: best,
          camerasOnFastest: fastest.cameraCount,
          camerasUnavoidable: 0,
        };
      }

      const hits = camerasNearRoute(best.coordinates, avoidable);
      const before = exclude.length;
      exclude = uniqueCameras([...exclude, ...hits]);
      if (exclude.length === before) break;
      if (exclude.length > 80) exclude = exclude.slice(0, 80);
    }
    if (best.cameraCount === 0) break;
  }

  // Last try: exclude ONLY leftover on-path cameras with a large radius.
  if (best.cameraCount > 0) {
    const leftover = camerasNearRoute(best.coordinates, avoidable);
    if (leftover.length) {
      try {
        const routes = await valhallaPlan(
          origin,
          destination,
          cameras,
          leftover,
          EXCLUDE_RADIUS_LARGE_M,
          3,
        );
        for (const r of routes) candidates.push(r);
        best = pickBest(candidates);
      } catch {
        // keep current best
      }
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
