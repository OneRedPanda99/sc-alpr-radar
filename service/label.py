#!/usr/bin/env python
"""Label harvested crops, and measure whether the score actually separates them.

    python label.py            # open the labelling UI
    python label.py --report   # score the detector against existing labels

Labelling is the only thing that turns this from guesswork into measurement.
Until crops are marked, a detector that misses every cruiser and a correct one
watching an empty road produce identical output.

Labels live in out/labels.json as {crop_filename: "police" | "civilian"}, so
they survive re-runs and the crop directory being cleared.
"""

from __future__ import annotations

import argparse
import json
import re
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import unquote

import config

LABELS_PATH = config.OUT_DIR / "labels.json"
PORT = 8777


def load_labels() -> dict[str, str]:
    if LABELS_PATH.exists():
        try:
            return json.loads(LABELS_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}
    return {}


def save_labels(labels: dict[str, str]) -> None:
    config.OUT_DIR.mkdir(parents=True, exist_ok=True)
    LABELS_PATH.write_text(json.dumps(labels, indent=1), encoding="utf-8")


def crop_files() -> list[str]:
    if not config.CROP_DIR.exists():
        return []
    return sorted(p.name for p in config.CROP_DIR.glob("*.jpg"))


def score_of(filename: str) -> float | None:
    """Crops are saved as `<score*100>_<camera>_<track>.jpg`."""
    m = re.match(r"^(\d{3})_", filename)
    return int(m.group(1)) / 100 if m else None


# ------------------------------------------------------------------ report ---


def rescore() -> dict[str, float]:
    """Run CLIP over every labelled crop and return {filename: score}.

    Crops harvested before scores were written into filenames carry no score at
    all, so the labels on them would otherwise be unusable. Scoring the images
    directly recovers them, and is the fastest path to an answer: it needs no
    new traffic, just the labels already collected.
    """
    import cv2

    from detect import PoliceAppearance

    labels = load_labels()
    files = [f for f in labels if (config.CROP_DIR / f).exists()]
    if not files:
        return {}

    print(f"scoring {len(files)} labelled crops ...", flush=True)
    device = "cuda"
    try:
        import torch

        device = "cuda" if torch.cuda.is_available() else "cpu"
    except ImportError:
        pass

    model = PoliceAppearance(device)
    out: dict[str, float] = {}
    # Batched, since CLIP is far faster on a batch than one image at a time.
    for i in range(0, len(files), 32):
        chunk = files[i : i + 32]
        crops = [cv2.imread(str(config.CROP_DIR / f)) for f in chunk]
        pairs = [(f, c) for f, c in zip(chunk, crops) if c is not None]
        if not pairs:
            continue
        scores = model.score_batch([c for _, c in pairs])
        for (f, _), s in zip(pairs, scores):
            out[f] = s
    return out


def report() -> None:
    labels = load_labels()
    if not labels:
        print("No labels yet. Run `python label.py` and mark some crops first.")
        return

    # Prefer the score baked into the filename; fall back to re-scoring the
    # image for older crops that predate that.
    scores = {f: score_of(f) for f in labels}
    if any(v is None for v in scores.values()):
        fresh = rescore()
        for f, v in fresh.items():
            if scores.get(f) is None:
                scores[f] = v

    police = [scores[f] for f, v in labels.items() if v == "police" and scores.get(f) is not None]
    civilian = [scores[f] for f, v in labels.items() if v == "civilian" and scores.get(f) is not None]

    print(f"labelled: {len(labels)}  (police {len(police)}, civilian {len(civilian)})")
    if not police:
        print("\nNo police crops labelled yet — that's the missing half. Without a")
        print("single confirmed cruiser there is still nothing to measure against.")
        return
    if not civilian:
        print("\nNo civilian crops labelled yet; label some ordinary cars too.")
        return

    mean_p = sum(police) / len(police)
    mean_c = sum(civilian) / len(civilian)
    print(f"\nmean score  police {mean_p:.3f}   civilian {mean_c:.3f}")

    # AUC via the Mann-Whitney form: probability a random police crop outscores
    # a random civilian one. 0.5 is a coin flip, 1.0 is perfect separation.
    wins = sum(1 for p in police for c in civilian if p > c)
    ties = sum(1 for p in police for c in civilian if p == c)
    auc = (wins + 0.5 * ties) / (len(police) * len(civilian))
    print(f"AUC {auc:.3f}   (0.5 = coin flip, 1.0 = perfect)")

    # Best threshold by Youden's J, which balances catching cruisers against
    # false alarms rather than optimising one at the other's expense.
    best = (0.0, 0.0, 0.0, 0.0)
    for t in [i / 100 for i in range(101)]:
        tpr = sum(1 for p in police if p >= t) / len(police)
        fpr = sum(1 for c in civilian if c >= t) / len(civilian)
        if tpr - fpr > best[0]:
            best = (tpr - fpr, t, tpr, fpr)
    print(
        f"best threshold {best[1]:.2f} -> catches {best[2]*100:.0f}% of cruisers, "
        f"flags {best[3]*100:.0f}% of ordinary cars"
    )

    print()

    # Sample size first. AUC from a handful of positives is extremely noisy —
    # three cruisers can produce 0.8 by luck — and quoting it as if it settled
    # the question is how a promising number becomes a wrong conclusion.
    if len(police) < 15:
        print(f"SAMPLE TOO SMALL: {len(police)} cruisers labelled.")
        print("AUC from this few positives is mostly noise; treat it as a hint,")
        print("not a result. Label ~15-20 cruisers before trusting any of this.")
        print()

    # The practical question isn't AUC, it's the false-alarm rate at a
    # threshold that still catches cruisers. Anything above a few percent
    # buries real hits on a road carrying hundreds of cars an hour.
    usable = [
        (t / 100, sum(1 for p in police if p >= t / 100) / len(police),
         sum(1 for c in civilian if c >= t / 100) / len(civilian))
        for t in range(101)
    ]
    practical = [(t, tpr, fpr) for t, tpr, fpr in usable if fpr <= 0.05 and tpr > 0]
    if practical:
        t, tpr, fpr = max(practical, key=lambda x: x[1])
        print(f"at 5% false alarms: threshold {t:.2f} catches {tpr*100:.0f}% of cruisers")
    else:
        print("No threshold reaches even 5% false alarms while catching anything.")

    if auc < 0.65:
        print("VERDICT: not separating. At this resolution the appearance score is")
        print("close to a coin flip; no threshold fixes that.")
    elif auc < 0.85 or not practical:
        print("VERDICT: real but weak signal. Overlap is heavy, so any threshold")
        print("that catches cruisers also flags a lot of ordinary traffic.")
    else:
        print("VERDICT: separating well enough to use at the threshold above.")


# --------------------------------------------------------------------- UI ---

PAGE = """<!doctype html><meta charset=utf-8>
<title>Label crops</title>
<style>
 body{background:#0b0f14;color:#e8eef6;font:15px system-ui;margin:0;
      display:flex;flex-direction:column;height:100vh;align-items:center}
 header{padding:12px;font-size:13px;color:#7d8aa0}
 .wrap{flex:1;display:grid;place-items:center;width:100%}
 img{max-width:92vw;max-height:60vh;image-rendering:pixelated;
     border:1px solid #24303f;border-radius:8px;background:#000}
 .meta{margin-top:10px;color:#7d8aa0;font-size:13px;text-align:center}
 .btns{display:flex;gap:10px;padding:16px}
 button{padding:14px 22px;border-radius:10px;border:1px solid #24303f;
        background:#131c28;color:#e8eef6;font-size:15px;font-weight:600;cursor:pointer}
 button.yes{background:#16e0b8;color:#04211b;border-color:#16e0b8}
 button.no{background:#1b2430}
 kbd{background:#0b0f14;border:1px solid #2c3a4c;border-radius:4px;padding:1px 5px;font-size:12px}
 .done{font-size:18px;text-align:center;padding:40px}
</style>
<header>
  <span id=progress></span> &nbsp;
  <kbd>Y</kbd> cruiser &nbsp; <kbd>N</kbd> not &nbsp; <kbd>S</kbd> skip &nbsp; <kbd>&larr;</kbd> back
</header>
<div class=wrap><div>
  <div style=text-align:center><img id=img alt=""></div>
  <div class=meta id=meta></div>
</div></div>
<div class=btns>
  <button class=yes onclick="mark('police')">Cruiser (Y)</button>
  <button class=no onclick="mark('civilian')">Not a cruiser (N)</button>
  <button onclick="skip()">Skip (S)</button>
</div>
<script>
let queue = [], i = 0, history = [];
async function boot(){
  const r = await fetch('/queue'); const d = await r.json();
  queue = d.queue; document.getElementById('progress').textContent =
    d.labelled + ' labelled, ' + queue.length + ' to go';
  show();
}
function show(){
  if(i >= queue.length){
    document.querySelector('.wrap').innerHTML =
      '<div class=done>All done.<br><br>Run <code>python label.py --report</code></div>';
    return;
  }
  const f = queue[i];
  document.getElementById('img').src = '/crop/' + encodeURIComponent(f);
  const m = f.match(/^(\\d{3})_/);
  document.getElementById('meta').textContent =
    (m ? 'model score ' + (m[1]/100).toFixed(2) + '  ·  ' : '') + f;
}
async function mark(v){
  const f = queue[i];
  await fetch('/label', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({file:f, label:v})});
  history.push(i); i++; show();
}
function skip(){ history.push(i); i++; show(); }
function back(){ if(history.length){ i = history.pop(); show(); } }
addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if(k === 'y') mark('police');
  else if(k === 'n') mark('civilian');
  else if(k === 's') skip();
  else if(e.key === 'ArrowLeft') back();
});
boot();
</script>
"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_a):
        pass  # keep the console clean for the labelling session

    def _send(self, code, body, ctype="text/html; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/":
            self._send(200, PAGE.encode("utf-8"))
        elif self.path == "/queue":
            labels = load_labels()
            # Highest-scoring first: if the detector works at all, the cruisers
            # are near the top, so the useful labels come early.
            queue = [f for f in reversed(crop_files()) if f not in labels]
            body = json.dumps({"queue": queue, "labelled": len(labels)})
            self._send(200, body.encode(), "application/json")
        elif self.path.startswith("/crop/"):
            name = unquote(self.path[len("/crop/"):])
            path = config.CROP_DIR / name
            # Resolve and confine to CROP_DIR so a crafted path can't read
            # arbitrary files off disk.
            try:
                path = path.resolve()
                path.relative_to(config.CROP_DIR.resolve())
            except (ValueError, OSError):
                self._send(404, b"no")
                return
            if not path.exists():
                self._send(404, b"no")
                return
            self._send(200, path.read_bytes(), "image/jpeg")
        else:
            self._send(404, b"no")

    def do_POST(self):
        if self.path != "/label":
            self._send(404, b"no")
            return
        n = int(self.headers.get("Content-Length", 0))
        data = json.loads(self.rfile.read(n) or b"{}")
        labels = load_labels()
        labels[data["file"]] = data["label"]
        save_labels(labels)
        self._send(200, b'{"ok":true}', "application/json")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", action="store_true", help="score against labels")
    args = ap.parse_args()

    if args.report:
        report()
        return

    crops = crop_files()
    if not crops:
        print(f"No crops in {config.CROP_DIR}. Run watch.py first.")
        return

    labelled = len(load_labels())
    print(f"{len(crops)} crops, {labelled} already labelled")
    print(f"open http://localhost:{PORT}  (ctrl-c to stop)")
    webbrowser.open(f"http://localhost:{PORT}")
    try:
        HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nstopped — run `python label.py --report` to see the numbers")


if __name__ == "__main__":
    main()
