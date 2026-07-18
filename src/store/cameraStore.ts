import { create } from "zustand";
import type { CameraDataset } from "@/types";
import { CameraGrid } from "@/services/geo";
import { cameraFromFeatureProps } from "@/services/cameraParse";
import { loadCameras, saveCameras } from "@/services/storage";
import { updateCameras } from "@/services/sync";

type Status = "idle" | "loading" | "ready" | "empty" | "error";

interface CameraState {
  dataset: CameraDataset | null;
  grid: CameraGrid | null;
  status: Status;
  error: string | null;
  updating: boolean;
  hydrate: () => Promise<void>;
  refresh: (source: "bundled" | "live") => Promise<void>;
}

function buildGrid(dataset: CameraDataset): CameraGrid {
  return new CameraGrid(dataset.cameras);
}

/** Upgrade older IndexedDB packs that predate purpose / FOV fields. */
function normalizeDataset(dataset: CameraDataset): CameraDataset {
  const cameras = dataset.cameras.map((c) =>
    cameraFromFeatureProps(c.id, c.lat, c.lon, c as unknown as Record<string, unknown>),
  );
  return { ...dataset, cameras, count: cameras.length };
}

export const useCameraStore = create<CameraState>((set) => ({
  dataset: null,
  grid: null,
  status: "idle",
  error: null,
  updating: false,

  hydrate: async () => {
    set({ status: "loading" });
    try {
      let dataset = await loadCameras();
      // First launch: seed from the bundled pack automatically.
      if (!dataset) {
        dataset = await updateCameras("bundled");
      } else {
        dataset = normalizeDataset(dataset);
        // If the pack predates purpose or camera-kind metadata, prefer the newer bundle.
        const needsUpgrade = dataset.cameras.some((c) => !c.purpose || !c.kind);
        if (needsUpgrade) {
          dataset = await updateCameras("bundled");
        } else {
          await saveCameras(dataset);
        }
      }
      set({
        dataset,
        grid: buildGrid(dataset),
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
      const dataset = await updateCameras(source);
      set({
        dataset,
        grid: buildGrid(dataset),
        status: dataset.count > 0 ? "ready" : "empty",
        updating: false,
      });
    } catch (e) {
      set({ updating: false, error: (e as Error).message });
    }
  },
}));
