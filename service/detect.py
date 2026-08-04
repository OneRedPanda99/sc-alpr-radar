"""Vehicle detection and police scoring.

Two independent signals, combined:

1. **Appearance** (CLIP, zero-shot). Catches a marked cruiser driving normally
   with its lights off, which is the common case and the whole reason this
   isn't just a strobe detector. Zero-shot means it works before any training
   data exists; the crops it saves can train something sharper later.

2. **Strobe** (temporal). Emergency lights are a *timing* signature — periodic
   saturated red/blue — not a shape. That survives 720x480 and heavy
   compression far better than appearance does, so it stays reliable exactly
   where CLIP gets shaky. Only fires when lights are actually on.

Neither is trustworthy on its own at this resolution, which is why the score is
a max of the two rather than an average: a confident strobe shouldn't be
diluted by a mediocre appearance score, or vice versa.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

import numpy as np
import torch

import config


# --------------------------------------------------------------- appearance --


class PoliceAppearance:
    """CLIP zero-shot 'does this crop look like a patrol vehicle'."""

    def __init__(self, device: str):
        import open_clip

        self.device = device
        self.model, _, self.preprocess = open_clip.create_model_and_transforms(
            config.CLIP_MODEL, pretrained=config.CLIP_PRETRAINED, device=device
        )
        self.model.eval()
        tokenizer = open_clip.get_tokenizer(config.CLIP_MODEL)

        prompts = config.POLICE_PROMPTS + config.CIVILIAN_PROMPTS
        self.n_police = len(config.POLICE_PROMPTS)
        with torch.no_grad():
            tokens = tokenizer(prompts).to(device)
            feats = self.model.encode_text(tokens)
            self.text_feats = feats / feats.norm(dim=-1, keepdim=True)

    @torch.no_grad()
    def score_batch(self, crops: list[np.ndarray]) -> list[float]:
        """Police-likeness per crop, 0-1. Crops are BGR, as ffmpeg gives them.

        Scored as the *margin* between the best police prompt and the best
        civilian one, squashed through a sigmoid — not a softmax at CLIP's
        standard 100x logit scale.

        That scale assumes well-separated classes. Here every prompt describes
        some kind of road vehicle, so their embeddings sit very close together
        and a 100x multiplier turns hundredth-of-a-point differences into 0.00
        or 1.00. Measured live, that produced a p90 of 0.95+ — around a tenth of
        all passing traffic reading as a patrol car — with the median flipping
        between 0.97 and 0.01 report to report. That's saturation noise, not
        classification.
        """
        if not crops:
            return []
        from PIL import Image

        batch = torch.stack(
            [
                self.preprocess(Image.fromarray(c[:, :, ::-1]))  # BGR -> RGB
                for c in crops
            ]
        ).to(self.device)

        feats = self.model.encode_image(batch)
        feats = feats / feats.norm(dim=-1, keepdim=True)

        sims = feats @ self.text_feats.T          # cosine, roughly -1..1
        police = sims[:, : self.n_police].max(dim=-1).values
        civilian = sims[:, self.n_police :].max(dim=-1).values

        # Cosine margins between near-identical prompts land around ±0.05, so
        # the gain has to be large enough to spread that across a usable range
        # without pinning everything to the ends.
        margin = police - civilian
        return torch.sigmoid(margin * config.SCORE_GAIN).tolist()


# ------------------------------------------------------------------ strobe --


def strobe_score(history: deque[np.ndarray]) -> float:
    """How strongly a crop sequence looks like flashing emergency lights.

    Looks for saturated red and blue pixels whose *coverage varies over time*.
    A car with red tail lights has a steady red fraction; a light bar makes that
    fraction swing hard between frames. Variation is the signal, not colour.
    """
    if len(history) < 6:
        return 0.0

    reds: list[float] = []
    blues: list[float] = []
    for crop in history:
        if crop.size == 0:
            continue
        b = crop[:, :, 0].astype(np.int16)
        g = crop[:, :, 1].astype(np.int16)
        r = crop[:, :, 2].astype(np.int16)
        n = crop.shape[0] * crop.shape[1]
        # Dominant-and-bright, so ordinary paint doesn't register.
        reds.append(float(np.count_nonzero((r > 140) & (r - g > 55) & (r - b > 45))) / n)
        blues.append(float(np.count_nonzero((b > 140) & (b - g > 45) & (b - r > 55))) / n)

    if len(reds) < 6:
        return 0.0

    def swing(vals: list[float]) -> float:
        arr = np.array(vals)
        if arr.max() < 0.004:  # never enough coloured pixels to matter
            return 0.0
        # Normalised spread: a steady light scores ~0, a strobe approaches 1.
        return float(min(1.0, (arr.max() - arr.min()) / (arr.max() + 1e-6)))

    r_sw, b_sw = swing(reds), swing(blues)
    both = min(r_sw, b_sw)
    # Alternating red *and* blue is the strongest tell; a single colour still
    # counts but is discounted, since brake lights alone can swing red.
    return float(min(1.0, max(both * 1.15, max(r_sw, b_sw) * 0.7)))


# ------------------------------------------------------------------ tracks ---


@dataclass
class Track:
    """One vehicle followed across frames on a single camera."""

    track_id: int
    camera_id: str
    cls_name: str
    box: tuple[int, int, int, int]
    first_seen: float
    last_seen: float
    centroids: deque = field(default_factory=lambda: deque(maxlen=30))
    crops: deque = field(default_factory=lambda: deque(maxlen=12))
    appearance: float = 0.0
    strobe: float = 0.0
    best_crop: np.ndarray | None = None

    @property
    def police_score(self) -> float:
        return max(self.appearance, self.strobe)

    @property
    def box_w(self) -> int:
        return self.box[2] - self.box[0]

    def pixel_velocity(self) -> tuple[float, float]:
        """Mean per-second pixel motion across the tracked path."""
        if len(self.centroids) < 2:
            return (0.0, 0.0)
        (t0, x0, y0), (t1, x1, y1) = self.centroids[0], self.centroids[-1]
        dt = t1 - t0
        if dt <= 0:
            return (0.0, 0.0)
        return ((x1 - x0) / dt, (y1 - y0) / dt)


def _iou(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0, ix2 - ix1), max(0, iy2 - iy1)
    inter = iw * ih
    if inter == 0:
        return 0.0
    area_a = (ax2 - ax1) * (ay2 - ay1)
    area_b = (bx2 - bx1) * (by2 - by1)
    return inter / float(area_a + area_b - inter)


class CameraTracker:
    """Greedy IoU tracker, one instance per camera.

    Ultralytics' built-in tracker keeps its state on the *model*, so a single
    shared model fed frames from several cameras treats them as one video and
    associates nothing — which is exactly why five of six cameras reported zero
    vehicles. Each camera gets its own tracker here instead.

    IoU matching is enough because we sample one camera at a time at 4 fps and
    only care about a vehicle for the few seconds it's in the near field.
    """

    def __init__(self, iou_threshold: float = 0.25, max_missed: int = 6):
        self.iou_threshold = iou_threshold
        self.max_missed = max_missed
        self._next_id = 1
        # track_id -> [box, missed_frames]
        self._active: dict[int, list] = {}

    def update(self, boxes: list[tuple[int, int, int, int]]) -> list[int]:
        """Assign a stable id to each box, in the order given."""
        assigned: list[int] = [-1] * len(boxes)
        taken: set[int] = set()

        # Best-first matching, so a strong overlap wins over an incidental one.
        pairs = [
            (_iou(box, state[0]), i, tid)
            for i, box in enumerate(boxes)
            for tid, state in self._active.items()
        ]
        pairs.sort(reverse=True)

        used_boxes: set[int] = set()
        for score, i, tid in pairs:
            if score < self.iou_threshold:
                break
            if i in used_boxes or tid in taken:
                continue
            assigned[i] = tid
            used_boxes.add(i)
            taken.add(tid)
            self._active[tid] = [boxes[i], 0]

        for i, box in enumerate(boxes):
            if assigned[i] != -1:
                continue
            tid = self._next_id
            self._next_id += 1
            assigned[i] = tid
            self._active[tid] = [box, 0]
            taken.add(tid)

        # Anything not seen this frame ages; drop it once it's been gone a while.
        # `taken` covers both matched and newly created tracks, so a brand-new
        # one is never penalised on the frame it appeared.
        for tid in list(self._active):
            if tid in taken:
                continue
            self._active[tid][1] += 1
            if self._active[tid][1] > self.max_missed:
                del self._active[tid]

        return assigned


class VehicleDetector:
    """YOLO detection. Tracking is per-camera and lives in CameraTracker."""

    def __init__(self, device: str):
        from ultralytics import YOLO

        self.device = device
        self.model = YOLO(config.YOLO_MODEL)
        self.model.to(device)
        self._trackers: dict[str, CameraTracker] = {}

    def detect(self, frame: np.ndarray, camera_id: str):
        """Yield (track_id, cls_name, box) for vehicles in one frame."""
        results = self.model.predict(
            frame,
            verbose=False,
            conf=config.YOLO_CONF,
            classes=list(config.VEHICLE_CLASSES),
            device=self.device,
        )
        if not results:
            return
        r = results[0]
        if r.boxes is None or len(r.boxes) == 0:
            return

        boxes: list[tuple[int, int, int, int]] = []
        names: list[str] = []
        for cls, xyxy in zip(r.boxes.cls.int().tolist(), r.boxes.xyxy.tolist()):
            x1, y1, x2, y2 = (int(v) for v in xyxy)
            boxes.append((x1, y1, x2, y2))
            names.append(config.VEHICLE_CLASSES.get(cls, "vehicle"))

        tracker = self._trackers.get(camera_id)
        if tracker is None:
            tracker = self._trackers[camera_id] = CameraTracker()
        ids = tracker.update(boxes)

        for tid, name, box in zip(ids, names, boxes):
            yield tid, name, box
