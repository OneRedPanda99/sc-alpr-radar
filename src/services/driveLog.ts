import type { Camera, CameraKind } from "@/types";

/**
 * A short record of each drive, kept on this device: what you passed, how
 * far, how long. It turns "the app beeped a lot" into something concrete,
 * and the month adds up from it.
 */
const KEY = "alpr.drives";
const KEEP = 300;

/** Close enough that you drove past it, not just near it. */
export const PASS_METERS = 120;

export interface DriveRecord {
  start: number;
  end: number;
  meters: number;
  /** Cameras passed, by kind. */
  kinds: Partial<Record<CameraKind, number>>;
  flock: number;
  police: number;
  clips: number;
}

export function loadDrives(): DriveRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as DriveRecord[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveDrive(d: DriveRecord) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...loadDrives(), d].slice(-KEEP)));
  } catch {
    // Storage full or private mode: the summary still shows once.
  }
}

/** Builds the record as the drive goes. */
export class DriveRecorder {
  readonly start = Date.now();
  meters = 0;
  private passed = new Map<string, Camera>();
  private police = new Set<string>();
  private last: { lat: number; lon: number } | null = null;

  move(p: { lat: number; lon: number }, step: number) {
    // Ignore GPS jumps; a real second of driving is never a kilometre.
    if (this.last && step < 1000) this.meters += step;
    this.last = p;
  }

  pass(c: Camera) {
    if (c.kind === "aircraft" || c.kind === "radio" || c.kind === "police") return;
    if (c.myReport || c.kind === "incident") return;
    this.passed.set(c.id, c);
  }

  sawPolice(id: string) {
    this.police.add(id);
  }

  finish(clips: number): DriveRecord {
    const kinds: Partial<Record<CameraKind, number>> = {};
    let flock = 0;
    for (const c of this.passed.values()) {
      kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
      if (c.brand === "Flock Safety") flock++;
    }
    return { start: this.start, end: Date.now(), meters: this.meters, kinds, flock, police: this.police.size, clips };
  }
}

/** Totals for the calendar month containing `now`. */
export function monthTotals(now = new Date()) {
  const from = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const drives = loadDrives().filter((d) => d.start >= from);
  return {
    drives: drives.length,
    readers: drives.reduce((n, d) => n + (d.kinds.alpr ?? 0), 0),
    cameras: drives.reduce((n, d) => n + Object.values(d.kinds).reduce((a, b) => a + (b ?? 0), 0), 0),
    miles: drives.reduce((n, d) => n + d.meters, 0) / 1609.34,
    clips: drives.reduce((n, d) => n + d.clips, 0),
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "This month: 12 drives, 210 mi, 96 cameras passed (34 plate readers)". */
export function monthText(t: ReturnType<typeof monthTotals>): string {
  const miles = t.miles < 10 ? t.miles.toFixed(1) : String(Math.round(t.miles));
  const readers = t.readers ? ` (${plural(t.readers, "plate reader")})` : "";
  return `This month: ${plural(t.drives, "drive")}, ${miles} mi, ${plural(t.cameras, "camera")} passed${readers}`;
}
