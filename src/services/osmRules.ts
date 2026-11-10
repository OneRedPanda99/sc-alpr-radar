/**
 * What each OpenStreetMap detail layer is and how to recognise its features.
 * No app imports, so the statewide tile build uses exactly the same rules.
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
  /** Worked out from the road graph rather than queried by tag. */
  computed?: boolean;
}

export const OSM_CATEGORIES: OsmCategory[] = [
  {
    id: "deadends",
    label: "No-go roads (dead ends)",
    color: "#ff3b3b",
    query: "",
    match: () => false,
    minZoom: 13,
    lines: true,
    computed: true,
  },
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

export type Bbox = [south: number, west: number, north: number, east: number];

/** "45 mph" → "45"; leaves odd values (e.g. "signals") alone. */
export function shortSpeed(v?: string): string {
  if (!v) return "";
  const m = /^(\d+)/.exec(v);
  return m ? m[1] : v;
}

/** The map feature properties every detail layer uses, from OSM tags. */
export function osmFeatureProps(
  cat: OsmCategory,
  osmType: string,
  osmId: number,
  tags: Record<string, string>,
) {
  return {
    osmType,
    osmId,
    category: cat.id,
    color: cat.color,
    name: tags.name ?? tags.ref ?? "",
    label: cat.lines ? shortSpeed(tags.maxspeed) : "",
    tags: JSON.stringify(tags),
  };
}
