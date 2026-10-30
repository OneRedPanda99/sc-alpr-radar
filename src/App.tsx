import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { ActiveTrip, AppMode, Trip } from "@/types";
import { DriveMode } from "@/modes/DriveMode";
import { RouteMode } from "@/modes/RouteMode";
import { SettingsMode } from "@/modes/SettingsMode";
import { WatchMode } from "@/modes/WatchMode";
import { useCameraStore } from "@/store/cameraStore";
import { useSettingsStore } from "@/store/settingsStore";
import { Icon, type IconName } from "@/components/Icon";
import { FALLBACK_CENTER } from "@/services/geo";
import { listTrips } from "@/services/storage";

const ACTIVE_KEY = "alpr.activeTrip";

export default function App() {
  const [mode, setMode] = useState<AppMode>("drive");
  // Drive and Plan stay mounted once visited. Unmounting them threw away the
  // map (a full reload of style + tiles on every tab tap) and, worse, stopped
  // an in-progress drive the moment you peeked at Settings.
  const [visited, setVisited] = useState<Set<AppMode>>(() => new Set(["drive"]));
  const [active, setActive] = useState<ActiveTrip | null>(null);
  const [driving, setDriving] = useState(false);
  const [destinationRequest, setDestinationRequest] = useState<{
    label: string;
    point: { lat: number; lon: number };
    token: number;
  } | null>(null);
  const [openTripRequest, setOpenTripRequest] = useState<{
    tripId: string;
    token: number;
  } | null>(null);

  const hydrateCameras = useCameraStore((s) => s.hydrate);
  const hydrateSettings = useSettingsStore((s) => s.hydrate);
  const refreshIncidents = useCameraStore((s) => s.refreshIncidents);
  const refreshAircraft = useCameraStore((s) => s.refreshAircraft);
  const showAircraft = useSettingsStore((s) => s.showAircraft);

  const go = useCallback((m: AppMode) => {
    setVisited((v) => (v.has(m) ? v : new Set(v).add(m)));
    setMode(m);
  }, []);

  useEffect(() => {
    void hydrateCameras();
    void hydrateSettings();
  }, [hydrateCameras, hydrateSettings]);

  // Bring back the trip Drive was following before a reload.
  useEffect(() => {
    let saved: { tripId: string; planId: string } | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(ACTIVE_KEY) ?? "null");
    } catch {
      saved = null;
    }
    if (!saved) return;
    void listTrips().then((trips) => {
      const trip = trips.find((t) => t.id === saved!.tripId);
      if (trip) setActive({ trip, planId: saved!.planId });
    });
  }, []);

  useEffect(() => {
    try {
      if (active) {
        localStorage.setItem(
          ACTIVE_KEY,
          JSON.stringify({ tripId: active.trip.id, planId: active.planId }),
        );
      } else {
        localStorage.removeItem(ACTIVE_KEY);
      }
    } catch {
      // storage blocked: the trip just won't survive a reload
    }
  }, [active]);

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

  const handleDrive = useCallback(
    (trip: Trip, planId: string) => {
      setActive({ trip, planId });
      go("drive");
    },
    [go],
  );

  // Edits in the planner flow straight into the trip Drive is following.
  const handleTripSaved = useCallback((trip: Trip) => {
    setActive((a) =>
      a && a.trip.id === trip.id
        ? {
            trip,
            planId: trip.plans.some((p) => p.id === a.planId) ? a.planId : trip.plans[0].id,
          }
        : a,
    );
  }, []);

  const openPlanner = useCallback(() => {
    if (active) setOpenTripRequest({ tripId: active.trip.id, token: Date.now() });
    go("route");
  }, [active, go]);

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
        <Pane active={mode === "drive"}>
          <DriveMode
            active={active}
            visible={mode === "drive"}
            onSwitchPlan={(planId) => setActive((a) => (a ? { ...a, planId } : a))}
            onClearTrip={() => setActive(null)}
            onOpenPlanner={openPlanner}
            onDrivingChange={setDriving}
            onPlanTo={(place) => {
              setDestinationRequest({ ...place, token: Date.now() });
              go("route");
            }}
          />
        </Pane>
        {visited.has("route") && (
          <Pane active={mode === "route"}>
            <RouteMode
              onDrive={handleDrive}
              onTripSaved={handleTripSaved}
              activeTripId={active?.trip.id ?? null}
              openTripRequest={openTripRequest}
              destinationRequest={destinationRequest}
            />
          </Pane>
        )}
        {/* Overwatch streams video, so it only lives while it's on screen. */}
        {mode === "watch" && (
          <Pane active>
            <WatchMode />
          </Pane>
        )}
        {mode === "settings" && (
          <Pane active>
            <SettingsMode />
          </Pane>
        )}
      </main>

      <nav className="tabbar">
        <TabButton current={mode} value="drive" label="Drive" icon="drive" onClick={go} live={driving} />
        <TabButton current={mode} value="route" label="Plan" icon="route" onClick={go} />
        <TabButton current={mode} value="watch" label="Overwatch" icon="watch" onClick={go} />
        <TabButton current={mode} value="settings" label="Settings" icon="settings" onClick={go} />
      </nav>
    </div>
  );
}

function Pane({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <section className={`pane ${active ? "pane-active" : ""}`} aria-hidden={!active}>
      {children}
    </section>
  );
}

function TabButton({
  current,
  value,
  label,
  icon,
  onClick,
  live,
}: {
  current: AppMode;
  value: AppMode;
  label: string;
  icon: IconName;
  onClick: (m: AppMode) => void;
  live?: boolean;
}) {
  return (
    <button
      className={`tab ${current === value ? "tab-active" : ""}`}
      onClick={() => onClick(value)}
      aria-current={current === value ? "page" : undefined}
    >
      <span className="tab-icon">
        <Icon name={icon} />
        {live && <span className="tab-live" aria-label="Driving" />}
      </span>
      {label}
    </button>
  );
}
