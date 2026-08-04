# Police-vehicle watcher

Watches SCDOT camera streams continuously, detects and tracks vehicles, scores
each one for "is this a patrol vehicle", and writes hits to
`out/detections.json` for the map to read.

> **Status: written, not yet run.** The sandbox this was built in refused to
> execute it, so every number below is a design target rather than a measured
> result. Treat the first run as the real test.

## Run it

Everything is already installed in `.venv` (torch 2.13 + CUDA 12.6, ultralytics,
open_clip).

```bash
cd service
.venv/Scripts/python.exe watch.py --probe --cameras 6
```

`--probe` pulls one frame per camera, reports how many streams delivered and how
many vehicles were found, then exits. **Run this first** — if streams don't
arrive, nothing else matters.

Then the real thing:

```bash
.venv/Scripts/python.exe watch.py
```

Flags: `--cameras N` to change how many streams, `--no-crops` to stop saving
training images.

## How it decides something is a cop

Two independent signals, combined with `max()` rather than an average — a
confident strobe shouldn't be diluted by a mediocre appearance read, or vice
versa.

**Appearance (CLIP, zero-shot).** Catches a marked cruiser driving normally with
lights off, which is the common case and the reason this isn't just a strobe
detector. Zero-shot means it needs no training data to start.

**Strobe (temporal).** Emergency lights are a *timing* signature — periodic
saturated red/blue — not a shape. That survives 720x480 and heavy compression
far better than appearance does, so it stays reliable exactly where CLIP gets
shaky. Only fires when the lights are actually on.

Neither is trustworthy alone at this resolution. Expect false positives on white
SUVs and work trucks until the threshold is tuned against real output.

## The honest limits

- **Only the near third of frame is classifiable.** Measured on a real frame:
  foreground vehicles are 80–150px wide, mid-frame ones 10–25px. You can detect
  *a vehicle* to the horizon; you cannot tell it's a cruiser. A car crosses the
  usable band in 2–4 seconds.
- **Unmarked cars are invisible.** No amount of model tuning fixes this.
- **PTZ cameras move.** When an operator pans one, any per-camera calibration
  dies. Speed estimation (not built yet) has to detect that and re-calibrate.
- **Cross-camera re-identification is not implemented and probably shouldn't be
  attempted directly** at this resolution. The workable version is predictive:
  if something passes camera A southbound at 70 mph and camera B is 3 miles
  down, look for a match in a time window rather than trying to recognise the
  same car.

## Why not all 767 cameras

Each stream is ~284 kbps.

| Cameras | Bandwidth | Per day |
|---|---|---|
| 10 | 2.8 Mbps | 30 GB |
| 40 (default) | 11 Mbps | 120 GB |
| 767 | 218 Mbps | 2.3 TB |

The full set is impractical on any home connection and an unreasonable sustained
load to put on a public DOT service. The GPU is not the constraint — an RTX 3080
runs YOLOv8n far faster than 40 streams at 4 fps needs.

## Output

`out/detections.json`, rewritten atomically each sweep:

```json
{
  "generatedAt": "2026-08-04T15:22:01Z",
  "cameras": 40,
  "count": 1,
  "detections": [
    {
      "id": "sc511/2712#14",
      "cameraName": "I-77 S @ MM 5.8",
      "lat": 34.02, "lon": -80.99,
      "score": 0.81,
      "appearance": 0.74,
      "strobe": 0.81,
      "lightsOn": true,
      "vehicle": "car",
      "pixelVelocity": [42.1, -3.4],
      "firstSeen": "...", "lastSeen": "..."
    }
  ]
}
```

`out/crops/` accumulates the best crop per detected vehicle. That's the training
set for replacing CLIP with something sharper once there are enough labelled
examples.

## Tuning

All in `config.py`. The two that matter first:

- `POLICE_THRESHOLD` (0.62) — raise it if you get false positives, lower it if
  real cruisers slip through.
- `MIN_BOX_W` (60px) — how close a vehicle must be before appearance scoring
  runs at all.
