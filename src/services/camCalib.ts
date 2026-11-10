/**
 * Where your car shows up in a camera's picture, learned from your own passes.
 *
 * A camera's aim and zoom aren't published (and PTZ cameras get re-aimed), so
 * there's no way to compute a pixel from a GPS position. Instead, each time
 * you tap your car in a frame, the app pairs that spot in the picture with
 * how far along the road you were at that frame's moment. With two or more
 * of those marks, a later pass can be placed in the picture by interpolating
 * between them. More marks follow the road's perspective more closely.
 */
const KEY = "alpr.camCalib";

export interface CalibMark {
  /** Position in the video frame, 0..1 of its width and height. */
  x: number;
  y: number;
  /** Metres along the road from the camera: negative before it, positive after. */
  s: number;
}

type Store = Record<string, { marks: CalibMark[]; at: number; offsetMs?: number }>;

function load(): Store {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? "{}") as Store) ?? {};
  } catch {
    return {};
  }
}

function save(store: Store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Storage blocked: marks last this session only.
  }
}

export function marksFor(camId: string): CalibMark[] {
  return load()[camId]?.marks ?? [];
}

/** Add a mark; one replaces any earlier mark within 15 m of the same spot. */
export function addMark(camId: string, mark: CalibMark): CalibMark[] {
  const store = load();
  const marks = (store[camId]?.marks ?? []).filter((m) => Math.abs(m.s - mark.s) > 15);
  marks.push(mark);
  marks.sort((a, b) => a.s - b.s);
  store[camId] = { ...store[camId], marks, at: Date.now() };
  save(store);
  return marks;
}

/**
 * A per-camera correction to the estimated frame time. The streams carry no
 * timestamps, so the delay is estimated to within a second or so; nudging
 * "car's ahead / behind" once or twice settles it for that camera.
 */
export function offsetFor(camId: string): number {
  return load()[camId]?.offsetMs ?? 0;
}

export function setOffset(camId: string, ms: number) {
  const store = load();
  store[camId] = { marks: store[camId]?.marks ?? [], at: Date.now(), offsetMs: ms };
  save(store);
}

export function clearMarks(camId: string) {
  const store = load();
  delete store[camId];
  save(store);
}

/**
 * Where in the frame you'd be at distance `s`, or null when it's outside what
 * the marks cover (a little extrapolation either side is allowed).
 */
export function placeOnFrame(marks: CalibMark[], s: number): { x: number; y: number } | null {
  if (marks.length < 2) return null;
  const first = marks[0];
  const last = marks[marks.length - 1];
  const span = last.s - first.s;
  if (span < 10) return null;
  const slack = span * 0.25;
  if (s < first.s - slack || s > last.s + slack) return null;
  let i = 1;
  while (i < marks.length - 1 && s > marks[i].s) i++;
  const a = marks[i - 1];
  const b = marks[i];
  const t = (s - a.s) / (b.s - a.s);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
