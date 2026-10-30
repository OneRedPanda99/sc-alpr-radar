import { useSettingsStore } from "@/store/settingsStore";
import { OSM_CATEGORIES } from "@/services/osmDetails";
import { KIND_COLORS } from "@/services/brand";
import type { Settings } from "@/types";

type BoolKey = {
  [K in keyof Settings]: Settings[K] extends boolean ? K : never;
}[keyof Settings];

const CAMERA_LAYERS: { key: BoolKey; label: string; color: string }[] = [
  { key: "showAlpr", label: "Plate readers", color: KIND_COLORS.alpr },
  { key: "showTraffic", label: "Traffic & speed cams", color: KIND_COLORS.traffic },
  { key: "showIncidents", label: "Live incidents", color: KIND_COLORS.incident },
  { key: "showPolice", label: "Police stations", color: KIND_COLORS.police },
  { key: "showGunshot", label: "Gunshot detectors", color: KIND_COLORS.gunshot },
  { key: "showAircraft", label: "Aircraft overhead", color: KIND_COLORS.aircraft },
  { key: "showRadio", label: "Public-safety radio", color: KIND_COLORS.radio },
  { key: "showUnconfirmed", label: "Unconfirmed sightings", color: "#ff4d4d" },
  { key: "showFov", label: "Camera view cones", color: "#16e0b8" },
];

/** One place for everything the map can show, instead of chips plus Settings. */
export function LayersPanel({ onClose }: { onClose: () => void }) {
  const settings = useSettingsStore();
  const { set, osmLayers, basemap } = settings;

  const toggleOsm = (id: string) =>
    set(
      "osmLayers",
      osmLayers.includes(id) ? osmLayers.filter((x) => x !== id) : [...osmLayers, id],
    );

  return (
    <div className="layers-panel" role="dialog" aria-label="Map layers">
      <div className="layers-head">
        <h3>Map layers</h3>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close layers">
          ✕
        </button>
      </div>

      <div className="seg layers-basemap">
        <button
          type="button"
          className={basemap === "streets" ? "seg-on" : ""}
          onClick={() => set("basemap", "streets")}
        >
          Map
        </button>
        <button
          type="button"
          className={basemap === "satellite" ? "seg-on" : ""}
          onClick={() => set("basemap", "satellite")}
        >
          Satellite
        </button>
      </div>

      <h4>Cameras &amp; activity</h4>
      <div className="layer-grid">
        {CAMERA_LAYERS.map((l) => (
          <button
            key={l.key}
            type="button"
            className={`layer-toggle ${settings[l.key] ? "on" : ""}`}
            aria-pressed={!!settings[l.key]}
            onClick={() => set(l.key, !settings[l.key])}
          >
            <span className="layer-dot" style={{ background: l.color }} />
            {l.label}
          </button>
        ))}
      </div>

      <h4>
        OpenStreetMap details <span className="layers-sub">loads for the area on screen</span>
      </h4>
      <div className="layer-grid">
        {OSM_CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`layer-toggle ${osmLayers.includes(c.id) ? "on" : ""}`}
            aria-pressed={osmLayers.includes(c.id)}
            onClick={() => toggleOsm(c.id)}
          >
            <span className="layer-dot" style={{ background: c.color }} />
            {c.label}
          </button>
        ))}
      </div>
      {osmLayers.length > 0 && (
        <button type="button" className="text-btn" onClick={() => set("osmLayers", [])}>
          Turn off all map details
        </button>
      )}
      <p className="tip">Tap any detail on the map to see everything OpenStreetMap knows about it.</p>
    </div>
  );
}
