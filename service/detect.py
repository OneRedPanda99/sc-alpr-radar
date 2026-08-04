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
        """P(police) per crop. Crops are BGR, as they come off ffmpeg."""
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
        # 100.0 is CLIP's standard logit scale; without it the softmax is flat.
        probs = (100.0 * feats @ self.text_feats.T).softmax(dim=-1)
        return probs[:, : self.n_police].sum(dim=-1).tolist()


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


class VehicleDetector:
    """YOLO detection plus Ultralytics' built-in ByteTrack."""

    def __init__(self, device: str):
        from ultralytics import YOLO

        self.device = device
        self.model = YOLO(config.YOLO_MODEL)
        self.model.to(device)

    def detect(self, frame: np.ndarray):
        """Yield (track_id, cls_name, box) for vehicles in one frame."""
        results = self.model.track(
            frame,
            persist=True,
            verbose=False,
            conf=config.YOLO_CONF,
            classes=list(config.VEHICLE_CLASSES),
            tracker="bytetrack.yaml",
            device=self.device,
        )
        if not results:
            return
        r = results[0]
        if r.boxes is None or r.boxes.id is None:
            return
        ids = r.boxes.id.int().tolist()
        clss = r.boxes.cls.int().tolist()
        for tid, cls, xyxy in zip(ids, clss, r.boxes.xyxy.tolist()):
            x1, y1, x2, y2 = (int(v) for v in xyxy)
            yield tid, config.VEHICLE_CLASSES.get(cls, "vehicle"), (x1, y1, x2, y2)
