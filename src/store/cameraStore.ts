import { create } from "zustand";
import type { Camera, CameraDataset } from "@/types";
import { CameraGrid } from "@/services/geo";
import { cameraFromFeatureProps } from "@/services/cameraParse";
import {
  loadCameras,
  loadCommunityCache,
  loadCustomCameras,
  loadRadioCache,
  saveCameras,
  saveCommunityCache,
  saveCustomCameras,
  saveRadioCache,
} from "@/services/storage";
import { fetchCommunityCameras } from "@/services/community";
import {
  fetchLiveIncidents,
  fetchRadioSites,
  fetchWigleCandidates,
} from "@/services/extraLayers";
import { PACK_SCHEMA_VERSION, updateCameras } from "@/services/sync";

type Status = "idle" | "loading" | "ready" | "empty" | "error";

interface CameraState {
  /** The bundled/live pack (excludes user-added cameras). */
  pack: CameraDataset | null;
  /** Community-submitted cameras fetched from the shared GitHub dataset. */
  community: Camera[];
  /** User-added cameras, persisted on device and merged into the map. */
  custom: Camera[];
  /**
   * Layers shipped as their own files: FCC radio sites and unconfirmed WiGLE
   * candidates. Grouped because they load and cache identically.
   */
  extra: Camera[];
  /**
   * Live road incidents. Deliberately not persisted — a stale incident is worse
   * than no incident, so these simply vanish when you go offline.
   */
  incidents: Camera[];
  /** Combined view (pack + community + custom + extra + incidents). */
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
  refreshIncidents: () => Promise<void>;
}

function combine(
  pack: CameraDataset | null,
  community: Camera[],
  custom: Camera[],
  extra: Camera[] = [],
  incidents: Camera[] = [],
): CameraDataset {
  // Drop local customs that already exist in the shared dataset (e.g. after the
  // user shared one and it was accepted) so they don't appear twice.
  const key = (c: Camera) =>
    `${c.kind}@${c.lat.toFixed(4)},${c.lon.toFixed(4)}`;
  const shared = new Set(community.map(key));
  const localOnly = custom.filter((c) => !shared.has(key(c)));
  const cameras = [
    ...(pack?.cameras ?? []),
    ...community,
    ...localOnly,
    ...extra,
    ...incidents,
  ];
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
  extra: [],
  incidents: [],
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
        // Rebuild from the bundle when the cached pack predates the current
        // schema (new kinds/fields) or is missing derived metadata entirely.
        const needsUpgrade =
          (pack.schemaVersion ?? 1) < PACK_SCHEMA_VERSION ||
          pack.cameras.some((c) => !c.purpose || !c.kind);
        if (needsUpgrade) {
          pack = await updateCameras("bundled");
        } else {
          await saveCameras(pack);
        }
      }
      const custom = await loadCustomCameras();
      const community = await loadCommunityCache();
      const extra = await loadRadioCache();
      const dataset = combine(pack, community, custom, extra, get().incidents);
      set({
        pack,
        community,
        custom,
        extra,
        dataset,
        grid: new CameraGrid(dataset.cameras),
        status: dataset.count > 0 ? "ready" : "empty",
        error: null,
      });

      // Radio sites are a large, rarely-changing file — fetch both extra layers
      // off the critical path so the map is usable immediately on a slow
      // hotspot, and keep the cached copy if either fetch fails offline.
      void Promise.all([fetchRadioSites(), fetchWigleCandidates()]).then(
        ([sites, candidates]) => {
          if (sites == null && candidates == null) return;
          const fresh = [...(sites ?? []), ...(candidates ?? [])];
          if (fresh.length === 0) return;
          void saveRadioCache(fresh);
          const next = combine(
            get().pack,
            get().community,
            get().custom,
            fresh,
            get().incidents,
          );
          set({
            extra: fresh,
            dataset: next,
            grid: new CameraGrid(next.cameras),
            status: next.count > 0 ? "ready" : "empty",
          });
        },
      );

      void get().refreshIncidents();

      // Refresh the shared community dataset in the background (non-blocking).
      // Prefer tip-of-main sources so newly approved cameras appear without a
      // Pages redeploy. `null` means every source failed; keep the cache.
      void fetchCommunityCameras().then((fresh) => {
        if (fresh == null) return;
        void saveCommunityCache(fresh);
        const next = combine(get().pack, fresh, get().custom, get().extra, get().incidents);
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
      const dataset = combine(pack, community, get().custom, get().extra, get().incidents);
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
    const dataset = combine(get().pack, get().community, custom, get().extra, get().incidents);
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
    const dataset = combine(get().pack, get().community, custom, get().extra, get().incidents);
    set({
      custom,
      dataset,
      grid: new CameraGrid(dataset.cameras),
    });
  },

  refreshIncidents: async () => {
    const incidents = await fetchLiveIncidents();
    // null means every mirror failed; keep whatever we already had rather than
    // blanking the layer on one bad poll.
    if (incidents == null) return;
    const next = combine(
      get().pack,
      get().community,
      get().custom,
      get().extra,
      incidents,
    );
    set({
      incidents,
      dataset: next,
      grid: new CameraGrid(next.cameras),
      status: next.count > 0 ? "ready" : "empty",
    });
  },

  removeCamera: async (id) => {
    const custom = get().custom.filter((c) => c.id !== id);
    await saveCustomCameras(custom);
    const dataset = combine(get().pack, get().community, custom, get().extra, get().incidents);
    set({
      custom,
      dataset,
      grid: new CameraGrid(dataset.cameras),
    });
  },
}));
