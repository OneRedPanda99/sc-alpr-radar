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
/**
 * The streams carry no wall-clock timestamps (no EXT-X-PROGRAM-DATE-TIME), so
 * "when was this frame shot" is estimated: a segment is published once it has
 * been fully encoded, so the playlist's newest edge is roughly the moment we
 * first see it, less a small allowance for the camera's encoder and the CDN.
 */
const UPSTREAM_DELAY_MS = 2000;
/** How close (in estimated frame time) counts as "you're on screen now". */
const ON_SCREEN_WINDOW_MS = 3500;

export interface PassInfo {
  /** Wall-clock ms of your closest approach to this camera. */
  at: number;
  /** True once it actually happened (not just predicted from speed). */
  actual: boolean;
  /** Where in the picture to look, e.g. "coming toward the camera". */
  hint?: string;
}

export function LiveCameraVideo({
  camera,
  onError,
  fullscreenTarget,
  pass,
  onClip,
}: {
  camera: Camera;
  onError?: () => void;
  /** Element to put fullscreen; defaults to the player itself. */
  fullscreenTarget?: React.RefObject<HTMLElement>;
  /** Your pass by this camera, to time the "you're on screen" cue. */
  pass?: PassInfo | null;
  /** Receives a recorded clip (blob URL) of the moment you pass. */
  onClip?: (url: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  /** Latest playlist edge (media seconds) and the wall time it appeared. */
  const edgeRef = useRef<{ media: number; wall: number } | null>(null);
  const [lagMs, setLagMs] = useState<number | null>(null);
  const [frameWall, setFrameWall] = useState<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const clipDoneRef = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dimHeadlights = useSettingsStore((s) => s.dimHeadlights);
  const setSetting = useSettingsStore((s) => s.set);
  const [useStill, setUseStill] = useState(!camera.streamUrl);
  const [playing, setPlaying] = useState(false);
  const [isFull, setIsFull] = useState(false);
  const [paused, setPaused] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  // Reset the viewer when the camera changes; a pan into the corner of the
  // previous camera's frame is meaningless on the next one.
  useEffect(() => {
    setPaused(false);
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [camera.streamUrl]);

  const cycleZoom = useCallback(() => {
    setZoom((z) => (z >= 4 ? 1 : z * 2));
    setPan({ x: 0, y: 0 });
  }, []);

  const togglePause = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      void v.play().catch(() => {});
      setPaused(false);
    } else {
      v.pause();
      setPaused(true);
    }
  }, []);

  /** Step backwards inside the live buffer (a few seconds is all HLS keeps). */
  const nudge = useCallback((seconds: number) => {
    const v = videoRef.current;
    if (!v) return;
    const b = v.buffered;
    const floor = b.length ? b.start(0) : 0;
    v.currentTime = Math.max(floor + 0.1, v.currentTime + seconds);
    v.pause();
    setPaused(true);
  }, []);

  const goLive = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const b = v.buffered;
    if (b.length) v.currentTime = Math.max(0, b.end(b.length - 1) - 3);
    void v.play().catch(() => {});
    setPaused(false);
  }, []);

  // Drag to pan, but only when zoomed in — otherwise there's nothing to pan to
  // and dragging would just feel broken.
  const onPanStart = useCallback(
    (e: React.PointerEvent) => {
      if (zoom <= 1) return;
      dragRef.current = { x: e.clientX, y: e.clientY };
    },
    [zoom],
  );

  const onPanMove = useCallback(
    (e: React.PointerEvent) => {
      const start = dragRef.current;
      if (!start || zoom <= 1) return;
      const limit = (zoom - 1) * 50;
      setPan((p) => ({
        x: Math.max(-limit, Math.min(limit, p.x + (e.clientX - start.x) * 0.15)),
        y: Math.max(-limit, Math.min(limit, p.y + (e.clientY - start.y) * 0.15)),
      }));
      dragRef.current = { x: e.clientX, y: e.clientY };
    },
    [zoom],
  );

  const onPanEnd = useCallback(() => {
    dragRef.current = null;
  }, []);


  // Reset per camera so a previous camera's failures never poison the next one.
  useEffect(() => {
    setUseStill(!camera.streamUrl);
    setPlaying(false);
  }, [camera.streamUrl]);

  // Estimated capture time of the frame on screen, and how far behind real
  // time that is. Ticks fast enough to make the "on screen now" cue useful.
  useEffect(() => {
    edgeRef.current = null;
    clipDoneRef.current = false;
    const t = window.setInterval(() => {
      const v = videoRef.current;
      const e = edgeRef.current;
      if (!v || !e || v.readyState < 2) return;
      const fw = e.wall - (e.media - v.currentTime) * 1000;
      setFrameWall(fw);
      setLagMs(Date.now() - fw);
    }, 250);
    return () => window.clearInterval(t);
  }, [camera.streamUrl]);

  // Record the stretch of video around your pass, so you can watch yourself
  // properly once you've parked. The live window is only ~15s, so without a
  // recording the moment is gone for good.
  useEffect(() => {
    const v = videoRef.current as
      | (HTMLVideoElement & { captureStream?: () => MediaStream })
      | null;
    if (!pass || frameWall == null || !v || !onClip || clipDoneRef.current) return;
    const rec = recorderRef.current;
    if (!rec && frameWall > pass.at - 6000 && frameWall < pass.at + 2000) {
      if (!v.captureStream || typeof MediaRecorder === "undefined") return;
      try {
        const chunks: Blob[] = [];
        const r = new MediaRecorder(v.captureStream());
        r.ondataavailable = (ev) => {
          if (ev.data.size) chunks.push(ev.data);
        };
        r.onstop = () => {
          if (chunks.length) onClip(URL.createObjectURL(new Blob(chunks, { type: r.mimeType })));
        };
        r.start(1000);
        recorderRef.current = r;
      } catch {
        clipDoneRef.current = true; // unsupported here; don't retry every tick
      }
    } else if (rec && frameWall > pass.at + 7000) {
      rec.stop();
      recorderRef.current = null;
      clipDoneRef.current = true;
    }
  }, [pass, frameWall, onClip]);

  useEffect(
    () => () => {
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    },
    [],
  );

  /** Seek to a few seconds before your pass, if it's still in the buffer. */
  const replayPass = useCallback(() => {
    const v = videoRef.current;
    const e = edgeRef.current;
    if (!v || !e || !pass) return;
    const target = e.media - (e.wall - pass.at) / 1000 - 3;
    const b = v.buffered;
    if (!b.length || target < b.start(0)) return;
    v.currentTime = target;
    void v.play().catch(() => {});
  }, [pass]);

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
      const sample = () => {
        const sk = video.seekable;
        if (!sk.length) return;
        const edge = sk.end(sk.length - 1);
        if (!edgeRef.current || edge > edgeRef.current.media + 0.5) {
          edgeRef.current = { media: edge, wall: Date.now() - UPSTREAM_DELAY_MS };
        }
      };
      video.addEventListener("progress", sample);
      void video.play().catch(() => {});
      return () => {
        cancelled = true;
        video.removeEventListener("error", giveUp);
        video.removeEventListener("progress", sample);
        video.removeAttribute("src");
        video.load();
      };
    }

    if (!Hls.isSupported()) {
      giveUp();
      return;
    }

    hls = new Hls({
      // Segments run 4-6s, so each one of these is ~5s of latency. 3 put us
      // ~18s behind; 2 lands nearer 10s. Going to 1 (as an earlier version did,
      // with lowLatencyMode on a stream that isn't low-latency HLS) left no
      // buffer at all and stalled within seconds.
      liveSyncDurationCount: 2,
      // Rather than seek when we drift, play slightly fast to catch up. Far
      // gentler than a jump, and it keeps latency from creeping over time.
      maxLiveSyncPlaybackRate: 1.5,
      manifestLoadingMaxRetry: 4,
      levelLoadingMaxRetry: 4,
      fragLoadingMaxRetry: 6,
    });

    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(Hls.Events.LEVEL_LOADED, (_evt, data) => {
      const edge = data.details.edge;
      // Only re-anchor when a new segment shows up; a reload that returns
      // the same playlist says nothing new about time.
      if (!edgeRef.current || edge > edgeRef.current.media + 0.5) {
        edgeRef.current = { media: edge, wall: Date.now() - UPSTREAM_DELAY_MS };
      }
    });
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

    // Latency creeps: a stall, a backgrounded tab, or a slow segment leaves
    // playback sitting further and further behind the live edge, and playing
    // 1.5x only claws back so much. If we fall badly behind, jump forward.
    const catchUp = window.setInterval(() => {
      // Never yank the user back to live while they're inspecting a frame.
      if (cancelled || video.paused || video.seeking) return;
      const b = video.buffered;
      if (!b.length) return;
      const behind = b.end(b.length - 1) - video.currentTime;
      if (behind > 20) {
        // Land a few seconds back from the edge, not on it — seeking to the
        // very end just starves the buffer and stalls again immediately.
        video.currentTime = b.end(b.length - 1) - 5;
      }
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(catchUp);
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

  /**
   * Keyboard shortcuts, for driving the viewer from a laptop.
   *
   * Bound on window rather than the player so they work without clicking the
   * video first — but skipped whenever focus is in a text field, so typing a
   * destination doesn't pause the feed. Space is also swallowed to stop the
   * page scrolling under the player.
   */
  useEffect(() => {
    if (useStill) return;
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable)
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          togglePause();
          break;
        case "ArrowLeft":
        case "j":
          e.preventDefault();
          nudge(-3);
          break;
        case "ArrowRight":
        case "l":
          e.preventDefault();
          goLive();
          break;
        case "z":
          e.preventDefault();
          cycleZoom();
          break;
        case "d":
          e.preventDefault();
          setSetting("dimHeadlights", !dimHeadlights);
          break;
        case "f":
          e.preventDefault();
          toggleFullscreen();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    useStill,
    togglePause,
    nudge,
    goLive,
    cycleZoom,
    toggleFullscreen,
    setSetting,
    dimHeadlights,
  ]);

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
    <div
      className={`live-cam ${zoom > 1 ? "zoomed" : ""} ${
        pass && frameWall != null && Math.abs(frameWall - pass.at) < ON_SCREEN_WINDOW_MS
          ? "on-screen"
          : ""
      }`}
      ref={wrapRef}
      onPointerDown={onPanStart}
      onPointerMove={onPanMove}
      onPointerUp={onPanEnd}
      onPointerCancel={onPanEnd}
    >
      <video
        ref={videoRef}
        muted
        playsInline
        autoPlay
        style={{
          filter: dimHeadlights ? DIM_FILTER : undefined,
          transform: `scale(${zoom}) translate(${pan.x}%, ${pan.y}%)`,
        }}
        onPlaying={() => {
          setPlaying(true);
          setPaused(false);
        }}
        onWaiting={() => setPlaying(false)}
        // Track the element's real state, not just our own clicks. Autoplay can
        // be refused and a backgrounded tab can pause on its own, which
        // previously left the badge reading LIVE over a frozen frame and made
        // the Pause button do the opposite of its label.
        onPause={() => setPaused(true)}
        onPlay={() => setPaused(false)}
        aria-label={camera.name ?? "Live traffic camera"}
      />
      <div className={`live-cam-badge ${paused ? "still" : ""}`}>
        {!paused && <span className="live-dot" aria-hidden="true" />}
        {paused ? "PAUSED" : playing ? "LIVE" : "CONNECTING"}
        {lagMs != null && playing && !paused && (
          <span className="live-cam-lag" title="Estimated delay behind real time">
            ~{Math.round(lagMs / 1000)}s behind
          </span>
        )}
      </div>
      {pass && (
        <PassOverlay
          pass={pass}
          frameWall={frameWall}
          lagMs={lagMs}
          onReplay={replayPass}
          recording={!!recorderRef.current}
        />
      )}

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
          className={`live-cam-btn ${zoom > 1 ? "on" : ""}`}
          onClick={cycleZoom}
          title="Digital zoom — magnifies, does not add detail"
        >
          {zoom}×
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

      {/* Scrubbing the last few seconds is the only real way to study a
          specific car: paused you can look, live it is gone in one frame. */}
      <div className="live-cam-transport">
        <button
          type="button"
          className="live-cam-btn"
          onClick={() => nudge(-3)}
          title="Back 3 seconds"
        >
          ⏴3s
        </button>
        <button
          type="button"
          className="live-cam-btn wide"
          onClick={togglePause}
          title={paused ? "Resume" : "Pause to inspect a frame"}
        >
          {paused ? "▶ Resume" : "⏸ Pause"}
        </button>
        <button
          type="button"
          className="live-cam-btn"
          onClick={goLive}
          title="Jump back to live"
        >
          Live
        </button>
      </div>
    </div>
  );
}

function PassOverlay({
  pass,
  frameWall,
  lagMs,
  onReplay,
  recording,
}: {
  pass: PassInfo;
  frameWall: number | null;
  lagMs: number | null;
  onReplay: () => void;
  recording: boolean;
}) {
  const untilPass = (pass.at - Date.now()) / 1000;
  // Seconds until the frame showing your pass reaches the screen.
  const untilShown = frameWall == null ? null : (pass.at - frameWall) / 1000;
  let text: string;
  let tone = "";
  if (untilShown != null && Math.abs(untilShown) * 1000 < ON_SCREEN_WINDOW_MS) {
    text = "You should be on screen now";
    tone = "now";
  } else if (untilPass > 0) {
    text = `Passing this camera in ${Math.ceil(untilPass)}s${
      lagMs != null ? `, on screen in ~${Math.ceil(untilPass + lagMs / 1000)}s` : ""
    }`;
  } else if (untilShown != null && untilShown > 0) {
    text = `You passed. You'll appear in ~${Math.ceil(untilShown)}s`;
    tone = "soon";
  } else {
    text = "Your pass has played";
  }
  const past = untilShown != null && untilShown < -ON_SCREEN_WINDOW_MS / 1000;
  return (
    <div className={`pass-overlay ${tone}`} role="status">
      <div className="pass-text">
        {recording && <span className="rec-dot" aria-label="Recording" />}
        {text}
      </div>
      {pass.hint && <div className="pass-hint">{pass.hint}</div>}
      {past && (
        <button type="button" className="live-cam-btn" onClick={onReplay}>
          Replay my pass
        </button>
      )}
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
