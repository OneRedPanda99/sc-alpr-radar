import type { Camera, LatLng } from "@/types";
import { bearingDeg, bearingDelta, haversineMeters } from "@/services/geo";

/**
 * "Follow me": a delayed live feed of your own drive.
 *
 * The camera streams run 10-20s behind real time, so the picture on screen
 * shows where you *were*. Instead of following the camera nearest you now,
 * follow a delayed clock (now minus the stream delay) and show whichever
 * camera your delayed self is approaching. Pass times are re-predicted every
 * second from your current speed and the distance left along the route, and
 * pinned to the measured moment once the GPS track has actually gone by.
 */

/** Keep showing a camera this long after your delayed self passes it. */
export const FOLLOW_AFTER_MS = 6000;
/** A typical SCDOT stream delay, used until a stream has been measured. */
export const DEFAULT_LAG_MS = 12000;
/** How far ahead (along the road) a camera is worth scheduling. */
const LOOKAHEAD_M = 6000;
/** Forget passes this long after they happened; the delay is never longer. */
const PASS_KEEP_MS = 60000;
/** Closest approach farther than this isn't "passing" the camera. */
const PASS_MAX_M = 300;
/** Positions older than this aren't needed to place you in a delayed frame. */
const HISTORY_MS = 4 * 60 * 1000;

interface XY {
  x: number;
  y: number;
}

/** Flat metres around an origin; plenty accurate over a few km. */
function toXY(o: LatLng, p: LatLng): XY {
  const k = Math.cos((o.lat * Math.PI) / 180);
  return { x: (p.lon - o.lon) * 111320 * k, y: (p.lat - o.lat) * 110540 };
}

/** Projection of p onto segment a→b: fraction along it and distance off it. */
function project(a: LatLng, b: LatLng, p: LatLng): { f: number; off: number; len: number } {
  const B = toXY(a, b);
  const P = toXY(a, p);
  const len2 = B.x * B.x + B.y * B.y;
  const f = len2 > 0 ? (P.x * B.x + P.y * B.y) / len2 : 0;
  const c = Math.max(0, Math.min(1, f));
  const off = Math.hypot(P.x - B.x * c, P.y - B.y * c);
  return { f, off, len: Math.sqrt(len2) };
}

export interface TrackPoint extends LatLng {
  t: number;
}

/** Where you've been over the last few minutes, timestamped. */
export class Track {
  pts: TrackPoint[] = [];

  push(t: number, p: LatLng) {
    const last = this.pts[this.pts.length - 1];
    if (last && t <= last.t) return;
    this.pts.push({ t, lat: p.lat, lon: p.lon });
    while (this.pts.length > 2 && this.pts[0].t < t - HISTORY_MS) this.pts.shift();
  }

  clear() {
    this.pts = [];
  }

  /** Your position at time t, interpolated between fixes. */
  at(t: number): LatLng | null {
    const pts = this.pts;
    if (!pts.length) return null;
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (t <= first.t) return t > first.t - 3000 ? first : null;
    if (t >= last.t) return t < last.t + 5000 ? last : null;
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const a = pts[lo];
    const b = pts[hi];
    const f = (t - a.t) / (b.t - a.t);
    return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
  }

  /** Average speed over the last few seconds, m/s. */
  speed(windowMs = 8000): number | null {
    const pts = this.pts;
    if (pts.length < 2) return null;
    const end = pts[pts.length - 1];
    let meters = 0;
    let i = pts.length - 1;
    while (i > 0 && pts[i - 1].t >= end.t - windowMs) {
      meters += haversineMeters(pts[i - 1], pts[i]);
      i--;
    }
    const dt = (end.t - pts[i].t) / 1000;
    return dt >= 2 ? meters / dt : null;
  }

  /**
   * When the track went past p, if it has: the closest point on a segment you
   * have driven all the way through, interpolated between the two fixes.
   */
  passOf(p: LatLng, maxOff = PASS_MAX_M): { t: number; off: number } | null {
    const pts = this.pts;
    let best: { t: number; off: number } | null = null;
    for (let i = pts.length - 1; i > 0; i--) {
      const a = pts[i - 1];
      const b = pts[i];
      const { f, off } = project(a, b, p);
      // f >= 1 on the newest segment means the camera is still ahead.
      if (f < 0 || f >= 1 || off > maxOff) continue;
      if (!best || off < best.off) best = { t: a.t + (b.t - a.t) * f, off };
    }
    return best;
  }
}

/** Distance along a route polyline, for "how far until the camera". */
export class RouteMeasure {
  private pts: LatLng[];
  private cum: number[];

  constructor(coordinates: [number, number][]) {
    this.pts = coordinates.map(([lon, lat]) => ({ lat, lon }));
    this.cum = [0];
    for (let i = 1; i < this.pts.length; i++) {
      this.cum.push(this.cum[i - 1] + haversineMeters(this.pts[i - 1], this.pts[i]));
    }
  }

  /** Metres from the route start to p's nearest point, and how far off it p is. */
  measure(p: LatLng): { m: number; off: number } | null {
    let best: { m: number; off: number } | null = null;
    for (let i = 1; i < this.pts.length; i++) {
      const { f, off, len } = project(this.pts[i - 1], this.pts[i], p);
      if (!best || off < best.off) {
        best = { m: this.cum[i - 1] + Math.max(0, Math.min(1, f)) * len, off };
      }
    }
    return best;
  }
}

/**
 * Which traffic a live camera watches, compared with the way you're going.
 * SCDOT tags each camera with the direction it covers ("covering NB
 * traffic"); the exact aim isn't published and operators re-aim them, so this
 * is the best available guess at whether you'll be in the picture.
 */
export type Cover = "yours" | "opposite" | "crossing" | "unknown";

export function coverFor(cam: Camera, heading: number | null): Cover {
  if (heading == null || cam.roadBearing == null || !Number.isFinite(cam.roadBearing)) {
    return "unknown";
  }
  const d = bearingDelta(heading, cam.roadBearing);
  return d <= 60 ? "yours" : d >= 120 ? "opposite" : "crossing";
}

const COVER_RANK: Record<Cover, number> = { yours: 0, unknown: 1, opposite: 2, crossing: 3 };

/** Cameras this close together (one each way at an interchange) are a pair. */
const PAIR_METERS = 250;

export interface ChasePass {
  cam: Camera;
  /** Whether it watches your direction of travel. */
  cover: Cover;
  /** Wall-clock ms you pass (or passed) closest to the camera. */
  at: number;
  /** True once the GPS track has actually gone by it. */
  actual: boolean;
  /** Metres still to go along the road; negative once passed. */
  along: number;
}

/**
 * Every live camera you're about to pass or just passed, in pass order.
 * `camMeasures` caches each camera's position along the route.
 */
export function schedulePasses(opts: {
  cams: Camera[];
  track: Track;
  now: number;
  here: LatLng;
  heading: number | null;
  speed: number | null;
  route: RouteMeasure | null;
  camMeasures: Map<string, { m: number; off: number } | null>;
}): ChasePass[] {
  const { cams, track, now, here, heading, speed, route, camMeasures } = opts;
  const hereM = route?.measure(here) ?? null;
  const onRoute = hereM != null && hereM.off < 150;
  const out: ChasePass[] = [];

  for (const cam of cams) {
    const d = haversineMeters(here, cam);
    if (d > LOOKAHEAD_M + 1000) continue;

    const passed = track.passOf(cam);
    if (passed) {
      if (now - passed.t < PASS_KEEP_MS) {
        out.push({ cam, at: passed.t, actual: true, along: -d, cover: coverFor(cam, heading) });
      }
      continue;
    }

    let along: number | null = null;
    if (route && onRoute) {
      let cm = camMeasures.get(cam.id);
      if (cm === undefined) {
        cm = route.measure(cam);
        camMeasures.set(cam.id, cm);
      }
      if (cm && cm.off < 350) along = cm.m - hereM.m;
    } else if (heading != null) {
      // No route: only cameras close to the line you're driving along.
      const rad = (bearingDelta(heading, bearingDeg(here, cam)) * Math.PI) / 180;
      if (rad <= Math.PI / 2 && d * Math.sin(rad) < 300) along = d * Math.cos(rad);
    } else {
      along = d;
    }
    if (along == null || along < 0 || along > LOOKAHEAD_M) continue;

    const at = speed && speed > 1 ? now + (along / speed) * 1000 : Number.POSITIVE_INFINITY;
    out.push({ cam, at, actual: false, along, cover: coverFor(cam, heading) });
  }

  out.sort((a, b) => a.at - b.at || a.along - b.along);
  // Where SCDOT has a camera for each direction side by side, keep the one
  // watching your side; the other would show the far lanes, if you at all.
  return out.filter(
    (p) =>
      !out.some(
        (q) =>
          q !== p &&
          COVER_RANK[q.cover] < COVER_RANK[p.cover] &&
          Math.abs(q.at - p.at) < 20000 &&
          haversineMeters(q.cam, p.cam) < PAIR_METERS,
      ),
  );
}

/**
 * The camera to show right now: the first one whose pass hasn't finished
 * playing in the delayed picture. Switching as soon as the last pass has
 * played gives the next stream the most time to connect before you arrive.
 */
export function followTarget(passes: ChasePass[], delayedNow: number): ChasePass | null {
  // A camera on a road you only cross shows you for a second, if at all.
  const watchable = passes.filter((p) => p.cover !== "crossing");
  const pool = watchable.length ? watchable : passes;
  return pool.find((p) => p.at + FOLLOW_AFTER_MS > delayedNow) ?? null;
}
