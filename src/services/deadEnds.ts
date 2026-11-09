import type { LatLng } from "@/types";
import type { Bbox } from "@/services/osmDetails";
import { overpassQuery } from "@/services/overpass";

/**
 * No-go roads: anywhere you can only leave the way you came in.
 *
 * Built from the real road graph rather than tags, because `noexit=yes` is
 * rarely mapped. Fetch the drivable roads in view, join them at shared nodes,
 * treat anything that runs off the edge of the view as connected to the wider
 * world, then find the bridges: a road whose removal cuts part of the network
 * off from the outside. Everything on the far side of one is a trap, whether
 * it's a single cul-de-sac or a whole subdivision of loops with one entrance.
 */

/** Public, through-capable roads. Driveways, parking aisles and tracks are
 * dead ends by nature and would bury the useful ones. */
const ROAD_TYPES =
  "motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|road|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link";

/** Roads ending this close to the edge of the view may continue beyond it. */
const EDGE_MARGIN_DEG = 0.0006;

interface OsmWay {
  type: "way";
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
}

interface OsmNode {
  type: "node";
  id: number;
  lat: number;
  lon: number;
}

async function fetchRoads(bbox: Bbox, signal?: AbortSignal) {
  const box = bbox.map((n) => n.toFixed(5)).join(",");
  const q =
    `[out:json][timeout:25];` +
    `way["highway"~"^(${ROAD_TYPES})$"]["access"!~"^(no|private)$"]["area"!="yes"](${box});` +
    `out body;>;out skel qt;`;
  return overpassQuery<{ elements: (OsmWay | OsmNode)[] }>(q, signal);
}

interface Edge {
  a: number;
  b: number;
  coords: [number, number][];
  name: string;
  wayId: number;
}

/** The pure graph part, separate from fetching so it can be tested. */
export function findDeadEnds(
  ways: OsmWay[],
  nodes: Map<number, { lat: number; lon: number }>,
  bbox: Bbox,
): GeoJSON.FeatureCollection {
  const [s, w, n, e] = bbox;
  const outside = (id: number) => {
    const p = nodes.get(id);
    if (!p) return true; // Unknown nodes lie beyond what was fetched.
    return (
      p.lat < s + EDGE_MARGIN_DEG ||
      p.lat > n - EDGE_MARGIN_DEG ||
      p.lon < w + EDGE_MARGIN_DEG ||
      p.lon > e - EDGE_MARGIN_DEG
    );
  };

  // Junctions: endpoints and any node shared by two or more ways.
  const uses = new Map<number, number>();
  for (const way of ways) for (const id of way.nodes) uses.set(id, (uses.get(id) ?? 0) + 1);

  // Split every way at junctions into graph edges. Node 0 stands for "the
  // rest of the world"; anything at or past the edge of the view joins it.
  const OUT = 0;
  const edges: Edge[] = [];
  const key = (id: number) => (outside(id) ? OUT : id);
  for (const way of ways) {
    let start = 0;
    for (let i = 1; i < way.nodes.length; i++) {
      const id = way.nodes[i];
      const last = i === way.nodes.length - 1;
      if (!last && (uses.get(id) ?? 0) < 2 && !outside(id)) continue;
      const seg = way.nodes.slice(start, i + 1);
      const coords = seg
        .map((nid) => nodes.get(nid))
        .filter((p): p is { lat: number; lon: number } => !!p)
        .map((p) => [p.lon, p.lat] as [number, number]);
      const a = key(seg[0]);
      const b = key(seg[seg.length - 1]);
      if (coords.length >= 2 && !(a === OUT && b === OUT)) {
        edges.push({ a, b, coords, name: way.tags?.name ?? way.tags?.ref ?? "", wayId: way.id });
      }
      start = i;
    }
  }

  // Adjacency, then bridges via an iterative Tarjan low-link pass.
  const adj = new Map<number, number[]>();
  edges.forEach((ed, i) => {
    if (ed.a === ed.b) return;
    (adj.get(ed.a) ?? adj.set(ed.a, []).get(ed.a)!).push(i);
    (adj.get(ed.b) ?? adj.set(ed.b, []).get(ed.b)!).push(i);
  });
  const disc = new Map<number, number>();
  const low = new Map<number, number>();
  const isBridge = new Uint8Array(edges.length);
  let time = 0;
  for (const root of adj.keys()) {
    if (disc.has(root)) continue;
    const stack: { v: number; via: number; i: number }[] = [{ v: root, via: -1, i: 0 }];
    disc.set(root, time);
    low.set(root, time++);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const list = adj.get(top.v)!;
      if (top.i < list.length) {
        const ei = list[top.i++];
        if (ei === top.via) continue;
        const ed = edges[ei];
        const to = ed.a === top.v ? ed.b : ed.a;
        if (!disc.has(to)) {
          disc.set(to, time);
          low.set(to, time++);
          stack.push({ v: to, via: ei, i: 0 });
        } else {
          low.set(top.v, Math.min(low.get(top.v)!, disc.get(to)!));
        }
      } else {
        stack.pop();
        const parent = stack[stack.length - 1];
        if (parent) {
          low.set(parent.v, Math.min(low.get(parent.v)!, low.get(top.v)!));
          if (low.get(top.v)! > disc.get(parent.v)!) isBridge[top.via] = 1;
        }
      }
    }
  }

  // Without the bridges, whatever can still reach the outside is the through
  // network. Everything else (and the bridges into it) is a trap.
  const free = new Set<number>([OUT]);
  const queue = [OUT];
  while (queue.length) {
    const v = queue.pop()!;
    for (const ei of adj.get(v) ?? []) {
      if (isBridge[ei]) continue;
      const ed = edges[ei];
      const to = ed.a === v ? ed.b : ed.a;
      if (!free.has(to)) {
        free.add(to);
        queue.push(to);
      }
    }
  }

  const features: GeoJSON.Feature[] = [];
  edges.forEach((ed) => {
    if (free.has(ed.a) && free.has(ed.b)) return;
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: ed.coords },
      properties: {
        osmType: "way",
        osmId: ed.wayId,
        category: "deadends",
        color: "#ff3b3b",
        name: ed.name,
        label: "",
        tags: JSON.stringify({ name: ed.name, "No-go": "Dead end: the only way out is back the way you came" }),
      },
    });
  });
  return { type: "FeatureCollection", features };
}

/** The no-go roads most recently found, for the driving warning. */
let latest: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
export function latestDeadEnds() {
  return latest;
}

export async function fetchDeadEnds(bbox: Bbox, signal?: AbortSignal) {
  const json = await fetchRoads(bbox, signal);
  const ways: OsmWay[] = [];
  const nodes = new Map<number, { lat: number; lon: number }>();
  for (const el of json.elements) {
    if (el.type === "way") ways.push(el);
    else nodes.set(el.id, { lat: el.lat, lon: el.lon });
  }
  latest = findDeadEnds(ways, nodes, bbox);
  return latest;
}

/** Flat metres from p to the segment a→b. */
function segDist(p: LatLng, a: [number, number], b: [number, number]): number {
  const k = Math.cos((p.lat * Math.PI) / 180) * 111320;
  const ax = (a[0] - p.lon) * k;
  const ay = (a[1] - p.lat) * 110540;
  const bx = (b[0] - p.lon) * k;
  const by = (b[1] - p.lat) * 110540;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + dx * t, ay + dy * t);
}

/** The no-go road within `meters` of p, if any. */
export function deadEndNear(p: LatLng, meters: number): GeoJSON.Feature | null {
  for (const f of latest.features) {
    const c = (f.geometry as GeoJSON.LineString).coordinates as [number, number][];
    for (let i = 1; i < c.length; i++) {
      if (segDist(p, c[i - 1], c[i]) <= meters) return f;
    }
  }
  return null;
}
