import { create } from "zustand";
import type { Camera, CameraDataset } from "@/types";
import { CameraGrid } from "@/services/geo";
import { cameraFromFeatureProps } from "@/services/cameraParse";
import {
  loadCameras,
  loadCommunityCache,
  loadCustomCameras,
  saveCameras,
  saveCommunityCache,
  saveCustomCameras,
} from "@/services/storage";
import { fetchCommunityCameras } from "@/services/community";
import { updateCameras } from "@/services/sync";

type Status = "idle" | "loading" | "ready" | "empty" | "error";

interface CameraState {
  /** The bundled/live pack (excludes user-added cameras). */
  pack: CameraDataset | null;
  /** Community-submitted cameras fetched from the shared GitHub dataset. */
  community: Camera[];
  /** User-added cameras, persisted on device and merged into the map. */
  custom: Camera[];
  /** Combined view (pack + community + custom) used by map, grid and alerts. */
  dataset: CameraDataset | null;
  grid: CameraGrid | null;
  status: Status;
  error: string | null;
  updating: boolean;
  hydrate: () => Promise<void>;
  refresh: (source: "bundled" | "live") => Promise<void>;
  addCamera: (camera: Camera) => Promise<void>;
  updateCamera: (id: string, patch: Partial<Camera>) => Promise<void>;
  removeCamera: (id: string) => Promise<void>;
}

function combine(
  pack: CameraDataset | null,
  community: Camera[],
  custom: Camera[],
): CameraDataset {
  // Drop local customs that already exist in the shared dataset (e.g. after the
  // user shared one and it was accepted) so they don't appear twice.
  const key = (c: Camera) =>
    `${c.kind}@${c.lat.toFixed(4)},${c.lon.toFixed(4)}`;
  const shared = new Set(community.map(key));
  const localOnly = custom.filter((c) => !shared.has(key(c)));
  const cameras = [...(pack?.cameras ?? []), ...community, ...localOnly];
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
  community: [],
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
      const community = await loadCommunityCache();
      const dataset = combine(pack, community, custom);
      set({
        pack,
        community,
        custom,
        dataset,
        grid: new CameraGrid(dataset.cameras),
        status: dataset.count > 0 ? "ready" : "empty",
        error: null,
      });

      // Refresh the shared community dataset in the background (non-blocking).
      // Prefer tip-of-main sources so newly approved cameras appear without a
      // Pages redeploy. `null` means every source failed; keep the cache.
      void fetchCommunityCameras().then((fresh) => {
        if (fresh == null) return;
        void saveCommunityCache(fresh);
        const next = combine(get().pack, fresh, get().custom);
        set({
          community: fresh,
          dataset: next,
          grid: new CameraGrid(next.cameras),
          status: next.count > 0 ? "ready" : "empty",
        });
      });
    } catch (e) {
      set({ status: "error", error: (e as Error).message });
    }
  },

  refresh: async (source) => {
    set({ updating: true, error: null });
    try {
      const pack = await updateCameras(source);
      const community = (await fetchCommunityCameras()) ?? get().community;
      void saveCommunityCache(community);
      const dataset = combine(pack, community, get().custom);
      set({
        pack,
        community,
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
    const dataset = combine(get().pack, get().community, custom);
    set({
      custom,
      dataset,
      grid: new CameraGrid(dataset.cameras),
      status: dataset.count > 0 ? "ready" : "empty",
    });
  },

  updateCamera: async (id, patch) => {
    const custom = get().custom.map((c) =>
      c.id === id ? { ...c, ...patch, id: c.id, custom: true } : c,
    );
    await saveCustomCameras(custom);
    const dataset = combine(get().pack, get().community, custom);
    set({
      custom,
      dataset,
      grid: new CameraGrid(dataset.cameras),
    });
  },

  removeCamera: async (id) => {
    const custom = get().custom.filter((c) => c.id !== id);
    await saveCustomCameras(custom);
    const dataset = combine(get().pack, get().community, custom);
    set({
      custom,
      dataset,
      grid: new CameraGrid(dataset.cameras),
    });
  },
}));
