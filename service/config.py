"""Tunables for the police-vehicle watcher.

Kept in one file so the pipeline can be retuned without reading it.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent

# ---------------------------------------------------------------- cameras ---

# Where to watch from. Cameras are chosen by distance from here.
# Blythewood, taken from the SCDOT camera at I-77 MM 27 (Blythewood Rd).
HOME_LAT = 34.2140
HOME_LON = -80.9830

# Camera pack built by scripts/fetch-sc-cameras.mjs.
CAMERA_PACK = REPO / "public" / "data" / "sc-cameras.geojson"

# How many of the nearest SCDOT cameras to watch at once.
#
# Each stream is ~284 kbps, so this is the bandwidth dial: 40 cameras is about
# 11 Mbps sustained and ~120 GB/day. Watching all 767 would be 218 Mbps and
# ~2.3 TB/day, which is impractical and an unreasonable load to put on a public
# DOT service.
MAX_CAMERAS = 40

# ---------------------------------------------------------------- sampling --

# Frames per second pulled from each stream. Vehicles cross the usable
# near-field band in 2-4s, so 4 fps still gives 8-16 looks at each one while
# keeping decode cost sane.
SAMPLE_FPS = 4

# These streams are only 720x480 to begin with; decode at native size.
FRAME_W = 720
FRAME_H = 480

# --------------------------------------------------------------- detection --

# Ultralytics model. The nano model is plenty at 720x480.
YOLO_MODEL = "yolov8n.pt"
YOLO_CONF = 0.35

# COCO class ids worth tracking.
VEHICLE_CLASSES = {2: "car", 5: "bus", 7: "truck"}

# Narrower than this and there aren't enough pixels to classify. Detection
# still works out to the horizon; "is it a cruiser" does not.
#
# Raised from 60 after inspecting real output: at ~80px the top-scoring crops
# were a white sedan and two grey SUVs, i.e. CLIP was ranking ordinary traffic.
# 130 restricts scoring to the closest band of the frame, which is the only
# place there are enough pixels for a light bar to be visible at all. It also
# cuts the sample rate hard — few vehicles get that close to the camera.
MIN_BOX_W = 130

# ------------------------------------------------------------ police score --

# CLIP zero-shot, so nothing needs training before this can run at all.
# Harvested crops can train something sharper later.
CLIP_MODEL = "ViT-B-32"
CLIP_PRETRAINED = "laion2b_s34b_b79k"

POLICE_PROMPTS = [
    "a police car with a light bar on the roof",
    "a police patrol cruiser with door markings",
    "a sheriff patrol SUV with a light bar",
    "a state trooper highway patrol car",
]
CIVILIAN_PROMPTS = [
    "an ordinary passenger car",
    "a delivery van",
    "a semi truck",
    "a pickup truck",
    "an empty road",
]

# Sigmoid gain applied to the police-vs-civilian cosine margin. Margins between
# near-identical prompts are small (order ±0.05), so this spreads them across a
# usable range. Raise it for a sharper decision, lower it for a softer one.
SCORE_GAIN = 30.0

# Above this, call it a police vehicle. Tune against the score distribution the
# watcher prints, not by guessing — the previous 0.62 was meaningless once the
# scores turned out to be saturated.
POLICE_THRESHOLD = 0.62

# ----------------------------------------------------------------- output ---

OUT_DIR = ROOT / "out"
DETECTIONS_JSON = OUT_DIR / "detections.json"
CROP_DIR = OUT_DIR / "crops"

# Keep a detection on the map this long after it was last seen.
DETECTION_TTL_S = 180
