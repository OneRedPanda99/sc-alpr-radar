#!/usr/bin/env node
/**
 * Fetch all ALPR cameras in South Carolina from OpenStreetMap via Overpass and
 * write a normalized GeoJSON pack to public/data/sc-cameras.geojson.
 *
 * This is the data DeFlock volunteers maintain (surveillance:type=ALPR).
 * Run on Wi-Fi:  npm run fetch:cameras
 *
 * No dependencies; uses Node 18+ global fetch.
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

// Overpass rejects requests without a descriptive User-Agent (HTTP 406).
const USER_AGENT = "sc-alpr-radar/0.1 (personal DeFlock data pack; +https://deflock.me)";

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
    .filter((n) => Number.isFinite(n));
}

function isOmni(tags) {
  return (
    tags["camera:type"] === "dome" ||
    tags["surveillance:zone"] === "town" ||
    String(tags["direction"]).trim() === "360"
  );
}

async function overpass() {
  let lastErr;
  // A couple of passes so transient rate-limits (HTTP 429) can clear.
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const endpoint of ENDPOINTS) {
      try {
        console.log(`Querying ${endpoint} (attempt ${attempt + 1}) …`);
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
        return await res.json();
      } catch (e) {
        console.warn(`  failed: ${e.message}`);
        lastErr = e;
        await sleep(3000);
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
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [el.lon, el.lat] },
      properties: {
        id: `node/${el.id}`,
        brand: normalizeBrand(rawBrand),
        rawBrand: rawBrand ?? null,
        directions: parseDirections(tags),
        omni: isOmni(tags),
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
  for (const f of features) {
    const b = f.properties.brand;
    byBrand[b] = (byBrand[b] ?? 0) + 1;
  }
  console.table(byBrand);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
