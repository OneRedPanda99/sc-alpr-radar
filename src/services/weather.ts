import { create } from "zustand";
import type { LatLng } from "@/types";

/**
 * National Weather Service alerts that matter on the road: flooding first
 * (SC's real driving hazard), then tornado, severe storms, ice, fog, wind and
 * tropical systems. api.weather.gov allows browser requests, so this polls
 * directly with no server in between.
 */
const API = "https://api.weather.gov/alerts/active?area=SC";

const DRIVING = /flood|tornado|thunderstorm|hurricane|tropical|storm surge|ice|winter|freezing|fog|high wind|extreme wind/i;

export interface WeatherAlert {
  id: string;
  event: string;
  headline: string;
  severity: string;
  ends: string | null;
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
}

/** Colour by what kind of danger it is, so flooding reads as flooding. */
export function alertColor(event: string): string {
  if (/flood|surge/i.test(event)) return "#2f80ed";
  if (/tornado/i.test(event)) return "#e5383b";
  if (/thunderstorm/i.test(event)) return "#f4a261";
  if (/hurricane|tropical/i.test(event)) return "#c77dff";
  if (/ice|winter|freezing/i.test(event)) return "#90e0ef";
  return "#adb5bd";
}

/** Zone outlines don't change; fetch each once per session. */
const zoneCache = new Map<string, GeoJSON.Geometry | null>();

async function zoneGeometry(url: string): Promise<GeoJSON.Geometry | null> {
  if (zoneCache.has(url)) return zoneCache.get(url)!;
  try {
    const res = await fetch(url, { headers: { Accept: "application/geo+json" } });
    const g = res.ok ? ((await res.json()) as GeoJSON.Feature).geometry : null;
    zoneCache.set(url, g);
    return g;
  } catch {
    return null;
  }
}

/** Many watches are issued by county zone rather than a drawn polygon. */
async function alertGeometry(f: GeoJSON.Feature): Promise<WeatherAlert["geometry"] | null> {
  const g = f.geometry;
  if (g && (g.type === "Polygon" || g.type === "MultiPolygon")) return g;
  const zones = ((f.properties?.affectedZones as string[]) ?? []).slice(0, 25);
  const polys: GeoJSON.Position[][][] = [];
  for (const z of await Promise.all(zones.map(zoneGeometry))) {
    if (z?.type === "Polygon") polys.push(z.coordinates);
    else if (z?.type === "MultiPolygon") polys.push(...z.coordinates);
  }
  return polys.length ? { type: "MultiPolygon", coordinates: polys } : null;
}

export async function fetchWeatherAlerts(): Promise<WeatherAlert[] | null> {
  try {
    const res = await fetch(API, { headers: { Accept: "application/geo+json" } });
    if (!res.ok) return null;
    const json = (await res.json()) as GeoJSON.FeatureCollection;
    // "Statements" are informational bulletins, not warnings; skip them.
    const wanted = json.features.filter((f) => {
      const event = String(f.properties?.event ?? "");
      return DRIVING.test(event) && !/statement/i.test(event);
    });
    const out: WeatherAlert[] = [];
    for (const f of wanted) {
      const geometry = await alertGeometry(f);
      if (!geometry) continue;
      const p = f.properties ?? {};
      out.push({
        id: String(p.id ?? f.id),
        event: String(p.event),
        headline: String(p.headline ?? p.event),
        severity: String(p.severity ?? ""),
        ends: (p.ends ?? p.expires ?? null) as string | null,
        geometry,
      });
    }
    return out;
  } catch {
    return null;
  }
}

function inRing(p: LatLng, ring: GeoJSON.Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p.lat !== yj > p.lat && p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function alertContains(a: WeatherAlert, p: LatLng): boolean {
  const polys = a.geometry.type === "Polygon" ? [a.geometry.coordinates] : a.geometry.coordinates;
  return polys.some((rings) => inRing(p, rings[0]) && !rings.slice(1).some((h) => inRing(p, h)));
}

/** Alerts a route line passes through (sampled, so cheap on long routes). */
export function alertsOnLine(alerts: WeatherAlert[], coords: [number, number][]): WeatherAlert[] {
  if (!alerts.length || coords.length < 2) return [];
  const step = Math.max(1, Math.floor(coords.length / 400));
  const hits = new Set<WeatherAlert>();
  for (let i = 0; i < coords.length; i += step) {
    const p = { lon: coords[i][0], lat: coords[i][1] };
    for (const a of alerts) if (!hits.has(a) && alertContains(a, p)) hits.add(a);
  }
  return [...hits];
}

/** "until 6:45 PM" for the end of an alert. */
export function untilText(a: WeatherAlert): string {
  if (!a.ends) return "";
  const d = new Date(a.ends);
  return Number.isNaN(d.getTime())
    ? ""
    : `until ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

export function alertsAsGeoJSON(alerts: WeatherAlert[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: alerts.map((a) => ({
      type: "Feature",
      geometry: a.geometry,
      properties: { id: a.id, event: a.event, color: alertColor(a.event) },
    })),
  };
}

interface WeatherState {
  alerts: WeatherAlert[];
  refresh: () => Promise<void>;
}

export const useWeatherStore = create<WeatherState>((set) => ({
  alerts: [],
  refresh: async () => {
    const alerts = await fetchWeatherAlerts();
    // null = the request failed; keep the last set rather than blanking it.
    if (alerts) set({ alerts });
  },
}));
