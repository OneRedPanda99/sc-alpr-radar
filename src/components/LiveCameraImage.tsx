import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import type { Camera } from "@/types";

/** SCDOT publishes a fresh still roughly once a minute (fallback path only). */
const REFRESH_MS = 30_000;

/** SCDOT 511 cameras are the only ones with a live feed. */
export function isLiveCamera(camera: Camera): boolean {
  return camera.id.startsWith("sc511/") && !!(camera.streamUrl || camera.imageUrl);
}

/**
 * Live traffic camera.
 *
 * Prefers the real HLS video stream. SkyVDN serves the playlist and segments
 * with `Access-Control-Allow-Origin: *`, so it plays directly in the browser —
 * via hls.js on Chrome/Firefox/Android, and via the native player on Safari and
 * iOS, which handle .m3u8 in a <video> tag but have no MSE for hls.js to use.
 *
 * Falls back to the cache-busted still image if the stream fails or the camera
 * has no stream URL. The stills are the only thing SCDOT publishes for some
 * cameras, and a frozen picture beats a dead player.
 */
export function LiveCameraVideo({
  camera,
  onError,
}: {
  camera: Camera;
  onError?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [useStill, setUseStill] = useState(!camera.streamUrl);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    setUseStill(!camera.streamUrl);
    setPlaying(false);
  }, [camera.streamUrl]);

  useEffect(() => {
    const video = videoRef.current;
    const url = camera.streamUrl;
    if (!video || !url || useStill) return;

    let hls: Hls | null = null;
    let cancelled = false;

    const fail = () => {
      if (cancelled) return;
      setUseStill(true);
    };

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari / iOS: native HLS.
      video.src = url;
      video.addEventListener("error", fail);
    } else if (Hls.isSupported()) {
      hls = new Hls({
        // These are live cameras — never sit on a buffered backlog, always
        // jump to the live edge. Without this you drift seconds behind.
        liveSyncDurationCount: 1,
        lowLatencyMode: true,
        // A traffic camera isn't worth retrying forever in the background.
        manifestLoadingMaxRetry: 2,
        levelLoadingMaxRetry: 2,
        fragLoadingMaxRetry: 2,
      });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) fail();
      });
    } else {
      fail();
      return;
    }

    void video.play().catch(() => {
      /* autoplay can be refused; the controls still work */
    });

    return () => {
      cancelled = true;
      video.removeEventListener("error", fail);
      if (hls) hls.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [camera.streamUrl, useStill]);

  if (useStill) {
    return <LiveCameraStill camera={camera} onError={onError} />;
  }

  return (
    <div className="live-cam">
      <video
        ref={videoRef}
        muted
        playsInline
        autoPlay
        controls={false}
        onPlaying={() => setPlaying(true)}
        aria-label={camera.name ?? "Live traffic camera"}
      />
      <div className="live-cam-badge">
        <span className="live-dot" aria-hidden="true" />
        {playing ? "LIVE" : "CONNECTING"}
      </div>
    </div>
  );
}

function ago(from: number): string {
  const s = Math.max(0, Math.round((Date.now() - from) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

/** Cache-busted auto-refreshing still, for cameras with no usable stream. */
function LiveCameraStill({
  camera,
  onError,
}: {
  camera: Camera;
  onError?: () => void;
}) {
  const [src, setSrc] = useState(() => `${camera.imageUrl}?t=${Date.now()}`);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    if (failed || !camera.imageUrl) return;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      setSrc(`${camera.imageUrl}?t=${Date.now()}`);
    };
    const timer = window.setInterval(refresh, REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [camera.imageUrl, failed]);

  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);

  if (failed || !camera.imageUrl) return null;

  return (
    <div className="live-cam">
      <img
        src={src}
        alt={camera.name ?? "Traffic camera"}
        onLoad={() => setLoadedAt(Date.now())}
        onError={() => {
          setFailed(true);
          onError?.();
        }}
      />
      <div className="live-cam-badge still">SNAPSHOT</div>
      {loadedAt && <div className="live-cam-age">{ago(loadedAt)}</div>}
    </div>
  );
}

/** Back-compat alias — call sites use the same name for either mode. */
export const LiveCameraImage = LiveCameraVideo;
