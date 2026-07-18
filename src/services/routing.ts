import type { Camera, LatLng, SavedRoute } from "@/types";
import { haversineMeters, feetToMeters } from "@/services/geo";

/**
 * Routing strategy (personal, SC-scale):
 *  1. Ask OSRM for the fastest route plus alternatives.
 *  2. For each route, count cameras whose distance to the route line is within
 *     a corridor (default ~250 ft — a camera basically on your road).
 *  3. "Fastest" = OSRM's first route. "Avoidance" = the alternative with the
 *     fewest cameras (ties broken by shorter duration). Unavoidable = the
 *     camera count still remaining on that best route.
 *
 * OSRM's public demo server has no ALPR knowledge, so avoidance quality is
 * limited to whatever alternatives it offers. Good enough for a personal tool;
 * can be swapped for a GraphHopper/FlockHopper avoidance API later.
 */

const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";
const CORRIDOR_METERS = feetToMeters(250);

interface OsrmRoute {
  geometry: { coordinates: [number, number][] };
  distance: number;
  duration: number;
}

interface ScoredRoute {
  coordinates: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
  cameraCount: number;
}

/** Perpendicular distance (m) from point p to segment a-b, via local planar approx. */
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
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Cameras whose min distance to the route polyline is within the corridor. */
export function camerasNearRoute(
  coordinates: [number, number][],
  cameras: Camera[],
  corridorMeters = CORRIDOR_METERS,
): Camera[] {
  const path: LatLng[] = coordinates.map(([lon, lat]) => ({ lat, lon }));
  if (path.length < 2) return [];

  // Bounding box prefilter so we don't test every SC camera against every leg.
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
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
    let near = false;
    for (let i = 1; i < path.length; i++) {
      if (distanceToSegment(cam, path[i - 1], path[i]) <= corridorMeters) {
        near = true;
        break;
      }
    }
    if (near) hits.push(cam);
  }
  return hits;
}

async function fetchOsrm(origin: LatLng, destination: LatLng): Promise<OsrmRoute[]> {
  const coords = `${origin.lon},${origin.lat};${destination.lon},${destination.lat}`;
  const url = `${OSRM_BASE}/${coords}?overview=full&geometries=geojson&alternatives=3`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Routing failed (${res.status})`);
  const json = await res.json();
  if (json.code !== "Ok" || !json.routes?.length) {
    throw new Error("No route found");
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
  const routes = await fetchOsrm(origin, destination);

  const scored: ScoredRoute[] = routes.map((r) => ({
    coordinates: r.geometry.coordinates,
    distanceMeters: r.distance,
    durationSeconds: r.duration,
    cameraCount: camerasNearRoute(r.geometry.coordinates, cameras).length,
  }));

  const fastest = scored[0];
  const avoidance = [...scored].sort(
    (a, b) => a.cameraCount - b.cameraCount || a.durationSeconds - b.durationSeconds,
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
  };
}

/** Simple forward geocode via Nominatim, biased to South Carolina. */
export async function geocode(query: string): Promise<{ label: string; point: LatLng }[]> {
  const url =
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=us` +
    `&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "Accept-Language": "en-US" } });
  if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
  const json = await res.json();
  return (json as any[]).map((r) => ({
    label: r.display_name as string,
    point: { lat: Number.parseFloat(r.lat), lon: Number.parseFloat(r.lon) },
  }));
}

export function haversineLabel(a: LatLng, b: LatLng): number {
  return haversineMeters(a, b);
}
