import { useEffect, useState } from "react";
import type { Camera } from "@/types";

/**
 * Advance aircraft along their heading between polls.
 *
 * The API is polled every ~25s, but a plane at 250 kt covers about 1.7 miles in
 * that time — so without this the icons teleport once every poll and look
 * frozen in between. Each aircraft reports heading and ground speed, which is
 * everything needed to estimate where it is *now* from where it was last seen.
 *
 * This is dead reckoning, not truth: it assumes straight and level flight, so a
 * turning aircraft drifts off until the next real fix corrects it. Capped so a
 * stalled feed can't fling icons across the state.
 */
const TICK_MS = 1000;
const MAX_EXTRAPOLATION_S = 60;

export function useMovingAircraft(cameras: Camera[]): Camera[] {
  const [tick, setTick] = useState(0);

  const hasMoving = cameras.some(
    (c) => c.kind === "aircraft" && c.groundSpeedKt && c.trackDeg != null,
  );

  useEffect(() => {
    if (!hasMoving) return;
    const t = window.setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => window.clearInterval(t);
  }, [hasMoving]);

  // `tick` isn't read; it exists to re-run this on a timer.
  void tick;

  if (!hasMoving) return cameras;

  const now = Date.now();
  return cameras.map((c) => {
    if (
      c.kind !== "aircraft" ||
      !c.groundSpeedKt ||
      c.trackDeg == null ||
      !c.fixedAt
    ) {
      return c;
    }
    const age = Math.min((now - c.fixedAt) / 1000, MAX_EXTRAPOLATION_S);
    if (age <= 0) return c;

    // knots -> nautical miles travelled -> degrees.
    const nm = (c.groundSpeedKt * age) / 3600;
    const rad = (c.trackDeg * Math.PI) / 180;
    const dLat = (nm * Math.cos(rad)) / 60;
    const dLon =
      (nm * Math.sin(rad)) / (60 * Math.cos((c.lat * Math.PI) / 180) || 1);

    return { ...c, lat: c.lat + dLat, lon: c.lon + dLon };
  });
}
