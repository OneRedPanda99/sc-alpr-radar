/**
 * The road-graph half of the no-go roads layer, with no app imports so the
 * statewide tile build (scripts/build-osm-tiles.mjs) runs the exact same code.
 *
 * Join roads at shared nodes, treat anything that reaches the outside world as
 * free, then find the bridges: a road whose removal cuts part of the network
 * off. Everything on the far side of one is a trap, whether it's a single
 * cul-de-sac or a whole subdivision of loops with one entrance.
 */

export interface RoadWay {
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
}

interface Edge {
  a: number;
  b: number;
  coords: [number, number][];
  name: string;
  wayId: number;
}

/**
 * Every road you can only leave the way you came in, as GeoJSON lines.
 * `outside` says which nodes connect to the wider world (the edge of a view,
 * or a state line); unknown nodes count as outside too.
 */
export function findTraps(
  ways: RoadWay[],
  nodes: Map<number, { lat: number; lon: number }>,
  outside: (id: number) => boolean,
): GeoJSON.FeatureCollection {
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
