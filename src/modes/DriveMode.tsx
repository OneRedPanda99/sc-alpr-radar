import { useEffect, useMemo, useRef, useState } from "react";
import type { Camera, SavedRoute } from "@/types";
import { MapView } from "@/components/MapView";
import {
  AllClearBanner,
  CameraAlertCard,
  CameraDetailCard,
} from "@/components/CameraAlertCard";
import type { LatLng } from "@/types";
import { useCameraStore } from "@/store/cameraStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useGeolocation } from "@/hooks/useGeolocation";
import { useWakeLock } from "@/hooks/useWakeLock";
import {
  AlertTracker,
  playChirp,
  unlockAudio,
} from "@/services/alertEngine";
import {
  bearingDeg,
  bearingDelta,
  feetToMeters,
  haversineMeters,
} from "@/services/geo";
import { formatDistance, formatDuration } from "@/services/routing";

interface DriveModeProps {
  activeRoute: SavedRoute | null;
}

interface NearHit {
  camera: Camera;
  distance: number;
  ahead: boolean;
}

export function DriveMode({ activeRoute }: DriveModeProps) {
  const { grid, dataset, status } = useCameraStore();
  const {
    alertDistanceFeet,
    muted,
    flockOnly,
    headingUp,
    escalate,
    showFov,
    showAlpr,
    showTraffic,
    alertTraffic,
    basemap,
    set: setSetting,
  } = useSettingsStore();

  const isShown = useMemo(
    () => (c: Camera) =>
      (c.kind === "alpr" ? showAlpr : showTraffic) &&
      (!flockOnly || c.brand === "Flock Safety"),
    [showAlpr, showTraffic, flockOnly],
  );
  const isAlertable = useMemo(
    () => (c: Camera) => isShown(c) && (c.kind !== "traffic" || alertTraffic),
    [isShown, alertTraffic],
  );

  const [driving, setDriving] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [browseCenter, setBrowseCenter] = useState<LatLng | null>(null);
  const { fix, error } = useGeolocation({ enabled: driving });
  useWakeLock(driving);

  // One-shot location while idle so the map opens near you and nearby cameras show.
  useEffect(() => {
    if (driving || browseCenter || !("geolocation" in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        setBrowseCenter({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => {},
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 },
    );
  }, [driving, browseCenter]);

  const trackerRef = useRef(new AlertTracker());
  const [near, setNear] = useState<NearHit[]>([]);

  const radiusMeters = feetToMeters(alertDistanceFeet);

  // Advance turn-by-turn as you pass each maneuver point.
  useEffect(() => {
    if (!driving || !fix || !activeRoute?.steps?.length) return;
    const steps = activeRoute.steps;
    let next = stepIndex;
    for (let i = stepIndex; i < steps.length - 1; i++) {
      const [lon, lat] = steps[i].location;
      const dist = haversineMeters(fix.point, { lat, lon });
      if (dist < 40) next = i + 1;
      else break;
    }
    if (next !== stepIndex) setStepIndex(next);
  }, [driving, fix, activeRoute, stepIndex]);

  useEffect(() => {
    setStepIndex(0);
  }, [activeRoute?.id]);

  useEffect(() => {
    if (!driving || !fix || !grid) return;
    const hits = grid.within(fix.point, radiusMeters);
    const filtered = hits.filter((h) => isAlertable(h.camera));

    const enriched: NearHit[] = filtered.map((h) => {
      const brg = bearingDeg(fix.point, h.camera);
      const ahead =
        fix.heading == null ? true : bearingDelta(fix.heading, brg) <= 80;
      return { camera: h.camera, distance: h.distance, ahead };
    });

    setNear(enriched);

    if (!muted) {
      const aheadIds = enriched.filter((h) => h.ahead).map((h) => h.camera.id);
      const fresh = trackerRef.current.update(aheadIds);
      if (fresh.length > 0) {
        const nearest = enriched.find((h) => h.camera.id === fresh[0]);
        const intensity =
          nearest && escalate
            ? 1 - Math.min(1, nearest.distance / radiusMeters)
            : 0.45;
        playChirp({ intensity });
      }
    }
  }, [driving, fix, grid, radiusMeters, muted, isAlertable, escalate]);

  const highlightIds = useMemo(
    () => new Set(near.filter((h) => h.ahead).map((h) => h.camera.id)),
    [near],
  );

  const visibleCameras = useMemo(() => {
    if (!dataset) return [];
    return dataset.cameras.filter(isShown);
  }, [dataset, isShown]);

  const counts = useMemo(() => {
    const c = { alpr: 0, traffic: 0 };
    if (dataset)
      for (const cam of dataset.cameras)
        if (cam.kind === "alpr") c.alpr++;
        else c.traffic++;
    return c;
  }, [dataset]);

  const selectedCamera = useMemo(
    () => dataset?.cameras.find((c) => c.id === selectedId) ?? null,
    [dataset, selectedId],
  );
  const selectedDistance = useMemo(() => {
    if (!selectedCamera || !fix) return null;
    return haversineMeters(fix.point, selectedCamera);
  }, [selectedCamera, fix]);

  const nearestAhead = near.find((h) => h.ahead) ?? near[0] ?? null;
  const currentStep = activeRoute?.steps?.[stepIndex] ?? null;
  const mapCenter = fix?.point ?? browseCenter;

  const handleStart = async () => {
    await unlockAudio();
    trackerRef.current.reset();
    setDriving(true);
  };

  const urgency =
    !nearestAhead
      ? "cool"
      : nearestAhead.distance / radiusMeters < 0.35
        ? "hot"
        : nearestAhead.distance / radiusMeters < 0.65
          ? "warm"
          : "cool";

  return (
    <div className="mode drive-mode">
      <MapView
        cameras={visibleCameras}
        highlightIds={highlightIds}
        center={mapCenter}
        heading={fix?.heading ?? null}
        follow={driving}
        headingUp={headingUp}
        showFov={showFov}
        basemap={basemap}
        routeLine={activeRoute?.coordinates ?? null}
        onSelectCamera={setSelectedId}
      />

      <div className="map-controls">
        <button
          className={`map-chip ${basemap === "satellite" ? "on" : ""}`}
          onClick={() =>
            setSetting("basemap", basemap === "satellite" ? "streets" : "satellite")
          }
          title="Toggle satellite imagery"
        >
          {basemap === "satellite" ? "Satellite" : "Map"}
        </button>
        <button
          className={`map-chip alpr ${showAlpr ? "on" : ""}`}
          onClick={() => setSetting("showAlpr", !showAlpr)}
          title="Plate readers (ALPR)"
        >
          Plate {counts.alpr}
        </button>
        <button
          className={`map-chip traffic ${showTraffic ? "on" : ""}`}
          onClick={() => setSetting("showTraffic", !showTraffic)}
          title="Traffic / DOT cameras"
        >
          Traffic {counts.traffic}
        </button>
      </div>

      {selectedCamera && (
        <CameraDetailCard
          camera={selectedCamera}
          distanceMeters={selectedDistance}
          onClose={() => setSelectedId(null)}
        />
      )}

      <div className="drive-hud">
        {!driving ? (
          <div className="start-panel">
            <div className="start-copy">
              <h1>SC ALPR Radar</h1>
              <p>
                {status === "ready"
                  ? `${dataset?.count ?? 0} cameras loaded · tap a dot for details, or start`
                  : "Loading camera pack…"}
              </p>
            </div>
            <button
              className="big-btn"
              onClick={handleStart}
              disabled={status !== "ready"}
            >
              Start Driving
            </button>
          </div>
        ) : nearestAhead ? (
          <CameraAlertCard
            camera={nearestAhead.camera}
            distanceMeters={nearestAhead.distance}
            ahead={nearestAhead.ahead}
            muted={muted}
            urgency={urgency}
          />
        ) : (
          <AllClearBanner />
        )}

        {driving && currentStep && (
          <div className="nav-banner">
            <div className="nav-instruction">{currentStep.instruction}</div>
            <div className="nav-sub">
              {formatDistance(currentStep.distanceMeters)}
              {activeRoute &&
                ` · ${formatDuration(activeRoute.durationSeconds)} total · ${activeRoute.camerasUnavoidable} unavoidable`}
            </div>
          </div>
        )}

        {error && driving && <div className="hud-error">GPS: {error}</div>}
      </div>

      {driving && (
        <button className="stop-btn" onClick={() => setDriving(false)}>
          Stop
        </button>
      )}
    </div>
  );
}
