import { useCallback, useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import type { Camera } from "@/types";
import { useSettingsStore } from "@/store/settingsStore";

/**
 * Tone curve for the headlight dimmer.
 *
 * A blown-out headlight is clipped at the sensor — those pixels are pure white
 * and no filter can invent detail back into them. What this *can* do is stop
 * the bloom from dominating the frame and lift the surrounding road and
 * vehicles into a readable range, which is the part you actually want to see.
 *
 * It's a switch rather than an always-on correction because the same curve
 * that rescues a night feed just crushes a normal daytime one.
 */
const DIM_FILTER = "brightness(0.48) contrast(1.7) saturate(0.85)";

/** Snapshot refresh cadence (fallback path only). */
const REFRESH_MS = 30_000;

/** Give the stream this many recovery attempts before falling back to stills. */
const MAX_RECOVERIES = 3;

/** SCDOT 511 cameras are the only ones with a live feed. */
export function isLiveCamera(camera: Camera): boolean {
  return (
    camera.id.startsWith("sc511/") && !!(camera.streamUrl || camera.imageUrl)
  );
}

/**
 * Live traffic camera.
 *
 * Prefers the HLS stream (SkyVDN sends `Access-Control-Allow-Origin: *`), via
 * hls.js on Chrome/Firefox/Android and the native player on Safari/iOS.
 *
 * Fatal errors are *recovered*, not surrendered to. These are 24/7 public
 * cameras that stall, drop and re-key constantly; treating the first fatal
 * error as terminal is what made switching cameras and coming back drop to
 * stills permanently. Only after several failed recoveries do we fall back.
 */
export function LiveCameraVideo({
  camera,
  onError,
  fullscreenTarget,
}: {
  camera: Camera;
  onError?: () => void;
  /** Element to put fullscreen; defaults to the player itself. */
  fullscreenTarget?: React.RefObject<HTMLElement>;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dimHeadlights = useSettingsStore((s) => s.dimHeadlights);
  const setSetting = useSettingsStore((s) => s.set);
  const [useStill, setUseStill] = useState(!camera.streamUrl);
  const [playing, setPlaying] = useState(false);
  const [isFull, setIsFull] = useState(false);

  // Reset per camera so a previous camera's failures never poison the next one.
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
    let recoveries = 0;

    const giveUp = () => {
      if (cancelled) return;
      setUseStill(true);
    };

    if (!Hls.isSupported() && video.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari / iOS: native HLS, no MSE for hls.js to use.
      video.src = url;
      video.addEventListener("error", giveUp);
      void video.play().catch(() => {});
      return () => {
        cancelled = true;
        video.removeEventListener("error", giveUp);
        video.removeAttribute("src");
        video.load();
      };
    }

    if (!Hls.isSupported()) {
      giveUp();
      return;
    }

    hls = new Hls({
      // Deliberately NOT lowLatencyMode with a 1-segment sync window. These are
      // plain (non-LL) HLS streams; pinning to the very live edge made them
      // stall and throw fatal errors within seconds. The default sync window
      // trades ~10s of latency for a feed that actually stays up.
      liveSyncDurationCount: 3,
      manifestLoadingMaxRetry: 4,
      levelLoadingMaxRetry: 4,
      fragLoadingMaxRetry: 6,
    });

    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      void video.play().catch(() => {});
    });

    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal || cancelled || !hls) return;
      if (recoveries >= MAX_RECOVERIES) {
        giveUp();
        return;
      }
      recoveries++;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        hls.startLoad();
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
      } else {
        giveUp();
      }
    });

    return () => {
      cancelled = true;
      hls?.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [camera.streamUrl, useStill]);

  useEffect(() => {
    const onChange = () => setIsFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = fullscreenTarget?.current ?? wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    if (el.requestFullscreen) {
      void el.requestFullscreen().catch(() => {});
    } else {
      // iOS Safari exposes fullscreen only on the video element itself.
      const v = videoRef.current as
        | (HTMLVideoElement & { webkitEnterFullscreen?: () => void })
        | null;
      v?.webkitEnterFullscreen?.();
    }
  }, [fullscreenTarget]);

  if (useStill) {
    return (
      <LiveCameraStill
        camera={camera}
        onError={onError}
        onFullscreen={toggleFullscreen}
      />
    );
  }

  return (
    <div className="live-cam" ref={wrapRef}>
      <video
        ref={videoRef}
        muted
        playsInline
        autoPlay
        style={{ filter: dimHeadlights ? DIM_FILTER : undefined }}
        onPlaying={() => setPlaying(true)}
        onWaiting={() => setPlaying(false)}
        aria-label={camera.name ?? "Live traffic camera"}
      />
      <div className="live-cam-badge">
        <span className="live-dot" aria-hidden="true" />
        {playing ? "LIVE" : "CONNECTING"}
      </div>
      <div className="live-cam-controls">
        <button
          type="button"
          className={`live-cam-btn ${dimHeadlights ? "on" : ""}`}
          onClick={() => setSetting("dimHeadlights", !dimHeadlights)}
          aria-pressed={dimHeadlights}
          title="Headlight dimmer — cuts glare on night feeds"
        >
          Dimmer
        </button>
        <button
          type="button"
          className="live-cam-btn"
          onClick={toggleFullscreen}
          aria-label={isFull ? "Exit fullscreen" : "Fullscreen"}
          title={isFull ? "Exit fullscreen" : "Fullscreen"}
        >
          {isFull ? "✕" : "⛶"}
        </button>
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
  onFullscreen,
}: {
  camera: Camera;
  onError?: () => void;
  onFullscreen?: () => void;
}) {
  const dimHeadlights = useSettingsStore((s) => s.dimHeadlights);
  const [src, setSrc] = useState(() => `${camera.imageUrl}?t=${Date.now()}`);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    setSrc(`${camera.imageUrl}?t=${Date.now()}`);
    setFailed(false);
  }, [camera.imageUrl]);

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
        style={{ filter: dimHeadlights ? DIM_FILTER : undefined }}
        onLoad={() => setLoadedAt(Date.now())}
        onError={() => {
          setFailed(true);
          onError?.();
        }}
      />
      <div className="live-cam-badge still">SNAPSHOT</div>
      {loadedAt && <div className="live-cam-age">{ago(loadedAt)}</div>}
      {onFullscreen && (
        <div className="live-cam-controls">
          <button
            type="button"
            className="live-cam-btn"
            onClick={onFullscreen}
            aria-label="Fullscreen"
          >
            ⛶
          </button>
        </div>
      )}
    </div>
  );
}

/** Back-compat alias — call sites use the same name for either mode. */
export const LiveCameraImage = LiveCameraVideo;
