import { create } from "zustand";
import type { Settings } from "@/types";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "@/services/storage";

interface SettingsState extends Settings {
  loaded: boolean;
  hydrate: () => Promise<void>;
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

function pickSettings(s: Settings): Settings {
  return {
    alertDistanceFeet: s.alertDistanceFeet,
    muted: s.muted,
    flockOnly: s.flockOnly,
    headingUp: s.headingUp,
    escalate: s.escalate,
    showFov: s.showFov,
    showAlpr: s.showAlpr,
    showTraffic: s.showTraffic,
    alertTraffic: s.alertTraffic,
    basemap: s.basemap,
  };
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...DEFAULT_SETTINGS,
  loaded: false,
  hydrate: async () => {
    const stored = await loadSettings();
    set({ ...stored, loaded: true });
  },
  set: (key, value) => {
    set({ [key]: value } as Partial<SettingsState>);
    void saveSettings(pickSettings(get()));
  },
}));
