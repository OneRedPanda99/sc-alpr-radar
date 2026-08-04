#!/usr/bin/env python
"""Train a linear probe on CLIP embeddings from labelled crops.

    python train.py

Zero-shot prompts top out around AUC 0.79 because they compare an image
against *sentences*, and every sentence here describes some kind of road
vehicle. A probe trained on actual labelled crops learns what a cruiser looks
like on *these* cameras — the specific light-bar silhouette, the roof profile,
the livery contrast — which no prompt can express.

A linear layer over frozen CLIP features is the right size for this. Training
the vision encoder itself would need thousands of examples and would overfit
badly on tens; a linear probe learns usefully from ~50 per class and cannot
memorise the training set the way a full fine-tune would.

Reports leave-one-out cross-validated AUC, so the number is honest: every crop
is scored by a model that never saw it. Comparing that against the zero-shot
baseline is the only way to know the probe is actually an improvement rather
than a memorised training set.
"""

from __future__ import annotations

import json

import cv2
import numpy as np
import torch
import torch.nn.functional as F

import config
from label import load_labels


def embed_all(files: list[str], device: str) -> tuple[torch.Tensor, list[str]]:
    """CLIP image embeddings for each crop that still exists on disk."""
    import open_clip
    from PIL import Image

    model, _, preprocess = open_clip.create_model_and_transforms(
        config.CLIP_MODEL, pretrained=config.CLIP_PRETRAINED, device=device
    )
    model.eval()

    feats: list[torch.Tensor] = []
    kept: list[str] = []
    with torch.no_grad():
        for i in range(0, len(files), 32):
            chunk = files[i : i + 32]
            imgs, names = [], []
            for f in chunk:
                img = cv2.imread(str(config.CROP_DIR / f))
                if img is None:
                    continue
                imgs.append(preprocess(Image.fromarray(img[:, :, ::-1])))
                names.append(f)
            if not imgs:
                continue
            batch = torch.stack(imgs).to(device)
            emb = model.encode_image(batch)
            emb = emb / emb.norm(dim=-1, keepdim=True)
            feats.append(emb.cpu())
            kept.extend(names)
    if not feats:
        return torch.empty(0), []
    return torch.cat(feats), kept


def fit(x: torch.Tensor, y: torch.Tensor, epochs: int = 400) -> torch.nn.Linear:
    """Logistic regression on the embeddings."""
    layer = torch.nn.Linear(x.shape[1], 1)
    opt = torch.optim.AdamW(layer.parameters(), lr=1e-2, weight_decay=1e-3)
    # Cruisers are heavily outnumbered; without this the model can score 95%
    # accuracy by calling everything civilian and learn nothing.
    pos_weight = torch.tensor([(y == 0).sum().item() / max(1, (y == 1).sum().item())])
    for _ in range(epochs):
        opt.zero_grad()
        loss = F.binary_cross_entropy_with_logits(
            layer(x).squeeze(-1), y, pos_weight=pos_weight
        )
        loss.backward()
        opt.step()
    return layer


def auc_of(scores: np.ndarray, labels: np.ndarray) -> float:
    pos = scores[labels == 1]
    neg = scores[labels == 0]
    if len(pos) == 0 or len(neg) == 0:
        return float("nan")
    wins = sum(1 for p in pos for n in neg if p > n)
    ties = sum(1 for p in pos for n in neg if p == n)
    return (wins + 0.5 * ties) / (len(pos) * len(neg))


def main() -> None:
    labels = load_labels()
    files = [f for f in labels if (config.CROP_DIR / f).exists()]
    if not files:
        print("No labelled crops on disk. Run label.py first.")
        return

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"embedding {len(files)} crops on {device} ...", flush=True)
    x, kept = embed_all(files, device)
    if len(kept) == 0:
        print("Nothing could be read.")
        return

    y = torch.tensor(
        [1.0 if labels[f] == "police" else 0.0 for f in kept], dtype=torch.float32
    )
    n_pos = int(y.sum().item())
    print(f"usable: {len(kept)} crops ({n_pos} cruisers, {len(kept) - n_pos} civilian)")

    if n_pos < 5:
        print("\nNeed at least 5 cruisers to fit anything. Label more first.")
        return

    # Leave-one-out: each crop scored by a model trained without it. Slow but
    # exact, and with a hundred-odd crops it takes seconds.
    print("cross-validating (leave-one-out) ...", flush=True)
    loo = np.zeros(len(kept))
    for i in range(len(kept)):
        mask = torch.ones(len(kept), dtype=torch.bool)
        mask[i] = False
        layer = fit(x[mask], y[mask])
        with torch.no_grad():
            loo[i] = torch.sigmoid(layer(x[i : i + 1])).item()

    y_np = y.numpy()
    probe_auc = auc_of(loo, y_np)
    print(f"\nprobe AUC (cross-validated): {probe_auc:.3f}")
    print("zero-shot baseline was ~0.79 — anything below that is worse than prompts")

    for target_fpr in (0.05, 0.10, 0.20):
        best_t, best_tpr = None, 0.0
        for t in np.unique(loo):
            tpr = float(((loo >= t) & (y_np == 1)).sum() / max(1, (y_np == 1).sum()))
            fpr = float(((loo >= t) & (y_np == 0)).sum() / max(1, (y_np == 0).sum()))
            if fpr <= target_fpr and tpr > best_tpr:
                best_t, best_tpr = float(t), tpr
        if best_t is not None:
            print(
                f"  at {int(target_fpr*100):>2}% false alarms: "
                f"threshold {best_t:.2f} catches {best_tpr*100:.0f}% of cruisers"
            )

    # Final model over everything, for use at runtime.
    layer = fit(x, y)
    torch.save(
        {
            "weight": layer.weight.detach(),
            "bias": layer.bias.detach(),
            "clip_model": config.CLIP_MODEL,
            "clip_pretrained": config.CLIP_PRETRAINED,
            "n_police": n_pos,
            "n_civilian": len(kept) - n_pos,
            "cv_auc": probe_auc,
        },
        config.PROBE_PATH,
    )
    print(f"\nsaved {config.PROBE_PATH}")
    print("watch.py will use it automatically on next start.")


if __name__ == "__main__":
    main()
