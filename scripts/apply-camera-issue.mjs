#!/usr/bin/env node
/**
 * Parse a "camera-submission" issue (GitHub issue form) and append the camera to
 * the shared community dataset. Run by .github/workflows/community-camera.yml.
 *
 * Writes step outputs (status, message) to $GITHUB_OUTPUT so the workflow can
 * comment on / close the issue.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(__dirname, "../public/data/community-cameras.json");

// Rough South Carolina bounding box (with a little slack).
const SC = { minLat: 31.9, maxLat: 35.3, minLon: -83.6, maxLon: -78.3 };
const KINDS = new Set(["alpr", "traffic", "speed"]);

async function setOutput(status, message) {
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    await writeFile(out, `status=${status}\nmessage=${message}\n`, { flag: "a" });
  }
  console.log(`[${status}] ${message}`);
}

/** Parse "### Label\n\nvalue" sections from a GitHub issue-form body. */
function parseForm(body) {
  const fields = {};
  const parts = body.split(/^###\s+/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf("\n");
    if (nl === -1) continue;
    const label = part.slice(0, nl).trim().toLowerCase();
    const value = part.slice(nl).trim();
    fields[label] = value === "_No response_" ? "" : value;
  }
  return fields;
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    await setOutput("error", "No event payload.");
    process.exit(0);
  }
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const issue = event.issue;
  if (!issue) {
    await setOutput("error", "No issue in payload.");
    process.exit(0);
  }

  const f = parseForm(issue.body ?? "");
  const lat = Number.parseFloat(f["latitude"]);
  const lon = Number.parseFloat(f["longitude"]);
  const kind = (f["type"] || "alpr").toLowerCase();
  const name = (f["name / location (optional)"] || "").slice(0, 80) || undefined;

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    await setOutput("error", "Could not read a valid latitude/longitude.");
    process.exit(0);
  }
  if (lat < SC.minLat || lat > SC.maxLat || lon < SC.minLon || lon > SC.maxLon) {
    await setOutput(
      "error",
      `Coordinates ${lat}, ${lon} are outside South Carolina.`,
    );
    process.exit(0);
  }
  if (!KINDS.has(kind)) {
    await setOutput("error", `Unknown type "${kind}".`);
    process.exit(0);
  }

  const file = JSON.parse(await readFile(DATA, "utf8"));
  const id = `community/${issue.number}`;
  // Drop any prior entry from this same issue (handles edits) before de-duping.
  const cameras = (Array.isArray(file.cameras) ? file.cameras : []).filter(
    (c) => c.id !== id,
  );

  // Reject near-duplicates (~20 m) of the same kind from other submissions.
  const dup = cameras.find(
    (c) =>
      c.kind === kind &&
      Math.abs(c.lat - lat) < 0.0002 &&
      Math.abs(c.lon - lon) < 0.0002,
  );
  if (dup) {
    await setOutput("duplicate", "That camera is already in the dataset.");
    process.exit(0);
  }

  cameras.push({
    id,
    lat: Number(lat.toFixed(6)),
    lon: Number(lon.toFixed(6)),
    kind,
    brand: "Other",
    name,
    operator: "Community submission",
    directions: [],
    omni: true,
    purpose:
      kind === "alpr"
        ? "Community-reported plate reader"
        : kind === "speed"
          ? "Community-reported speed camera"
          : "Community-reported traffic camera",
    fovHalfAngle: 40,
    submittedBy: issue.user?.login ?? "unknown",
    submittedAt: new Date().toISOString(),
  });

  file.cameras = cameras;
  file.updatedAt = new Date().toISOString();
  await writeFile(DATA, JSON.stringify(file, null, 2) + "\n");
  await setOutput(
    "added",
    `Added ${kind} camera at ${lat.toFixed(5)}, ${lon.toFixed(5)}. Total: ${cameras.length}.`,
  );
}

main().catch(async (e) => {
  await setOutput("error", e.message);
  process.exit(0);
});
