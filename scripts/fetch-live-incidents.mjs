#!/usr/bin/env node
/**
 * Build public/data/live-incidents.json — live road incidents in South
 * Carolina, from SCDOT's 511 feed and the Waze data SCDOT republishes under
 * its Waze for Cities partnership.
 *
 *   node scripts/fetch-live-incidents.mjs
 *
 * Run on a short cron (see .github/workflows/refresh-incidents.yml). These
 * feeds send no Access-Control-Allow-Origin header, so the browser can never
 * poll them directly — the Action fetches, commits, and the app reads the
 * committed file from the tip of main.
 *
 * IMPORTANT, and the app says so too: this is *incident* data, not police
 * dispatch. No agency in SC publishes a live CAD feed. A crash means officers
 * are very likely there, which is genuinely useful, but absence of an incident
 * says nothing about absence of police.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../public/data/live-incidents.json");

const BASE = "https://sc.cdn.iteris-atis.com/geojson/icons/metadata";
const SOURCES = [
  { file: "icons.incident.geojson", source: "SCDOT", kind: "incident" },
  { file: "icons.waze_accident.geojson", source: "Waze", kind: "accident" },
  { file: "icons.waze_hazard.geojson", source: "Waze", kind: "hazard" },
];

/** Drop Waze reports older than this; they linger in the feed after clearing. */
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

const USER_AGENT =
  "sc-alpr-radar/0.3 (personal traffic-incident layer; +https://github.com/OneRedPanda99/sc-alpr-radar)";

function titleCase(s) {
  return s
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Turn a Waze subtype like HAZARD_ON_ROAD_LANE_CLOSED into something readable. */
function wazeHeadline(p) {
  if (p.type === "ACCIDENT") {
    return p.subtype === "ACCIDENT_MAJOR" ? "Major crash" : "Crash";
  }
  const sub = String(p.subtype ?? "").replace(/^HAZARD_(ON_ROAD_|WEATHER_)?/, "");
  return sub ? titleCase(sub) : "Hazard";
}

async function fetchSource({ file, source, kind }) {
  const res = await fetch(`${BASE}/${file}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const json = await res.json();
  const now = Date.now();
  const out = [];

  for (const f of json.features ?? []) {
    const [lon, lat] = f.geometry?.coordinates ?? [];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const p = f.properties ?? {};

    let reportedAt = null;
    if (p.unixtime) {
      const ms = Number(p.unixtime) * 1000;
      if (Number.isFinite(ms)) {
        if (now - ms > MAX_AGE_MS) continue;
        reportedAt = new Date(ms).toISOString();
      }
    }

    const headline =
      source === "Waze" ? wazeHeadline(p) : (p.headline ?? "Incident");
    const where =
      p.location_description ??
      [p.route, p.cross_street].filter(Boolean).join(" at ") ??
      "";

    out.push({
      id: `${source.toLowerCase()}/${f.id ?? p.event_id ?? `${lat},${lon}`}`,
      lat,
      lon,
      source,
      kind,
      headline,
      description: source === "Waze" ? (p.reportDescription ?? "") : where,
      road: p.route ?? null,
      reportedAt,
      // Waze reliability is 0–10 from user up/down votes; SCDOT is authoritative.
      reliability: source === "Waze" ? (p.reliability ?? null) : null,
    });
  }
  return out;
}

async function main() {
  const incidents = [];
  const bySource = {};

  for (const src of SOURCES) {
    try {
      const rows = await fetchSource(src);
      incidents.push(...rows);
      bySource[`${src.source}/${src.kind}`] = rows.length;
    } catch (e) {
      // One dead feed must not blank the whole layer.
      console.warn(`  ${src.file} failed: ${e.message}`);
      bySource[`${src.source}/${src.kind}`] = "failed";
    }
  }

  // Collapse duplicates: SCDOT and Waze often report the same crash. Sort
  // SCDOT first so the authoritative record is the one that survives.
  const rank = (i) => (i.source === "SCDOT" ? 0 : 1);
  const seen = new Set();
  const deduped = [];
  for (const i of incidents.sort((a, b) => rank(a) - rank(b))) {
    const key = `${i.kind}@${i.lat.toFixed(3)},${i.lon.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(i);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    count: deduped.length,
    incidents: deduped,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload));

  console.log(`Wrote ${deduped.length} live incidents to ${OUT}`);
  console.table(bySource);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
