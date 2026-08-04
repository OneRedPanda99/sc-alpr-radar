"""Police-vehicle watcher.

Pulls N SCDOT camera streams continuously, detects and tracks vehicles, scores
each track for "is this a patrol vehicle", and writes the hits to JSON for the
map to read.

    python watch.py               # run the watcher
    python watch.py --cameras 10  # fewer streams
    python watch.py --probe       # one frame per camera, then exit

Deliberately *not* all 767 cameras: that would be 218 Mbps and ~2.3 TB/day, and
an unreasonable sustained load on a public DOT service. See config.MAX_CAMERAS.
"""

from __future__ import annotations

import argparse
import json
import signal
import time
from collections import deque

import cv2
import numpy as np
import torch

import config
from detect import PoliceAppearance, Track, VehicleDetector, strobe_score
from streams import StreamReader, load_cameras


def pick_device() -> str:
    return "cuda" if torch.cuda.is_available() else "cpu"


class Watcher:
    def __init__(self, camera_limit: int, save_crops: bool, load_appearance: bool = True):
        self.device = pick_device()
        print(f"device: {self.device}")
        if self.device == "cuda":
            print(f"gpu:    {torch.cuda.get_device_name(0)}")

        self.cameras = load_cameras(camera_limit)
        print(f"watching {len(self.cameras)} cameras "
              f"(~{len(self.cameras) * 284 / 1000:.1f} Mbps)")

        self.readers = {c.id: StreamReader(c) for c in self.cameras}

        print("loading detector ...", flush=True)
        self.detector = VehicleDetector(self.device)

        # Skipped for --probe: the probe only needs detection, and pulling a
        # ~600 MB CLIP checkpoint just to count vehicles makes the first run
        # look like it has hung.
        self.appearance = None
        if load_appearance:
            print(
                "loading CLIP (first run downloads ~600 MB, be patient) ...",
                flush=True,
            )
            self.appearance = PoliceAppearance(self.device)

        self.save_crops = save_crops

        # (camera_id, track_id) -> Track
        self.tracks: dict[tuple[str, int], Track] = {}
        # Confirmed hits, keyed the same way, aged out by DETECTION_TTL_S.
        self.hits: dict[str, dict] = {}
        self.running = True

        config.OUT_DIR.mkdir(parents=True, exist_ok=True)
        if save_crops:
            config.CROP_DIR.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------ run --

    def start(self) -> None:
        print("connecting streams ...", flush=True)
        for r in self.readers.values():
            r.start()
        # Streams need a moment to negotiate before any frame exists.
        time.sleep(6)

    def stop(self, *_a) -> None:
        self.running = False
        for r in self.readers.values():
            r.stop()

    def loop(self) -> None:
        last_report = 0.0
        while self.running:
            t0 = time.time()
            pending: list[tuple[Track, np.ndarray]] = []

            for cam in self.cameras:
                frame = self.readers[cam.id].latest()
                if frame is None:
                    continue
                pending.extend(self._process_frame(cam, frame))

            self._score_appearance(pending)
            self._publish()

            if time.time() - last_report > 30:
                last_report = time.time()
                self._report()

            # Pace the sweep so we sample near SAMPLE_FPS without spinning.
            elapsed = time.time() - t0
            time.sleep(max(0.0, (1.0 / config.SAMPLE_FPS) - elapsed))

    # ------------------------------------------------------------ per frame --

    def _process_frame(self, cam, frame) -> list[tuple[Track, np.ndarray]]:
        now = time.time()
        needs_appearance: list[tuple[Track, np.ndarray]] = []

        for tid, cls_name, box in self.detector.detect(frame, cam.id):
            x1, y1, x2, y2 = box
            key = (cam.id, tid)
            track = self.tracks.get(key)
            if track is None:
                track = Track(
                    track_id=tid,
                    camera_id=cam.id,
                    cls_name=cls_name,
                    box=box,
                    first_seen=now,
                    last_seen=now,
                )
                self.tracks[key] = track

            track.box = box
            track.last_seen = now
            track.centroids.append((now, (x1 + x2) / 2, (y1 + y2) / 2))

            crop = frame[max(0, y1):y2, max(0, x1):x2]
            if crop.size == 0:
                continue
            track.crops.append(crop)
            track.strobe = strobe_score(track.crops)

            # Only classify appearance once a vehicle is close enough to have
            # the pixels for it. Detection works far out; classification doesn't.
            if track.box_w >= config.MIN_BOX_W:
                if track.best_crop is None or crop.shape[1] > track.best_crop.shape[1]:
                    track.best_crop = crop
                needs_appearance.append((track, crop))

        return needs_appearance

    def _score_appearance(self, pending) -> None:
        """One batched CLIP pass per sweep, rather than per track."""
        if not pending or self.appearance is None:
            return
        # Cap the batch so a busy sweep can't stall the loop.
        pending = pending[:64]
        scores = self.appearance.score_batch([c for _, c in pending])
        for (track, _), score in zip(pending, scores):
            # Keep the strongest look at this vehicle; a single bad frame
            # (occluded, motion-blurred) shouldn't erase a confident read.
            track.appearance = max(track.appearance, score)

    # -------------------------------------------------------------- publish --

    def _publish(self) -> None:
        now = time.time()
        cam_by_id = {c.id: c for c in self.cameras}

        for (cam_id, tid), track in list(self.tracks.items()):
            if now - track.last_seen > 20:
                del self.tracks[(cam_id, tid)]
                continue
            if track.police_score < config.POLICE_THRESHOLD:
                continue

            cam = cam_by_id.get(cam_id)
            if not cam:
                continue

            vx, vy = track.pixel_velocity()
            hit_id = f"{cam_id}#{tid}"
            prior = self.hits.get(hit_id, {})
            self.hits[hit_id] = {
                "id": hit_id,
                "cameraId": cam_id,
                "cameraName": cam.name,
                "lat": cam.lat,
                "lon": cam.lon,
                "score": round(track.police_score, 3),
                "appearance": round(track.appearance, 3),
                "strobe": round(track.strobe, 3),
                "lightsOn": track.strobe >= 0.6,
                "vehicle": track.cls_name,
                "pixelVelocity": [round(vx, 1), round(vy, 1)],
                "firstSeen": prior.get(
                    "firstSeen", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(track.first_seen))
                ),
                "lastSeen": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(track.last_seen)),
            }

            if self.save_crops and track.best_crop is not None:
                # Harvest for training a sharper classifier later.
                path = config.CROP_DIR / f"{cam_id.replace('/', '_')}_{tid}.jpg"
                if not path.exists():
                    cv2.imwrite(str(path), track.best_crop)

        # Age out hits so one car doesn't leave a permanent dot.
        cutoff = time.time() - config.DETECTION_TTL_S
        for hid, hit in list(self.hits.items()):
            seen = time.mktime(time.strptime(hit["lastSeen"], "%Y-%m-%dT%H:%M:%SZ"))
            if seen - time.timezone < cutoff:
                del self.hits[hid]

        payload = {
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "cameras": len(self.cameras),
            "count": len(self.hits),
            "detections": sorted(
                self.hits.values(), key=lambda h: h["score"], reverse=True
            ),
        }
        tmp = config.DETECTIONS_JSON.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, indent=1), encoding="utf-8")
        tmp.replace(config.DETECTIONS_JSON)  # atomic; readers never see a partial file

    def _report(self) -> None:
        live = sum(1 for r in self.readers.values() if r.latest() is not None)
        restarts = sum(r.restarts for r in self.readers.values())
        print(
            f"[{time.strftime('%H:%M:%S')}] streams {live}/{len(self.readers)} "
            f"| tracks {len(self.tracks)} | hits {len(self.hits)} "
            f"| restarts {restarts}"
        )

    # ---------------------------------------------------------------- probe --

    def probe(self) -> None:
        """Sanity check: one frame per camera, report what came back."""
        ok = 0
        for cam in self.cameras:
            frame = self.readers[cam.id].latest()
            if frame is None:
                print(f"  ✗ {cam.name}")
                continue
            ok += 1
            vehicles = list(self.detector.detect(frame, cam.id))
            big = [v for v in vehicles if v[2][2] - v[2][0] >= config.MIN_BOX_W]
            # Mean luminance separates a genuinely empty road from a black or
            # placeholder frame, which otherwise both report zero vehicles.
            bright = float(frame.mean())
            flag = "  [dark frame — check the feed]" if bright < 18 else ""
            print(
                f"  ✓ {cam.name}: {len(vehicles)} vehicles "
                f"({len(big)} classifiable, brightness {bright:.0f}){flag}"
            )
        print(f"\n{ok}/{len(self.cameras)} streams delivered a frame")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cameras", type=int, default=config.MAX_CAMERAS)
    ap.add_argument("--probe", action="store_true", help="one frame per camera, then exit")
    ap.add_argument("--no-crops", action="store_true", help="don't save training crops")
    args = ap.parse_args()

    w = Watcher(
        args.cameras,
        save_crops=not args.no_crops,
        load_appearance=not args.probe,
    )
    signal.signal(signal.SIGINT, w.stop)
    w.start()

    if args.probe:
        w.probe()
        w.stop()
        return

    print("watching — ctrl-c to stop")
    try:
        w.loop()
    finally:
        w.stop()


if __name__ == "__main__":
    main()
