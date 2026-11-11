import { fetchDeadEnds } from "@/services/deadEnds";
import { overpassQuery } from "@/services/overpass";
import {
  OSM_CATEGORIES,
  OSM_CATEGORY_BY_ID,
  osmFeatureProps,
  type Bbox,
  type OsmCategory,
} from "@/services/osmRules";

export { OSM_CATEGORIES, OSM_CATEGORY_BY_ID, type Bbox, type OsmCategory };

/**
 * On-demand OpenStreetMap detail layers.
 *
 * The camera pack is prebuilt because it has to work offline; these are the
 * opposite — road furniture and places you'd want while planning (signals,
 * stop signs, speed limits, rail crossings, schools…). There are far too many
 * statewide to bundle, so they're fetched from Overpass for the visible area
 * only, and only for the categories you switch on.
 */

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}


/**
 * Fetch every enabled category inside `bbox` in one Overpass request and
 * return it as GeoJSON. Each feature carries its category, colour, OSM type/id
 * and the full tag set (serialised, since MapLibre flattens nested props).
 */
export async function fetchOsmDetails(
  categories: OsmCategory[],
  bbox: Bbox,
  signal?: AbortSignal,
): Promise<GeoJSON.FeatureCollection> {
  // Computed layers run their own query alongside the tag lookups.
  const computed = categories.some((c) => c.id === "deadends")
    ? fetchDeadEnds(bbox, signal)
    : null;
  // If the tag query fails first, nobody awaits this one; keep it quiet.
  computed?.catch(() => {});
  const tagged = categories.filter((c) => !c.computed);
  if (!tagged.length) return computed ?? { type: "FeatureCollection", features: [] };
  const box = bbox.map((n) => n.toFixed(5)).join(",");
  const points = tagged.filter((c) => !c.lines);
  const lines = tagged.filter((c) => c.lines);
  let q = "[out:json][timeout:25];";
  if (points.length) {
    q += `(${points.map((c) => c.query.replaceAll("{{bbox}}", box)).join("")});out center tags 3000;`;
  }
  if (lines.length) {
    q += `(${lines.map((c) => c.query.replaceAll("{{bbox}}", box)).join("")});out geom tags 1500;`;
  }

  const json = await overpassQuery<{ elements: OverpassElement[] }>(q, signal);
  const fc = toFeatures(json.elements, tagged);
  if (computed) fc.features.push(...(await computed).features);
  return fc;
}

function toFeatures(
  elements: OverpassElement[],
  categories: OsmCategory[],
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const el of elements) {
    const tags = el.tags ?? {};
    const cat = categories.find((c) => c.match(tags));
    if (!cat) continue;
    const props = osmFeatureProps(cat, el.type, el.id, tags);
    if (cat.lines && el.geometry?.length) {
      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: el.geometry.map((g) => [g.lon, g.lat]),
        },
        properties: props,
      });
      continue;
    }
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: props,
    });
  }
  return { type: "FeatureCollection", features };
}

/** Human labels for the tags people actually care about, shown first. */
export const FRIENDLY_TAGS: Record<string, string> = {
  name: "Name",
  operator: "Operator",
  brand: "Brand",
  maxspeed: "Speed limit",
  maxheight: "Height limit",
  opening_hours: "Hours",
  phone: "Phone",
  website: "Website",
  "addr:housenumber": "Number",
  "addr:street": "Street",
  "addr:city": "City",
  lanes: "Lanes",
  surface: "Surface",
  oneway: "One-way",
  access: "Access",
  fee: "Fee",
  capacity: "Capacity",
};
