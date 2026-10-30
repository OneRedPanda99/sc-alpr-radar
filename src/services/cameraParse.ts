import type { Brand, Camera, CameraKind } from "@/types";
import {
  defaultFovHalf,
  derivePurpose,
  normalizeBrand,
  resolveImageUrl,
} from "@/services/brand";

/**
 * Classify an OSM node into a broad category, or null for nodes we don't map
 * (e.g. `surveillance:type=guard`, which is a person, not a device).
 */
export function classifyKind(tags: Record<string, string>): CameraKind | null {
  if (tags["amenity"] === "police") return "police";
  if (tags["surveillance:type"] === "ALPR") return "alpr";
  if (tags["surveillance:type"] === "gunshot_detector") return "gunshot";
  if (tags["highway"] === "speed_camera") return "speed";
  if (tags["surveillance:type"] === "guard") return null;
  return "traffic";
}

/**
 * Shared parsing for Overpass elements and bundled GeoJSON properties.
 * Returns null for nodes we deliberately skip (see `classifyKind`).
 */
export function cameraFromTags(
  id: string,
  lat: number,
  lon: number,
  tags: Record<string, string>,
): Camera | null {
  const kind = classifyKind(tags);
  if (kind == null) return null;
  const rawBrand =
    tags["manufacturer"] ?? tags["brand"] ?? tags["operator"] ?? tags["name"];
  const brand: Brand = normalizeBrand(rawBrand);
  const directions = parseDirections(tags);
  const omni = isOmni(tags, directions);
  const zone = tags["surveillance:zone"] ?? tags["surveillance"] ?? undefined;
  const operator = tags["operator"] ?? undefined;
  const name = tags["name"] ?? tags["ref"] ?? undefined;
  const description = tags["description"] ?? tags["note"] ?? undefined;

  return {
    id,
    lat,
    lon,
    kind,
    brand,
    rawBrand,
    name,
    operator,
    directions: omni ? [] : directions,
    omni,
    zone,
    purpose: derivePurpose(brand, zone, operator, description, kind),
    imageUrl: resolveImageUrl(tags),
    fovHalfAngle: defaultFovHalf(brand, omni),
  };
}

export function cameraFromFeatureProps(
  id: string,
  lat: number,
  lon: number,
  p: Record<string, unknown>,
): Camera {
  const brand = (p.brand as Brand) ?? normalizeBrand(p.rawBrand as string);
  const kind = (p.kind as CameraKind) ?? "alpr";
  const directions = Array.isArray(p.directions)
    ? (p.directions as number[])
    : [];
  const omni = Boolean(p.omni);
  const zone = (p.zone as string) || undefined;
  const operator = (p.operator as string) || undefined;
  const name = (p.name as string) || undefined;
  const purpose =
    (p.purpose as string) ||
    derivePurpose(brand, zone, operator, p.description as string, kind);

  return {
    id,
    lat,
    lon,
    kind,
    brand,
    rawBrand: (p.rawBrand as string) || undefined,
    name,
    operator,
    directions,
    omni,
    zone,
    purpose,
    imageUrl: (p.imageUrl as string) || undefined,
    streamUrl: (p.streamUrl as string) || undefined,
    roadBearing:
      typeof p.roadBearing === "number" ? p.roadBearing : undefined,
    fovHalfAngle:
      typeof p.fovHalfAngle === "number"
        ? p.fovHalfAngle
        : defaultFovHalf(brand, omni),
  };
}

function parseDirections(tags: Record<string, string>): number[] {
  const raw = tags["direction"] ?? tags["camera:direction"] ?? "";
  if (!raw) return [];
  return raw
    .split(";")
    .map((s) => Number.parseFloat(s.trim()))
    .filter((n) => Number.isFinite(n) && n !== 360);
}

function isOmni(tags: Record<string, string>, directions: number[]): boolean {
  const dir = tags["direction"]?.trim() ?? tags["camera:direction"]?.trim();
  return (
    tags["camera:type"] === "dome" ||
    dir === "360" ||
    directions.includes(360)
  );
}

const AGENCY = /police|sheriff|department|\bpd\b|\bpcso\b|town of|city of|county/i;
const RAW_BRAND_FIXES: Record<string, string> = { rekoe: "Rekor", flock: "Flock Safety" };

/** "RichlandCountySheriffDepartment" → "Richland County Sheriff Department". */
function spaceCamel(s: string): string {
  return s.includes(" ") ? s : s.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/**
 * Tidy who-made-it / who-runs-it. OSM mappers often type the agency into
 * `manufacturer`, which then showed up on the card as the camera's maker,
 * and a few operators carry stray brackets or spelling variants.
 */
export function cleanAttribution(c: Camera): Camera {
  let rawBrand = c.rawBrand?.trim() || undefined;
  let operator = c.operator?.replace(/^\[(.*)\]$/, "$1").trim() || undefined;
  if (rawBrand && AGENCY.test(spaceCamel(rawBrand)) && c.kind !== "police") {
    operator ??= spaceCamel(rawBrand);
    rawBrand = undefined;
  }
  if (rawBrand) rawBrand = RAW_BRAND_FIXES[rawBrand.toLowerCase()] ?? rawBrand;
  if (operator && /^lowes$/i.test(operator)) operator = "Lowe's";
  if (rawBrand === c.rawBrand && operator === c.operator) return c;
  return { ...c, rawBrand, operator };
}

/**
 * One pole often carries two cameras facing different ways, and OSM maps them
 * as two nodes on the same spot (sometimes the same camera is simply mapped
 * twice). Drawn separately they stack into one blob and alert twice; merged,
 * they're one point with every facing it covers.
 */
export function mergeColocated(cameras: Camera[]): Camera[] {
  const out: Camera[] = [];
  const byKey = new Map<string, number>();
  for (const c of cameras) {
    if (c.kind !== "alpr" && c.kind !== "speed") {
      out.push(c);
      continue;
    }
    const key = `${c.kind}:${c.brand}:${c.lat.toFixed(5)},${c.lon.toFixed(5)}`;
    const at = byKey.get(key);
    if (at == null) {
      byKey.set(key, out.length);
      out.push(c);
      continue;
    }
    const a = out[at];
    const omni = a.omni || c.omni;
    const directions = omni
      ? []
      : [...new Set([...a.directions, ...c.directions].map((d) => Math.round(d) % 360))];
    out[at] = {
      ...a,
      name: a.name ?? c.name,
      operator: a.operator ?? c.operator,
      rawBrand: a.rawBrand ?? c.rawBrand,
      imageUrl: a.imageUrl ?? c.imageUrl,
      directions,
      omni,
      fovHalfAngle: omni ? 180 : a.fovHalfAngle,
    };
  }
  return out;
}
