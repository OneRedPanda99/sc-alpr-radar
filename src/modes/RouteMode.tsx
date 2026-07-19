import { useEffect, useMemo, useRef, useState } from "react";
import type { Camera, LatLng, SavedRoute } from "@/types";
import { MapView } from "@/components/MapView";
import { useCameraStore } from "@/store/cameraStore";
import { useSettingsStore } from "@/store/settingsStore";
import {
  camerasNearRoute,
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

function shouldAvoidCamera(
  c: Camera,
  s: {
    avoidFlock: boolean;
    avoidOtherAlpr: boolean;
    avoidTraffic: boolean;
    avoidCustom: boolean;
    avoidCommunity: boolean;
  },
): boolean {
  if (c.custom) return s.avoidCustom;
  if (c.id.startsWith("community/")) return s.avoidCommunity;
  if (c.kind === "alpr" || c.kind === "speed") {
    if (c.brand === "Flock Safety") return s.avoidFlock;
    return s.avoidOtherAlpr;
  }
  // traffic / CCTV / SCDOT
  return s.avoidTraffic;
}

export function RouteMode({ onActivateRoute, activeRouteId }: RouteModeProps) {
  const { dataset } = useCameraStore();
  const showFov = useSettingsStore((s) => s.showFov);
  const showAlpr = useSettingsStore((s) => s.showAlpr);
  const showTraffic = useSettingsStore((s) => s.showTraffic);
  const flockOnly = useSettingsStore((s) => s.flockOnly);
  const basemap = useSettingsStore((s) => s.basemap);
  const avoidFlock = useSettingsStore((s) => s.avoidFlock);
  const avoidOtherAlpr = useSettingsStore((s) => s.avoidOtherAlpr);
  const avoidTraffic = useSettingsStore((s) => s.avoidTraffic);
  const avoidCustom = useSettingsStore((s) => s.avoidCustom);
  const avoidCommunity = useSettingsStore((s) => s.avoidCommunity);

  const [gpsPoint, setGpsPoint] = useState<LatLng | null>(null);

  const mapCameras = useMemo(() => {
    if (!dataset) return [];
    return dataset.cameras.filter(
      (c) =>
        (c.kind === "alpr" ? showAlpr : showTraffic) &&
        (!flockOnly || c.brand === "Flock Safety" || c.custom),
    );
  }, [dataset, showAlpr, showTraffic, flockOnly]);

  const routeCameras = useMemo(() => {
    if (!dataset) return [];
    const opts = {
      avoidFlock,
      avoidOtherAlpr,
      avoidTraffic,
      avoidCustom,
      avoidCommunity,
    };
    return dataset.cameras.filter((c) => shouldAvoidCamera(c, opts));
  }, [
    dataset,
    avoidFlock,
    avoidOtherAlpr,
    avoidTraffic,
    avoidCustom,
    avoidCommunity,
  ]);

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

  const searchSeq = useRef(0);
  const toInputRef = useRef<HTMLInputElement>(null);
  const fromInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void listRoutes().then(setSaved);
  }, []);

  const runSearch = async (which: "from" | "to", query: string) => {
    const q = query.trim();
    if (!q || q === "Current location") {
      if (which === "from") setFromResults([]);
      else setToResults([]);
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(which);
    setError(null);
    setActiveField(which);
    try {
      const results = await geocode(q, gpsPoint ?? from?.point ?? null);
      if (seq !== searchSeq.current) return; // stale
      if (!results.length) {
        setError(
          "No places found. Try: street number + street + city, e.g. 1600 Main St, Columbia SC",
        );
        if (which === "from") setFromResults([]);
        else setToResults([]);
        return;
      }
      if (which === "from") setFromResults(results);
      else setToResults(results);
    } catch (e) {
      if (seq !== searchSeq.current) return;
      setError((e as Error).message);
    } finally {
      if (seq === searchSeq.current) setSearching(null);
    }
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
    if (!("geolocation" in navigator)) {
      setError("Geolocation not supported on this device.");
      return;
    }
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const point = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
        };
        setGpsPoint(point);
        pickPlace("from", { label: "Current location", point });
      },
      (err) => setError(`GPS: ${err.message}`),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 15000 },
    );
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

  const highlightIds = useMemo(() => {
    if (!plan) return undefined;
    return new Set(
      camerasNearRoute(plan.avoidance.coordinates, routeCameras).map(
        (c) => c.id,
      ),
    );
  }, [plan, routeCameras]);

  const showingFromResults = activeField === "from" && fromResults.length > 0;
  const showingToResults = activeField === "to" && toResults.length > 0;

  return (
    <div className="mode route-mode">
      <div className={`route-map ${panelOpen ? "with-panel" : "full"}`}>
        <MapView
          cameras={mapCameras}
          highlightIds={highlightIds}
          center={from?.point ?? gpsPoint}
          showFov={showFov}
          basemap={basemap}
          routeLine={plan?.avoidance.coordinates ?? null}
          fitRoute
        />
        {!panelOpen && (
          <button
            className="route-sheet-toggle"
            onClick={() => setPanelOpen(true)}
          >
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
                ref={fromInputRef}
                className="search-input"
                placeholder="Type a start address"
                value={fromQuery}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="search"
                onFocus={() => setActiveField("from")}
                onChange={(e) => {
                  const v = e.target.value;
                  setFromQuery(v);
                  if (from) setFrom(null);
                  setFromResults([]);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void runSearch("from", fromQuery);
                  }
                }}
              />
              <button
                type="button"
                className="search-btn"
                onClick={() => void runSearch("from", fromQuery)}
              >
                {searching === "from" ? "…" : "Search"}
              </button>
              <button
                type="button"
                className="ghost-btn"
                onClick={useGpsOrigin}
                title="Use current GPS"
              >
                GPS
              </button>
            </div>

            {showingFromResults && (
              <ResultList
                items={fromResults}
                onPick={(p) => {
                  pickPlace("from", p);
                  toInputRef.current?.focus();
                }}
              />
            )}

            <div className="place-row">
              <span className="place-dot dest" />
              <input
                ref={toInputRef}
                className="search-input"
                placeholder="Type a destination address"
                value={toQuery}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="search"
                onFocus={() => setActiveField("to")}
                onChange={(e) => {
                  const v = e.target.value;
                  setToQuery(v);
                  if (to) setTo(null);
                  setToResults([]);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void runSearch("to", toQuery);
                  }
                }}
              />
              <button
                type="button"
                className="search-btn"
                onClick={() => void runSearch("to", toQuery)}
              >
                {searching === "to" ? "…" : "Search"}
              </button>
            </div>

            {showingToResults && (
              <ResultList
                items={toResults}
                onPick={(p) => pickPlace("to", p)}
              />
            )}

            <p className="place-hint">
              Type an address, tap <strong>Search</strong>, then tap a result.
              GPS is optional for start only.
            </p>
          </div>

          {searching && <div className="info">Searching addresses…</div>}
          {busy && (
            <div className="info">
              Searching parallel roads for fewer cameras + faster time…
            </div>
          )}
          {error && <div className="hud-error">{error}</div>}

          {from && to && !plan && !busy && !error && (
            <div className="info">Ready — calculating when both ends are set…</div>
          )}

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
                  ? "Avoidance route clears the cameras selected in Settings."
                  : plan.camerasUnavoidable < plan.camerasOnFastest
                    ? `Detoured some cameras — ${plan.camerasUnavoidable} still on this path (highlighted).`
                    : `${plan.camerasUnavoidable} camera(s) couldn't be avoided — highlighted on the map.`}
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
