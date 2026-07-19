import { useEffect, useMemo, useRef, useState } from "react";
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

  const mapCameras = useMemo(() => {
    if (!dataset) return [];
    return dataset.cameras.filter(
      (c) =>
        (c.kind === "alpr" ? showAlpr : showTraffic) &&
        (!flockOnly || c.brand === "Flock Safety"),
    );
  }, [dataset, showAlpr, showTraffic, flockOnly]);

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
  const [activeField, setActiveField] = useState<"from" | "to" | null>(null);
  const [searching, setSearching] = useState<"from" | "to" | null>(null);
  const [plan, setPlan] = useState<RoutePlan | null>(null);
  const [saved, setSaved] = useState<SavedRoute[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSteps, setShowSteps] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);

  const fromTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gpsSeeded = useRef(false);

  useEffect(() => {
    void listRoutes().then(setSaved);
  }, []);

  // Seed origin from GPS once (don't fight the user if they clear it).
  useEffect(() => {
    if (gpsSeeded.current || !fix || from) return;
    gpsSeeded.current = true;
    setFrom({ label: "Current location", point: fix.point });
    setFromQuery("Current location");
  }, [fix, from]);

  const runSearch = async (
    which: "from" | "to",
    query: string,
    autoPickSingle: boolean,
  ) => {
    const q = query.trim();
    if (!q || q === "Current location") {
      if (which === "from") setFromResults([]);
      else setToResults([]);
      return;
    }
    setSearching(which);
    setError(null);
    try {
      const results = await geocode(q, fix?.point ?? from?.point);
      if (!results.length) {
        setError("No places found — try a street address + city (e.g. Columbia SC).");
        if (which === "from") setFromResults([]);
        else setToResults([]);
        return;
      }
      if (autoPickSingle && results.length === 1) {
        pickPlace(which, results[0]);
        return;
      }
      if (which === "from") setFromResults(results);
      else setToResults(results);
      setActiveField(which);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSearching(null);
    }
  };

  const scheduleSearch = (which: "from" | "to", query: string) => {
    const timer = which === "from" ? fromTimer : toTimer;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void runSearch(which, query, false);
    }, 400);
  };

  const pickPlace = (which: "from" | "to", place: Place) => {
    if (which === "from") {
      setFrom(place);
      setFromQuery(place.label);
      setFromResults([]);
    } else {
      setTo(place);
      setToQuery(place.label);
      setToResults([]);
    }
    setActiveField(null);
    setError(null);
  };

  const useGpsOrigin = () => {
    if (!fix) {
      setError("GPS not ready yet — allow location, or type a starting address.");
      return;
    }
    pickPlace("from", { label: "Current location", point: fix.point });
  };

  useEffect(() => {
    if (!from || !to || !dataset) return;
    let cancelled = false;
    (async () => {
      setBusy(true);
      setError(null);
      setPlan(null);
      setShowSteps(false);
      try {
        const p = await planRoute(from.point, to.point, routeCameras);
        if (!cancelled) {
          setPlan(p);
          setPanelOpen(true);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [from, to, dataset, routeCameras]);

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

  const results =
    activeField === "from"
      ? fromResults
      : activeField === "to"
        ? toResults
        : [];

  return (
    <div className="mode route-mode">
      <div className={`route-map ${panelOpen ? "with-panel" : "full"}`}>
        <MapView
          cameras={mapCameras}
          center={from?.point ?? fix?.point ?? null}
          showFov={showFov}
          basemap={basemap}
          routeLine={plan?.avoidance.coordinates ?? null}
          fitRoute
        />
        {!panelOpen && (
          <button className="route-sheet-toggle" onClick={() => setPanelOpen(true)}>
            Show route
          </button>
        )}
      </div>

      {panelOpen && (
        <div className="route-panel">
          <div className="route-panel-head">
            <h2>Plan a route</h2>
            <button
              className="ghost-btn"
              onClick={() => setPanelOpen(false)}
              title="Hide panel — see more map"
            >
              Map
            </button>
          </div>

          <div className="place-fields">
            <div className="place-row">
              <span className="place-dot origin" />
              <input
                className="search-input"
                placeholder="Start — address or place"
                value={fromQuery}
                autoComplete="street-address"
                enterKeyHint="search"
                onFocus={() => setActiveField("from")}
                onChange={(e) => {
                  const v = e.target.value;
                  setFromQuery(v);
                  if (from && v !== from.label) setFrom(null);
                  scheduleSearch("from", v);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void runSearch("from", fromQuery, true);
                  }
                }}
              />
              <button className="ghost-btn" onClick={useGpsOrigin} title="Use GPS">
                GPS
              </button>
            </div>
            <div className="place-row">
              <span className="place-dot dest" />
              <input
                className="search-input"
                placeholder="Destination — e.g. 1600 Main St, Columbia"
                value={toQuery}
                autoComplete="street-address"
                enterKeyHint="search"
                onFocus={() => setActiveField("to")}
                onChange={(e) => {
                  const v = e.target.value;
                  setToQuery(v);
                  if (to && v !== to.label) setTo(null);
                  scheduleSearch("to", v);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void runSearch("to", toQuery, true);
                  }
                }}
              />
              <button
                className="search-btn"
                onClick={() => void runSearch("to", toQuery, true)}
              >
                {searching ? "…" : "Go"}
              </button>
            </div>
            <p className="place-hint">
              Type an address — suggestions appear as you type. Tap one to set it.
            </p>
          </div>

          {searching && <div className="info">Searching places…</div>}

          {results.length > 0 && activeField && (
            <ResultList
              items={results}
              onPick={(p) => pickPlace(activeField, p)}
            />
          )}

          {busy && <div className="info">Calculating routes…</div>}
          {error && <div className="hud-error">{error}</div>}

          {plan && to && (
            <div className="plan-card">
              <div className="plan-dest">To {to.label}</div>
              <div className="plan-stats">
                <Stat
                  label="Fastest"
                  value={`${plan.camerasOnFastest}`}
                  unit="cams"
                  sub={`${formatDistance(plan.fastest.distanceMeters)} · ${formatDuration(plan.fastest.durationSeconds)}`}
                />
                <Stat
                  label="Avoid cameras"
                  value={`${plan.camerasUnavoidable}`}
                  unit="cams"
                  sub={`${formatDistance(plan.avoidance.distanceMeters)} · ${formatDuration(plan.avoidance.durationSeconds)}`}
                  highlight
                />
              </div>
              <div className="plan-note">
                {plan.camerasUnavoidable === 0
                  ? "Avoidance route clears all known plate readers."
                  : `${plan.camerasUnavoidable} plate reader(s) still on the avoidance route — Drive will alert for them.`}
              </div>

              {plan.avoidance.steps.length > 0 && (
                <>
                  <button
                    className="steps-toggle"
                    onClick={() => setShowSteps((v) => !v)}
                  >
                    {showSteps ? "Hide" : "Show"} turn-by-turn (
                    {plan.avoidance.steps.length})
                  </button>
                  {showSteps && (
                    <ol className="directions">
                      {plan.avoidance.steps.map((s, i) => (
                        <li key={i}>
                          <span className="dir-text">{s.instruction}</span>
                          <span className="dir-dist">
                            {formatDistance(s.distanceMeters)}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                </>
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
                  <li
                    key={r.id}
                    className={r.id === activeRouteId ? "active" : ""}
                  >
                    <button
                      className="saved-main"
                      onClick={() => onActivateRoute(r)}
                    >
                      <span className="saved-label">{r.destinationLabel}</span>
                      <span className="saved-sub">
                        {r.camerasUnavoidable} unavoidable ·{" "}
                        {formatDistance(r.distanceMeters)} ·{" "}
                        {formatDuration(r.durationSeconds)}
                      </span>
                    </button>
                    <button
                      className="saved-del"
                      onClick={() => doDelete(r.id)}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
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
        <li key={`${r.label}-${i}`}>
          <button type="button" onClick={() => onPick(r)}>
            {r.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

function Stat({
  label,
  value,
  unit,
  sub,
  highlight,
}: {
  label: string;
  value: string;
  unit?: string;
  sub: string;
  highlight?: boolean;
}) {
  return (
    <div className={`stat ${highlight ? "stat-hl" : ""}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">
        {value}
        {unit ? <span className="stat-unit"> {unit}</span> : null}
      </span>
      <span className="stat-sub">{sub}</span>
    </div>
  );
}
