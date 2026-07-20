import { useEffect, useState } from "react";
import type { AppMode, SavedRoute } from "@/types";
import { DriveMode } from "@/modes/DriveMode";
import { RouteMode } from "@/modes/RouteMode";
import { SettingsMode } from "@/modes/SettingsMode";
import { useCameraStore } from "@/store/cameraStore";
import { useSettingsStore } from "@/store/settingsStore";
import { Icon, type IconName } from "@/components/Icon";

export default function App() {
  const [mode, setMode] = useState<AppMode>("drive");
  const [activeRoute, setActiveRoute] = useState<SavedRoute | null>(null);

  const hydrateCameras = useCameraStore((s) => s.hydrate);
  const hydrateSettings = useSettingsStore((s) => s.hydrate);

  useEffect(() => {
    void hydrateCameras();
    void hydrateSettings();
  }, [hydrateCameras, hydrateSettings]);

  const handleActivateRoute = (route: SavedRoute) => {
    setActiveRoute(route);
    setMode("drive");
  };

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
