import { useEffect, useMemo, useState } from "react";
import type { Camera } from "@/types";
import { MapView } from "@/components/MapView";
import { LiveCameraVideo, isLiveCamera } from "@/components/LiveCameraImage";
import { useCameraStore } from "@/store/cameraStore";
import { useSettingsStore } from "@/store/settingsStore";
import { makeIsShown } from "@/services/layers";
import { incidentSymbol } from "@/services/symbols";
import { FALLBACK_CENTER, haversineMeters, metersToFeet } from "@/services/geo";

function minutesAgo(iso?: string): string {
  if (!iso) return "";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(mins)) return "";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

export function WatchMode() {
  const { dataset } = useCameraStore();
  const settings = useSettingsStore();
  const [center, setCenter] = useState(FALLBACK_CENTER);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [watchId, setWatchId] = useState<string | null>(null);

  useEffect(() => {
    if (!("geolocation" in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (p) => setCenter({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => {},
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 },
    );
  }, []);

  const all = dataset?.cameras ?? [];

  const visible = useMemo(
    () => all.filter(makeIsShown(settings)),
    [all, settings],
  );

  const incidents = useMemo(
    () =>
      all
        .filter((c) => c.kind === "incident")
        .map((c) => ({ c, d: haversineMeters(center, c) }))
        .sort((a, b) => a.d - b.d),
    [all, center],
  );

  /** Nearest live cameras — the ones worth actually watching. */
  const liveCams = useMemo(
    () =>
      all
        .filter(isLiveCamera)
        .map((c) => ({ c, d: haversineMeters(center, c) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 12),
    [all, center],
  );

  const watched = useMemo(
    () => all.find((c) => c.id === watchId) ?? liveCams[0]?.c ?? null,
    [all, watchId, liveCams],
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const cam of all) c[cam.kind] = (c[cam.kind] ?? 0) + 1;
    return c;
  }, [all]);

  const selected = all.find((c) => c.id === selectedId) ?? null;

  /**
   * Tapping a camera on the map should show its feed, not just its name. Any
   * other kind (ALPR, station, incident) still just selects, since there is
   * nothing to watch.
   */
  const handleSelect = (id: string) => {
    setSelectedId(id);
    const cam = all.find((c) => c.id === id);
    if (cam && isLiveCamera(cam)) setWatchId(id);
  };

  return (
    <div className="watch-mode">
      <div className="watch-map">
        <MapView
          cameras={visible}
          center={center}
          heading={null}
          showFov={settings.showFov}
          basemap={settings.basemap}
          onSelectCamera={handleSelect}
          highlightIds={selectedId ? new Set([selectedId]) : undefined}
        />
      </div>

      <aside className="watch-panel">
        <header className="watch-head">
          <h2>Overwatch</h2>
          <div className="watch-stats">
            <Stat label="Plate" value={counts.alpr ?? 0} tone="hot" />
            <Stat label="Traffic" value={counts.traffic ?? 0} tone="info" />
            <Stat label="Live" value={incidents.length} tone="warm" />
          </div>
        </header>

        <section className="watch-section">
          <h3>Live camera</h3>
          {watched ? (
            <>
              <div className="watch-feed">
                <LiveCameraVideo camera={watched} />
              </div>
              <div className="watch-feed-name">{watched.name}</div>
            </>
          ) : (
            <p className="tip">No live cameras nearby.</p>
          )}
          <div className="watch-cam-list">
            {liveCams.map(({ c, d }) => (
              <button
                key={c.id}
                type="button"
                className={`watch-cam ${watched?.id === c.id ? "on" : ""}`}
                onClick={() => setWatchId(c.id)}
                title={c.name}
              >
                <span className="watch-cam-name">{c.name}</span>
                <span className="watch-cam-dist">
                  {(d / 1609).toFixed(1)} mi
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="watch-section">
          <h3>Incident feed</h3>
          {incidents.length === 0 ? (
            <p className="tip">
              Nothing live right now. This is crash and hazard data, not police
              dispatch — quiet here doesn't mean a clear road.
            </p>
          ) : (
            <ul className="watch-feed-list">
              {incidents.slice(0, 25).map(({ c, d }) => (
                <li key={c.id}>
                  <button type="button" onClick={() => setSelectedId(c.id)}>
                    <span className="wf-sym" aria-hidden="true">
                      {incidentSymbol(c)}
                    </span>
                    <span className="wf-text">
                      <span className="wf-head">{c.name}</span>
                      <span className="wf-meta">
                        {(d / 1609).toFixed(1)} mi · {c.source}
                        {c.reportedAt ? ` · ${minutesAgo(c.reportedAt)}` : ""}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {selected && <SelectedRow camera={selected} center={center} />}
      </aside>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div className={`watch-stat ${tone}`}>
      <span className="watch-stat-val">{value.toLocaleString()}</span>
      <span className="watch-stat-label">{label}</span>
    </div>
  );
}

function SelectedRow({ camera, center }: { camera: Camera; center: { lat: number; lon: number } }) {
  const feet = Math.round(metersToFeet(haversineMeters(center, camera)));
  return (
    <section className="watch-section watch-selected">
      <h3>Selected</h3>
      <div className="wf-head">{camera.name ?? camera.kind}</div>
      <div className="wf-meta">{camera.purpose}</div>
      <div className="wf-meta">{feet.toLocaleString()} ft away</div>
      {camera.frequencies?.length ? (
        <div className="wf-meta">
          {camera.frequencies.slice(0, 6).join(" · ")} MHz
        </div>
      ) : null}
    </section>
  );
}
