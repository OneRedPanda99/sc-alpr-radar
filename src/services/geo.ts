import type { Camera, LatLng } from "@/types";

/**
 * Columbia. Used whenever we need a map centre before (or instead of) a GPS
 * fix — denied permission shouldn't mean a blank map or an empty sky.
 */
export const FALLBACK_CENTER: LatLng = { lat: 34.0007, lon: -81.0348 };

export const FEET_PER_METER = 3.28084;
export const feetToMeters = (ft: number) => ft / FEET_PER_METER;
export const metersToFeet = (m: number) => m * FEET_PER_METER;

/**
 * Read coordinates out of whatever someone pastes: "34.0007, -81.0348",
 * "34.0007 -81.0348", "N34.0007 W81.0348", "34°00'02.5"N 81°02'05.3"W", or a
 * Google / Apple / OpenStreetMap link. Returns null for anything else, so the
 * caller can fall through to an address search.
 *
 * Two bare numbers are read lat-then-lon, which is how every maps app copies
 * them. In South Carolina longitude is always negative, so a pair that only
 * makes sense swapped (e.g. "-81.03, 34.00") is swapped back.
 */
export function parseCoordinates(input: string): LatLng | null {
  const raw = input.trim();
  if (!raw) return null;

  // Map links: @lat,lon (Google), ?q=lat,lon / ll= (Apple/Google), #map=z/lat/lon (OSM).
  const link =
    /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(raw) ??
    /[?&](?:q|ll|query|destination)=(-?\d+\.\d+)(?:,|%2C)\s*(-?\d+\.\d+)/i.exec(raw) ??
    /#map=\d+(?:\.\d+)?\/(-?\d+\.\d+)\/(-?\d+\.\d+)/.exec(raw);
  if (link) return valid(+link[1], +link[2]);

  // Degrees / minutes / seconds with hemisphere letters.
  const dms = [
    ...raw.matchAll(
      /([NSEW])?\s*(\d{1,3}(?:\.\d+)?)\s*°\s*(?:(\d{1,2}(?:\.\d+)?)\s*['′]\s*)?(?:(\d{1,2}(?:\.\d+)?)\s*(?:"|″|''))?\s*([NSEW])?/gi,
    ),
  ].filter((m) => m[2] != null);
  if (dms.length === 2) {
    const vals = dms.map((m) => {
      const hemi = (m[1] ?? m[5] ?? "").toUpperCase();
      let v = +m[2] + (m[3] ? +m[3] / 60 : 0) + (m[4] ? +m[4] / 3600 : 0);
      if (hemi === "S" || hemi === "W") v = -v;
      return { v, hemi };
    });
    const latFirst = !(vals[0].hemi === "E" || vals[0].hemi === "W");
    const [a, b] = latFirst ? vals : [vals[1], vals[0]];
    return valid(a.v, b.v);
  }

  // Decimal pair, optionally with hemisphere letters.
  const dec =
    /^([NS])?\s*(-?\d{1,3}(?:\.\d+)?)\s*([NS])?\s*[,;\s]\s*([EW])?\s*(-?\d{1,3}(?:\.\d+)?)\s*([EW])?$/i.exec(
      raw,
    );
  if (dec) {
    let lat = +dec[2];
    let lon = +dec[5];
    if (/s/i.test(dec[1] ?? dec[3] ?? "")) lat = -Math.abs(lat);
    if (/w/i.test(dec[4] ?? dec[6] ?? "")) lon = -Math.abs(lon);
    const hasHemi = !!(dec[1] ?? dec[3] ?? dec[4] ?? dec[6]);
    if (!hasHemi && Math.abs(lat) > 90 && Math.abs(lon) <= 90) [lat, lon] = [lon, lat];
    if (!hasHemi && lat < 0 && lon > 0 && Math.abs(lat) > Math.abs(lon)) [lat, lon] = [lon, lat];
    // Plain decimal numbers need at least one decimal place each, so a
    // street number pair like "12 34" isn't read as a location.
    if (!hasHemi && !(/\./.test(dec[2]) && /\./.test(dec[5]))) return null;
    return valid(lat, lon);
  }
  return null;
}

function valid(lat: number, lon: number): LatLng | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

const EARTH_RADIUS_M = 6371008.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/** Great-circle distance in meters (haversine). */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, degrees 0-360 (0 = north). */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest absolute difference between two bearings, 0-180. */
export function bearingDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Uniform lat/lon grid for O(1)-ish nearest lookups. SC is small enough that a
 * coarse cell (~0.05deg, roughly 5.5km) keeps each bucket tiny while letting a
 * proximity query touch only the 9 cells around the driver.
 */
export class CameraGrid {
  private readonly cell = 0.05;
  private readonly buckets = new Map<string, Camera[]>();

  constructor(cameras: Camera[]) {
    for (const cam of cameras) {
      const key = this.key(cam.lat, cam.lon);
      const arr = this.buckets.get(key);
      if (arr) arr.push(cam);
      else this.buckets.set(key, [cam]);
    }
  }

  private key(lat: number, lon: number): string {
    const r = Math.floor(lat / this.cell);
    const c = Math.floor(lon / this.cell);
    return `${r}:${c}`;
  }

  /** All cameras within radiusMeters of the point. */
  within(point: LatLng, radiusMeters: number): { camera: Camera; distance: number }[] {
    // Expand cell ring if the alert radius is large relative to cell size.
    const ring = Math.max(1, Math.ceil(radiusMeters / (this.cell * 111320)) + 1);
    const r = Math.floor(point.lat / this.cell);
    const c = Math.floor(point.lon / this.cell);
    const out: { camera: Camera; distance: number }[] = [];
    for (let dr = -ring; dr <= ring; dr++) {
      for (let dc = -ring; dc <= ring; dc++) {
        const arr = this.buckets.get(`${r + dr}:${c + dc}`);
        if (!arr) continue;
        for (const camera of arr) {
          const distance = haversineMeters(point, camera);
          if (distance <= radiusMeters) out.push({ camera, distance });
        }
      }
    }
    out.sort((a, b) => a.distance - b.distance);
    return out;
  }
}

/** Destination point a given distance and bearing from origin. */
export function destinationPoint(
  origin: LatLng,
  distanceMeters: number,
  bearingDegrees: number,
): LatLng {
  const δ = distanceMeters / EARTH_RADIUS_M;
  const θ = toRad(bearingDegrees);
  const φ1 = toRad(origin.lat);
  const λ1 = toRad(origin.lon);
  const sinφ1 = Math.sin(φ1);
  const cosφ1 = Math.cos(φ1);
  const sinδ = Math.sin(δ);
  const cosδ = Math.cos(δ);
  const φ2 = Math.asin(sinφ1 * cosδ + cosφ1 * sinδ * Math.cos(θ));
  const λ2 =
    λ1 +
    Math.atan2(Math.sin(θ) * sinδ * cosφ1, cosδ - sinφ1 * Math.sin(φ2));
  return { lat: toDeg(φ2), lon: ((toDeg(λ2) + 540) % 360) - 180 };
}

/**
 * Build a DeFlock-style FOV wedge (Polygon) for one camera direction.
 * Returns [lon, lat] ring. Range is short so it reads as "looking at" nearby road.
 */
export function fovConePolygon(
  cam: Camera,
  directionDeg: number,
  rangeMeters = 55,
): [number, number][] {
  const half =
    Number.isFinite(cam.fovHalfAngle) && cam.fovHalfAngle > 0
      ? cam.fovHalfAngle
      : 35;
  const dir = Number.isFinite(directionDeg) ? directionDeg : 0;
  const steps = Math.max(6, Math.round(half / 5));
  const apex: [number, number] = [cam.lon, cam.lat];
  const ring: [number, number][] = [apex];
  for (let i = 0; i <= steps; i++) {
    const bearing = dir - half + (i / steps) * (half * 2);
    const p = destinationPoint(cam, rangeMeters, bearing);
    if (Number.isFinite(p.lon) && Number.isFinite(p.lat)) {
      ring.push([p.lon, p.lat]);
    }
  }
  ring.push(apex);
  return ring;
}
