#!/usr/bin/env node
/**
 * Build public/data/sc-radio-sites.geojson — every licensed public-safety radio
 * transmitter site in South Carolina, from the FCC ULS Land Mobile (Private)
 * database.
 *
 * This is intentionally NOT part of the nightly refresh: the source is a 420 MB
 * national archive and licensed tower sites essentially never move. Re-run it
 * by hand every month or two:
 *
 *   node scripts/fetch-fcc-radio.mjs
 *
 * To reuse an already-extracted copy instead of re-downloading:
 *
 *   ULS_DIR=/path/to/extracted node scripts/fetch-fcc-radio.mjs
 *
 * ULS files are pipe-delimited. Field positions below were verified against the
 * live data rather than taken from the spec, which drifts.
 */
import { createReadStream, existsSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../public/data/sc-radio-sites.geojson");
const ZIP_URL = "https://data.fcc.gov/download/pub/uls/complete/l_LMpriv.zip";

/**
 * PW = Public Safety Pool (conventional), YW = Public Safety Pool (trunked).
 * These two *are* the public-safety allocation. Government pool codes (GO, GE,
 * …) also carry some police licenses, so those are admitted only when the
 * licensee name looks like law enforcement — otherwise they drag in every water
 * department in the state.
 */
const PUBLIC_SAFETY_CODES = new Set(["PW", "YW"]);
const GOV_CODES = new Set(["GO", "GE", "GB", "GI", "GJ", "GU", "PA", "PB"]);
const LAW_ENFORCEMENT =
  /\b(POLICE|SHERIFF|PUBLIC SAFETY|CONSTABLE|MARSHAL|STATE PATROL|HIGHWAY PATROL|DEPT OF PUBLIC SAFETY|LAW ENFORCEMENT)\b/i;

const STATE = "SC";

function dms(deg, min, sec, dir) {
  const d = Number(deg);
  const m = Number(min);
  const s = Number(sec);
  if (!Number.isFinite(d) || !Number.isFinite(m) || !Number.isFinite(s)) {
    return null;
  }
  const val = d + m / 60 + s / 3600;
  if (!Number.isFinite(val) || val === 0) return null;
  return dir === "S" || dir === "W" ? -val : val;
}

async function eachRow(path, fn) {
  const rl = createInterface({
    input: createReadStream(path, { encoding: "latin1" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line) fn(line.split("|"));
  }
}

async function resolveUlsDir() {
  if (process.env.ULS_DIR) {
    const dir = resolve(process.env.ULS_DIR);
    if (!existsSync(join(dir, "HD.dat"))) {
      throw new Error(`ULS_DIR=${dir} has no HD.dat`);
    }
    console.log(`Using existing ULS extract at ${dir}`);
    return { dir, cleanup: false };
  }

  const dir = join(tmpdir(), `uls-lmpriv-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const zip = join(dir, "l_LMpriv.zip");

  console.log(`Downloading ${ZIP_URL} (~420 MB) …`);
  const res = await fetch(ZIP_URL);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  await writeFile(zip, Buffer.from(await res.arrayBuffer()));

  console.log("Extracting …");
  // Only the four tables we read, to save time and disk.
  execFileSync("unzip", ["-o", "-q", zip, "HD.dat", "EN.dat", "LO.dat", "FR.dat"], {
    cwd: dir,
    stdio: "inherit",
  });
  return { dir, cleanup: true };
}

async function main() {
  const { dir, cleanup } = await resolveUlsDir();

  // Pass 1 — active licenses in a service code we might care about.
  // usi -> { call, code }
  const licenses = new Map();
  await eachRow(join(dir, "HD.dat"), (f) => {
    if (f[5] !== "A") return; // license_status: A = active
    const code = f[6];
    if (!PUBLIC_SAFETY_CODES.has(code) && !GOV_CODES.has(code)) return;
    licenses.set(f[1], { call: f[4], code });
  });
  console.log(`Active public-safety / government licenses: ${licenses.size}`);

  // Pass 2 — licensee names, so we can name the agency and vet government codes.
  await eachRow(join(dir, "EN.dat"), (f) => {
    const rec = licenses.get(f[1]);
    if (rec && f[7] && !rec.name) rec.name = f[7].trim();
  });

  // Drop government-pool licenses that aren't law enforcement.
  for (const [usi, rec] of licenses) {
    if (GOV_CODES.has(rec.code) && !LAW_ENFORCEMENT.test(rec.name ?? "")) {
      licenses.delete(usi);
    }
  }
  console.log(`After filtering government pool to law enforcement: ${licenses.size}`);

  // Pass 3 — frequencies.
  const freqs = new Map();
  await eachRow(join(dir, "FR.dat"), (f) => {
    if (!licenses.has(f[1])) return;
    const mhz = Number.parseFloat(f[10]);
    if (!Number.isFinite(mhz) || mhz <= 0) return;
    const list = freqs.get(f[1]) ?? new Set();
    list.add(Math.round(mhz * 10000) / 10000);
    freqs.set(f[1], list);
  });

  // Pass 4 — SC transmitter sites with real coordinates.
  const features = [];
  const seen = new Set();
  await eachRow(join(dir, "LO.dat"), (f) => {
    if (f[14] !== STATE) return;
    const rec = licenses.get(f[1]);
    if (!rec) return;
    const lat = dms(f[19], f[20], f[21], f[22]);
    const lon = dms(f[23], f[24], f[25], f[26]);
    if (lat == null || lon == null) return;
    // A licence can list the same site many times (one row per location
    // record); collapse to one pin per call sign + rounded position.
    const key = `${rec.call}@${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (seen.has(key)) return;
    seen.add(key);

    const mhz = [...(freqs.get(f[1]) ?? [])].sort((a, b) => a - b);
    const city = (f[12] ?? "").trim();
    const county = (f[13] ?? "").trim();
    const where = city || county;
    // The Public Safety Pool is broader than police — it also covers fire, EMS,
    // DOT and forestry. Flag the ones whose licensee is unambiguously law
    // enforcement so the map can say which is which instead of implying that
    // every pin is a cop. County-wide systems (e.g. "YORK, COUNTY OF") carry
    // police traffic too but can't be identified by name, so they stay unflagged
    // rather than being guessed at either way.
    const isLE = LAW_ENFORCEMENT.test(rec.name ?? "");

    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: {
        id: `fcc/${rec.call}/${lat.toFixed(5)},${lon.toFixed(5)}`,
        kind: "radio",
        brand: "Other",
        rawBrand: "FCC ULS",
        name: rec.name ? `${rec.name} (${rec.call})` : rec.call,
        operator: rec.name ?? null,
        directions: [],
        omni: true,
        zone: null,
        purpose: rec.name
          ? `${isLE ? "Law-enforcement" : "Public-safety"} radio transmitter — ${rec.name}${where ? `, ${where}` : ""}`
          : "Licensed public-safety radio transmitter",
        imageUrl: null,
        fovHalfAngle: 180,
        frequencies: mhz.slice(0, 40),
        lawEnforcement: isLE,
      },
    });
  });

  const fc = {
    type: "FeatureCollection",
    generatedAt: new Date().toISOString(),
    count: features.length,
    features,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(fc));
  console.log(`\nWrote ${features.length} SC public-safety transmitter sites to ${OUT}`);

  const byAgency = {};
  for (const f of features) {
    const a = f.properties.operator ?? "(unnamed)";
    byAgency[a] = (byAgency[a] ?? 0) + 1;
  }
  const top = Object.entries(byAgency).sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log("\nTop licensees:");
  for (const [a, n] of top) console.log(`  ${String(n).padStart(4)}  ${a}`);

  if (cleanup) await rm(dir, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
