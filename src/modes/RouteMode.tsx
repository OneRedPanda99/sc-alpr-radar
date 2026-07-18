import { useEffect, useMemo, useState } from "react";
import type { LatLng, SavedRoute } from "@/types";
import { MapView } from "@/components/MapView";
import { useCameraStore } from "@/store/cameraStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useGeolocation } from "@/hooks/useGeolocation";
import {
  formatDistance,
  formatDuration,
  geocode,
  planRoute,
  planToSavedRoute,
  type RoutePlan,
} from "@/services/routing";
import { listRoutes, saveRoute, deleteRoute } from "@/services/storage";

interface RouteModeProps {
  onActivateRoute: (route: SavedRoute) => void;
  activeRouteId: string | null;
}

type Place = { label: string; point: LatLng };

export function RouteMode({ onActivateRoute, activeRouteId }: RouteModeProps) {
  const { dataset } = useCameraStore();
  const showFov = useSettingsStore((s) => s.showFov);
  const showAlpr = useSettingsStore((s) => s.showAlpr);
  const showTraffic = useSettingsStore((s) => s.showTraffic);
  const flockOnly = useSettingsStore((s) => s.flockOnly);
  const basemap = useSettingsStore((s) => s.basemap);
  const { fix } = useGeolocation({ enabled: true });

  // Cameras drawn on the map (respect layer + brand filters).
  const mapCameras = useMemo(() => {
    if (!dataset) return [];
    return dataset.cameras.filter(
      (c) =>
        (c.kind === "alpr" ? showAlpr : showTraffic) &&
        (!flockOnly || c.brand === "Flock Safety"),
    );
  }, [dataset, showAlpr, showTraffic, flockOnly]);

  // Route avoidance only considers plate readers (surveillance), not DOT cams.
  const routeCameras = useMemo(() => {
    if (!dataset) return [];
    return dataset.cameras.filter(
      (c) => c.kind === "alpr" && (!flockOnly || c.brand === "Flock Safety"),
    );
  }, [dataset, flockOnly]);

  const [fromQuery, setFromQuery] = useState("");
  const [toQuery, setToQuery] = useState("");
  const [from, setFrom] = useState<Place | null>(null);
  const [to, setTo] = useState<Place | null>(null);
  const [fromResults, setFromResults] = useState<Place[]>([]);
  const [toResults, setToResults] = useState<Place[]>([]);
  const [plan, setPlan] = useState<RoutePlan | null>(null);
  const [saved, setSaved] = useState<SavedRoute[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listRoutes().then(setSaved);
  }, []);

  // Auto-fill origin from GPS when available.
  useEffect(() => {
    if (fix && !from) {
      setFrom({
        label: "Current location",
        point: fix.point,
      });
      setFromQuery("Current location");
    }
  }, [fix, from]);

  const search = async (which: "from" | "to") => {
    const q = which === "from" ? fromQuery : toQuery;
    if (!q.trim() || q === "Current location") return;
    setError(null);
    try {
      const results = await geocode(q, fix?.point ?? from?.point);
      if (!results.length) {
        setError("No places found. Try a more specific address in South Carolina.");
        return;
      }
      if (which === "from") setFromResults(results);
      else setToResults(results);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const useGpsOrigin = () => {
    if (!fix) {
      setError("GPS not available yet — allow location, or search an origin address.");
      return;
    }
    setFrom({ label: "Current location", point: fix.point });
    setFromQuery("Current location");
    setFromResults([]);
  };

  const doPlan = async (origin: Place, destination: Place) => {
    if (!dataset) {
      setError("Camera data not loaded yet.");
      return;
    }
    setBusy(true);
    setError(null);
    setPlan(null);
    try {
      const p = await planRoute(origin.point, destination.point, routeCameras);
      setPlan(p);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Auto-plan when both ends are set.
  useEffect(() => {
    if (from && to && dataset) void doPlan(from, to);
  }, [from, to, dataset]);

  const doSave = async () => {
    if (!plan || !from || !to) return;
    const route = planToSavedRoute(plan, from.point, to.point, to.label);
    await saveRoute(route);
    setSaved(await listRoutes());
    onActivateRoute(route);
  };

  const doDelete = async (id: string) => {
    await deleteRoute(id);
    setSaved(await listRoutes());
  };

  return (
    <div className="mode route-mode">
      <div className="route-map">
        <MapView
          cameras={mapCameras}
          center={from?.point ?? fix?.point ?? null}
          showFov={showFov}
          basemap={basemap}
          routeLine={plan?.avoidance.coordinates ?? null}
          fitRoute
        />
      </div>

      <div className="route-panel">
        <div className="place-fields">
          <div className="place-row">
            <span className="place-dot origin" />
            <input
              className="search-input"
              placeholder="Starting point"
              value={fromQuery}
              onChange={(e) => {
                setFromQuery(e.target.value);
                if (from?.label === "Current location") setFrom(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && search("from")}
            />
            <button className="ghost-btn" onClick={useGpsOrigin} title="Use GPS">
              GPS
            </button>
          </div>
          <div className="place-row">
            <span className="place-dot dest" />
            <input
              className="search-input"
              placeholder="Destination in South Carolina"
              value={toQuery}
              onChange={(e) => setToQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search("to")}
            />
            <button className="search-btn" onClick={() => search("to")}>
              Go
            </button>
          </div>
        </div>

        {fromResults.length > 0 && (
          <ResultList
            items={fromResults}
            onPick={(p) => {
              setFrom(p);
              setFromQuery(p.label);
              setFromResults([]);
            }}
          />
        )}
        {toResults.length > 0 && (
          <ResultList
            items={toResults}
            onPick={(p) => {
              setTo(p);
              setToQuery(p.label);
              setToResults([]);
            }}
          />
        )}

        {busy && <div className="info">Calculating routes…</div>}
        {error && <div className="hud-error">{error}</div>}

        {plan && to && (
          <div className="plan-card">
            <div className="plan-dest">{to.label}</div>
            <div className="plan-stats">
              <Stat
                label="Fastest"
                value={`${plan.camerasOnFastest} cams`}
                sub={`${formatDistance(plan.fastest.distanceMeters)} · ${formatDuration(plan.fastest.durationSeconds)}`}
              />
              <Stat
                label="Avoid cameras"
                value={`${plan.camerasUnavoidable} cams`}
                sub={`${formatDistance(plan.avoidance.distanceMeters)} · ${formatDuration(plan.avoidance.durationSeconds)}`}
                highlight
              />
            </div>
            <div className="plan-note">
              {plan.camerasUnavoidable === 0
                ? "This route avoids all known cameras on the map."
                : `${plan.camerasUnavoidable} camera(s) couldn't be avoided — they'll still alert in Drive.`}
            </div>

            {plan.avoidance.steps.length > 0 && (
              <ol className="directions">
                {plan.avoidance.steps.slice(0, 12).map((s, i) => (
                  <li key={i}>
                    <span className="dir-text">{s.instruction}</span>
                    <span className="dir-dist">{formatDistance(s.distanceMeters)}</span>
                  </li>
                ))}
                {plan.avoidance.steps.length > 12 && (
                  <li className="dir-more">
                    +{plan.avoidance.steps.length - 12} more turns in Drive mode
                  </li>
                )}
              </ol>
            )}

            <button className="save-btn" onClick={doSave}>
              Start this route in Drive
            </button>
          </div>
        )}

        {saved.length > 0 && (
          <div className="saved">
            <h3>Saved routes</h3>
            <ul>
              {saved.map((r) => (
                <li key={r.id} className={r.id === activeRouteId ? "active" : ""}>
                  <button className="saved-main" onClick={() => onActivateRoute(r)}>
                    <span className="saved-label">{r.destinationLabel}</span>
                    <span className="saved-sub">
                      {r.camerasUnavoidable} unavoidable ·{" "}
                      {formatDistance(r.distanceMeters)} ·{" "}
                      {formatDuration(r.durationSeconds)}
                    </span>
                  </button>
                  <button className="saved-del" onClick={() => doDelete(r.id)}>
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function ResultList({
  items,
  onPick,
}: {
  items: Place[];
  onPick: (p: Place) => void;
}) {
  return (
    <ul className="results">
      {items.map((r, i) => (
        <li key={i}>
          <button onClick={() => onPick(r)}>{r.label}</button>
        </li>
      ))}
    </ul>
  );
}

function Stat({
  label,
  value,
  sub,
  highlight,
}: {
  label: string;
  value: string;
  sub: string;
  highlight?: boolean;
}) {
  return (
    <div className={`stat ${highlight ? "stat-hl" : ""}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      <span className="stat-sub">{sub}</span>
    </div>
  );
}
