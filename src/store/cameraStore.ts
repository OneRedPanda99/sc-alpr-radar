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
import { fetchAircraft } from "@/services/aircraft";
import {
  fetchLiveIncidents,
  fetchRadioSites,
  fetchWigleCandidates,
} from "@/services/extraLayers";
import {
  fetchBundledDataset,
  PACK_SCHEMA_VERSION,
  updateCameras,
} from "@/services/sync";

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
  /**
   * Aircraft overhead. Like incidents these are never persisted, but they move
   * at 150 mph so they expire far faster — a two-minute-old position is a
   * different county.
   */
  aircraft: Camera[];
  /** Combined view (pack + community + custom + extra + incidents + air). */
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
  refreshAircraft: (lat: number, lon: number) => Promise<void>;
}

function combine(
  pack: CameraDataset | null,
  community: Camera[],
  custom: Camera[],
  extra: Camera[] = [],
  incidents: Camera[] = [],
  aircraft: Camera[] = [],
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
    ...aircraft,
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
  aircraft: [],
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
      const dataset = combine(pack, community, custom, extra, get().incidents, get().aircraft);
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
            get().aircraft,
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

      // Self-healing pack refresh. Bumping PACK_SCHEMA_VERSION above catches
      // breaking changes, but forgetting to bump it is silent: the app keeps a
      // cached pack missing the new field and quietly degrades (this is exactly
      // how live stream URLs failed to reach anyone). So whenever the bundle's
      // generatedAt differs from the cached one, take the bundle.
      void fetchBundledDataset()
        .then(async (bundled) => {
          const current = get().pack;
          if (!current || bundled.generatedAt === current.generatedAt) return;
          bundled.syncedAt = new Date().toISOString();
          await saveCameras(bundled);
          const next = combine(
            bundled,
            get().community,
            get().custom,
            get().extra,
            get().incidents,
            get().aircraft,
          );
          set({
            pack: bundled,
            dataset: next,
            grid: new CameraGrid(next.cameras),
            status: next.count > 0 ? "ready" : "empty",
          });
        })
        .catch(() => {
          // Offline or the bundle is unreachable; the cached pack is fine.
        });

      // Refresh the shared community dataset in the background (non-blocking).
      // Prefer tip-of-main sources so newly approved cameras appear without a
      // Pages redeploy. `null` means every source failed; keep the cache.
      void fetchCommunityCameras().then((fresh) => {
        if (fresh == null) return;
        void saveCommunityCache(fresh);
        const next = combine(get().pack, fresh, get().custom, get().extra, get().incidents, get().aircraft);
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
      const dataset = combine(pack, community, get().custom, get().extra, get().incidents, get().aircraft);
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
    const dataset = combine(get().pack, get().community, custom, get().extra, get().incidents, get().aircraft);
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
    const dataset = combine(get().pack, get().community, custom, get().extra, get().incidents, get().aircraft);
    set({
      custom,
      dataset,
      grid: new CameraGrid(dataset.cameras),
    });
  },

  refreshAircraft: async (lat, lon) => {
    const aircraft = await fetchAircraft(lat, lon);
    // null = the poll failed; keep the last known set rather than blinking the
    // layer off, which reads as "nothing overhead".
    if (aircraft == null) return;
    const next = combine(
      get().pack,
      get().community,
      get().custom,
      get().extra,
      get().incidents,
      aircraft,
    );
    set({
      aircraft,
      dataset: next,
      grid: new CameraGrid(next.cameras),
      status: next.count > 0 ? "ready" : "empty",
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
      get().aircraft,
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
    const dataset = combine(get().pack, get().community, custom, get().extra, get().incidents, get().aircraft);
    set({
      custom,
      dataset,
      grid: new CameraGrid(dataset.cameras),
    });
  },
}));
