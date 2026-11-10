/**
 * Facts about the browser this is running in. The Tesla browser and iPhone
 * Safari differ from a laptop in scale, location access and what can record
 * video, and those are hard to guess from outside, so this reports them.
 */

/** Tesla's in-car browser names itself in the user agent. */
export function isCarBrowser(): boolean {
  return /\bTesla\b/i.test(navigator.userAgent);
}

/** Recording a live feed needs MediaRecorder plus a way to capture the video. */
export function recordingSupport(): string {
  if (typeof MediaRecorder === "undefined") return "not available";
  const v = document.createElement("video") as HTMLVideoElement & { captureStream?: unknown };
  const c = document.createElement("canvas") as HTMLCanvasElement & { captureStream?: unknown };
  if (typeof v.captureStream === "function") return "yes";
  if (typeof c.captureStream === "function") return "yes (via canvas)";
  return "not available";
}

export function deviceReport(): [string, string][] {
  const ua = navigator.userAgent;
  const browser = isCarBrowser()
    ? "Tesla"
    : /iPhone|iPad/.test(ua)
      ? "iPhone Safari"
      : /Android/.test(ua)
        ? "Android"
        : "Desktop";
  return [
    ["Screen", `${window.innerWidth} × ${window.innerHeight} at ${window.devicePixelRatio}×`],
    ["Browser", browser],
    ["Location", "geolocation" in navigator ? "available" : "not available"],
    ["Recording passes", recordingSupport()],
  ];
}
