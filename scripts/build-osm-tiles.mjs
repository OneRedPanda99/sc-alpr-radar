#!/usr/bin/env node
/**
 * Build the statewide OpenStreetMap detail tiles the app loads instead of
 * asking Overpass live:
 *
 *   node scripts/build-osm-tiles.mjs --details details.geojsonseq \
 *     --roads roads.opl --poly south-carolina.poly --out dist/osm
 *
 * Inputs come from Geofabrik's South Carolina extract via osmium (see
 * .github/workflows/build-osm-tiles.yml):
 *   details.geojsonseq  osmium export of everything the detail layers want
 *   roads.opl           drivable roads, with node locations, for no-go roads
 *   south-carolina.poly the extract's outline
 *
 * Output: <out>/<layer>/<x>/<y>.json at zoom 12 (about 10 km square), plus
 * <out>/index.json listing which tiles exist per layer. Tiles live on the
 * site's CDN, so opening the app fetches a few small files in well under a
 * second instead of waiting on a public server that is often overloaded.
 *
 * Needs Node 23.6+ (it imports the app's TypeScript rules directly, so the
 * app and the build can never disagree about what a layer contains).
 */
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { OSM_CATEGORIES, osmFeatureProps } from "../src/services/osmRules.ts";
import { findTraps } from "../src/services/roadGraph.ts";

const ZOOM = 12;
const ROAD_TYPES = new Set(
  "motorway trunk primary secondary tertiary unclassified residential living_street road motorway_link trunk_link primary_link secondary_link tertiary_link".split(
    " ",
  ),
);

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

// --- tiles ----------------------------------------------------------------------
const n = 2 ** ZOOM;
const tileX = (lon) => Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
const tileY = (lat) => {
  const r = (lat * Math.PI) / 180;
  return Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)));
};

/** layer -> "x/y" -> features */
const tiles = new Map();
function put(layer, x, y, feature) {
  let byTile = tiles.get(layer);
  if (!byTile) tiles.set(layer, (byTile = new Map()));
  const key = `${x}/${y}`;
  let list = byTile.get(key);
  if (!list) byTile.set(key, (list = []));
  list.push(feature);
}

const round = (v) => Math.round(v * 1e6) / 1e6;
const roundCoords = (c) => (typeof c[0] === "number" ? [round(c[0]), round(c[1])] : c.map(roundCoords));

/** A line goes in every tile its bounding box touches, so it draws whole. */
function putLine(layer, feature) {
  const coords = feature.geometry.coordinates;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [lon, lat] of coords) {
    const x = tileX(lon), y = tileY(lat);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) put(layer, x, y, feature);
}

// --- detail layers ----------------------------------------------------------------
const tagged = OSM_CATEGORIES.filter((c) => !c.computed);
const TYPE = { n: "node", w: "way", r: "relation", a: "way" };

function centre(geom) {
  switch (geom.type) {
    case "Point":
      return geom.coordinates;
    case "LineString":
      return geom.coordinates[Math.floor(geom.coordinates.length / 2)];
    case "Polygon":
    case "MultiPolygon": {
      const ring = geom.type === "Polygon" ? geom.coordinates[0] : geom.coordinates[0][0];
      const pts = ring.length > 1 ? ring.slice(0, -1) : ring;
      return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
    }
    default:
      return null;
  }
}

function asLines(geom) {
  switch (geom.type) {
    case "LineString":
      return [geom.coordinates];
    case "MultiLineString":
      return geom.coordinates;
    case "Polygon":
      return [geom.coordinates[0]];
    case "MultiPolygon":
      return geom.coordinates.map((p) => p[0]);
    default:
      return [];
  }
}

async function readDetails(path) {
  let count = 0;
  const seen = new Set();
  const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const raw of rl) {
    // geojsonseq lines may start with an ASCII record separator.
    const line = (raw.charCodeAt(0) === 0x1e ? raw.slice(1) : raw).trim();
    if (!line) continue;
    const f = JSON.parse(line);
    const tags = f.properties ?? {};
    const cat = tagged.find((c) => c.match(tags));
    if (!cat || !f.geometry) continue;
    const id = String(f.id ?? "");
    const osmType = TYPE[id[0]] ?? "node";
    const osmId = Number(id.slice(1)) || 0;
    // An area and its outline can both come through; keep one per object.
    const key = `${cat.id}/${osmType}/${osmId}`;
    if (osmId && seen.has(key)) continue;
    seen.add(key);
    const properties = osmFeatureProps(cat, osmType, osmId, tags);
    if (cat.lines) {
      for (const coords of asLines(f.geometry)) {
        if (coords.length < 2) continue;
        putLine(cat.id, { type: "Feature", geometry: { type: "LineString", coordinates: roundCoords(coords) }, properties });
      }
    } else {
      const c = centre(f.geometry);
      if (!c) continue;
      put(cat.id, tileX(c[0]), tileY(c[1]), {
        type: "Feature",
        geometry: { type: "Point", coordinates: roundCoords(c) },
        properties,
      });
    }
    count++;
  }
  return count;
}

// --- no-go roads ------------------------------------------------------------------
/** osmium's .poly format: rings of "lon lat", holes start with "!". */
async function readPoly(path) {
  const rings = [];
  let cur = null;
  let named = false;
  for (const raw of (await readFile(path, "utf8")).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!named) {
      named = true; // The first line is the file's name.
      continue;
    }
    if (line === "END") {
      if (cur) rings.push(cur);
      cur = null;
      continue;
    }
    if (cur) {
      const [lon, lat] = line.split(/\s+/).map(Number);
      if (Number.isFinite(lon) && Number.isFinite(lat)) cur.pts.push([lon, lat]);
    } else {
      cur = { hole: line.startsWith("!"), pts: [] };
    }
  }
  return rings.filter((r) => r.pts.length > 2);
}

function inRing(lon, lat, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** OPL escapes special characters as %<hex>%. */
const unescape = (s) => s.replace(/%([0-9a-fA-F]+)%/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));

async function readRoads(path) {
  const ways = [];
  const nodes = new Map();
  const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.startsWith("w")) continue;
    const fields = line.split(" ");
    const id = Number(fields[0].slice(1));
    const tagField = fields.find((f) => f.startsWith("T")) ?? "T";
    const nodeField = fields.find((f) => f.startsWith("N")) ?? "N";
    const tags = {};
    for (const kv of tagField.slice(1).split(",")) {
      if (!kv) continue;
      const eq = kv.indexOf("=");
      tags[unescape(kv.slice(0, eq))] = unescape(kv.slice(eq + 1));
    }
    if (!ROAD_TYPES.has(tags.highway) || /^(no|private)$/.test(tags.access ?? "") || tags.area === "yes") continue;
    const refs = [];
    for (const nf of nodeField.slice(1).split(",")) {
      const m = /^n(\d+)x([-\d.]+)y([-\d.]+)$/.exec(nf);
      if (!m) continue;
      const nid = Number(m[1]);
      refs.push(nid);
      if (!nodes.has(nid)) nodes.set(nid, { lon: Number(m[2]), lat: Number(m[3]) });
    }
    if (refs.length >= 2) ways.push({ id, nodes: refs, tags });
  }
  return { ways, nodes };
}

// --- main -----------------------------------------------------------------------
const out = arg("out");
const detailsPath = arg("details");
const roadsPath = arg("roads");
const polyPath = arg("poly");
if (!out || !detailsPath || !roadsPath || !polyPath) {
  console.error("usage: build-osm-tiles.mjs --details f.geojsonseq --roads f.opl --poly f.poly --out dir");
  process.exit(2);
}

const t0 = Date.now();
const details = await readDetails(detailsPath);
console.log(`details: ${details} features`);

const rings = await readPoly(polyPath);
const outer = rings.filter((r) => !r.hole);
const holes = rings.filter((r) => r.hole);
const { ways, nodes } = await readRoads(roadsPath);
const outsideMemo = new Map();
const outside = (nid) => {
  let v = outsideMemo.get(nid);
  if (v !== undefined) return v;
  const p = nodes.get(nid);
  v = !p || !outer.some((r) => inRing(p.lon, p.lat, r.pts)) || holes.some((r) => inRing(p.lon, p.lat, r.pts));
  outsideMemo.set(nid, v);
  return v;
};
const traps = findTraps(ways, nodes, outside);
for (const f of traps.features) {
  f.geometry.coordinates = roundCoords(f.geometry.coordinates);
  putLine("deadends", f);
}
console.log(`roads: ${ways.length} ways, ${traps.features.length} no-go segments`);

await rm(out, { recursive: true, force: true });
const index = { generatedAt: new Date().toISOString(), zoom: ZOOM, layers: {} };
let files = 0;
for (const [layer, byTile] of tiles) {
  index.layers[layer] = [...byTile.keys()].sort();
  for (const [key, features] of byTile) {
    const [x, y] = key.split("/");
    const dir = join(out, layer, x);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${y}.json`), JSON.stringify({ type: "FeatureCollection", features }));
    files++;
  }
}
await mkdir(out, { recursive: true });
await writeFile(join(out, "index.json"), JSON.stringify(index));
console.log(`wrote ${files} tiles for ${tiles.size} layers in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
