import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Camera, LatLng, PlanRoute, Trip, TripPlan, TripStop } from "@/types";
import { PASSIVE_KINDS } from "@/types";
import { MapView } from "@/components/MapView";
import { PlaceInput } from "@/components/PlaceInput";
import { LayersPanel } from "@/components/LayersPanel";
import { Icon } from "@/components/Icon";
import { makeIsShown } from "@/services/layers";
import { useCameraStore } from "@/store/cameraStore";
import { useSettingsStore } from "@/store/settingsStore";
import {
  camerasNearRoute,
  formatDistance,
  formatDuration,
  planStops,
  reverseGeocode,
} from "@/services/routing";
import { deleteTrip, listTrips, saveTrip } from "@/services/storage";
import {
  arrivalTime,
  chosenRoute,
  duplicatePlan,
  mapStops,
  newStop,
  newTrip,
  planColor,
  planKey,
  planLetter,
  planReady,
  rememberPlace,
  shortLabel,
  stopBadge,
  tripTitle,
} from "@/services/trips";

interface RouteModeProps {
  onDrive: (trip: Trip, planId: string) => void;
  /** Called after every save so Drive can pick up edits to the active trip. */
  onTripSaved: (trip: Trip) => void;
  activeTripId: string | null;
  /** Lets other screens ask the planner to open a specific trip. */
  openTripRequest?: { tripId: string; token: number } | null;
  /** Start a fresh trip that ends at this place (from Drive's "Plan a route here"). */
  destinationRequest?: { label: string; point: LatLng; token: number } | null;
}

type AvoidOpts = {
  avoidFlock: boolean;
  avoidOtherAlpr: boolean;
  avoidTraffic: boolean;
  avoidCustom: boolean;
  avoidCommunity: boolean;
};

function shouldAvoidCamera(c: Camera, s: AvoidOpts): boolean {
  // Police stations aren't something a route detours around.
  if (PASSIVE_KINDS.has(c.kind)) return false;
  if (c.custom) return s.avoidCustom;
  if (c.id.startsWith("community/")) return s.avoidCommunity;
  if (c.kind === "alpr" || c.kind === "speed") {
    if (c.brand === "Flock Safety") return s.avoidFlock;
    return s.avoidOtherAlpr;
  }
  // traffic / CCTV / SCDOT
  return s.avoidTraffic;
}

const AVOID_CHIPS: { key: keyof AvoidOpts; label: string }[] = [
  { key: "avoidFlock", label: "Flock" },
  { key: "avoidOtherAlpr", label: "Other plate readers" },
  { key: "avoidTraffic", label: "Traffic cams" },
  { key: "avoidCustom", label: "Mine" },
  { key: "avoidCommunity", label: "Community" },
];

function cameraGroup(c: Camera): string {
  if (c.custom) return "yours";
  if (c.id.startsWith("community/")) return "community";
  if (c.kind === "alpr" || c.kind === "speed") {
    return c.brand === "Flock Safety" ? "Flock" : "other plate readers";
  }
  return "traffic cams";
}

export function RouteMode({
  onDrive,
  onTripSaved,
  activeTripId,
  openTripRequest,
  destinationRequest,
}: RouteModeProps) {
  const { dataset } = useCameraStore();
  const settings = useSettingsStore();
  const { showFov, basemap, osmLayers, set: setSetting } = settings;
  const avoid: AvoidOpts = {
    avoidFlock: settings.avoidFlock,
    avoidOtherAlpr: settings.avoidOtherAlpr,
    avoidTraffic: settings.avoidTraffic,
    avoidCustom: settings.avoidCustom,
    avoidCommunity: settings.avoidCommunity,
  };
  const avoidKey = AVOID_CHIPS.map((c) => (avoid[c.key] ? 1 : 0)).join("");

  const mapCameras = useMemo(() => {
    if (!dataset) return [];
    return dataset.cameras.filter(makeIsShown(settings));
  }, [dataset, settings]);

  const routeCameras = useMemo(() => {
    if (!dataset) return [];
    const opts: AvoidOpts = {
      avoidFlock: avoidKey[0] === "1",
      avoidOtherAlpr: avoidKey[1] === "1",
      avoidTraffic: avoidKey[2] === "1",
      avoidCustom: avoidKey[3] === "1",
      avoidCommunity: avoidKey[4] === "1",
    };
    return dataset.cameras.filter((c) => shouldAvoidCamera(c, opts));
  }, [dataset, avoidKey]);

  const [trips, setTrips] = useState<Trip[]>([]);
  const [trip, setTrip] = useState<Trip>(newTrip);
  const [planIdx, setPlanIdx] = useState(0);
  const [view, setView] = useState<"edit" | "trips">("edit");
  const [gpsPoint, setGpsPoint] = useState<LatLng | null>(null);
  const [progress, setProgress] = useState<Record<string, { f: number; stage: string }>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [placingStopId, setPlacingStopId] = useState<string | null>(null);
  const [openNotes, setOpenNotes] = useState<Set<string>>(new Set());
  const [showSteps, setShowSteps] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [gpsError, setGpsError] = useState<string | null>(null);

  const plan = trip.plans[Math.min(planIdx, trip.plans.length - 1)];
  const route = chosenRoute(plan);
  const currentKey = planKey(plan, avoidKey);
  const stale = !!plan.computed && plan.computed.key !== currentKey;
  const busy = progress[plan.id];

  useEffect(() => {
    void listTrips().then(setTrips);
  }, []);

  // Open a trip handed over from elsewhere (e.g. Drive's "Edit plan").
  useEffect(() => {
    if (!openTripRequest) return;
    void listTrips().then((all) => {
      setTrips(all);
      const t = all.find((x) => x.id === openTripRequest.tripId);
      if (t) {
        setTrip(t);
        setPlanIdx(0);
        setView("edit");
      }
    });
  }, [openTripRequest]);

  useEffect(() => {
    if (!destinationRequest) return;
    const t = newTrip();
    const dest = t.plans[0].stops[1];
    dest.label = destinationRequest.label;
    dest.point = destinationRequest.point;
    setTrip(t);
    setPlanIdx(0);
    setView("edit");
    setCollapsed(false);
  }, [destinationRequest]);

  // If location is already allowed, quietly fill the start with it. Asking
  // for permission is left to an explicit tap.
  useEffect(() => {
    const perms = (navigator as Navigator & { permissions?: Permissions }).permissions;
    if (!perms?.query || !("geolocation" in navigator)) return;
    void perms
      .query({ name: "geolocation" as PermissionName })
      .then((st) => {
        if (st.state !== "granted") return;
        navigator.geolocation.getCurrentPosition(
          (pos) => setGpsPoint({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
          () => {},
          { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 },
        );
      })
      .catch(() => {});
  }, []);

  // --- Editing helpers ------------------------------------------------------

  const updatePlan = useCallback((planId: string, fn: (p: TripPlan) => TripPlan) => {
    setTrip((t) => ({ ...t, plans: t.plans.map((p) => (p.id === planId ? fn(p) : p)) }));
  }, []);

  const setStops = (fn: (stops: TripStop[]) => TripStop[]) =>
    updatePlan(plan.id, (p) => ({ ...p, stops: fn(p.stops) }));

  const patchStop = (stopId: string, patch: Partial<TripStop>) =>
    setStops((stops) => stops.map((s) => (s.id === stopId ? { ...s, ...patch } : s)));

  // Fill an empty start with GPS once it's known.
  useEffect(() => {
    if (!gpsPoint) return;
    const first = plan.stops[0];
    if (first && !first.point && !first.label) {
      patchStop(first.id, { label: "Current location", point: gpsPoint });
    }
    // Deliberately only when the fix first arrives or the plan changes.
  }, [gpsPoint, plan.id]);

  const fillWithGps = (stopId: string) => {
    if (!("geolocation" in navigator)) {
      setGpsError("This device can't share its location.");
      return;
    }
    setGpsError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const point = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        setGpsPoint(point);
        patchStop(stopId, { label: "Current location", point });
      },
      (err) =>
        setGpsError(
          err.code === err.PERMISSION_DENIED
            ? "Location is blocked for this site. Type a start address instead."
            : "Couldn't get a GPS fix. Type a start address instead.",
        ),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 15000 },
    );
  };

  const [focusStopId, setFocusStopId] = useState<string | null>(null);
  const addStop = () => {
    const stop = newStop();
    setStops((stops) => [...stops.slice(0, -1), stop, stops[stops.length - 1]]);
    // Put the cursor in the new field; otherwise it appears somewhere above
    // the button you just pressed and you have to go looking for it.
    setFocusStopId(stop.id);
  };

  const removeStop = (i: number) =>
    setStops((stops) =>
      stops.length > 2
        ? stops.filter((_, j) => j !== i)
        : stops.map((s, j) => (j === i ? { ...s, label: "", point: null } : s)),
    );

  const moveStop = (i: number, dir: -1 | 1) =>
    setStops((stops) => {
      const j = i + dir;
      if (j < 0 || j >= stops.length) return stops;
      const next = [...stops];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const reverseStops = () => setStops((stops) => [...stops].reverse());

  const addPlan = () => {
    setTrip((t) => ({ ...t, plans: [...t.plans, duplicatePlan(plan, t.plans.length)] }));
    setPlanIdx(trip.plans.length);
    setShowSteps(false);
  };

  const deletePlan = () => {
    if (trip.plans.length < 2) return;
    setTrip((t) => ({ ...t, plans: t.plans.filter((p) => p.id !== plan.id) }));
    setPlanIdx((i) => Math.max(0, i - 1));
  };

  const handleMapPlace = async (point: LatLng) => {
    const stopId = placingStopId;
    if (!stopId) return;
    setPlacingStopId(null);
    patchStop(stopId, { point, label: "Dropped pin" });
    const label = await reverseGeocode(point);
    patchStop(stopId, { label });
    rememberPlace({ label, point });
  };

  // --- Routing --------------------------------------------------------------

  const inflight = useRef(new Map<string, string>());

  const compute = useCallback(
    async (p: TripPlan, key: string) => {
      if (inflight.current.get(p.id) === key) return;
      inflight.current.set(p.id, key);
      const live = () => inflight.current.get(p.id) === key;
      setProgress((s) => ({ ...s, [p.id]: { f: 0.03, stage: "Starting" } }));
      setErrors((s) => {
        const n = { ...s };
        delete n[p.id];
        return n;
      });
      try {
        const res = await planStops(
          p.stops.map((s) => ({ label: shortLabel(s.label || "stop"), point: s.point! })),
          routeCameras,
          (f, stage) => {
            if (live()) setProgress((s) => ({ ...s, [p.id]: { f, stage } }));
          },
        );
        if (!live()) return;
        updatePlan(p.id, (cur) => ({
          ...cur,
          computed: { ...res, computedAt: new Date().toISOString(), key },
        }));
      } catch (e) {
        if (live()) setErrors((s) => ({ ...s, [p.id]: (e as Error).message }));
      } finally {
        if (live()) {
          inflight.current.delete(p.id);
          setProgress((s) => {
            const n = { ...s };
            delete n[p.id];
            return n;
          });
        }
      }
    },
    [routeCameras, updatePlan],
  );

  useEffect(() => {
    if (!dataset || !planReady(plan)) return;
    if (plan.computed?.key === currentKey) return;
    const t = setTimeout(() => void compute(plan, currentKey), 350);
    return () => clearTimeout(t);
    // `plan` identity changes on every edit; the key captures what matters.
  }, [currentKey, plan.id, dataset, compute]);

  // --- Autosave -------------------------------------------------------------

  const [savedAt, setSavedAt] = useState<number | null>(null);
  useEffect(() => {
    const hasContent = trip.plans.some((p) => p.stops.some((s) => s.point));
    if (!hasContent) return;
    const t = setTimeout(async () => {
      const stored = { ...trip, updatedAt: new Date().toISOString() };
      await saveTrip(stored);
      setTrips(await listTrips());
      setSavedAt(Date.now());
      onTripSaved(stored);
    }, 600);
    return () => clearTimeout(t);
  }, [trip, onTripSaved]);

  // --- Derived map data -----------------------------------------------------

  const routeCams = useMemo(
    () => (route ? camerasNearRoute(route.coordinates, routeCameras) : []),
    [route, routeCameras],
  );
  const highlightIds = useMemo(() => new Set(routeCams.map((c) => c.id)), [routeCams]);
  const camGroups = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of routeCams) m.set(cameraGroup(c), (m.get(cameraGroup(c)) ?? 0) + 1);
    return [...m.entries()];
  }, [routeCams]);

  const altRoutes = useMemo(() => {
    const out: { coordinates: [number, number][]; color?: string }[] = [];
    trip.plans.forEach((p, i) => {
      if (p.id === plan.id) {
        const other = p.computed?.[p.prefer === "avoid" ? "fastest" : "avoid"];
        if (other && route && other.coordinates.length !== route.coordinates.length) {
          out.push({ coordinates: other.coordinates });
        }
        return;
      }
      const r = chosenRoute(p);
      if (r) out.push({ coordinates: r.coordinates, color: planColor(i) });
    });
    return out;
  }, [trip.plans, plan.id, route]);

  const stopsOnMap = useMemo(() => mapStops(plan), [plan]);

  // Keep fitted routes clear of the sheet.
  const sheetRef = useRef<HTMLDivElement>(null);
  const [fitPadding, setFitPadding] = useState({ top: 0, bottom: 0, left: 0, right: 0 });
  useEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const wide = window.innerWidth >= 900;
      setFitPadding(
        wide
          ? { top: 0, bottom: 0, left: el.offsetWidth + 16, right: 0 }
          : { top: 0, bottom: collapsed ? 120 : el.offsetHeight, left: 0, right: 0 },
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [collapsed]);

  const mapCenter = plan.stops.find((s) => s.point)?.point ?? gpsPoint;

  // --- Render ---------------------------------------------------------------

  const color = planColor(planIdx);
  const fastest = plan.computed?.fastest;
  const avoidR = plan.computed?.avoid;
  const sameRoute =
    !!fastest &&
    !!avoidR &&
    fastest.cameraCount === avoidR.cameraCount &&
    Math.abs(fastest.durationSeconds - avoidR.durationSeconds) < 30;

  const openTrip = (t: Trip) => {
    setTrip(t);
    setPlanIdx(0);
    setView("edit");
    setShowSteps(false);
    setCollapsed(false);
  };

  const startNew = () => {
    setTrip(newTrip());
    setPlanIdx(0);
    setView("edit");
    setShowSteps(false);
  };

  return (
    <div className="mode planner">
      <div className="planner-map">
        <MapView
          cameras={mapCameras}
          highlightIds={highlightIds}
          // With a route the map fits to it; centring on the start as well
          // would undo the fit and leave you zoomed in on one end.
          center={route ? gpsPoint : mapCenter}
          showFov={showFov}
          basemap={basemap}
          routeLine={route?.coordinates ?? null}
          routeColor={color}
          altRoutes={altRoutes}
          stops={stopsOnMap}
          fitRoute
          fitPadding={fitPadding}
          placing={placingStopId != null}
          onMapClick={handleMapPlace}
          osmLayers={osmLayers}
        />
        <div className="map-fabs">
          <button
            type="button"
            className="fab"
            onClick={() => setLayersOpen((v) => !v)}
            aria-label="Map layers"
            aria-expanded={layersOpen}
          >
            <Icon name="layers" />
          </button>
        </div>
        {layersOpen && <LayersPanel onClose={() => setLayersOpen(false)} />}
        {placingStopId && (
          <div className="place-banner" role="status">
            <span>Tap the map to set this stop</span>
            <button type="button" className="ghost-btn" onClick={() => setPlacingStopId(null)}>
              Cancel
            </button>
          </div>
        )}
      </div>

      <section
        ref={sheetRef}
        className={`planner-sheet ${collapsed ? "collapsed" : ""}`}
        aria-label="Trip planner"
      >
        <button
          type="button"
          className="sheet-handle"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? "Expand planner" : "Collapse planner to see the map"}
        >
          <span />
        </button>

        {view === "trips" ? (
          <TripsList
            trips={trips}
            activeTripId={activeTripId}
            confirmDelete={confirmDelete}
            onBack={() => setView("edit")}
            onNew={startNew}
            onOpen={openTrip}
            onDrive={(t) => {
              const p = t.plans.find((x) => chosenRoute(x)) ?? t.plans[0];
              onDrive(t, p.id);
            }}
            onDelete={async (id) => {
              if (confirmDelete !== id) {
                setConfirmDelete(id);
                return;
              }
              setConfirmDelete(null);
              await deleteTrip(id);
              setTrips(await listTrips());
              if (trip.id === id) setTrip(newTrip());
            }}
          />
        ) : (
          <>
            <div className="sheet-head">
              {renaming ? (
                <input
                  className="trip-name-input"
                  autoFocus
                  value={trip.name}
                  placeholder={tripTitle({ ...trip, name: "" })}
                  onChange={(e) => setTrip((t) => ({ ...t, name: e.target.value }))}
                  onBlur={() => setRenaming(false)}
                  onKeyDown={(e) => e.key === "Enter" && setRenaming(false)}
                />
              ) : (
                <button
                  type="button"
                  className="trip-name"
                  onClick={() => setRenaming(true)}
                  title="Rename trip"
                >
                  {tripTitle(trip)}
                  <span className="trip-name-edit">Rename</span>
                </button>
              )}
              <div className="sheet-head-actions">
                <button type="button" className="ghost-btn" onClick={startNew}>
                  New
                </button>
                <button type="button" className="ghost-btn" onClick={() => setView("trips")}>
                  Trips{trips.length ? ` (${trips.length})` : ""}
                </button>
              </div>
            </div>

            <div className="plan-tabs" role="tablist" aria-label="Plans">
              {trip.plans.map((p, i) => {
                const r = chosenRoute(p);
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="tab"
                    aria-selected={i === planIdx}
                    className={`plan-tab ${i === planIdx ? "on" : ""}`}
                    style={{ ["--plan" as string]: planColor(i) }}
                    onClick={() => {
                      setPlanIdx(i);
                      setShowSteps(false);
                    }}
                  >
                    <span className="plan-tab-name">{p.name}</span>
                    <span className="plan-tab-sub">
                      {progress[p.id]
                        ? "Planning"
                        : r
                          ? `${formatDuration(r.durationSeconds)} · ${r.cameraCount} cam${r.cameraCount === 1 ? "" : "s"}`
                          : "Not planned"}
                    </span>
                  </button>
                );
              })}
              {trip.plans.length < 6 && (
                <button
                  type="button"
                  className="plan-tab plan-tab-add"
                  onClick={addPlan}
                  title={`Add Plan ${planLetter(trip.plans.length)}, starting as a copy of ${plan.name}`}
                >
                  <Icon name="plus" /> Plan {planLetter(trip.plans.length)}
                </button>
              )}
            </div>

            <div className="sheet-scroll">
              <div className="stops" style={{ ["--plan" as string]: color }}>
                {plan.stops.map((s, i) => {
                  const n = plan.stops.length;
                  const isEnd = i === n - 1;
                  const noteOpen = openNotes.has(s.id) || !!s.note;
                  return (
                    <div key={s.id} className={`stop-row ${s.checkpoint ? "is-check" : ""}`}>
                      <div className="stop-rail">
                        <span className={`stop-badge ${i === 0 ? "start" : isEnd ? "end" : ""}`}>
                          {stopBadge(i, n)}
                        </span>
                        {!isEnd && <span className="stop-line" />}
                      </div>
                      <div className="stop-main">
                        <PlaceInput
                          label={s.label}
                          point={s.point}
                          near={gpsPoint}
                          placeholder={
                            i === 0
                              ? "Start: address, place or lat, lon"
                              : isEnd
                                ? "Destination: address, place or lat, lon"
                                : `Stop ${i}`
                          }
                          allowGps={i === 0}
                          autoFocus={focusStopId === s.id}
                          onPick={(p) => patchStop(s.id, { label: p.label, point: p.point })}
                          onEdit={(text) => patchStop(s.id, { label: text, point: null })}
                          onGps={() => fillWithGps(s.id)}
                          onPickOnMap={() => {
                            setPlacingStopId(s.id);
                            setCollapsed(true);
                          }}
                        />
                        {noteOpen && (
                          <textarea
                            className="stop-note"
                            rows={2}
                            placeholder="Note for this stop (shows in Drive when you arrive)"
                            value={s.note ?? ""}
                            onChange={(e) => patchStop(s.id, { note: e.target.value })}
                          />
                        )}
                        <div className="stop-tools">
                          <button
                            type="button"
                            className={`tool-btn ${s.checkpoint ? "on" : ""}`}
                            aria-pressed={!!s.checkpoint}
                            onClick={() => patchStop(s.id, { checkpoint: !s.checkpoint })}
                            title="Checkpoint: Drive counts down to it and tells you when you pass it"
                          >
                            <Icon name="flag" /> Checkpoint
                          </button>
                          <button
                            type="button"
                            className={`tool-btn ${noteOpen ? "on" : ""}`}
                            onClick={() =>
                              setOpenNotes((set) => {
                                const next = new Set(set);
                                if (next.has(s.id)) next.delete(s.id);
                                else next.add(s.id);
                                return next;
                              })
                            }
                          >
                            Note
                          </button>
                          <span className="stop-tools-spacer" />
                          <button
                            type="button"
                            className="tool-btn icon"
                            onClick={() => moveStop(i, -1)}
                            disabled={i === 0}
                            aria-label="Move up"
                          >
                            <Icon name="up" />
                          </button>
                          <button
                            type="button"
                            className="tool-btn icon"
                            onClick={() => moveStop(i, 1)}
                            disabled={isEnd}
                            aria-label="Move down"
                          >
                            <Icon name="down" />
                          </button>
                          <button
                            type="button"
                            className="tool-btn icon"
                            onClick={() => removeStop(i)}
                            aria-label={n > 2 ? "Remove stop" : "Clear"}
                          >
                            <Icon name="trash" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div className="stops-actions">
                  <button type="button" className="ghost-btn" onClick={addStop}>
                    <Icon name="plus" /> Add stop
                  </button>
                  <button type="button" className="ghost-btn" onClick={reverseStops}>
                    <Icon name="swap" /> Reverse
                  </button>
                </div>
                {gpsError && <div className="hud-error">{gpsError}</div>}
              </div>

              <div className="avoid-row">
                <span className="avoid-label">Avoid</span>
                {AVOID_CHIPS.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    className={`chip ${avoid[c.key] ? "on" : ""}`}
                    aria-pressed={avoid[c.key]}
                    onClick={() => setSetting(c.key, !avoid[c.key])}
                  >
                    {c.label}
                  </button>
                ))}
              </div>

              {busy && (
                <div className="plan-progress" role="status">
                  <div className="plan-progress-bar">
                    <span style={{ transform: `scaleX(${Math.max(0.04, busy.f)})` }} />
                  </div>
                  <div className="plan-progress-text">{busy.stage}</div>
                </div>
              )}
              {errors[plan.id] && <div className="hud-error">{errors[plan.id]}</div>}

              {(!route || !planReady(plan)) && !busy && !errors[plan.id] && (
                <div className="empty-hint">
                  {planReady(plan) ? "Getting ready to plan" : emptyStopHint(plan)}
                </div>
              )}

              {route && fastest && avoidR && (
                <div className={`results-block ${busy || stale ? "is-stale" : ""}`}>
                  {sameRoute ? (
                    <RouteOption
                      title="Best route"
                      subtitle="Fastest and fewest cameras"
                      r={avoidR}
                      selected
                      onSelect={() => {}}
                    />
                  ) : (
                    <div className="options">
                      <RouteOption
                        title="Fewest cameras"
                        r={avoidR}
                        selected={plan.prefer === "avoid"}
                        delta={`${avoidR.durationSeconds - fastest.durationSeconds > 0 ? "+" : ""}${Math.round((avoidR.durationSeconds - fastest.durationSeconds) / 60)} min, ${fastest.cameraCount - avoidR.cameraCount} fewer`}
                        onSelect={() => updatePlan(plan.id, (p) => ({ ...p, prefer: "avoid" }))}
                      />
                      <RouteOption
                        title="Fastest"
                        r={fastest}
                        selected={plan.prefer === "fastest"}
                        onSelect={() => updatePlan(plan.id, (p) => ({ ...p, prefer: "fastest" }))}
                      />
                    </div>
                  )}

                  <div className="route-cams">
                    {routeCams.length === 0 ? (
                      <span className="route-cams-clear">No avoided cameras on this route</span>
                    ) : (
                      <>
                        <span>On this route:</span>
                        {camGroups.map(([g, n]) => (
                          <span key={g} className="cam-chip">
                            {n} {g}
                          </span>
                        ))}
                      </>
                    )}
                  </div>

                  {route.legs.length > 1 && (
                    <ol className="legs">
                      {route.legs.map((leg, i) => (
                        <li key={i}>
                          <span className="leg-ends">
                            {stopBadge(i, plan.stops.length)} → {stopBadge(i + 1, plan.stops.length)}{" "}
                            <span className="leg-to">{shortLabel(plan.stops[i + 1]?.label ?? "")}</span>
                          </span>
                          <span className="leg-stats">
                            {formatDuration(leg.durationSeconds)} · {formatDistance(leg.distanceMeters)} ·{" "}
                            <b className={leg.cameraCount ? "warn" : "ok"}>{leg.cameraCount} cams</b>
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}

                  {route.steps.length > 0 && (
                    <>
                      <button
                        type="button"
                        className="steps-toggle"
                        onClick={() => setShowSteps((v) => !v)}
                        aria-expanded={showSteps}
                      >
                        {showSteps ? "Hide" : "Show"} turn-by-turn ({route.steps.length})
                      </button>
                      {showSteps && (
                        <ol className="directions">
                          {route.steps.map((st, i) => (
                            <li key={i} className={st.maneuverType === "waypoint" ? "dir-stop" : ""}>
                              <span className="dir-text">{st.instruction}</span>
                              {st.distanceMeters > 0 && (
                                <span className="dir-dist">{formatDistance(st.distanceMeters)}</span>
                              )}
                            </li>
                          ))}
                        </ol>
                      )}
                    </>
                  )}
                </div>
              )}

              <label className="plan-notes">
                <span>{plan.name} notes</span>
                <textarea
                  rows={3}
                  value={plan.notes}
                  placeholder="When to use this plan, what to watch for, where to switch to another plan…"
                  onChange={(e) => updatePlan(plan.id, (p) => ({ ...p, notes: e.target.value }))}
                />
              </label>

              {trip.plans.length > 1 && (
                <ComparePlans
                  plans={trip.plans}
                  current={planIdx}
                  onPick={(i) => setPlanIdx(i)}
                  onDelete={deletePlan}
                  currentName={plan.name}
                />
              )}
            </div>

            <div className="sheet-foot">
              <span className="save-state">
                {savedAt ? "Saved on this device" : "Saves automatically"}
              </span>
              <button
                type="button"
                className="big-btn drive-btn"
                disabled={!route}
                style={{ ["--plan" as string]: color }}
                onClick={() => onDrive(trip, plan.id)}
              >
                Drive {plan.name}
                {route ? ` · ${formatDuration(route.durationSeconds)}` : ""}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

/** Say exactly which field is holding the plan up. */
function emptyStopHint(plan: TripPlan): string {
  const n = plan.stops.length;
  if (!plan.stops.some((s) => s.point)) {
    return "Set a start and destination. Add stops, notes and checkpoints, then add Plan B and C to compare different ways there.";
  }
  const missing = plan.stops
    .map((s, i) => (s.point ? null : i === 0 ? "the start" : i === n - 1 ? "the destination" : `stop ${i}`))
    .filter(Boolean);
  // Only stops in the middle can be removed; the ends just need filling in.
  const middleOnly = plan.stops.every((st, i) => st.point || (i > 0 && i < n - 1));
  return `Fill in ${missing.join(" and ")}${
    middleOnly ? ` (or remove ${missing.length > 1 ? "them" : "it"})` : ""
  } to plan this route.`;
}

function RouteOption({
  title,
  subtitle,
  r,
  selected,
  delta,
  onSelect,
}: {
  title: string;
  subtitle?: string;
  r: PlanRoute;
  selected: boolean;
  delta?: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`option ${selected ? "on" : ""}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="option-title">{title}</span>
      <span className="option-time">{formatDuration(r.durationSeconds)}</span>
      <span className="option-sub">
        {formatDistance(r.distanceMeters)} · arrive {arrivalTime(r.durationSeconds)}
      </span>
      <span className={`option-cams ${r.cameraCount ? "warn" : "ok"}`}>
        {r.cameraCount} camera{r.cameraCount === 1 ? "" : "s"}
      </span>
      {subtitle && <span className="option-delta">{subtitle}</span>}
      {delta && <span className="option-delta">{delta}</span>}
    </button>
  );
}

function ComparePlans({
  plans,
  current,
  onPick,
  onDelete,
  currentName,
}: {
  plans: TripPlan[];
  current: number;
  onPick: (i: number) => void;
  onDelete: () => void;
  currentName: string;
}) {
  return (
    <div className="compare">
      <h3>Compare plans</h3>
      <table>
        <thead>
          <tr>
            <th>Plan</th>
            <th>Time</th>
            <th>Distance</th>
            <th>Cams</th>
            <th>Stops</th>
          </tr>
        </thead>
        <tbody>
          {plans.map((p, i) => {
            const r = chosenRoute(p);
            return (
              <tr
                key={p.id}
                className={i === current ? "on" : ""}
                onClick={() => onPick(i)}
                style={{ ["--plan" as string]: planColor(i) }}
              >
                <td>
                  <span className="compare-dot" /> {p.name}
                </td>
                <td>{r ? formatDuration(r.durationSeconds) : "–"}</td>
                <td>{r ? formatDistance(r.distanceMeters) : "–"}</td>
                <td>{r ? r.cameraCount : "–"}</td>
                <td>{Math.max(0, p.stops.length - 2)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button type="button" className="text-btn danger" onClick={onDelete}>
        Delete {currentName}
      </button>
    </div>
  );
}

function TripsList({
  trips,
  activeTripId,
  confirmDelete,
  onBack,
  onNew,
  onOpen,
  onDrive,
  onDelete,
}: {
  trips: Trip[];
  activeTripId: string | null;
  confirmDelete: string | null;
  onBack: () => void;
  onNew: () => void;
  onOpen: (t: Trip) => void;
  onDrive: (t: Trip) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <>
      <div className="sheet-head">
        <button type="button" className="ghost-btn" onClick={onBack}>
          Back
        </button>
        <h2 className="sheet-title">Saved trips</h2>
        <button type="button" className="ghost-btn" onClick={onNew}>
          <Icon name="plus" /> New
        </button>
      </div>
      <div className="sheet-scroll">
        {trips.length === 0 ? (
          <div className="empty-hint">
            No trips yet. Plan one and it's saved here automatically.
          </div>
        ) : (
          <ul className="trip-list">
            {trips.map((t) => (
              <li key={t.id} className={t.id === activeTripId ? "active" : ""}>
                <button type="button" className="trip-main" onClick={() => onOpen(t)}>
                  <span className="trip-title">
                    {tripTitle(t)}
                    {t.id === activeTripId && <span className="badge-live">In Drive</span>}
                  </span>
                  <span className="trip-plans">
                    {t.plans.map((p, i) => {
                      const r = chosenRoute(p);
                      return (
                        <span key={p.id} className="trip-plan" style={{ ["--plan" as string]: planColor(i) }}>
                          {planLetter(i)}
                          {r ? ` ${formatDuration(r.durationSeconds)} · ${r.cameraCount}` : ""}
                        </span>
                      );
                    })}
                  </span>
                  <span className="trip-date">
                    Edited {new Date(t.updatedAt).toLocaleDateString([], { month: "short", day: "numeric" })}
                  </span>
                </button>
                <div className="trip-actions">
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => onDrive(t)}
                    disabled={!t.plans.some((p) => chosenRoute(p))}
                  >
                    Drive
                  </button>
                  <button
                    type="button"
                    className={`ghost-btn ${confirmDelete === t.id ? "danger" : ""}`}
                    onClick={() => onDelete(t.id)}
                    aria-label="Delete trip"
                  >
                    {confirmDelete === t.id ? "Delete?" : <Icon name="trash" />}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
