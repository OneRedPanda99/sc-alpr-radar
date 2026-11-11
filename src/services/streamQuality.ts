/**
 * How sharp each live camera's stream is. SCDOT publishes one rendition per
 * camera, anywhere from 480x270 (~0.1 Mbps) to 720x480 (~0.3 Mbps), and it's
 * written in the stream's master playlist, a few hundred bytes of text. Knowing
 * it lets Follow me pick the sharper of two cameras covering the same spot.
 */
const heights = new Map<string, number>();
const probing = new Map<string, Promise<number | undefined>>();

/** Stream height in pixels, if known yet. */
export function streamHeight(camId: string): number | undefined {
  return heights.get(camId);
}

/** Record a height the player measured from the video itself. */
export function noteStreamHeight(camId: string, height: number) {
  if (height > 0) heights.set(camId, height);
}

/** Read the height from the stream's playlist (once per camera). */
export function probeStream(camId: string, streamUrl: string): Promise<number | undefined> {
  const known = heights.get(camId);
  if (known) return Promise.resolve(known);
  let p = probing.get(camId);
  if (!p) {
    p = fetch(streamUrl)
      .then((r) => (r.ok ? r.text() : ""))
      .then((text) => {
        const m = /RESOLUTION=\d+x(\d+)/.exec(text);
        const h = m ? Number(m[1]) : undefined;
        if (h) heights.set(camId, h);
        return h;
      })
      .catch(() => undefined);
    probing.set(camId, p);
  }
  return p;
}

/** How far lock-on can zoom before a car turns into a few blocks of pixels. */
export function lockZoomFor(height: number): number {
  if (height >= 480) return 2.5;
  if (height >= 360) return 2;
  return 1.6;
}
