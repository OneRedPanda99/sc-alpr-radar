import type { Camera } from "@/types";

/**
 * Symbol per incident type, matched against the headline the feed gives us
 * (SCDOT writes "Crash"; Waze subtypes are normalised upstream into things
 * like "Lane Closed" and "Car Stopped"). Ordered most specific first, since
 * "Road Closed" would otherwise be caught by the lane-closure test.
 */
const INCIDENT_SYMBOLS: [RegExp, string][] = [
  [/major crash/i, "🛑"],
  [/crash|accident|collision/i, "💥"],
  [/road closed|closure/i, "⛔"],
  [/lane closed/i, "🚧"],
  [/construction|road ?work/i, "🚧"],
  [/car stopped|stopped vehicle|disabled/i, "🚗"],
  [/object|debris/i, "⚠️"],
  [/fog|weather|ice|snow|flood/i, "🌫️"],
  [/animal/i, "🦌"],
  [/police/i, "🚓"],
  [/fire/i, "🔥"],
];

/**
 * One glyph for anything worth marking on the map with a symbol rather than a
 * plain dot. Returns null for the static camera layers — there are thousands of
 * them and a field of emoji would be unreadable, so those stay as coloured dots.
 */
export function mapSymbol(camera: Camera): string | null {
  switch (camera.kind) {
    case "incident":
      return incidentSymbol(camera);
    case "aircraft":
      return camera.lawEnforcement
        ? "🚁"
        : /helicopter/i.test(camera.rawBrand ?? "")
          ? "🚁"
          : "✈️";
    case "police":
      return "🚓";
    case "gunshot":
      return "🔊";
    default:
      return null;
  }
}

export function incidentSymbol(camera: Camera): string {
  const text = `${camera.name ?? ""} ${camera.purpose ?? ""}`;
  for (const [pattern, symbol] of INCIDENT_SYMBOLS) {
    if (pattern.test(text)) return symbol;
  }
  return "❗";
}

/** Kinds drawn as a symbol; these skip the dot and the FOV cone. */
export function hasSymbol(camera: Camera): boolean {
  return mapSymbol(camera) != null;
}

/**
 * Which way to turn the map to look the way a camera looks. Prefers a tagged
 * facing, falling back to the roadway bearing for PTZ cameras (which are omni
 * and so have no tagged facing at all).
 */
export function aimBearingFor(camera: Camera): number | null {
  const tagged = camera.omni
    ? undefined
    : camera.directions.find((d) => Number.isFinite(d));
  const dir = tagged ?? camera.roadBearing;
  return dir != null && Number.isFinite(dir) ? dir : null;
}

/** Every glyph the map can draw, so they can be pre-rasterised on load. */
export const ALL_SYMBOLS: string[] = [
  ...new Set([...INCIDENT_SYMBOLS.map(([, s]) => s), "❗", "🚁", "✈️", "🚓", "🔊"]),
];

/**
 * Rasterise an emoji to pixels for `map.addImage`.
 *
 * MapLibre's `text-field` renders through the basemap style's SDF glyph atlas,
 * which is monochrome — emoji come out as solid black silhouettes. Drawing them
 * to a canvas and registering them as *images* keeps the real colour glyph and
 * still renders on the GPU, unlike HTML markers.
 */
export function rasterizeSymbol(
  symbol: string,
  size = 48,
): { width: number; height: number; data: Uint8ClampedArray } | null {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.font = `${Math.round(size * 0.78)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // A dark rim keeps light glyphs legible over the pale basemap.
  ctx.shadowColor = "rgba(7,11,16,0.85)";
  ctx.shadowBlur = 3;
  ctx.fillText(symbol, size / 2, size / 2 + size * 0.04);
  const img = ctx.getImageData(0, 0, size, size);
  return { width: size, height: size, data: img.data };
}
