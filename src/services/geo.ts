import type { Camera, LatLng } from "@/types";

export const FEET_PER_METER = 3.28084;
export const feetToMeters = (ft: number) => ft / FEET_PER_METER;
export const metersToFeet = (m: number) => m * FEET_PER_METER;

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
