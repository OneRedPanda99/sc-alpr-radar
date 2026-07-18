import { useEffect, useRef, useState } from "react";
import type { LatLng } from "@/types";
import { bearingDeg, haversineMeters } from "@/services/geo";

export interface GeoFix {
  point: LatLng;
  /** Heading in degrees (0-360). From GPS when moving, else derived. */
  heading: number | null;
  /** Speed in m/s if provided by the device. */
  speed: number | null;
  accuracy: number;
  timestamp: number;
}

interface Options {
  enabled: boolean;
}

/**
 * Watches device position. Prefers GPS-reported heading; when unavailable
 * (common when stationary or on desktop), derives heading from movement
 * between consecutive fixes.
 */
export function useGeolocation({ enabled }: Options) {
  const [fix, setFix] = useState<GeoFix | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prev = useRef<LatLng | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (!("geolocation" in navigator)) {
      setError("Geolocation not supported");
      return;
    }

    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const point: LatLng = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
        };
        let heading = Number.isFinite(pos.coords.heading as number)
          ? (pos.coords.heading as number)
          : null;
        if (heading == null && prev.current) {
          const moved = haversineMeters(prev.current, point);
          if (moved > 3) heading = bearingDeg(prev.current, point);
        }
        prev.current = point;
        setFix({
          point,
          heading,
          speed: Number.isFinite(pos.coords.speed as number)
            ? (pos.coords.speed as number)
            : null,
          accuracy: pos.coords.accuracy,
          timestamp: pos.timestamp,
        });
        setError(null);
      },
      (err) => setError(err.message),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 },
    );

    return () => navigator.geolocation.clearWatch(id);
  }, [enabled]);

  return { fix, error };
}
