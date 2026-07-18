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
    const r = Math.floor(point.lat / this.cell);
    const c = Math.floor(point.lon / this.cell);
    const out: { camera: Camera; distance: number }[] = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
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
