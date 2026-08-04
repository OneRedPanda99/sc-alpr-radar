import { useEffect, useRef, useState } from "react";
import type { Camera } from "@/types";

/** SCDOT publishes a fresh JPEG roughly once a minute. */
const REFRESH_MS = 60_000;

/**
 * Only SCDOT 511 cameras carry a live snapshot. Everything else with an
 * imageUrl (OSM photos, brand illustrations) is a static picture.
 */
export function isLiveCamera(camera: Camera): boolean {
  return camera.id.startsWith("sc511/") && !!camera.imageUrl;
}

function ago(from: number): string {
  const s = Math.max(0, Math.round((Date.now() - from) / 1000));
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

/**
 * Auto-refreshing view of a live traffic camera.
 *
 * The URL is cache-busted on every fetch: the CDN sets a 60s Expires, so
 * without a unique query the browser (and our own service worker) would keep
 * handing back the same frame and the feed would look frozen.
 */
export function LiveCameraImage({
  camera,
  onError,
}: {
  camera: Camera;
  onError?: () => void;
}) {
  const [src, setSrc] = useState(() => `${camera.imageUrl}?t=${Date.now()}`);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [, forceTick] = useState(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    setSrc(`${camera.imageUrl}?t=${Date.now()}`);
    setLoadedAt(null);
    setFailed(false);
  }, [camera.imageUrl]);

  useEffect(() => {
    if (failed) return;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      setSrc(`${camera.imageUrl}?t=${Date.now()}`);
    };
    timerRef.current = window.setInterval(refresh, REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [camera.imageUrl, failed]);

  // Re-render once a second purely so the "12s ago" label counts up.
  useEffect(() => {
    const t = window.setInterval(() => forceTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);

  if (failed) return null;

  return (
    <div className="live-cam">
      <img
        src={src}
        alt={camera.name ?? "Live traffic camera"}
        onLoad={() => setLoadedAt(Date.now())}
        onError={() => {
          setFailed(true);
          onError?.();
        }}
      />
      <div className="live-cam-badge">
        <span className="live-dot" aria-hidden="true" />
        LIVE
      </div>
      {loadedAt && <div className="live-cam-age">{ago(loadedAt)}</div>}
    </div>
  );
}
