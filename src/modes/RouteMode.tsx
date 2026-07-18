import { useEffect, useState } from "react";
import type { LatLng, SavedRoute } from "@/types";
import { MapView } from "@/components/MapView";
import { useCameraStore } from "@/store/cameraStore";
import { useGeolocation } from "@/hooks/useGeolocation";
import { geocode, planRoute, planToSavedRoute, type RoutePlan } from "@/services/routing";
import { listRoutes, saveRoute, deleteRoute } from "@/services/storage";

interface RouteModeProps {
  onActivateRoute: (route: SavedRoute) => void;
  activeRouteId: string | null;
}

export function RouteMode({ onActivateRoute, activeRouteId }: RouteModeProps) {
  const { dataset } = useCameraStore();
  const { fix } = useGeolocation({ enabled: true });

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ label: string; point: LatLng }[]>([]);
  const [dest, setDest] = useState<{ label: string; point: LatLng } | null>(null);
  const [plan, setPlan] = useState<RoutePlan | null>(null);
  const [saved, setSaved] = useState<SavedRoute[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listRoutes().then(setSaved);
  }, []);

  const doSearch = async () => {
    if (!query.trim()) return;
    setError(null);
    try {
      setResults(await geocode(query));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const doPlan = async (destination: { label: string; point: LatLng }) => {
    if (!fix) {
      setError("Waiting for your location…");
      return;
    }
    if (!dataset) {
      setError("Camera data not loaded yet.");
      return;
    }
    setBusy(true);
    setError(null);
    setDest(destination);
    setResults([]);
    try {
      const p = await planRoute(fix.point, destination.point, dataset.cameras);
      setPlan(p);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doSave = async () => {
    if (!plan || !dest || !fix) return;
    const route = planToSavedRoute(plan, fix.point, dest.point, dest.label);
    await saveRoute(route);
    setSaved(await listRoutes());
    onActivateRoute(route);
  };

  const doDelete = async (id: string) => {
    await deleteRoute(id);
    setSaved(await listRoutes());
  };

  const savingMin = (s: number) => Math.round(s / 60);
  const km = (m: number) => (m / 1000).toFixed(1);

  return (
    <div className="mode route-mode">
      <div className="route-map">
        <MapView
          cameras={dataset?.cameras ?? []}
          center={fix?.point ?? null}
          routeLine={plan?.avoidance.coordinates ?? null}
        />
      </div>

      <div className="route-panel">
        <div className="search-row">
          <input
            className="search-input"
            placeholder="Destination address or place"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doSearch()}
          />
          <button className="search-btn" onClick={doSearch}>
            Search
          </button>
        </div>

        {results.length > 0 && (
          <ul className="results">
            {results.map((r, i) => (
              <li key={i}>
                <button onClick={() => doPlan(r)}>{r.label}</button>
              </li>
            ))}
          </ul>
        )}

        {busy && <div className="info">Calculating routes…</div>}
        {error && <div className="hud-error">{error}</div>}

        {plan && dest && (
          <div className="plan-card">
            <div className="plan-dest">{dest.label}</div>
            <div className="plan-stats">
              <Stat
                label="Fastest"
                value={`${plan.camerasOnFastest} cams`}
                sub={`${km(plan.fastest.distanceMeters)} km · ${savingMin(
                  plan.fastest.durationSeconds,
                )} min`}
              />
              <Stat
                label="Avoidance"
                value={`${plan.camerasUnavoidable} cams`}
                sub={`${km(plan.avoidance.distanceMeters)} km · ${savingMin(
                  plan.avoidance.durationSeconds,
                )} min`}
                highlight
              />
            </div>
            <div className="plan-note">
              {plan.camerasUnavoidable === 0
                ? "This route avoids all known cameras."
                : `${plan.camerasUnavoidable} camera(s) couldn't be avoided on this route.`}
            </div>
            <button className="save-btn" onClick={doSave}>
              Save &amp; use in Drive
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
                      {(r.distanceMeters / 1000).toFixed(1)} km ·{" "}
                      {Math.round(r.durationSeconds / 60)} min
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
