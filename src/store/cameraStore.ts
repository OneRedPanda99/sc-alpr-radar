import { create } from "zustand";
import type { Camera, CameraDataset } from "@/types";
import { CameraGrid } from "@/services/geo";
import { cameraFromFeatureProps } from "@/services/cameraParse";
import {
  loadCameras,
  loadCustomCameras,
  saveCameras,
  saveCustomCameras,
} from "@/services/storage";
import { updateCameras } from "@/services/sync";

type Status = "idle" | "loading" | "ready" | "empty" | "error";

interface CameraState {
  /** The bundled/live pack (excludes user-added cameras). */
  pack: CameraDataset | null;
  /** User-added cameras, persisted on device and merged into the map. */
  custom: Camera[];
  /** Combined view (pack + custom) used by the map, grid and alerts. */
  dataset: CameraDataset | null;
  grid: CameraGrid | null;
  status: Status;
  error: string | null;
  updating: boolean;
  hydrate: () => Promise<void>;
  refresh: (source: "bundled" | "live") => Promise<void>;
  addCamera: (camera: Camera) => Promise<void>;
  removeCamera: (id: string) => Promise<void>;
}

function combine(pack: CameraDataset | null, custom: Camera[]): CameraDataset {
  const cameras = [...(pack?.cameras ?? []), ...custom];
  return {
    generatedAt: pack?.generatedAt ?? new Date().toISOString(),
    syncedAt: pack?.syncedAt,
    count: cameras.length,
    cameras,
  };
}

/** Upgrade older IndexedDB packs that predate purpose / FOV fields. */
function normalizeDataset(dataset: CameraDataset): CameraDataset {
  const cameras = dataset.cameras.map((c) =>
    cameraFromFeatureProps(c.id, c.lat, c.lon, c as unknown as Record<string, unknown>),
  );
  return { ...dataset, cameras, count: cameras.length };
}

export const useCameraStore = create<CameraState>((set, get) => ({
  pack: null,
  custom: [],
  dataset: null,
  grid: null,
  status: "idle",
  error: null,
  updating: false,

  hydrate: async () => {
    set({ status: "loading" });
    try {
      let pack = await loadCameras();
      // First launch: seed from the bundled pack automatically.
      if (!pack) {
        pack = await updateCameras("bundled");
      } else {
        pack = normalizeDataset(pack);
        // If the pack predates purpose or camera-kind metadata, prefer the newer bundle.
        const needsUpgrade = pack.cameras.some((c) => !c.purpose || !c.kind);
        if (needsUpgrade) {
          pack = await updateCameras("bundled");
        } else {
          await saveCameras(pack);
        }
      }
      const custom = await loadCustomCameras();
      const dataset = combine(pack, custom);
      set({
        pack,
        custom,
        dataset,
        grid: new CameraGrid(dataset.cameras),
        status: dataset.count > 0 ? "ready" : "empty",
        error: null,
      });
    } catch (e) {
      set({ status: "error", error: (e as Error).message });
    }
  },

  refresh: async (source) => {
    set({ updating: true, error: null });
    try {
      const pack = await updateCameras(source);
      const custom = get().custom;
      const dataset = combine(pack, custom);
      set({
        pack,
        dataset,
        grid: new CameraGrid(dataset.cameras),
        status: dataset.count > 0 ? "ready" : "empty",
        updating: false,
      });
    } catch (e) {
      set({ updating: false, error: (e as Error).message });
    }
  },

  addCamera: async (camera) => {
    const custom = [...get().custom, camera];
    await saveCustomCameras(custom);
    const dataset = combine(get().pack, custom);
    set({
      custom,
      dataset,
      grid: new CameraGrid(dataset.cameras),
      status: dataset.count > 0 ? "ready" : "empty",
    });
  },

  removeCamera: async (id) => {
    const custom = get().custom.filter((c) => c.id !== id);
    await saveCustomCameras(custom);
    const dataset = combine(get().pack, custom);
    set({
      custom,
      dataset,
      grid: new CameraGrid(dataset.cameras),
    });
  },
}));
