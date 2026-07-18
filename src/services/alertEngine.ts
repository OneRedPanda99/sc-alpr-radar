/**
 * Radar-detector-style audio alerts using the Web Audio API (no asset files).
 * A single AudioContext is lazily created on first user gesture so mobile
 * browsers allow playback.
 */

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
}

interface ChirpOptions {
  /** 0 (far) to 1 (very close). Raises pitch and urgency. */
  intensity?: number;
}

/** Short two-tone chirp; higher intensity = higher/faster, like a radar det. */
export function playChirp({ intensity = 0 }: ChirpOptions = {}): void {
  const c = context();
  if (c.state === "suspended") void c.resume();
  const now = c.currentTime;
  const baseFreq = 880 + intensity * 620; // 880 -> 1500 Hz
  const beeps = intensity > 0.66 ? 3 : intensity > 0.33 ? 2 : 1;
  const spacing = 0.11;

  for (let i = 0; i < beeps; i++) {
    const start = now + i * spacing;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(baseFreq, start);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.18, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.09);
    osc.connect(gain).connect(c.destination);
    osc.start(start);
    osc.stop(start + 0.1);
  }
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
