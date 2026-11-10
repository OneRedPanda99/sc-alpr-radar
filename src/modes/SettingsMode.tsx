import { useEffect, useState } from "react";
import { deviceReport } from "@/services/device";
import { useSettingsStore } from "@/store/settingsStore";
import { useCameraStore } from "@/store/cameraStore";
import { ALERT_SOUNDS, playAlert, unlockAudio } from "@/services/alertEngine";
import type { AlertSoundId } from "@/types";

/**
 * Nuclear option for a wedged install: drop the service worker and every cache,
 * then reload from the server.
 *
 * This exists because a stale precached app shell can pin the old bundle
 * indefinitely, and every in-app fix for that ships *inside* the bundle you
 * can't reach. IndexedDB is left alone on purpose — that's where cameras you
 * added yourself live, and they're not recoverable from the server.
 */
async function hardReset(): Promise<void> {
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } finally {
    // Cache-bust the navigation itself so we can't be handed the old shell.
    window.location.replace(
      `${window.location.pathname}?fresh=${Date.now()}`,
    );
  }
}

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
          label='Speak alerts ("Flock camera in 400 feet")'
          checked={s.spokenAlerts}
          onChange={(v) => s.set("spokenAlerts", v)}
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
          label="Beep for traffic / DOT + gunshot detectors"
          checked={s.alertTraffic}
          onChange={(v) => s.set("alertTraffic", v)}
        />
        <Toggle
          label="Beep for unconfirmed RF sightings"
          checked={s.alertUnconfirmed}
          onChange={(v) => s.set("alertUnconfirmed", v)}
        />
        <Toggle
          label="Beep for live road incidents"
          checked={s.alertIncidents}
          onChange={(v) => s.set("alertIncidents", v)}
        />
        <p className="tip" style={{ marginTop: 0 }}>
          Everything alerts by default. Police stations and radio towers are the
          exception — you pass too many for beeping to mean anything, so they
          stay map-only.
        </p>

        <label className="setting">
          <span>Alert sound</span>
          <div className="sound-grid">
            {ALERT_SOUNDS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`sound-opt ${s.alertSound === opt.id ? "on" : ""}`}
                onClick={() => {
                  s.set("alertSound", opt.id);
                  void unlockAudio().then(() =>
                    playAlert({ intensity: 0.7, sound: opt.id }),
                  );
                }}
              >
                <span className="sound-opt-label">{opt.label}</span>
                <span className="sound-opt-blurb">{opt.blurb}</span>
              </button>
            ))}
          </div>
        </label>
        <button
          className="test-btn"
          onClick={() => {
            void unlockAudio().then(() =>
              playAlert({
                intensity: 0.7,
                sound: s.alertSound as AlertSoundId,
              }),
            );
          }}
        >
          Test alert sound
        </button>
      </section>

      <section className="setting-group">
        <h3>Display</h3>
        <label className="setting">
          <span>Interface size</span>
          <div className="seg">
            {(
              [
                ["auto", "Auto"],
                ["normal", "Normal"],
                ["large", "Large"],
                ["xl", "Extra large"],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                className={s.uiScale === v ? "seg-on" : ""}
                onClick={() => s.set("uiScale", v)}
              >
                {label}
              </button>
            ))}
          </div>
        </label>
        <p className="tip" style={{ marginTop: 0 }}>
          Panels and buttons only; the map keeps its size. Auto picks Large in a Tesla.
        </p>
        <DeviceInfo />
        <Toggle
          label="Rotate map to heading while driving"
          checked={s.headingUp}
          onChange={(v) => s.set("headingUp", v)}
        />
        <p className="tip" style={{ marginTop: 0 }}>
          Which cameras and map details show is under <strong>Layers</strong> on the map.
          Muting is the <strong>Sound</strong> button there, and the cameras routes steer
          around are set in <strong>Plan</strong>.
        </p>
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

        <button className="test-btn" onClick={hardReset}>
          Force update (clear cache &amp; reload)
        </button>
        <p className="tip">
          Use if the app looks stuck on old data or an old layout. Unregisters
          the offline worker, clears every cache, and reloads from the server.
          Cameras you added yourself are kept.
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

/**
 * What this screen and browser actually are. Car and phone browsers differ in
 * ways that are hard to guess from outside (scale, location, recording), so
 * show them plainly.
 */
function DeviceInfo() {
  const [info, setInfo] = useState(deviceReport);
  useEffect(() => {
    const update = () => setInfo(deviceReport());
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return (
    <div className="device-info">
      {info.map(([k, v]) => (
        <div key={k}>
          <span className="meta-label">{k}</span> {v}
        </div>
      ))}
    </div>
  );
}
