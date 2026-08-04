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
