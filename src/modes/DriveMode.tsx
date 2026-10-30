import { useEffect, useMemo, useRef, useState } from "react";
import type { ActiveTrip, Camera, CameraKind } from "@/types";
import { MapView } from "@/components/MapView";
import {
  AllClearBanner,
  CameraAlertCard,
  CameraDetailCard,
  FacingPicker,
} from "@/components/CameraAlertCard";
import {
  LiveCameraVideo,
  isLiveCamera,
  type PassInfo,
} from "@/components/LiveCameraImage";
import { aimBearingFor } from "@/services/symbols";
import { LayersPanel } from "@/components/LayersPanel";
import { PlaceInput } from "@/components/PlaceInput";
import { Icon } from "@/components/Icon";
import type { LatLng } from "@/types";
import { useCameraStore } from "@/store/cameraStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useGeolocation } from "@/hooks/useGeolocation";
import { useWakeLock } from "@/hooks/useWakeLock";
import {
  AlertTracker,
  playAlert,
  unlockAudio,
} from "@/services/alertEngine";
import {
  bearingDeg,
  bearingDelta,
  feetToMeters,
  haversineMeters,
  parseCoordinates,
} from "@/services/geo";
import {
  camerasNearRoute,
  formatDistance,
  formatDuration,
  reverseGeocode,
} from "@/services/routing";
import { KIND_LABELS } from "@/services/brand";
import { makeIsAlertable, makeIsShown } from "@/services/layers";
import { useMovingAircraft } from "@/hooks/useMovingAircraft";
import {
  arrivalTime,
  chosenRoute,
  mapStops,
  planColor,
  shortLabel,
  stopBadge,
  tripTitle,
} from "@/services/trips";

interface DriveModeProps {
  active: ActiveTrip | null;
  onSwitchPlan: (planId: string) => void;
  onClearTrip: () => void;
  onOpenPlanner: () => void;
  onDrivingChange?: (driving: boolean) => void;
  /** Start a new trip in the planner that ends at this place. */
  onPlanTo?: (place: { label: string; point: LatLng }) => void;
  /** False while another tab is showing; live video pauses to save data. */
  visible?: boolean;
}

/** Matches the CSS breakpoint where the side rail appears. */
function useWide(query = "(min-width: 1000px)") {
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return wide;
}

interface NearHit {
  camera: Camera;
  distance: number;
  ahead: boolean;
}

/** How close counts as "arrived" at a stop or checkpoint. */
const ARRIVE_METERS = 90;
/** Start timing a pass once a live camera ahead is this close. */
const PASS_TRACK_METERS = 1600;
/** Keep showing the camera you passed this long, so you see yourself on it. */
const PASS_HOLD_MS = 35000;

interface PassTrack {
  camId: string;
  /** Closest approach so far, and when. */
  minD: number;
  minAt: number;
  /** Predicted or actual moment of closest approach. */
  at: number;
  actual: boolean;
  hint?: string;
}

/** Signed angle a→b in degrees, -180..180. */
function signedDelta(a: number, b: number): number {
  return ((b - a + 540) % 360) - 180;
}

/**
 * Where you'll show up in the camera's picture. Only as good as the camera's
 * mapped facing: PTZ cameras get re-aimed, so this is a hint, not a promise.
 */
function passHint(cam: Camera, heading: number | null, here: LatLng): string | undefined {
  if (heading == null) return undefined;
  // PTZ cameras only carry the road's bearing, which says nothing about which
  // way the lens points right now, so left/right would be invented.
  if (cam.omni || !cam.directions.some((d) => Number.isFinite(d))) {
    const dirs = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
    return `Look for your car in the ${dirs[Math.round(heading / 45) % 8]}bound lanes`;
  }
  const facing = aimBearingFor(cam);
  if (facing == null) return undefined;
  const rel = Math.abs(signedDelta(facing, heading));
  const motion =
    rel > 135
      ? "driving toward the camera, getting bigger"
      : rel < 45
        ? "driving away from the camera, into the distance"
        : signedDelta(facing, heading) > 0
          ? "crossing the picture left to right"
          : "crossing the picture right to left";
  const side = signedDelta(facing, bearingDeg(cam, here));
  const where = Math.abs(side) < 12 ? "near the middle" : side > 0 ? "on the right side" : "on the left side";
  return `Look ${where}, ${motion} (if it's aimed as mapped)`;
}

export function DriveMode({
  active,
  onSwitchPlan,
  onClearTrip,
  onOpenPlanner,
  onDrivingChange,
  onPlanTo,
  visible = true,
}: DriveModeProps) {
  const wide = useWide();
  const { grid, dataset, status, addCamera, updateCamera, removeCamera } =
    useCameraStore();
  const {
    alertDistanceFeet,
    muted,
    headingUp,
    escalate,
    showFov,
    alertSound,
    basemap,
    osmLayers,
    set: setSetting,
  } = useSettingsStore();

  const settings = useSettingsStore();
  const isShown = useMemo(() => makeIsShown(settings), [settings]);
  const isAlertable = useMemo(() => makeIsAlertable(settings), [settings]);

  const [driving, setDriving] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [browseCenter, setBrowseCenter] = useState<LatLng | null>(null);
  const [addKind, setAddKind] = useState<CameraKind | null>(null);
  /** Facing while placing: null = 360° / omni, else degrees 0–359. */
  const [addFacing, setAddFacing] = useState<number | null>(null);
  const [recenter, setRecenter] = useState(0);
  const [layersOpen, setLayersOpen] = useState(false);
  /** Phones: the live feed is a floating card you open on demand. */
  const [feedOpen, setFeedOpen] = useState(false);
  /** null = follow the nearest live camera ahead automatically. */
  const [pinnedFeedId, setPinnedFeedId] = useState<string | null>(null);
  const [reached, setReached] = useState<Set<string>>(new Set());
  const [arrival, setArrival] = useState<{ label: string; note?: string; checkpoint?: boolean } | null>(null);
  const [passTrack, setPassTrack] = useState<PassTrack | null>(null);
  /** A place you searched for or long-pressed, just to look at. */
  const [look, setLook] = useState<{ label: string; point: LatLng; token: number } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [clips, setClips] = useState<{ url: string; name: string; at: number }[]>([]);
  const { fix, error } = useGeolocation({ enabled: driving });
  useWakeLock(driving);

  useEffect(() => {
    onDrivingChange?.(driving);
  }, [driving, onDrivingChange]);

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

  // --- Active trip / plan ---------------------------------------------------
  const trip = active?.trip ?? null;
  const planIdx = trip ? Math.max(0, trip.plans.findIndex((p) => p.id === active?.planId)) : 0;
  const plan = trip?.plans[planIdx] ?? null;
  const route = plan ? chosenRoute(plan) : null;
  const steps = route?.steps ?? [];

  const altRoutes = useMemo(
    () =>
      (trip?.plans ?? []).flatMap((p, i) => {
        if (p.id === plan?.id) return [];
        const r = chosenRoute(p);
        return r ? [{ coordinates: r.coordinates, color: planColor(i) }] : [];
      }),
    [trip, plan?.id],
  );
  const stopsOnMap = useMemo(() => (plan ? mapStops(plan) : []), [plan]);

  // Advance turn-by-turn as you pass each maneuver point.
  useEffect(() => {
    if (!driving || !fix || !steps.length) return;
    let next = stepIndex;
    for (let i = stepIndex; i < steps.length - 1; i++) {
      const [lon, lat] = steps[i].location;
      const dist = haversineMeters(fix.point, { lat, lon });
      if (dist < 40) next = i + 1;
      else break;
    }
    if (next !== stepIndex) setStepIndex(next);
  }, [driving, fix, steps, stepIndex]);

  // New trip: start from the top. New plan mid-drive: pick up at the nearest
  // maneuver, since you're switching from wherever you are, not the start.
  const fixRef = useRef(fix);
  fixRef.current = fix;
  useEffect(() => {
    setReached(new Set());
    setArrival(null);
  }, [trip?.id]);
  useEffect(() => {
    const here = fixRef.current?.point;
    if (!here || !steps.length) {
      setStepIndex(0);
      return;
    }
    let best = 0;
    let bestD = Infinity;
    steps.forEach((s, i) => {
      const d = haversineMeters(here, { lat: s.location[1], lon: s.location[0] });
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    setStepIndex(best);
    // Only on plan changes.
  }, [plan?.id, route]);

  // Stops & checkpoints: mark arrived, surface the note.
  useEffect(() => {
    if (!driving || !fix || !plan) return;
    plan.stops.forEach((s, i) => {
      if (i === 0 || !s.point || reached.has(s.id)) return;
      if (haversineMeters(fix.point, s.point) < ARRIVE_METERS) {
        setReached((r) => new Set(r).add(s.id));
        setArrival({ label: s.label, note: s.note, checkpoint: s.checkpoint });
        if (!muted) playAlert({ intensity: 0.3, sound: "ping" });
      }
    });
  }, [driving, fix, plan, reached, muted]);

  useEffect(() => {
    if (!arrival) return;
    const t = setTimeout(() => setArrival(null), arrival.note ? 20000 : 8000);
    return () => clearTimeout(t);
  }, [arrival]);

  const nextStop = useMemo(() => {
    if (!plan) return null;
    const i = plan.stops.findIndex((s, j) => j > 0 && s.point && !reached.has(s.id));
    return i < 0 ? null : { stop: plan.stops[i], index: i };
  }, [plan, reached]);

  const here = fix?.point ?? browseCenter;

  // --- Alerts ---------------------------------------------------------------
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
        playAlert({ intensity, sound: alertSound });
      }
    }
  }, [
    driving,
    fix,
    grid,
    radiusMeters,
    muted,
    isAlertable,
    escalate,
    alertSound,
  ]);

  const highlightIds = useMemo(
    () => new Set(near.filter((h) => h.ahead).map((h) => h.camera.id)),
    [near],
  );

  const shownCameras = useMemo(() => {
    if (!dataset) return [];
    return dataset.cameras.filter(isShown);
  }, [dataset, isShown]);
  // Glide aircraft between polls rather than teleporting them every 25s.
  const visibleCameras = useMovingAircraft(shownCameras);

  // --- Live feeds -----------------------------------------------------------
  const liveCams = useMemo(
    () => (dataset ? dataset.cameras.filter(isLiveCamera) : []),
    [dataset],
  );
  // With a route, only cameras actually along it are worth watching.
  const routeLive = useMemo(
    () => (route ? camerasNearRoute(route.coordinates, liveCams, 350) : null),
    [route, liveCams],
  );
  const upcoming = useMemo(() => {
    if (!here) return [];
    const pool = routeLive ?? liveCams;
    return pool
      .map((c) => ({
        c,
        d: haversineMeters(here, c),
        ahead:
          fix?.heading == null ? true : bearingDelta(fix.heading, bearingDeg(here, c)) <= 90,
      }))
      .filter((x) => x.d < 40000)
      .sort((a, b) => Number(b.ahead) - Number(a.ahead) || a.d - b.d)
      .slice(0, 6);
  }, [here, routeLive, liveCams, fix?.heading]);
  // Pass timing: lock on to the next live camera ahead, predict the moment
  // of closest approach from speed, then pin the actual moment once the
  // distance starts growing again.
  const holding =
    passTrack && Date.now() < passTrack.at + PASS_HOLD_MS ? passTrack : null;
  useEffect(() => {
    if (!driving || !fix) return;
    const now = fix.timestamp || Date.now();
    setPassTrack((cur) => {
      const active = cur && now < cur.at + PASS_HOLD_MS ? cur : null;
      const cam = active
        ? liveCams.find((c) => c.id === active.camId)
        : upcoming.find((u) => u.ahead && u.d < PASS_TRACK_METERS)?.c;
      if (!cam) return active;
      const d = haversineMeters(fix.point, cam);
      const base: PassTrack =
        active && active.camId === cam.id
          ? active
          : { camId: cam.id, minD: d, minAt: now, at: now, actual: false };
      if (base.actual) return base;
      const next = { ...base };
      if (d <= next.minD) {
        next.minD = d;
        next.minAt = now;
        const speed = fix.speed && fix.speed > 1 ? fix.speed : 13; // ~30 mph fallback
        const along =
          fix.heading == null ? d : d * Math.cos((bearingDelta(fix.heading, bearingDeg(fix.point, cam)) * Math.PI) / 180);
        next.at = now + (Math.max(0, along) / speed) * 1000;
        next.hint = passHint(cam, fix.heading, fix.point);
      } else if (d > next.minD + 15) {
        // Moving away: the closest approach has happened.
        next.at = next.minAt;
        next.actual = true;
      }
      return next;
    });
  }, [driving, fix, liveCams, upcoming]);

  const feedCam =
    (pinnedFeedId && liveCams.find((c) => c.id === pinnedFeedId)) ||
    (holding && liveCams.find((c) => c.id === holding.camId)) ||
    upcoming[0]?.c ||
    null;
  const feedPass: PassInfo | null =
    holding && feedCam?.id === holding.camId
      ? { at: holding.at, actual: holding.actual, hint: holding.hint }
      : null;
  const handleClip = (url: string) =>
    setClips((c) => [{ url, name: feedCam?.name ?? "SCDOT camera", at: Date.now() }, ...c].slice(0, 12));

  const selectedCamera = useMemo(
    () => dataset?.cameras.find((c) => c.id === selectedId) ?? null,
    [dataset, selectedId],
  );
  const selectedDistance = useMemo(() => {
    if (!selectedCamera || !fix) return null;
    return haversineMeters(fix.point, selectedCamera);
  }, [selectedCamera, fix]);

  // What's around the place you're looking at, by kind.
  const lookSummary = useMemo(() => {
    if (!look || !grid) return [];
    const counts = new Map<CameraKind, number>();
    for (const h of grid.within(look.point, 500)) {
      // Aircraft are moving targets, not something "at" a place.
      if (!isShown(h.camera) || h.camera.kind === "aircraft") continue;
      counts.set(h.camera.kind, (counts.get(h.camera.kind) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [look, grid, isShown]);

  const lookAtPlace = (label: string, point: LatLng) => {
    setLook({ label, point, token: Date.now() });
    setCopied(false);
  };

  /** Pin a bare point and name it from the nearest address once known. */
  const lookAtPoint = async (point: LatLng, placeholder: string) => {
    lookAtPlace(placeholder, point);
    const label = await reverseGeocode(point);
    setLook((l) => (l && l.point === point ? { ...l, label } : l));
  };

  const handleLongPress = (point: LatLng) => {
    if (addKind) return;
    void lookAtPoint(point, "Dropped pin");
  };

  const nearestAhead = near.find((h) => h.ahead) ?? near[0] ?? null;
  const currentStep = steps[stepIndex] ?? null;
  const mapCenter = here;

  // Bearing from driver to the nearest camera, for the HUD dial.
  const bearingToNearest =
    nearestAhead && fix
      ? bearingDeg(fix.point, nearestAhead.camera)
      : null;

  const handleStart = async () => {
    await unlockAudio();
    trackerRef.current.reset();
    setDriving(true);
  };

  const handlePlace = async (point: LatLng) => {
    const kind = addKind ?? "alpr";
    const id = `custom/${Date.now()}`;
    const omni = addFacing == null;
    const camera: Camera = {
      id,
      lat: point.lat,
      lon: point.lon,
      kind,
      brand: "Other",
      name: kind === "alpr" ? "My plate reader" : "My traffic camera",
      operator: "Added by me",
      directions: omni ? [] : [addFacing],
      omni,
      purpose:
        kind === "alpr"
          ? "User-added plate reader"
          : "User-added traffic camera",
      fovHalfAngle: omni ? 180 : 40,
      custom: true,
    };
    await addCamera(camera);
    setAddKind(null);
    setAddFacing(null);
    setSelectedId(id);
  };

  const handleDelete = async (id: string) => {
    await removeCamera(id);
    setSelectedId(null);
  };

  const handleUpdateFacing = async (
    id: string,
    facing: { omni: boolean; degrees: number | null },
  ) => {
    await updateCamera(id, {
      omni: facing.omni,
      directions: facing.omni || facing.degrees == null ? [] : [facing.degrees],
      fovHalfAngle: facing.omni ? 180 : 40,
    });
  };

  const urgency =
    !nearestAhead
      ? "cool"
      : nearestAhead.distance / radiusMeters < 0.35
        ? "hot"
        : nearestAhead.distance / radiusMeters < 0.65
          ? "warm"
          : "cool";

  const color = planColor(planIdx);
  const nextStopDist =
    nextStop && here && nextStop.stop.point ? haversineMeters(here, nextStop.stop.point) : null;

  const planSwitcher = trip && trip.plans.length > 1 && (
    <div className="plan-switch" role="group" aria-label="Switch plan">
      {trip.plans.map((p, i) => {
        const r = chosenRoute(p);
        return (
          <button
            key={p.id}
            type="button"
            className={`plan-switch-btn ${p.id === plan?.id ? "on" : ""}`}
            style={{ ["--plan" as string]: planColor(i) }}
            disabled={!r}
            aria-pressed={p.id === plan?.id}
            onClick={() => onSwitchPlan(p.id)}
            title={p.notes || p.name}
          >
            <b>{p.name.replace(/^Plan\s*/i, "")}</b>
            <span>{r ? `${formatDuration(r.durationSeconds)} · ${r.cameraCount}` : "not planned"}</span>
          </button>
        );
      })}
    </div>
  );

  const feedPanel = (
    <div className="feed">
      <div className="feed-head">
        <h3>
          <Icon name="video" /> Live camera
        </h3>
        <button
          type="button"
          className={`chip ${pinnedFeedId == null ? "on" : ""}`}
          aria-pressed={pinnedFeedId == null}
          onClick={() => setPinnedFeedId(null)}
          title="Automatically show the nearest live camera ahead"
        >
          Auto-follow
        </button>
      </div>
      {feedCam ? (
        <>
          <div className="feed-video">
            {visible ? (
              <LiveCameraVideo
                key={feedCam.id}
                camera={feedCam}
                pass={feedPass}
                onClip={handleClip}
              />
            ) : (
              <div className="feed-paused">Paused</div>
            )}
          </div>
          <div className="feed-name">{feedCam.name ?? "SCDOT camera"}</div>
        </>
      ) : (
        <p className="tip">
          {here
            ? `No live traffic cameras ${route ? "along this route" : "nearby"}.`
            : "Live cameras near you show here once location is on. Overwatch lists every live camera."}
        </p>
      )}
      {clips.length > 0 && (
        <div className="clips">
          <h4>Your passes</h4>
          <ul>
            {clips.map((c) => (
              <li key={c.url}>
                <video src={c.url} controls muted playsInline preload="metadata" />
                <div className="clip-meta">
                  <span>{c.name}</span>
                  <a href={c.url} download={`pass-${new Date(c.at).toISOString().slice(0, 19)}.webm`}>
                    Save
                  </a>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!driving && liveCams.length > 0 && (
        <p className="tip">
          While driving, the camera you're about to pass is timed for you: it shows when you'll
          appear on screen and records the moment.
        </p>
      )}
      {upcoming.length > 1 && (
        <ul className="feed-list">
          {upcoming.map(({ c, d, ahead }) => (
            <li key={c.id}>
              <button
                type="button"
                className={feedCam?.id === c.id ? "on" : ""}
                onClick={() => setPinnedFeedId(c.id)}
              >
                <span className="feed-list-name">{c.name ?? "SCDOT camera"}</span>
                <span className="feed-list-dist">
                  {formatDistance(d)}
                  {!ahead && " behind"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <div className={`mode drive-mode ${driving ? "is-driving" : ""}`}>
      <div className="drive-map">
        <MapView
          cameras={visibleCameras}
          highlightIds={highlightIds}
          center={mapCenter}
          heading={fix?.heading ?? null}
          follow={driving}
          headingUp={headingUp}
          showFov={showFov}
          basemap={basemap}
          routeLine={route?.coordinates ?? null}
          routeColor={color}
          altRoutes={altRoutes}
          stops={stopsOnMap}
          fitRoute={!driving}
          // Keep the whole route clear of the start panel (top-left on a
          // laptop, the full top band on a phone) and the buttons on the right.
          fitPadding={
            wide
              ? { top: 10, bottom: 30, left: 470, right: 60 }
              : { top: trip ? 300 : 230, bottom: 60, left: 0, right: 56 }
          }
          recenterToken={recenter}
          onSelectCamera={setSelectedId}
          placing={addKind != null}
          onMapClick={handlePlace}
          osmLayers={osmLayers}
          lookAt={look}
          onLongPress={handleLongPress}
        />

        {searchOpen && (
          <div className="map-search" role="search">
            <PlaceInput
              label=""
              point={null}
              near={here}
              placeholder="Go to an address, place or lat, lon"
              autoFocus
              onPick={(p) => {
                if (parseCoordinates(p.label)) void lookAtPoint(p.point, "Looking up this spot");
                else lookAtPlace(p.label, p.point);
                setSearchOpen(false);
              }}
              onEdit={() => {}}
            />
            <button
              type="button"
              className="icon-btn"
              onClick={() => setSearchOpen(false)}
              aria-label="Close search"
            >
              ✕
            </button>
          </div>
        )}

        {look && (
          <div className="look-card" role="dialog" aria-label={look.label}>
            <div className="look-head">
              <Icon name="pin" />
              <div className="look-title">
                <strong>{look.label}</strong>
                <button
                  type="button"
                  className="look-coords"
                  title="Copy coordinates"
                  onClick={() => {
                    const text = `${look.point.lat.toFixed(6)}, ${look.point.lon.toFixed(6)}`;
                    void navigator.clipboard?.writeText(text).then(() => setCopied(true));
                  }}
                >
                  {look.point.lat.toFixed(6)}, {look.point.lon.toFixed(6)}
                  <span>{copied ? "Copied" : "Copy"}</span>
                </button>
              </div>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setLook(null)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="look-nearby">
              {lookSummary.length === 0 ? (
                <span>Nothing on the map within 500 m</span>
              ) : (
                <>
                  <span>Within 500 m:</span>
                  {lookSummary.map(([kind, n]) => (
                    <span key={kind} className="cam-chip">
                      {n} {KIND_LABELS[kind].replace(/ \(.*\)$/, "").toLowerCase()}
                      {n > 1 && !/s$/.test(KIND_LABELS[kind]) ? "s" : ""}
                    </span>
                  ))}
                </>
              )}
            </div>
            <div className="look-actions">
              {onPlanTo && (
                <button
                  type="button"
                  className="big-btn"
                  onClick={() => onPlanTo({ label: look.label, point: look.point })}
                >
                  Plan a route here
                </button>
              )}
              <a
                className="ghost-btn"
                href={`https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${look.point.lat},${look.point.lon}`}
                target="_blank"
                rel="noreferrer"
              >
                Street View
              </a>
            </div>
          </div>
        )}

        <div className="map-fabs">
          <button
            type="button"
            className={`fab ${searchOpen ? "on" : ""}`}
            onClick={() => setSearchOpen((v) => !v)}
            aria-label="Go to a place or coordinates"
            aria-expanded={searchOpen}
          >
            <Icon name="search" />
          </button>
          <button
            type="button"
            className="fab"
            onClick={() => setLayersOpen((v) => !v)}
            aria-label="Map layers"
            aria-expanded={layersOpen}
          >
            <Icon name="layers" />
          </button>
          <button
            type="button"
            className="fab"
            onClick={() => setRecenter((n) => n + 1)}
            aria-label="Center on my location"
            disabled={!here}
          >
            <Icon name="locate" />
          </button>
          <button
            type="button"
            className={`fab fab-feed ${feedOpen ? "on" : ""}`}
            onClick={() => setFeedOpen((v) => !v)}
            aria-label="Live camera feed"
            aria-pressed={feedOpen}
          >
            <Icon name="video" />
          </button>
        </div>

        {layersOpen && <LayersPanel onClose={() => setLayersOpen(false)} />}

        <div className="map-controls">
          <button
            className={`map-chip add ${addKind ? "on" : ""}`}
            onClick={() => {
              if (addKind) {
                setAddKind(null);
                setAddFacing(null);
              } else {
                setAddKind("alpr");
                setAddFacing(null);
              }
            }}
            title="Add a camera the map is missing"
          >
            {addKind ? "Cancel" : "+ Add camera"}
          </button>
          <button
            className={`map-chip ${muted ? "" : "on"}`}
            onClick={() => setSetting("muted", !muted)}
            aria-pressed={!muted}
          >
            {muted ? "Sound off" : "Sound on"}
          </button>
        </div>

        {addKind && (
          <div className="add-banner">
            <div className="add-banner-title">Tap the map where the camera is</div>
            <div className="add-kind-row">
              <button
                className={addKind === "alpr" ? "on" : ""}
                onClick={() => setAddKind("alpr")}
              >
                Plate reader
              </button>
              <button
                className={addKind === "traffic" ? "on" : ""}
                onClick={() => setAddKind("traffic")}
              >
                Traffic cam
              </button>
            </div>
            <FacingPicker value={addFacing} onChange={setAddFacing} />
          </div>
        )}

        {selectedCamera && (
          <CameraDetailCard
            camera={selectedCamera}
            distanceMeters={selectedDistance}
            onClose={() => setSelectedId(null)}
            onDelete={handleDelete}
            onUpdateFacing={
              selectedCamera.custom ? handleUpdateFacing : undefined
            }
          />
        )}

        {feedOpen && !wide && <div className="feed-float">{feedPanel}</div>}

        <div className="drive-hud">
          {!driving ? (
            <div className="start-panel">
              <div className="start-copy">
                <span className={`start-led ${status === "ready" ? "" : "loading"}`} />
                <div>
                  <h1>SC ALPR Radar</h1>
                  <p>
                    {status === "ready"
                      ? `${(dataset?.count ?? 0).toLocaleString()} cameras loaded. Tap a dot for details.`
                      : status === "error"
                        ? "Couldn't load the camera pack. Check Settings."
                        : "Loading camera pack"}
                  </p>
                </div>
              </div>

              {trip && plan ? (
                <div className="start-trip" style={{ ["--plan" as string]: color }}>
                  <div className="start-trip-text">
                    <span className="start-trip-title">{tripTitle(trip)}</span>
                    <span className="start-trip-sub">
                      {plan.name}
                      {route
                        ? ` · ${formatDuration(route.durationSeconds)} · ${route.cameraCount} cams · arrive ${arrivalTime(route.durationSeconds)}`
                        : ""}
                    </span>
                  </div>
                  <button type="button" className="ghost-btn" onClick={onOpenPlanner}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={onClearTrip}
                    aria-label="Stop following this trip"
                  >
                    ✕
                  </button>
                </div>
              ) : null}
              {planSwitcher}

              <div className="start-actions">
                <button
                  className="big-btn"
                  onClick={handleStart}
                  disabled={status !== "ready"}
                >
                  {status !== "ready" ? (
                    <>
                      <span className="spinner sm" /> Loading cameras
                    </>
                  ) : trip ? (
                    `Start ${plan?.name ?? "trip"}`
                  ) : (
                    "Start driving"
                  )}
                </button>
                {!trip && (
                  <button type="button" className="ghost-btn tall" onClick={onOpenPlanner}>
                    <Icon name="route" /> Plan a trip
                  </button>
                )}
              </div>
            </div>
          ) : nearestAhead ? (
            <CameraAlertCard
              camera={nearestAhead.camera}
              distanceMeters={nearestAhead.distance}
              ahead={nearestAhead.ahead}
              muted={muted}
              urgency={urgency}
              bearingToCamera={bearingToNearest}
              heading={fix?.heading ?? null}
            />
          ) : (
            <AllClearBanner />
          )}

          {driving && currentStep && (
            <div className="nav-banner" style={{ borderLeftColor: color }}>
              <div className="nav-instruction">{currentStep.instruction}</div>
              <div className="nav-sub">
                {currentStep.distanceMeters > 0 && formatDistance(currentStep.distanceMeters)}
                {route &&
                  ` · ${formatDuration(route.durationSeconds)} total · ${route.cameraCount} cams on ${plan?.name}`}
              </div>
            </div>
          )}

          {driving && nextStop && (
            <div className={`next-stop ${nextStop.stop.checkpoint ? "check" : ""}`}>
              <span className="next-stop-badge">
                {nextStop.stop.checkpoint ? <Icon name="flag" /> : stopBadge(nextStop.index, plan!.stops.length)}
              </span>
              <div className="next-stop-text">
                <span className="next-stop-label">
                  {nextStop.stop.checkpoint ? "Checkpoint" : "Next stop"}: {shortLabel(nextStop.stop.label)}
                </span>
                {nextStop.stop.note && <span className="next-stop-note">{nextStop.stop.note}</span>}
              </div>
              {nextStopDist != null && <span className="next-stop-dist">{formatDistance(nextStopDist)}</span>}
            </div>
          )}

          {driving && planSwitcher}

          {arrival && (
            <div className="arrival" role="status">
              <div className="arrival-title">
                {arrival.checkpoint ? "Checkpoint passed" : "Arrived"}: {shortLabel(arrival.label)}
              </div>
              {arrival.note && <div className="arrival-note">{arrival.note}</div>}
              <button type="button" className="ghost-btn" onClick={() => setArrival(null)}>
                OK
              </button>
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

      {/* Laptop / tablet: trip and live feed stay visible beside the map. */}
      {wide && (
      <aside className="drive-rail" aria-label="Trip and live cameras">
        {trip && plan ? (
          <section className="rail-trip" style={{ ["--plan" as string]: color }}>
            <div className="rail-trip-head">
              <h3>{tripTitle(trip)}</h3>
              <button type="button" className="ghost-btn" onClick={onOpenPlanner}>
                Edit
              </button>
            </div>
            {route && (
              <div className="rail-trip-stats">
                <b>{formatDuration(route.durationSeconds)}</b>
                <span>{formatDistance(route.distanceMeters)}</span>
                <span className={route.cameraCount ? "warn" : "ok"}>{route.cameraCount} cams</span>
                <span>arrive {arrivalTime(route.durationSeconds)}</span>
              </div>
            )}
            {planSwitcher}
            {plan.notes && <p className="rail-notes">{plan.notes}</p>}
            <ol className="rail-stops">
              {plan.stops.map((s, i) => (
                <li
                  key={s.id}
                  className={`${reached.has(s.id) ? "done" : ""} ${nextStop?.stop.id === s.id ? "next" : ""}`}
                >
                  <span className="rail-stop-badge">
                    {reached.has(s.id) ? "✓" : stopBadge(i, plan.stops.length)}
                  </span>
                  <div>
                    <span className="rail-stop-label">
                      {s.checkpoint && <Icon name="flag" />} {shortLabel(s.label || "Unset")}
                    </span>
                    {s.note && <span className="rail-stop-note">{s.note}</span>}
                    {route?.legs[i - 1] && (
                      <span className="rail-stop-leg">
                        {formatDuration(route.legs[i - 1].durationSeconds)} ·{" "}
                        {route.legs[i - 1].cameraCount} cams from previous
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        ) : (
          <section className="rail-empty">
            <h3>No trip loaded</h3>
            <p className="tip">
              Plan a trip with stops, checkpoints and backup plans, and it shows here while you
              drive.
            </p>
            <button type="button" className="ghost-btn tall" onClick={onOpenPlanner}>
              <Icon name="route" /> Plan a trip
            </button>
          </section>
        )}
        {feedPanel}
      </aside>
      )}
    </div>
  );
}
