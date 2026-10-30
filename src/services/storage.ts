import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type {
  Camera,
  CameraDataset,
  SavedRoute,
  Settings,
  Trip,
} from "@/types";

interface AlprDB extends DBSchema {
  meta: {
    key: string;
    value: unknown;
  };
  routes: {
    key: string;
    value: SavedRoute;
  };
}

const DB_NAME = "sc-alpr-radar";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<AlprDB>> | null = null;

function db(): Promise<IDBPDatabase<AlprDB>> {
  if (!dbPromise) {
    dbPromise = openDB<AlprDB>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains("meta")) {
          database.createObjectStore("meta");
        }
        if (!database.objectStoreNames.contains("routes")) {
          database.createObjectStore("routes", { keyPath: "id" });
        }
      },
    });
  }
  return dbPromise;
}

export const DEFAULT_SETTINGS: Settings = {
  alertDistanceFeet: 1500,
  muted: false,
  flockOnly: false,
  headingUp: true,
  escalate: true,
  showFov: true,
  alertSound: "chirp",
  showAlpr: true,
  showTraffic: true,
  showGunshot: true,
  showPolice: true,
  showRadio: false,
  showUnconfirmed: true,
  showIncidents: true,
  showAircraft: true,
  // Alert on everything detectable by default; each kind can be turned off
  // individually. Police stations and radio towers are the exception — see
  // PASSIVE_KINDS.
  alertTraffic: true,
  alertUnconfirmed: true,
  alertIncidents: true,
  dimHeadlights: false,
  basemap: "streets",
  avoidFlock: true,
  avoidOtherAlpr: true,
  avoidTraffic: false,
  avoidCustom: true,
  avoidCommunity: true,
  osmLayers: [],
};

export async function loadCameras(): Promise<CameraDataset | undefined> {
  return (await db()).get("meta", "cameras") as Promise<CameraDataset | undefined>;
}

export async function saveCameras(dataset: CameraDataset): Promise<void> {
  await (await db()).put("meta", dataset, "cameras");
}

export async function loadCustomCameras(): Promise<Camera[]> {
  const stored = (await (await db()).get("meta", "customCameras")) as
    | Camera[]
    | undefined;
  return stored ?? [];
}

export async function saveCustomCameras(cameras: Camera[]): Promise<void> {
  await (await db()).put("meta", cameras, "customCameras");
}

export async function loadCommunityCache(): Promise<Camera[]> {
  const stored = (await (await db()).get("meta", "communityCameras")) as
    | Camera[]
    | undefined;
  return stored ?? [];
}

export async function saveCommunityCache(cameras: Camera[]): Promise<void> {
  await (await db()).put("meta", cameras, "communityCameras");
}

export async function loadRadioCache(): Promise<Camera[]> {
  const stored = (await (await db()).get("meta", "radioSites")) as
    | Camera[]
    | undefined;
  return stored ?? [];
}

export async function saveRadioCache(cameras: Camera[]): Promise<void> {
  await (await db()).put("meta", cameras, "radioSites");
}

const ALERT_SOUND_IDS = new Set([
  "chirp",
  "pulse",
  "siren",
  "ping",
  "klaxon",
  "triple",
  "digital",
]);

/**
 * Bumped when a default changes in a way that should reach people who already
 * have settings saved. Plain `{...DEFAULTS, ...stored}` can't do that — a
 * stored `false` is indistinguishable from a deliberate one — so each migration
 * below resets only the specific keys it owns.
 */
const SETTINGS_VERSION = 2;

export async function loadSettings(): Promise<Settings> {
  const stored = (await (await db()).get("meta", "settings")) as
    | (Partial<Settings> & { settingsVersion?: number })
    | undefined;
  const merged = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };

  // v2: alerts changed from "cameras only" to "everything detectable".
  if (stored && (stored.settingsVersion ?? 1) < 2) {
    merged.alertTraffic = DEFAULT_SETTINGS.alertTraffic;
    merged.alertUnconfirmed = DEFAULT_SETTINGS.alertUnconfirmed;
  }

  if (!ALERT_SOUND_IDS.has(merged.alertSound)) {
    merged.alertSound = DEFAULT_SETTINGS.alertSound;
  }
  if (!Array.isArray(merged.osmLayers)) merged.osmLayers = [];
  return merged;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await (await db()).put(
    "meta",
    { ...settings, settingsVersion: SETTINGS_VERSION },
    "settings",
  );
}

export async function listRoutes(): Promise<SavedRoute[]> {
  const all = await (await db()).getAll("routes");
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function saveRoute(route: SavedRoute): Promise<void> {
  await (await db()).put("routes", route);
}

export async function deleteRoute(id: string): Promise<void> {
  await (await db()).delete("routes", id);
}

/**
 * Trips live in the meta store as one array: there are only ever a handful,
 * and keeping them out of a new object store avoids an IndexedDB version bump.
 * Old single A→B saved routes are folded in as one-plan trips on first load.
 */
export async function listTrips(): Promise<Trip[]> {
  const database = await db();
  let trips = ((await database.get("meta", "trips")) as Trip[] | undefined) ?? [];
  const legacy = await database.getAll("routes");
  if (legacy.length) {
    trips = [...trips, ...legacy.map(legacyRouteToTrip)];
    await database.put("meta", trips, "trips");
    for (const r of legacy) await database.delete("routes", r.id);
  }
  return trips.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function saveTrip(trip: Trip): Promise<void> {
  const database = await db();
  const trips = ((await database.get("meta", "trips")) as Trip[] | undefined) ?? [];
  const next = trips.filter((t) => t.id !== trip.id);
  next.push(trip);
  await database.put("meta", next, "trips");
}

export async function deleteTrip(id: string): Promise<void> {
  const database = await db();
  const trips = ((await database.get("meta", "trips")) as Trip[] | undefined) ?? [];
  await database.put(
    "meta",
    trips.filter((t) => t.id !== id),
    "trips",
  );
}

function legacyRouteToTrip(r: SavedRoute): Trip {
  const route = {
    coordinates: r.coordinates,
    distanceMeters: r.distanceMeters,
    durationSeconds: r.durationSeconds,
    cameraCount: r.camerasUnavoidable,
    steps: r.steps,
    legs: [
      {
        distanceMeters: r.distanceMeters,
        durationSeconds: r.durationSeconds,
        cameraCount: r.camerasUnavoidable,
      },
    ],
  };
  return {
    id: r.id,
    name: r.destinationLabel,
    createdAt: r.createdAt,
    updatedAt: r.createdAt,
    plans: [
      {
        id: `${r.id}-a`,
        name: "Plan A",
        notes: "",
        prefer: "avoid",
        stops: [
          { id: `${r.id}-o`, label: "Start", point: r.origin },
          { id: `${r.id}-d`, label: r.destinationLabel, point: r.destination },
        ],
        // Key left blank so the planner treats it as stale and re-plans
        // against today's cameras the first time it's opened.
        computed: {
          avoid: route,
          fastest: route,
          computedAt: r.createdAt,
          key: "",
        },
      },
    ],
  };
}
