#!/usr/bin/env node
/**
 * Fetch all ALPR cameras in South Carolina from OpenStreetMap via Overpass and
 * write a normalized GeoJSON pack to public/data/sc-cameras.geojson.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../public/data/sc-cameras.geojson");

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

const USER_AGENT = "sc-alpr-radar/0.2 (personal DeFlock data pack; +https://deflock.me)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const QUERY = `[out:json][timeout:180];
area["name"="South Carolina"]["admin_level"="4"]->.sc;
(
  node["surveillance:type"="ALPR"](area.sc);
);
out body;`;

function normalizeBrand(raw) {
  if (!raw) return "Other";
  const s = String(raw).toLowerCase();
  if (s.includes("flock")) return "Flock Safety";
  if (s.includes("motorola") || s.includes("vigilant")) return "Motorola";
  if (s.includes("genetec") || s.includes("autovu")) return "Genetec";
  if (s.includes("leonardo") || s.includes("elsag")) return "Leonardo";
  if (s.includes("neology")) return "Neology";
  return "Other";
}

function parseDirections(tags) {
  const raw = tags["direction"] ?? tags["camera:direction"] ?? "";
  if (!raw) return [];
  return String(raw)
    .split(";")
    .map((s) => Number.parseFloat(s.trim()))
    .filter((n) => Number.isFinite(n) && n !== 360);
}

function isOmni(tags, directions) {
  const dir = String(tags["direction"] ?? tags["camera:direction"] ?? "").trim();
  return tags["camera:type"] === "dome" || dir === "360" || directions.includes(360);
}

function resolveImageUrl(tags) {
  if (tags.image?.startsWith("http")) return tags.image.trim();
  const wiki = tags.wikimedia_commons?.trim();
  if (wiki) {
    const file = wiki.replace(/^File:/i, "").replace(/ /g, "_");
    return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=480`;
  }
  return null;
}

function derivePurpose(brand, zone, operator, description) {
  const z = (zone ?? "").toLowerCase();
  const desc = (description ?? "").toLowerCase();
  if (z.includes("traffic") || desc.includes("traffic")) {
    return "Traffic ALPR — scans plates of passing vehicles";
  }
  if (z.includes("parking") || desc.includes("parking")) {
    return "Parking enforcement / lot monitoring";
  }
  if (operator?.toLowerCase().includes("hoa") || desc.includes("hoa")) {
    return "Neighborhood / HOA ALPR surveillance";
  }
  const defaults = {
    "Flock Safety": "Automated license plate reader (Flock Safety network)",
    Motorola: "Law-enforcement ALPR (Motorola / Vigilant)",
    Genetec: "Security ALPR (Genetec AutoVu)",
    Leonardo: "Law-enforcement ALPR (Leonardo / ELSAG)",
    Neology: "Toll / enforcement ALPR (Neology)",
  };
  return defaults[brand] ?? "Automated license plate reader";
}

function defaultFovHalf(brand, omni) {
  if (omni) return 180;
  if (brand === "Flock Safety") return 35;
  return 40;
}

async function queryEndpoint(endpoint) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
    body: `data=${encodeURIComponent(QUERY)}`,
  });
  if (res.status === 429) throw new Error("HTTP 429 (rate limited)");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Exhaust retries on the primary (freshest) server BEFORE falling back to a
// mirror. Mirrors can lag and return a smaller, stale set, so preferring the
// reference server matters for completeness.
async function overpass() {
  let lastErr;
  for (const endpoint of ENDPOINTS) {
    const attempts = endpoint === ENDPOINTS[0] ? 4 : 2;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        console.log(`Querying ${endpoint} (attempt ${attempt + 1}/${attempts}) …`);
        return await queryEndpoint(endpoint);
      } catch (e) {
        console.warn(`  failed: ${e.message}`);
        lastErr = e;
        await sleep(5000);
      }
    }
  }
  throw lastErr ?? new Error("All Overpass endpoints failed");
}

async function main() {
  const json = await overpass();
  const elements = json.elements ?? [];
  const features = [];
  for (const el of elements) {
    if (el.lat == null || el.lon == null) continue;
    const tags = el.tags ?? {};
    const rawBrand =
      tags["manufacturer"] ?? tags["brand"] ?? tags["operator"] ?? tags["name"];
    const brand = normalizeBrand(rawBrand);
    const directions = parseDirections(tags);
    const omni = isOmni(tags, directions);
    const zone = tags["surveillance:zone"] ?? tags["surveillance"] ?? null;
    const operator = tags["operator"] ?? null;
    const name = tags["name"] ?? tags["ref"] ?? null;
    const description = tags["description"] ?? tags["note"] ?? null;

    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [el.lon, el.lat] },
      properties: {
        id: `node/${el.id}`,
        brand,
        rawBrand: rawBrand ?? null,
        name,
        operator,
        directions: omni ? [] : directions,
        omni,
        zone,
        purpose: derivePurpose(brand, zone, operator, description),
        imageUrl: resolveImageUrl(tags),
        fovHalfAngle: defaultFovHalf(brand, omni),
      },
    });
  }

  const fc = {
    type: "FeatureCollection",
    generatedAt: new Date().toISOString(),
    count: features.length,
    features,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(fc));
  console.log(`Wrote ${features.length} SC ALPR cameras to ${OUT}`);

  const byBrand = {};
  let withImage = 0;
  for (const f of features) {
    const b = f.properties.brand;
    byBrand[b] = (byBrand[b] ?? 0) + 1;
    if (f.properties.imageUrl) withImage++;
  }
  console.table(byBrand);
  console.log(`With OSM photos: ${withImage}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
