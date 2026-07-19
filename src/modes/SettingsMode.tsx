import { useState } from "react";
import { useSettingsStore } from "@/store/settingsStore";
import { useCameraStore } from "@/store/cameraStore";
import { playChirp } from "@/services/alertEngine";

export function SettingsMode() {
  const s = useSettingsStore();
  const { dataset, refresh, updating, error, status } = useCameraStore();
  const [source, setSource] = useState<"bundled" | "live">("bundled");

  const synced = dataset?.syncedAt
    ? new Date(dataset.syncedAt).toLocaleString()
    : "never";
  const generated = dataset?.generatedAt
    ? new Date(dataset.generatedAt).toLocaleDateString()
    : "unknown";

  return (
    <div className="mode settings-mode">
      <h2>Settings</h2>

      <section className="setting-group">
        <h3>Alerts</h3>

        <label className="setting">
          <span>Alert distance</span>
          <div className="slider-row">
            <input
              type="range"
              min={500}
              max={5000}
              step={100}
              value={s.alertDistanceFeet}
              onChange={(e) => s.set("alertDistanceFeet", Number(e.target.value))}
            />
            <span className="slider-val">{s.alertDistanceFeet} ft</span>
          </div>
        </label>

        <Toggle
          label="Mute alerts"
          checked={s.muted}
          onChange={(v) => s.set("muted", v)}
        />
        <Toggle
          label="Escalate as you get closer"
          checked={s.escalate}
          onChange={(v) => s.set("escalate", v)}
        />
        <Toggle
          label="Flock cameras only"
          checked={s.flockOnly}
          onChange={(v) => s.set("flockOnly", v)}
        />
        <Toggle
          label="Also beep for traffic / DOT cameras"
          checked={s.alertTraffic}
          onChange={(v) => s.set("alertTraffic", v)}
        />
        <button className="test-btn" onClick={() => playChirp({ intensity: 0.7 })}>
          Test alert sound
        </button>
      </section>

      <section className="setting-group">
        <h3>Route avoidance</h3>
        <p className="tip" style={{ marginTop: 0 }}>
          Choose which cameras the router tries to detour around.
        </p>
        <Toggle
          label="Avoid Flock cameras"
          checked={s.avoidFlock}
          onChange={(v) => s.set("avoidFlock", v)}
        />
        <Toggle
          label="Avoid other ALPRs (Motorola, etc.)"
          checked={s.avoidOtherAlpr}
          onChange={(v) => s.set("avoidOtherAlpr", v)}
        />
        <Toggle
          label="Avoid traffic / DOT cameras"
          checked={s.avoidTraffic}
          onChange={(v) => s.set("avoidTraffic", v)}
        />
        <Toggle
          label="Avoid cameras I added"
          checked={s.avoidCustom}
          onChange={(v) => s.set("avoidCustom", v)}
        />
        <Toggle
          label="Avoid community cameras"
          checked={s.avoidCommunity}
          onChange={(v) => s.set("avoidCommunity", v)}
        />
      </section>

      <section className="setting-group">
        <h3>Map</h3>
        <label className="setting">
          <span>Basemap</span>
          <div className="seg">
            <button
              className={s.basemap === "streets" ? "seg-on" : ""}
              onClick={() => s.set("basemap", "streets")}
            >
              Streets
            </button>
            <button
              className={s.basemap === "satellite" ? "seg-on" : ""}
              onClick={() => s.set("basemap", "satellite")}
            >
              Satellite
            </button>
          </div>
        </label>
        <Toggle
          label="Show plate readers (ALPR)"
          checked={s.showAlpr}
          onChange={(v) => s.set("showAlpr", v)}
        />
        <Toggle
          label="Show traffic / DOT cameras"
          checked={s.showTraffic}
          onChange={(v) => s.set("showTraffic", v)}
        />
        <Toggle
          label="Rotate map to heading"
          checked={s.headingUp}
          onChange={(v) => s.set("headingUp", v)}
        />
        <Toggle
          label="Show camera field-of-view cones"
          checked={s.showFov}
          onChange={(v) => s.set("showFov", v)}
        />
      </section>

      <section className="setting-group">
        <h3>Camera data</h3>
        <div className="data-status">
          <div>
            <strong>{dataset?.count ?? 0}</strong> cameras
          </div>
          <div className="muted-text">Pack built: {generated}</div>
          <div className="muted-text">Last updated on device: {synced}</div>
          {status === "empty" && (
            <div className="hud-error">
              No cameras loaded — try updating on Wi-Fi.
            </div>
          )}
          {error && <div className="hud-error">{error}</div>}
        </div>

        <div className="source-row">
          <label className={source === "bundled" ? "src-sel" : ""}>
            <input
              type="radio"
              name="src"
              checked={source === "bundled"}
              onChange={() => setSource("bundled")}
            />
            Bundled pack (offline)
          </label>
          <label className={source === "live" ? "src-sel" : ""}>
            <input
              type="radio"
              name="src"
              checked={source === "live"}
              onChange={() => setSource("live")}
            />
            Live from Overpass
          </label>
        </div>

        <button
          className="update-btn"
          disabled={updating}
          onClick={() => refresh(source)}
        >
          {updating ? "Updating…" : "Update cameras now"}
        </button>
        <p className="tip">
          Update while on Wi-Fi at home or work. Drive alerts then work fully
          offline.
        </p>
      </section>

      <section className="setting-group about">
        <h3>About</h3>
        <p>
          Camera locations come from{" "}
          <a href="https://deflock.me" target="_blank" rel="noreferrer">
            DeFlock
          </a>{" "}
          and{" "}
          <a href="https://www.openstreetmap.org" target="_blank" rel="noreferrer">
            OpenStreetMap
          </a>{" "}
          contributors (ODbL). Coverage is community-sourced and may be incomplete.
          Live traffic/CCTV cameras come from{" "}
          <a href="https://www.511sc.org" target="_blank" rel="noreferrer">
            SCDOT 511
          </a>
          .
        </p>
        <p className="tip">
          <strong>100% free stack</strong> — no paid APIs or API keys. Map tiles:
          OpenFreeMap. Routing: public OSRM. Search: Photon (Komoot). Data: OSM /
          Overpass.
        </p>
        <p className="tip">
          Personal awareness tool. It does not alter, obscure, or interfere with
          any camera or your plate. Follow traffic laws and drive attentively.
        </p>
      </section>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="setting toggle">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}
