import type { Camera } from "@/types";

/**
 * Live aircraft from airplanes.live.
 *
 * Chosen over OpenSky and adsb.lol purely because it is the one that sends
 * `Access-Control-Allow-Origin: *` — the others are browser-blocked and would
 * need a proxy, and proxying through a 10-minute cron would be useless for
 * something moving 150 mph.
 */
const API = "https://api.airplanes.live/v2/point";

/** Search radius in nautical miles (the endpoint caps at 250). */
const RADIUS_NM = 60;

/**
 * Above this, it's an airliner in cruise and irrelevant to anything happening
 * on your road. Surveillance and patrol work happens low.
 */
const MAX_ALT_FT = 12_000;

/**
 * Operators worth flagging. Deliberately does not match "MED-TRANS" and other
 * air-ambulance operators, which fly the same helicopter types at the same
 * altitudes and would otherwise dominate the results.
 */
const LAW_ENFORCEMENT =
  /\b(POLICE|SHERIFF|STATE PATROL|HIGHWAY PATROL|PUBLIC SAFETY|LAW ENFORCE\w*|MARSHAL|CONSTABLE|F\.?B\.?I|DEPT OF JUSTICE|HOMELAND|CUSTOMS|BORDER PROTECTION|AVIATION UNIT|SLED)\b/i;

interface RawAircraft {
  hex: string;
  r?: string;
  t?: string;
  desc?: string;
  ownOp?: string;
  flight?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | string;
  gs?: number;
  track?: number;
  category?: string;
}

function isHelicopter(a: RawAircraft): boolean {
  if (a.category === "A7") return true;
  return /^(EC|AS3|B06|B407|B429|R44|R66|MD5|H60|H64|S76|A109|BK17)/i.test(
    a.t ?? "",
  );
}

function classify(a: RawAircraft): { label: string; le: boolean } {
  const who = `${a.ownOp ?? ""} ${a.desc ?? ""}`;
  const le = LAW_ENFORCEMENT.test(who);
  if (le) return { label: "Law enforcement aircraft", le: true };
  if (isHelicopter(a)) return { label: "Helicopter", le: false };
  return { label: "Aircraft", le: false };
}

/**
 * Aircraft currently overhead, as map points.
 *
 * Returns null on failure so callers can keep the previous set rather than
 * blinking the layer out on one bad poll.
 */
export async function fetchAircraft(
  lat: number,
  lon: number,
): Promise<Camera[] | null> {
  try {
    const res = await fetch(
      `${API}/${lat.toFixed(3)}/${lon.toFixed(3)}/${RADIUS_NM}`,
      { cache: "no-store" },
    );
    if (!res.ok) return null;
    const json = await res.json();
    const out: Camera[] = [];

    for (const a of (json.ac ?? []) as RawAircraft[]) {
      if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) continue;

      // alt_baro is "ground" for aircraft on the tarmac.
      const onGround = a.alt_baro === "ground";
      const alt = onGround ? 0 : Number(a.alt_baro);
      if (!onGround && (!Number.isFinite(alt) || alt > MAX_ALT_FT)) continue;

      const { label, le } = classify(a);
      const tail = a.r ?? a.hex.toUpperCase();
      const speed = Number.isFinite(a.gs) ? ` · ${Math.round(a.gs!)} kt` : "";
      const owner = a.ownOp ? ` · ${a.ownOp}` : "";

      out.push({
        id: `air/${a.hex}`,
        lat: a.lat!,
        lon: a.lon!,
        kind: "aircraft",
        brand: "Other",
        rawBrand: le ? "Law enforcement" : label,
        name: `${tail}${a.t ? ` (${a.t})` : ""}`,
        operator: a.ownOp,
        directions: Number.isFinite(a.track) ? [a.track!] : [],
        omni: !Number.isFinite(a.track),
        purpose:
          `${label} — ${onGround ? "on ground" : `${alt.toLocaleString()} ft`}` +
          `${speed}${owner}`,
        fovHalfAngle: 30,
        lawEnforcement: le,
        trackDeg: Number.isFinite(a.track) ? a.track : undefined,
        groundSpeedKt: Number.isFinite(a.gs) ? a.gs : undefined,
        fixedAt: Date.now(),
      });
    }
    return out;
  } catch {
    return null;
  }
}
