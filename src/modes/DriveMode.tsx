import { useEffect, useMemo, useRef, useState } from "react";
import type { Camera, SavedRoute } from "@/types";
import { MapView } from "@/components/MapView";
import { AllClearBanner, CameraAlertCard } from "@/components/CameraAlertCard";
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
  const { alertDistanceFeet, muted, flockOnly, headingUp, escalate, showFov } =
    useSettingsStore();

  const [driving, setDriving] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const { fix, error } = useGeolocation({ enabled: driving });
  useWakeLock(driving);

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
    const filtered = hits.filter(
      (h) => !flockOnly || h.camera.brand === "Flock Safety",
    );

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
  }, [driving, fix, grid, radiusMeters, muted, flockOnly, escalate]);

  const highlightIds = useMemo(
    () => new Set(near.filter((h) => h.ahead).map((h) => h.camera.id)),
    [near],
  );

  const visibleCameras = useMemo(() => {
    if (!dataset) return [];
    return flockOnly
      ? dataset.cameras.filter((c) => c.brand === "Flock Safety")
      : dataset.cameras;
  }, [dataset, flockOnly]);

  const nearestAhead = near.find((h) => h.ahead) ?? near[0] ?? null;
  const currentStep = activeRoute?.steps?.[stepIndex] ?? null;

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
        center={fix?.point ?? null}
        heading={fix?.heading ?? null}
        follow={driving}
        headingUp={headingUp}
        showFov={showFov}
        routeLine={activeRoute?.coordinates ?? null}
      />

      <div className="drive-hud">
        {!driving ? (
          <div className="start-panel">
            <div className="start-copy">
              <h1>SC ALPR Radar</h1>
              <p>
                {status === "ready"
                  ? `${dataset?.count ?? 0} cameras loaded · tap to start`
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
