/**
 * On-demand OpenStreetMap detail layers.
 *
 * The camera pack is prebuilt because it has to work offline; these are the
 * opposite — road furniture and places you'd want while planning (signals,
 * stop signs, speed limits, rail crossings, schools…). There are far too many
 * statewide to bundle, so they're fetched from Overpass for the visible area
 * only, and only for the categories you switch on.
 */

export interface OsmCategory {
  id: string;
  label: string;
  color: string;
  /** Overpass statements; `{{bbox}}` is replaced with the query box. */
  query: string;
  /** Classifies a returned element back into this category. */
  match: (tags: Record<string, string>) => boolean;
  /** Below this zoom the area is too big to query politely. */
  minZoom: number;
  /** Line features (rendered as lines, fetched with full geometry). */
  lines?: boolean;
}

export const OSM_CATEGORIES: OsmCategory[] = [
  {
    id: "signals",
    label: "Traffic lights",
    color: "#f5c542",
    query: 'node["highway"="traffic_signals"]({{bbox}});',
    match: (t) => t.highway === "traffic_signals",
    minZoom: 13,
  },
  {
    id: "stops",
    label: "Stop & yield signs",
    color: "#ff6b6b",
    query: 'node["highway"~"^(stop|give_way)$"]({{bbox}});',
    match: (t) => t.highway === "stop" || t.highway === "give_way",
    minZoom: 14,
  },
  {
    id: "speed",
    label: "Speed limits",
    color: "#a78bfa",
    query: 'way["highway"]["maxspeed"]({{bbox}});',
    match: (t) => !!t.maxspeed && !!t.highway,
    minZoom: 13,
    lines: true,
  },
  {
    id: "calming",
    label: "Speed bumps",
    color: "#fb923c",
    query: 'node["traffic_calming"]({{bbox}});',
    match: (t) => !!t.traffic_calming,
    minZoom: 14,
  },
  {
    id: "rail",
    label: "Rail crossings",
    color: "#e2e8f0",
    query: 'node["railway"~"^(level_crossing|crossing)$"]({{bbox}});',
    match: (t) => t.railway === "level_crossing" || t.railway === "crossing",
    minZoom: 12,
  },
  {
    id: "clearance",
    label: "Height limits",
    color: "#f472b6",
    query: 'nwr["maxheight"]({{bbox}});',
    match: (t) => !!t.maxheight,
    minZoom: 12,
  },
  {
    id: "tolls",
    label: "Tolls",
    color: "#facc15",
    query: 'nwr["barrier"="toll_booth"]({{bbox}});',
    match: (t) => t.barrier === "toll_booth",
    minZoom: 10,
  },
  {
    id: "schools",
    label: "Schools (zones)",
    color: "#fde047",
    query: 'nwr["amenity"~"^(school|kindergarten|college|university)$"]({{bbox}});',
    match: (t) => /^(school|kindergarten|college|university)$/.test(t.amenity ?? ""),
    minZoom: 12,
  },
  {
    id: "emergency",
    label: "Hospitals & fire",
    color: "#f87171",
    query: 'nwr["amenity"~"^(hospital|fire_station|clinic)$"]({{bbox}});',
    match: (t) => /^(hospital|fire_station|clinic)$/.test(t.amenity ?? ""),
    minZoom: 11,
  },
  {
    id: "civic",
    label: "Courts, jails, gov",
    color: "#94a3b8",
    query:
      'nwr["amenity"~"^(courthouse|prison|townhall)$"]({{bbox}});nwr["office"="government"]({{bbox}});',
    match: (t) =>
      /^(courthouse|prison|townhall)$/.test(t.amenity ?? "") ||
      t.office === "government",
    minZoom: 12,
  },
  {
    id: "fuel",
    label: "Gas & EV charging",
    color: "#34d399",
    query: 'nwr["amenity"~"^(fuel|charging_station)$"]({{bbox}});',
    match: (t) => t.amenity === "fuel" || t.amenity === "charging_station",
    minZoom: 11,
  },
  {
    id: "rest",
    label: "Rest stops & restrooms",
    color: "#60a5fa",
    query:
      'nwr["highway"~"^(rest_area|services)$"]({{bbox}});nwr["amenity"="toilets"]({{bbox}});',
    match: (t) =>
      t.highway === "rest_area" || t.highway === "services" || t.amenity === "toilets",
    minZoom: 11,
  },
  {
    id: "parking",
    label: "Parking",
    color: "#38bdf8",
    query: 'nwr["amenity"="parking"]({{bbox}});',
    match: (t) => t.amenity === "parking",
    minZoom: 14,
  },
  {
    id: "food",
    label: "Food & coffee",
    color: "#fdba74",
    query: 'nwr["amenity"~"^(restaurant|fast_food|cafe)$"]({{bbox}});',
    match: (t) => /^(restaurant|fast_food|cafe)$/.test(t.amenity ?? ""),
    minZoom: 14,
  },
  {
    id: "shops",
    label: "Shops & businesses",
    color: "#c4b5fd",
    query: 'nwr["shop"]({{bbox}});',
    match: (t) => !!t.shop,
    minZoom: 15,
  },
];

export const OSM_CATEGORY_BY_ID = new Map(OSM_CATEGORIES.map((c) => [c.id, c]));

const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

export type Bbox = [south: number, west: number, north: number, east: number];

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
  const box = bbox.map((n) => n.toFixed(5)).join(",");
  const points = categories.filter((c) => !c.lines);
  const lines = categories.filter((c) => c.lines);
  let q = "[out:json][timeout:25];";
  if (points.length) {
    q += `(${points.map((c) => c.query.replaceAll("{{bbox}}", box)).join("")});out center tags 3000;`;
  }
  if (lines.length) {
    q += `(${lines.map((c) => c.query.replaceAll("{{bbox}}", box)).join("")});out geom tags 1500;`;
  }

  let lastErr: unknown = null;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        body: new URLSearchParams({ data: q }),
        signal,
      });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      const json = (await res.json()) as { elements: OverpassElement[] };
      return toFeatures(json.elements, categories);
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("Overpass unavailable");
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
    const props = {
      osmType: el.type,
      osmId: el.id,
      category: cat.id,
      color: cat.color,
      name: tags.name ?? tags.ref ?? "",
      label: cat.lines ? shortSpeed(tags.maxspeed) : "",
      tags: JSON.stringify(tags),
    };
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

/** "45 mph" → "45"; leaves odd values (e.g. "signals") alone. */
function shortSpeed(v?: string): string {
  if (!v) return "";
  const m = /^(\d+)/.exec(v);
  return m ? m[1] : v;
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
