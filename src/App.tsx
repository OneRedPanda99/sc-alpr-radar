import { useEffect, useState } from "react";
import type { AppMode, SavedRoute } from "@/types";
import { DriveMode } from "@/modes/DriveMode";
import { RouteMode } from "@/modes/RouteMode";
import { SettingsMode } from "@/modes/SettingsMode";
import { WatchMode } from "@/modes/WatchMode";
import { useCameraStore } from "@/store/cameraStore";
import { useSettingsStore } from "@/store/settingsStore";
import { Icon, type IconName } from "@/components/Icon";
import { FALLBACK_CENTER } from "@/services/geo";

export default function App() {
  const [mode, setMode] = useState<AppMode>("drive");
  const [activeRoute, setActiveRoute] = useState<SavedRoute | null>(null);

  const hydrateCameras = useCameraStore((s) => s.hydrate);
  const hydrateSettings = useSettingsStore((s) => s.hydrate);
  const refreshIncidents = useCameraStore((s) => s.refreshIncidents);
  const refreshAircraft = useCameraStore((s) => s.refreshAircraft);
  const showAircraft = useSettingsStore((s) => s.showAircraft);

  useEffect(() => {
    void hydrateCameras();
    void hydrateSettings();
  }, [hydrateCameras, hydrateSettings]);

  // Live incidents are rebuilt every ~10 minutes upstream. Poll a little more
  // often than that, and re-poll on regaining focus so a phone that was asleep
  // in your pocket isn't showing a stale road.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void refreshIncidents();
    };
    const timer = setInterval(tick, 4 * 60 * 1000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refreshIncidents]);

  const handleActivateRoute = (route: SavedRoute) => {
    setActiveRoute(route);
    setMode("drive");
  };

  // Aircraft move ~2.5 miles a minute, so this polls far harder than the
  // incident layer and only while the tab is visible and the layer is on.
  useEffect(() => {
    if (!showAircraft) return;
    let cancelled = false;
    // Remembered across polls so a single GPS timeout doesn't blank the layer.
    let last: { lat: number; lon: number } | null = null;

    const poll = () => {
      if (cancelled || document.visibilityState !== "visible") return;

      const run = (lat: number, lon: number) => {
        if (cancelled) return;
        last = { lat, lon };
        void refreshAircraft(lat, lon);
      };

      if (!("geolocation" in navigator)) {
        run(last?.lat ?? FALLBACK_CENTER.lat, last?.lon ?? FALLBACK_CENTER.lon);
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (p) => run(p.coords.latitude, p.coords.longitude),
        // Denied, timed out, or unavailable. Falling back to the last known
        // position (or Columbia) beats showing an empty sky forever with no
        // explanation, which is exactly how this looked broken.
        () =>
          run(last?.lat ?? FALLBACK_CENTER.lat, last?.lon ?? FALLBACK_CENTER.lon),
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 120000 },
      );
    };

    poll();
    const timer = setInterval(poll, 25000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [showAircraft, refreshAircraft]);

  return (
    <div className="app">
      <main className="app-main">
        {mode === "drive" && <DriveMode activeRoute={activeRoute} />}
        {mode === "route" && (
          <RouteMode
            onActivateRoute={handleActivateRoute}
            activeRouteId={activeRoute?.id ?? null}
          />
        )}
        {mode === "watch" && <WatchMode />}
        {mode === "settings" && <SettingsMode />}
      </main>

      <nav className="tabbar">
        <TabButton
          current={mode}
          value="drive"
          label="Drive"
          icon="drive"
          onClick={setMode}
        />
        <TabButton
          current={mode}
          value="route"
          label="Route"
          icon="route"
          onClick={setMode}
        />
        <TabButton
          current={mode}
          value="watch"
          label="Overwatch"
          icon="watch"
          onClick={setMode}
        />
        <TabButton
          current={mode}
          value="settings"
          label="Settings"
          icon="settings"
          onClick={setMode}
        />
      </nav>

      {activeRoute && mode === "drive" && (
        <button className="clear-route" onClick={() => setActiveRoute(null)}>
          Clear route
        </button>
      )}
    </div>
  );
}

function TabButton({
  current,
  value,
  label,
  icon,
  onClick,
}: {
  current: AppMode;
  value: AppMode;
  label: string;
  icon: IconName;
  onClick: (m: AppMode) => void;
}) {
  return (
    <button
      className={`tab ${current === value ? "tab-active" : ""}`}
      onClick={() => onClick(value)}
      aria-current={current === value ? "page" : undefined}
    >
      <span className="tab-icon">
        <Icon name={icon} />
      </span>
      {label}
    </button>
  );
}
