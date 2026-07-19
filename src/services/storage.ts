import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Camera, CameraDataset, SavedRoute, Settings } from "@/types";

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
  showAlpr: true,
  showTraffic: true,
  alertTraffic: false,
  basemap: "streets",
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

export async function loadSettings(): Promise<Settings> {
  const stored = (await (await db()).get("meta", "settings")) as Partial<Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await (await db()).put("meta", settings, "settings");
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
