import { useCallback, useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import type { Camera } from "@/types";
import { useSettingsStore } from "@/store/settingsStore";
import {
  addMark,
  clearMarks,
  marksFor,
  offsetFor,
  placeOnFrame,
  setOffset,
  type CalibMark,
} from "@/services/camCalib";

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
/** How far the picture zooms in when it locks onto your car. */
const LOCK_ZOOM = 2.5;
/** One tap of "car's ahead / behind" moves the timing this much. */
const NUDGE_MS = 500;

/** How close (in estimated frame time) counts as "you're on screen now". */
const ON_SCREEN_WINDOW_MS = 3500;

export interface PassInfo {
  /** Wall-clock ms of your closest approach to this camera. */
  at: number;
  /** True once it actually happened (not just predicted from speed). */
  actual: boolean;
  /** Where in the picture to look, e.g. "coming toward the camera". */
  hint?: string;
  /** How far you were from the camera at a given wall-clock time. */
  distanceAt?: (t: number) => number | null;
}

export function LiveCameraVideo({
  camera,
  onError,
  fullscreenTarget,
  pass,
  onClip,
  onLag,
  onHold,
}: {
  camera: Camera;
  onError?: () => void;
  /** Element to put fullscreen; defaults to the player itself. */
  fullscreenTarget?: React.RefObject<HTMLElement>;
  /** Your pass by this camera, to time the "you're on screen" cue. */
  pass?: PassInfo | null;
  /** Receives a recorded clip (blob URL) of the moment you pass. */
  onClip?: (blob: Blob, mime: string) => void;
  /** Receives the measured delay behind real time, for scheduling other feeds. */
  onLag?: (ms: number) => void;
  /** You paused, stepped back or started marking: keep this camera on screen. */
  onHold?: () => void;
}) {
  const onLagRef = useRef(onLag);
  onLagRef.current = onLag;
  const onHoldRef = useRef(onHold);
  onHoldRef.current = onHold;
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
  /** Your taps on this camera's picture, for placing the car dot. */
  const [marks, setMarks] = useState<CalibMark[]>(() => marksFor(camera.id));
  const [marking, setMarking] = useState(false);
  const [markNote, setMarkNote] = useState<string | null>(null);
  /** Per-camera timing correction, and whether lock-on is wanted / happening. */
  const [offsetMs, setOffsetMs] = useState(() => offsetFor(camera.id));
  const [lockOn, setLockOn] = useState(true);
  const [engaged, setEngaged] = useState(false);
  useEffect(() => {
    setMarks(marksFor(camera.id));
    setOffsetMs(offsetFor(camera.id));
    setMarking(false);
    setMarkNote(null);
  }, [camera.id]);

  // The per-frame loop reads these without re-subscribing every render.
  const passRef = useRef(pass);
  passRef.current = pass;
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const offsetRef = useRef(offsetMs);
  offsetRef.current = offsetMs;
  const lockOnRef = useRef(lockOn);
  lockOnRef.current = lockOn;
  const markingRef = useRef(marking);
  markingRef.current = marking;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const engagedRef = useRef(false);
  const dotRef = useRef<HTMLSpanElement>(null);

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
      onHoldRef.current?.();
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
    onHoldRef.current?.();
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
      onLagRef.current?.(Date.now() - fw);
    }, 250);
    return () => window.clearInterval(t);
  }, [camera.streamUrl]);

  // Record the stretch of video around your pass, so you can watch yourself
  // properly once you've parked. The live window is only ~15s, so without a
  // recording the moment is gone for good.
  useEffect(() => {
    const v = videoRef.current;
    if (!pass || frameWall == null || !v || !onClip || clipDoneRef.current) return;
    const rec = recorderRef.current;
    if (!rec && frameWall > pass.at - 6000 && frameWall < pass.at + 2000) {
      const capture = captureVideo(v);
      if (!capture || typeof MediaRecorder === "undefined") {
        clipDoneRef.current = true;
        return;
      }
      try {
        const chunks: Blob[] = [];
        // Safari records MP4; Chrome (and the Tesla browser) record WebM.
        const mime = MediaRecorder.isTypeSupported?.("video/mp4") ? "video/mp4" : "";
        const r = new MediaRecorder(capture.stream, mime ? { mimeType: mime } : undefined);
        r.ondataavailable = (ev) => {
          if (ev.data.size) chunks.push(ev.data);
        };
        r.onstop = () => {
          capture.stop();
          const type = r.mimeType || mime || "video/webm";
          if (chunks.length) onClip(new Blob(chunks, { type }), type);
        };
        r.start(1000);
        recorderRef.current = r;
      } catch {
        capture.stop();
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

  /**
   * Lock-on: every display frame, work out where your car is in the frame on
   * screen (from the frame's estimated capture time, your GPS track at that
   * moment and your marks on this camera), then zoom in and pan so it stays
   * centred, and place the "You" dot. Runs on requestAnimationFrame and
   * writes styles directly, so it moves smoothly at your real speed instead
   * of stepping 4 times a second through React.
   */
  useEffect(() => {
    if (useStill) return;
    const st = { z: 1, cx: 0.5, cy: 0.5, tx: 0, ty: 0, active: false };
    let raf = 0;
    let lastFrame = 0;
    const step = () => {
      const v = videoRef.current;
      const el = wrapRef.current;
      const dot = dotRef.current;
      const e = edgeRef.current;
      const p = passRef.current;
      if (!v || !el || !dot) return;

      let target: { u: number; v: number } | null = null;
      if (p?.distanceAt && e && v.readyState >= 2 && v.videoWidth && marksRef.current.length >= 2) {
        const fw = e.wall - (e.media - v.currentTime) * 1000 + offsetRef.current;
        const d = p.distanceAt(fw);
        const pos = d == null ? null : placeOnFrame(marksRef.current, fw < p.at ? -d : d);
        if (pos) {
          const r = el.getBoundingClientRect();
          const k = Math.max(r.width / v.videoWidth, r.height / v.videoHeight);
          const w = v.videoWidth * k;
          const h = v.videoHeight * k;
          target = {
            u: ((r.width - w) / 2 + pos.x * w) / r.width,
            v: ((r.height - h) / 2 + pos.y * h) / r.height,
          };
        }
      }

      const locking = !!target && lockOnRef.current && !markingRef.current;
      if (locking || st.active) {
        // Ease in and out, and follow with a little lag so GPS jitter
        // doesn't shake the picture.
        st.z += ((locking ? LOCK_ZOOM : 1) - st.z) * 0.12;
        const tu = target?.u ?? 0.5;
        const tv = target?.v ?? 0.5;
        st.cx += (tu - st.cx) * 0.3;
        st.cy += (tv - st.cy) * 0.3;
        const lim = 0.5 - 0.5 / st.z;
        st.tx = Math.max(-lim, Math.min(lim, 0.5 - st.cx));
        st.ty = Math.max(-lim, Math.min(lim, 0.5 - st.cy));
        if (!locking && Math.abs(st.z - 1) < 0.01) {
          st.active = false;
          st.z = 1;
          st.tx = st.ty = 0;
          v.style.transform = "";
        } else {
          st.active = true;
          v.style.transform = `scale(${st.z}) translate(${st.tx * 100}%, ${st.ty * 100}%)`;
        }
        if (st.active !== engagedRef.current) {
          engagedRef.current = st.active;
          setEngaged(st.active);
        }
      }

      // The dot sits on the same spot, through whatever zoom is applied.
      const manualZoom = !st.active && zoomRef.current !== 1;
      if (target && !manualZoom && !markingRef.current) {
        const r = el.getBoundingClientRect();
        const z = st.active ? st.z : 1;
        const x = 0.5 + z * (target.u + st.tx - 0.5);
        const y = 0.5 + z * (target.v + st.ty - 0.5);
        dot.style.display = x >= 0 && x <= 1 && y >= 0 && y <= 1 ? "block" : "none";
        dot.style.left = `${x * r.width}px`;
        dot.style.top = `${y * r.height}px`;
      } else {
        dot.style.display = "none";
      }
    };
    const loop = () => {
      raf = requestAnimationFrame(loop);
      lastFrame = performance.now();
      step();
    };
    raf = requestAnimationFrame(loop);
    // Some browsers stall animation frames (a backgrounded window, a busy car
    // browser); keep following at ~10 fps rather than freezing.
    const backup = window.setInterval(() => {
      if (performance.now() - lastFrame > 150) step();
    }, 100);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(backup);
      engagedRef.current = false;
    };
  }, [useStill, camera.streamUrl]);

  if (useStill) {
    return (
      <LiveCameraStill
        camera={camera}
        onError={onError}
        onFullscreen={toggleFullscreen}
      />
    );
  }

  /** Metres along the road at time t: negative before the camera, positive after. */
  const signedAt = (t: number | null): number | null => {
    if (t == null || !pass?.distanceAt) return null;
    const d = pass.distanceAt(t);
    return d == null ? null : t < pass.at ? -d : d;
  };

  /** The picture's box inside the player (object-fit: cover crops it). */
  const frameBox = () => {
    const v = videoRef.current;
    const el = wrapRef.current;
    if (!v || !el || !v.videoWidth) return null;
    const r = el.getBoundingClientRect();
    const scale = Math.max(r.width / v.videoWidth, r.height / v.videoHeight);
    const w = v.videoWidth * scale;
    const h = v.videoHeight * scale;
    return { r, w, h, ox: (r.width - w) / 2, oy: (r.height - h) / 2 };
  };

  const startMarking = () => {
    // A frame has to hold still to tap the car in it; zoom would skew the spot.
    setZoom(1);
    setPan({ x: 0, y: 0 });
    videoRef.current?.pause();
    setPaused(true);
    onHold?.();
    setMarkNote(null);
    setMarking(true);
  };

  const onMarkTap = (e: React.MouseEvent) => {
    // Taps on the player's own buttons aren't taps on the car.
    if (!marking || (e.target as HTMLElement).closest("button")) return;
    const box = frameBox();
    const s = signedAt(frameWall);
    if (!box) return;
    if (s == null || Math.abs(s) > 1500) {
      setMarkNote("This frame is from before or after your drive was tracked. Step to your pass first.");
      setMarking(false);
      return;
    }
    const x = (e.clientX - box.r.left - box.ox) / box.w;
    const y = (e.clientY - box.r.top - box.oy) / box.h;
    const next = addMark(camera.id, { x, y, s });
    setMarks(next);
    setMarking(false);
    setMarkNote(
      next.length < 2
        ? "Got it. Mark your car once more in a frame further along your pass to switch on the dot."
        : `${next.length} marks saved. The dot will follow you on this camera.`,
    );
  };

  const nudgeTiming = (ms: number) => {
    const next = offsetMs + ms;
    setOffsetMs(next);
    setOffset(camera.id, next);
  };

  // Over the picture it hides the very car you're looking for, so it sits
  // under the video, except in fullscreen where there is no "under".
  const overlay = pass && (
    <PassOverlay
      pass={pass}
      frameWall={frameWall}
      lagMs={lagMs}
      onReplay={replayPass}
      recording={!!recorderRef.current}
      below={!isFull}
      marks={marks.length}
      marking={marking}
      markNote={markNote}
      canMark={!!pass.distanceAt}
      onMark={startMarking}
      onCancelMark={() => setMarking(false)}
      onClearMarks={() => {
        clearMarks(camera.id);
        setMarks([]);
        setOffsetMs(0);
        setMarkNote("Marks cleared for this camera.");
      }}
      lockOn={lockOn}
      engaged={engaged}
      offsetMs={offsetMs}
      onToggleLock={() => setLockOn((v) => !v)}
      onNudge={nudgeTiming}
    />
  );

  return (
    <>
      <div
        className={`live-cam ${zoom > 1 ? "zoomed" : ""} ${marking ? "marking" : ""} ${
          pass && frameWall != null && Math.abs(frameWall - pass.at) < ON_SCREEN_WINDOW_MS
            ? "on-screen"
            : ""
        }`}
        ref={wrapRef}
        onClick={onMarkTap}
        onPointerDown={onPanStart}
        onPointerMove={onPanMove}
        onPointerUp={onPanEnd}
        onPointerCancel={onPanEnd}
      >
        <video
          ref={videoRef}
          // Lets Safari's canvas recorder read the frames (the streams allow it).
          crossOrigin="anonymous"
          muted
          playsInline
          autoPlay
          style={{
            filter: dimHeadlights ? DIM_FILTER : undefined,
            // While locked on, the per-frame loop owns the transform.
            transform: engaged ? undefined : `scale(${zoom}) translate(${pan.x}%, ${pan.y}%)`,
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
              {Math.round(lagMs / 1000)}s delay
            </span>
          )}
        </div>
        <span
          ref={dotRef}
          className="car-dot"
          style={{ display: "none" }}
          title="Where your car should be in this frame (estimated from your marks)"
        >
          <span className="car-dot-label">You</span>
        </span>
        {engaged && <div className="lock-badge">Locked on</div>}
        {marking && <div className="mark-prompt">Tap your car in the picture</div>}
        {isFull && overlay}

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
      {!isFull && overlay}
    </>
  );
}

function PassOverlay({
  pass,
  frameWall,
  lagMs,
  onReplay,
  recording,
  below,
  marks,
  marking,
  markNote,
  canMark,
  onMark,
  onCancelMark,
  onClearMarks,
  lockOn,
  engaged,
  offsetMs,
  onToggleLock,
  onNudge,
}: {
  pass: PassInfo;
  frameWall: number | null;
  lagMs: number | null;
  onReplay: () => void;
  recording: boolean;
  below: boolean;
  marks: number;
  marking: boolean;
  markNote: string | null;
  canMark: boolean;
  onMark: () => void;
  onCancelMark: () => void;
  onClearMarks: () => void;
  lockOn: boolean;
  engaged: boolean;
  offsetMs: number;
  onToggleLock: () => void;
  onNudge: (ms: number) => void;
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
  // Where you were at the moment this frame was shot: the honest version of
  // "where's my car in the picture", since the cameras' aim isn't known.
  const frameD = frameWall != null ? pass.distanceAt?.(frameWall) ?? null : null;
  const before = frameWall != null && frameWall < pass.at;
  const signed = frameD == null ? null : before ? -frameD : frameD;
  const STRIP_M = 500;
  return (
    <div className={`pass-overlay ${tone} ${below ? "below" : ""}`} role="status">
      <div className="pass-text">
        {recording && <span className="rec-dot" aria-label="Recording" />}
        {text}
      </div>
      {pass.hint && <div className="pass-hint">{pass.hint}</div>}
      {signed != null && Math.abs(signed) < 2000 && (
        <div className="pass-where">
          <span className="pass-where-text">
            In this frame you're{" "}
            {Math.abs(signed) < 40
              ? "at the camera"
              : `${Math.round(Math.abs(signed) / 10) * 10} m ${signed < 0 ? "before" : "past"} it`}
          </span>
          <span className="pass-strip" aria-hidden="true">
            <span className="pass-strip-cam" />
            <span
              className="pass-strip-car"
              style={{
                left: `${50 + 50 * Math.max(-1, Math.min(1, signed / STRIP_M))}%`,
              }}
            />
          </span>
        </div>
      )}
      <div className="pass-actions">
        {past && (
          <button type="button" className="live-cam-btn" onClick={onReplay}>
            Replay my pass
          </button>
        )}
        {canMark &&
          (marking ? (
            <button type="button" className="live-cam-btn" onClick={onCancelMark}>
              Cancel marking
            </button>
          ) : (
            <button
              type="button"
              className="live-cam-btn"
              onClick={onMark}
              title="Pause on a frame where you can see your car, then tap it. Two marks switch on the dot."
            >
              Mark my car
            </button>
          ))}
        {marks >= 2 && !marking && (
          <button
            type="button"
            className={`live-cam-btn ${lockOn ? "on" : ""}`}
            aria-pressed={lockOn}
            onClick={onToggleLock}
            title="Zoom in and follow your car when it's in the picture"
          >
            Lock-on {lockOn ? "on" : "off"}
          </button>
        )}
        {marks > 0 && !marking && (
          <button type="button" className="live-cam-btn" onClick={onClearMarks}>
            Clear {marks} mark{marks === 1 ? "" : "s"}
          </button>
        )}
      </div>
      {engaged && (
        <div className="pass-actions">
          <button
            type="button"
            className="live-cam-btn"
            onClick={() => onNudge(-NUDGE_MS)}
            title="Your car is behind where the lock is: move the timing earlier"
          >
            Car's behind
          </button>
          <button
            type="button"
            className="live-cam-btn"
            onClick={() => onNudge(NUDGE_MS)}
            title="Your car is ahead of where the lock is: move the timing later"
          >
            Car's ahead
          </button>
          {offsetMs !== 0 && (
            <span className="pass-hint">
              Timing {offsetMs > 0 ? "+" : ""}
              {(offsetMs / 1000).toFixed(1)}s for this camera
            </span>
          )}
        </div>
      )}
      {markNote && <div className="pass-hint">{markNote}</div>}
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

/**
 * A recordable stream of what the player shows. Chrome (and the Tesla
 * browser) can capture the video element directly; Safari can't, so there
 * the frames are copied onto a canvas and the canvas is recorded instead.
 */
function captureVideo(v: HTMLVideoElement): { stream: MediaStream; stop: () => void } | null {
  const direct = v as HTMLVideoElement & { captureStream?: () => MediaStream };
  if (typeof direct.captureStream === "function") {
    return { stream: direct.captureStream(), stop: () => {} };
  }
  const canvas = document.createElement("canvas") as HTMLCanvasElement & {
    captureStream?: (fps?: number) => MediaStream;
  };
  if (typeof canvas.captureStream !== "function" || !v.videoWidth) return null;
  const scale = Math.min(1, 1280 / v.videoWidth);
  canvas.width = Math.round(v.videoWidth * scale);
  canvas.height = Math.round(v.videoHeight * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  let raf = 0;
  const draw = () => {
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    raf = requestAnimationFrame(draw);
  };
  draw();
  return { stream: canvas.captureStream(25), stop: () => cancelAnimationFrame(raf) };
}
