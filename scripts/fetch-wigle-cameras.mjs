#!/usr/bin/env node
/**
 * Build public/data/sc-wigle-candidates.geojson — likely ALPR cameras found by
 * their WiFi signature in WiGLE's public wardriving database, for cameras that
 * nobody has mapped in OpenStreetMap yet.
 *
 *   WIGLE_API_NAME=... WIGLE_API_TOKEN=... node scripts/fetch-wigle-cameras.mjs
 *
 * Why the patterns below are so narrow: a naive `%flock%` search returns mostly
 * restaurants, home networks and sports-team puns. Validation against known OSM
 * ALPR positions showed the exact SSID "Flock" lands within 200 m of a mapped
 * ALPR 38% of the time versus a 2.1% control rate for random nearby points —
 * an ~18x enrichment. Broader patterns did not survive that test, so they are
 * deliberately not included. Re-run the validation before adding one.
 *
 * Output is marked `unconfirmed`: strong evidence is not proof, and a business
 * whose WiFi happens to match looks identical from a passing car. The app
 * renders these differently and never sounds an alert for them.
 */
import { readFileSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../public/data/sc-wigle-candidates.geojson");
const PACK = resolve(__dirname, "../public/data/sc-cameras.geojson");

const { WIGLE_API_NAME, WIGLE_API_TOKEN } = process.env;

// South Carolina bounding box.
const BBOX = { lat1: 32.0, lat2: 35.25, lon1: -83.4, lon2: -78.5 };

/**
 * Validated signatures only. `ssid` is an exact match (WiGLE's `ssid` param);
 * `brand` is what we attribute a hit to.
 */
const SIGNATURES = [
  { ssid: "Flock", brand: "Flock Safety", label: "Flock Safety camera" },
];

/** Don't emit a candidate this close to something already on the map. */
const DEDUPE_METERS = 200;

const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;
function meters(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function wigleSearch(ssid) {
  const auth = Buffer.from(`${WIGLE_API_NAME}:${WIGLE_API_TOKEN}`).toString(
    "base64",
  );
  const params = new URLSearchParams({
    onlymine: "false",
    latrange1: String(BBOX.lat1),
    latrange2: String(BBOX.lat2),
    longrange1: String(BBOX.lon1),
    longrange2: String(BBOX.lon2),
    resultsPerPage: "100",
    ssid,
  });
  const res = await fetch(`https://api.wigle.net/api/v2/network/search?${params}`, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
  });
  if (res.status === 401) throw new Error("WiGLE rejected the credentials");
  if (res.status === 429) {
    throw new Error("WiGLE daily query quota exhausted — try again tomorrow");
  }
  if (!res.ok) throw new Error(`WiGLE HTTP ${res.status}`);
  const json = await res.json();
  if (json.success === false) {
    throw new Error(`WiGLE error: ${json.message ?? "unknown"}`);
  }
  return json.results ?? [];
}

async function main() {
  if (!WIGLE_API_NAME || !WIGLE_API_TOKEN) {
    console.error(
      "Missing WIGLE_API_NAME / WIGLE_API_TOKEN.\n" +
        "Set them in .env (gitignored) or as GitHub Actions secrets.",
    );
    process.exit(1);
  }

  const pack = JSON.parse(readFileSync(PACK, "utf8"));
  const known = pack.features.map((f) => ({
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
  }));
  console.log(`Known mapped points: ${known.length}`);

  const features = [];
  let totalHits = 0;

  for (const sig of SIGNATURES) {
    console.log(`\nQuerying WiGLE for SSID "${sig.ssid}" …`);
    const results = await wigleSearch(sig.ssid);
    totalHits += results.length;
    console.log(`  ${results.length} observations`);

    let novel = 0;
    for (const r of results) {
      const lat = r.trilat;
      const lon = r.trilong;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const p = { lat, lon };
      if (known.some((k) => meters(p, k) <= DEDUPE_METERS)) continue;
      novel++;

      const firstSeen = (r.firsttime ?? "").slice(0, 10);
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lon, lat] },
        properties: {
          id: `wigle/${r.netid}`,
          kind: "alpr",
          brand: sig.brand,
          rawBrand: "WiGLE RF signature",
          name: `Possible ${sig.label}`,
          operator: null,
          directions: [],
          omni: true,
          zone: null,
          purpose: `Unconfirmed — WiFi signature matches a ${sig.label}. Not verified by eye.`,
          imageUrl: null,
          fovHalfAngle: 180,
          unconfirmed: true,
          evidence:
            `WiGLE: SSID "${r.ssid}", ${r.netid}` +
            (firstSeen ? `, first seen ${firstSeen}` : ""),
        },
      });
    }
    console.log(`  ${novel} not already on the map`);
  }

  const fc = {
    type: "FeatureCollection",
    generatedAt: new Date().toISOString(),
    count: features.length,
    features,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(fc));
  console.log(
    `\nWrote ${features.length} unconfirmed candidates (from ${totalHits} observations) to ${OUT}`,
  );
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
