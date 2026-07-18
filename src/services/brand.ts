import type { Brand, Camera, CameraKind } from "@/types";

/**
 * OSM tagging for ALPRs is inconsistent (manufacturer, brand, operator,
 * description all get used). Normalize whatever string we find into a small,
 * stable set of brands for filtering and coloring.
 */
export function normalizeBrand(raw?: string | null): Brand {
  if (!raw) return "Other";
  const s = raw.toLowerCase();
  if (s.includes("flock")) return "Flock Safety";
  if (s.includes("motorola") || s.includes("vigilant")) return "Motorola";
  if (s.includes("genetec") || s.includes("autovu")) return "Genetec";
  if (s.includes("leonardo") || s.includes("elsag")) return "Leonardo";
  if (s.includes("neology")) return "Neology";
  return "Other";
}

export const BRAND_COLORS: Record<Brand, string> = {
  "Flock Safety": "#ff4d4d",
  Motorola: "#ff9f1c",
  Genetec: "#2ec4b6",
  Leonardo: "#9b5de5",
  Neology: "#4895ef",
  Other: "#a8b3c7",
};

/** Non-ALPR category colors (ALPR keeps its brand color). */
export const KIND_COLORS: Record<CameraKind, string> = {
  alpr: "#ff4d4d",
  speed: "#f2c14e",
  traffic: "#4895ef",
};

export const KIND_LABELS: Record<CameraKind, string> = {
  alpr: "Plate reader (ALPR)",
  speed: "Speed camera",
  traffic: "Traffic camera",
};

/** Map dot / cone color: ALPR uses brand color, others use category color. */
export function cameraColor(camera: Camera): string {
  if (camera.kind === "alpr") return BRAND_COLORS[camera.brand] ?? "#ff4d4d";
  return KIND_COLORS[camera.kind];
}

/** Local reference illustrations shipped with the app (free, no CDN). */
export function brandImage(brand: Brand): string {
  const file = brand.replace(/\s+/g, "-").toLowerCase();
  return `${import.meta.env.BASE_URL}brands/${file}.svg`;
}

const CARDINAL = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
];

export function formatFacing(directions: number[], omni: boolean): string {
  if (omni || directions.includes(360)) return "360° (all directions)";
  if (!directions.length) return "Direction unknown";
  return directions
    .map((d) => {
      const idx = Math.round((((d % 360) + 360) % 360) / 22.5) % 16;
      return `${Math.round(d)}° ${CARDINAL[idx]}`;
    })
    .join(" · ");
}

/** Derive a plain-English "what it's used for" line. */
export function derivePurpose(
  brand: Brand,
  zone?: string,
  operator?: string,
  description?: string,
  kind: CameraKind = "alpr",
): string {
  const z = (zone ?? "").toLowerCase();
  const desc = (description ?? "").toLowerCase();

  if (kind === "speed") {
    return "Speed enforcement camera";
  }
  if (kind === "traffic") {
    return "Traffic monitoring / CCTV camera";
  }

  if (z.includes("traffic") || desc.includes("traffic")) {
    return "Traffic ALPR — scans plates of passing vehicles";
  }
  if (z.includes("parking") || desc.includes("parking")) {
    return "Parking enforcement / lot monitoring";
  }
  if (operator?.toLowerCase().includes("hoa") || desc.includes("hoa")) {
    return "Neighborhood / HOA ALPR surveillance";
  }
  if (brand === "Flock Safety") {
    return "Automated license plate reader (Flock Safety network)";
  }
  if (brand === "Motorola") {
    return "Law-enforcement ALPR (Motorola / Vigilant)";
  }
  if (brand === "Genetec") {
    return "Security ALPR (Genetec AutoVu)";
  }
  if (brand === "Leonardo") {
    return "Law-enforcement ALPR (Leonardo / ELSAG)";
  }
  if (brand === "Neology") {
    return "Toll / enforcement ALPR (Neology)";
  }
  return "Automated license plate reader";
}

/** Typical half-angle for ALPR FOV cones (full cone ≈ 60–80°). */
export function defaultFovHalf(brand: Brand, omni: boolean): number {
  if (omni) return 180;
  if (brand === "Flock Safety") return 35;
  return 40;
}

export function resolveImageUrl(tags: Record<string, string>): string | undefined {
  if (tags.image) {
    const img = tags.image.trim();
    if (img.startsWith("http")) return img;
  }
  const wiki = tags.wikimedia_commons?.trim();
  if (wiki) {
    // File:Name.jpg → special redirect that serves the file
    const file = wiki.replace(/^File:/i, "").replace(/ /g, "_");
    return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=480`;
  }
  return undefined;
}
