import type { Brand, Camera, CameraKind } from "@/types";
import {
  defaultFovHalf,
  derivePurpose,
  normalizeBrand,
  resolveImageUrl,
} from "@/services/brand";

/** Classify an OSM node into a broad camera category. */
export function classifyKind(tags: Record<string, string>): CameraKind {
  if (tags["surveillance:type"] === "ALPR") return "alpr";
  if (tags["highway"] === "speed_camera") return "speed";
  return "traffic";
}

/** Shared parsing for Overpass elements and bundled GeoJSON properties. */
export function cameraFromTags(
  id: string,
  lat: number,
  lon: number,
  tags: Record<string, string>,
): Camera {
  const kind = classifyKind(tags);
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
