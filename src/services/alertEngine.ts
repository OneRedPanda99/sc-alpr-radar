import type { AlertSoundId } from "@/types";

/**
 * Radar-detector-style audio alerts using the Web Audio API (no asset files).
 * A single AudioContext is lazily created on first user gesture so mobile
 * browsers allow playback.
 */

export type { AlertSoundId };

export const ALERT_SOUNDS: {
  id: AlertSoundId;
  label: string;
  blurb: string;
}[] = [
  { id: "chirp", label: "Radar chirp", blurb: "Classic square beeps" },
  { id: "pulse", label: "Soft pulse", blurb: "Mellow sine taps" },
  { id: "siren", label: "Two-tone", blurb: "Short hi-lo sweep" },
  { id: "ping", label: "Sonar ping", blurb: "Clean high ping" },
  { id: "klaxon", label: "Klaxon", blurb: "Harsh saw alarm" },
  { id: "triple", label: "Triple drop", blurb: "Three descending beeps" },
  { id: "digital", label: "Digital", blurb: "Quick arpeggio blips" },
];

let ctx: AudioContext | null = null;

function context(): AudioContext {
  if (!ctx) {
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    ctx = new Ctor();
  }
  return ctx;
}

/** Must be called from a user gesture (e.g. Start Driving tap) to unlock audio. */
export async function unlockAudio(): Promise<void> {
  const c = context();
  if (c.state === "suspended") await c.resume();
  // Play a near-silent blip to fully unlock on iOS.
  const osc = c.createOscillator();
  const gain = c.createGain();
  gain.gain.value = 0.0001;
  osc.connect(gain).connect(c.destination);
  osc.start();
  osc.stop(c.currentTime + 0.02);
  // iOS only lets speech start after a tap; an empty utterance unlocks it.
  try {
    if ("speechSynthesis" in window) speechSynthesis.speak(new SpeechSynthesisUtterance(""));
  } catch {
    // No speech on this device; the tones still work.
  }
}

/**
 * Speak a short alert. Interrupts anything still being said: the newest
 * alert is the one about the road you're on now.
 */
export function speak(text: string, delayMs = 350): void {
  if (!("speechSynthesis" in window)) return;
  window.setTimeout(() => {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      speechSynthesis.speak(u);
    } catch {
      // Ignore: speech is a bonus on top of the tone.
    }
  }, delayMs);
}

/** "400 feet", "a quarter mile", "1.2 miles": how distances sound aloud. */
export function spokenDistance(meters: number): string {
  const feet = meters * 3.28084;
  if (feet < 1000) return `${Math.max(100, Math.round(feet / 100) * 100)} feet`;
  const miles = meters / 1609.34;
  if (miles < 0.35) return "a quarter mile";
  if (miles < 0.65) return "half a mile";
  if (miles < 0.9) return "three quarters of a mile";
  if (miles < 1.15) return "1 mile";
  return `${miles.toFixed(1)} miles`;
}

interface ToneOpts {
  type?: OscillatorType;
  freq: number;
  start: number;
  dur: number;
  peak?: number;
  freqEnd?: number;
}

function tone(c: AudioContext, o: ToneOpts): void {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = o.type ?? "square";
  osc.frequency.setValueAtTime(o.freq, o.start);
  if (o.freqEnd != null) {
    osc.frequency.linearRampToValueAtTime(o.freqEnd, o.start + o.dur);
  }
  const peak = o.peak ?? 0.18;
  gain.gain.setValueAtTime(0, o.start);
  gain.gain.linearRampToValueAtTime(peak, o.start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, o.start + o.dur);
  osc.connect(gain).connect(c.destination);
  osc.start(o.start);
  osc.stop(o.start + o.dur + 0.02);
}

export interface AlertPlayOptions {
  /** 0 (far) to 1 (very close). Raises pitch and urgency. */
  intensity?: number;
  sound?: AlertSoundId;
}

/** Play the selected alert sound. */
export function playAlert({
  intensity = 0,
  sound = "chirp",
}: AlertPlayOptions = {}): void {
  const c = context();
  if (c.state === "suspended") void c.resume();
  const now = c.currentTime;
  const i = Math.max(0, Math.min(1, intensity));

  switch (sound) {
    case "pulse":
      playPulse(c, now, i);
      break;
    case "siren":
      playSiren(c, now, i);
      break;
    case "ping":
      playPing(c, now, i);
      break;
    case "klaxon":
      playKlaxon(c, now, i);
      break;
    case "triple":
      playTriple(c, now, i);
      break;
    case "digital":
      playDigital(c, now, i);
      break;
    case "chirp":
    default:
      playChirpTone(c, now, i);
      break;
  }
}

/** @deprecated Prefer playAlert({ sound: "chirp" }) */
export function playChirp({ intensity = 0 }: { intensity?: number } = {}): void {
  playAlert({ intensity, sound: "chirp" });
}

function playChirpTone(c: AudioContext, now: number, i: number): void {
  const baseFreq = 880 + i * 620;
  const beeps = i > 0.66 ? 3 : i > 0.33 ? 2 : 1;
  for (let n = 0; n < beeps; n++) {
    tone(c, {
      type: "square",
      freq: baseFreq,
      start: now + n * 0.11,
      dur: 0.09,
      peak: 0.18,
    });
  }
}

function playPulse(c: AudioContext, now: number, i: number): void {
  const base = 520 + i * 280;
  const beeps = i > 0.55 ? 3 : 2;
  for (let n = 0; n < beeps; n++) {
    tone(c, {
      type: "sine",
      freq: base + n * 40,
      start: now + n * 0.16,
      dur: 0.14,
      peak: 0.22,
    });
  }
}

function playSiren(c: AudioContext, now: number, i: number): void {
  const lo = 640 + i * 120;
  const hi = 980 + i * 220;
  tone(c, {
    type: "triangle",
    freq: lo,
    freqEnd: hi,
    start: now,
    dur: 0.18,
    peak: 0.2,
  });
  tone(c, {
    type: "triangle",
    freq: hi,
    freqEnd: lo,
    start: now + 0.18,
    dur: 0.2,
    peak: 0.2,
  });
}

function playPing(c: AudioContext, now: number, i: number): void {
  const freq = 1200 + i * 600;
  tone(c, {
    type: "sine",
    freq,
    freqEnd: freq * 0.55,
    start: now,
    dur: 0.28,
    peak: 0.24,
  });
  if (i > 0.4) {
    tone(c, {
      type: "sine",
      freq: freq * 1.01,
      freqEnd: freq * 0.5,
      start: now + 0.22,
      dur: 0.22,
      peak: 0.12,
    });
  }
}

function playKlaxon(c: AudioContext, now: number, i: number): void {
  const bursts = i > 0.6 ? 3 : 2;
  for (let n = 0; n < bursts; n++) {
    const start = now + n * 0.14;
    tone(c, {
      type: "sawtooth",
      freq: 420 + i * 80,
      freqEnd: 720 + i * 160,
      start,
      dur: 0.11,
      peak: 0.14,
    });
  }
}

function playTriple(c: AudioContext, now: number, i: number): void {
  const top = 1100 + i * 400;
  const freqs = [top, top * 0.84, top * 0.7];
  freqs.forEach((freq, n) => {
    tone(c, {
      type: "square",
      freq,
      start: now + n * 0.13,
      dur: 0.1,
      peak: 0.17,
    });
  });
}

function playDigital(c: AudioContext, now: number, i: number): void {
  const root = 700 + i * 350;
  const seq = [0, 4, 7, 12].map((semis) => root * 2 ** (semis / 12));
  seq.forEach((freq, n) => {
    tone(c, {
      type: "square",
      freq,
      start: now + n * 0.055,
      dur: 0.05,
      peak: 0.15,
    });
  });
}

/**
 * Tracks which cameras have already alerted so one camera does not spam while
 * you approach it. A camera re-arms once you leave its radius.
 */
export class AlertTracker {
  private readonly alerted = new Set<string>();

  /**
   * @param inRangeIds ids currently within alert radius (nearest first)
   * @returns ids that newly entered range this tick
   */
  update(inRangeIds: string[]): string[] {
    const current = new Set(inRangeIds);
    // Re-arm cameras that dropped out of range.
    for (const id of this.alerted) {
      if (!current.has(id)) this.alerted.delete(id);
    }
    const fresh: string[] = [];
    for (const id of inRangeIds) {
      if (!this.alerted.has(id)) {
        this.alerted.add(id);
        fresh.push(id);
      }
    }
    return fresh;
  }

  reset(): void {
    this.alerted.clear();
  }
}
