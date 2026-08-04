"""HLS ingest.

One ffmpeg subprocess per camera, decoding straight to raw BGR frames on
stdout. OpenCV's VideoCapture can read HLS too, but it buffers aggressively and
reconnects badly on a stream that drops several times an hour, which these do.
Driving ffmpeg directly makes the reconnect behaviour explicit.
"""

from __future__ import annotations

import json
import math
import subprocess
import threading
from dataclasses import dataclass, field

import numpy as np

import config


@dataclass
class CameraInfo:
    id: str
    name: str
    lat: float
    lon: float
    stream_url: str
    distance_mi: float = 0.0


def _haversine_mi(a_lat, a_lon, b_lat, b_lon) -> float:
    r = 3958.8
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp = math.radians(b_lat - a_lat)
    dl = math.radians(b_lon - a_lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def load_cameras(limit: int | None = None) -> list[CameraInfo]:
    """Nearest SCDOT cameras that actually publish a stream."""
    limit = limit or config.MAX_CAMERAS
    pack = json.loads(config.CAMERA_PACK.read_text(encoding="utf-8"))
    out: list[CameraInfo] = []
    for f in pack.get("features", []):
        p = f.get("properties", {})
        if not str(p.get("id", "")).startswith("sc511/"):
            continue
        url = p.get("streamUrl")
        if not url:
            continue
        lon, lat = f["geometry"]["coordinates"]
        out.append(
            CameraInfo(
                id=p["id"],
                name=p.get("name") or p["id"],
                lat=lat,
                lon=lon,
                stream_url=url,
                distance_mi=_haversine_mi(config.HOME_LAT, config.HOME_LON, lat, lon),
            )
        )
    out.sort(key=lambda c: c.distance_mi)
    return out[:limit]


@dataclass
class StreamReader:
    """Latest frame from one camera, decoded in a background thread.

    Only the most recent frame is kept. Falling behind on a live camera is
    pointless — a queued frame from 20s ago tells you nothing about where a car
    is now — so the reader always drops rather than buffers.
    """

    camera: CameraInfo
    _frame: np.ndarray | None = field(default=None, init=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False)
    _stop: threading.Event = field(default_factory=threading.Event, init=False)
    _thread: threading.Thread | None = field(default=None, init=False)
    frames_read: int = field(default=0, init=False)
    restarts: int = field(default=0, init=False)

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def latest(self) -> np.ndarray | None:
        with self._lock:
            return None if self._frame is None else self._frame.copy()

    def _spawn(self) -> subprocess.Popen:
        cmd = [
            "ffmpeg",
            "-nostdin",
            "-loglevel", "error",
            # Reconnect rather than exit when the CDN drops a segment.
            "-reconnect", "1",
            "-reconnect_streamed", "1",
            "-reconnect_delay_max", "5",
            "-i", self.camera.stream_url,
            # Sample down; we don't need every frame of a 4-6s segment.
            "-vf", f"fps={config.SAMPLE_FPS},scale={config.FRAME_W}:{config.FRAME_H}",
            "-f", "rawvideo",
            "-pix_fmt", "bgr24",
            "-",
        ]
        return subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=10**8,
        )

    def _run(self) -> None:
        frame_bytes = config.FRAME_W * config.FRAME_H * 3
        while not self._stop.is_set():
            proc = self._spawn()
            try:
                while not self._stop.is_set():
                    buf = proc.stdout.read(frame_bytes)
                    if not buf or len(buf) < frame_bytes:
                        break  # stream ended or stalled; respawn
                    frame = np.frombuffer(buf, np.uint8).reshape(
                        config.FRAME_H, config.FRAME_W, 3
                    )
                    with self._lock:
                        self._frame = frame
                    self.frames_read += 1
            finally:
                proc.kill()
                proc.wait(timeout=5)
            if not self._stop.is_set():
                self.restarts += 1
                self._stop.wait(3)
