import { useEffect, useMemo, useRef, useState } from "react";
import type { Camera, SavedRoute } from "@/types";
import { MapView } from "@/components/MapView";
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
  metersToFeet,
} from "@/services/geo";

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
  const { alertDistanceFeet, muted, flockOnly, headingUp, escalate } =
    useSettingsStore();

  const [driving, setDriving] = useState(false);
  const { fix, error } = useGeolocation({ enabled: driving });
  useWakeLock(driving);

  const trackerRef = useRef(new AlertTracker());
  const [near, setNear] = useState<NearHit[]>([]);

  const radiusMeters = feetToMeters(alertDistanceFeet);

  // Proximity scan on each GPS fix.
  useEffect(() => {
    if (!driving || !fix || !grid) return;
    const hits = grid.within(fix.point, radiusMeters);

    const filtered = hits.filter(
      (h) => !flockOnly || h.camera.brand === "Flock Safety",
    );

    const enriched: NearHit[] = filtered.map((h) => {
      const brg = bearingDeg(fix.point, h.camera);
      const ahead =
        fix.heading == null ? true : bearingDelta(fix.heading, brg) <= 75;
      return { camera: h.camera, distance: h.distance, ahead };
    });

    setNear(enriched);

    if (!muted) {
      // Only alert for cameras ahead of travel; nearest first.
      const aheadIds = enriched.filter((h) => h.ahead).map((h) => h.camera.id);
      const fresh = trackerRef.current.update(aheadIds);
      if (fresh.length > 0) {
        const nearest = enriched.find((h) => h.camera.id === fresh[0]);
        const intensity =
          nearest && escalate
            ? 1 - Math.min(1, nearest.distance / radiusMeters)
            : 0.4;
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

  const handleStart = async () => {
    await unlockAudio();
    trackerRef.current.reset();
    setDriving(true);
  };

  return (
    <div className="mode drive-mode">
      <MapView
        cameras={visibleCameras}
        highlightIds={highlightIds}
        center={fix?.point ?? null}
        heading={fix?.heading ?? null}
        follow={driving}
        headingUp={headingUp}
        routeLine={activeRoute?.coordinates ?? null}
      />

      <div className="drive-hud">
        {!driving ? (
          <button className="big-btn" onClick={handleStart} disabled={status !== "ready"}>
            {status === "ready" ? "Start Driving" : "Loading cameras…"}
          </button>
        ) : (
          <NearestBanner hit={nearestAhead} radiusMeters={radiusMeters} muted={muted} />
        )}

        {error && driving && <div className="hud-error">GPS: {error}</div>}
        {activeRoute && (
          <div className="hud-route">
            Route active · {activeRoute.camerasUnavoidable} unavoidable
          </div>
        )}
      </div>

      {driving && (
        <button className="stop-btn" onClick={() => setDriving(false)}>
          Stop
        </button>
      )}
    </div>
  );
}

function NearestBanner({
  hit,
  radiusMeters,
  muted,
}: {
  hit: NearHit | null;
  radiusMeters: number;
  muted: boolean;
}) {
  if (!hit) {
    return (
      <div className="nearest none">
        <span className="nearest-label">All clear</span>
        <span className="nearest-sub">No cameras within range</span>
      </div>
    );
  }
  const feet = Math.round(metersToFeet(hit.distance));
  const pct = Math.max(0, Math.min(1, 1 - hit.distance / radiusMeters));
  return (
    <div className={`nearest ${pct > 0.6 ? "hot" : pct > 0.3 ? "warm" : "cool"}`}>
      <div className="nearest-row">
        <span className="nearest-label">
          {hit.camera.brand}
          {muted ? " (muted)" : ""}
        </span>
        <span className="nearest-dist">{feet} ft</span>
      </div>
      <div className="nearest-bar">
        <div className="nearest-bar-fill" style={{ width: `${pct * 100}%` }} />
      </div>
      <span className="nearest-sub">{hit.ahead ? "Ahead" : "Nearby"}</span>
    </div>
  );
}
