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
import { LiveCamList } from "@/components/LiveCamList";
import { ClipLibrary } from "@/components/ClipLibrary";
import { useClipsStore } from "@/services/clips";
import {
  DEFAULT_LAG_MS,
  RouteMeasure,
  Track,
  coverFor,
  followTarget,
  schedulePasses,
} from "@/services/chase";
import { Icon } from "@/components/Icon";
import type { LatLng } from "@/types";
import { useCameraStore } from "@/store/cameraStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useGeolocation } from "@/hooks/useGeolocation";
import { useWakeLock } from "@/hooks/useWakeLock";
import { useDarkMap } from "@/hooks/useDarkMap";
import {
  AlertTracker,
  playAlert,
  speak,
  spokenDistance,
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
import { deadEndNear } from "@/services/deadEnds";
import {
  DriveRecorder,
  PASS_METERS,
  monthText,
  monthTotals,
  saveDrive,
  type DriveRecord,
} from "@/services/driveLog";
import {
  alertContains,
  alertsAsGeoJSON,
  alertsOnLine,
  untilText,
  useWeatherStore,
} from "@/services/weather";
import {
  REPORT_TYPES,
  addReport,
  freshness,
  removeReport,
  updateReport,
  type ReportType,
} from "@/services/policeReports";
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

/** Stream delays beyond this mean a stalled player, not a slow stream. */
const MAX_TRUSTED_LAG_MS = 45000;
/** How close counts as "arrived" at a stop or checkpoint. */
const ARRIVE_METERS = 90;
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
  // PTZ cameras only say which direction of traffic they cover, not where the
  // lens points right now, so left/right would be invented. Say which lanes.
  if (cam.omni || !cam.directions.some((d) => Number.isFinite(d))) {
    const dirs = ["north", "east", "south", "west"];
    const watches =
      cam.roadBearing != null ? `${dirs[Math.round(cam.roadBearing / 90) % 4]}bound` : null;
    switch (coverFor(cam, heading)) {
      case "yours":
        return `Watches ${watches} traffic, your direction: look in the lanes it's covering`;
      case "opposite":
        return `Watches ${watches} traffic, the other way: you'll be across the median, if in view`;
      case "crossing":
        return `Watches the cross road (${watches}): you may only show up crossing the picture`;
      default:
        return `Look for your car in the ${["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"][Math.round(heading / 45) % 8]}bound lanes`;
    }
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
  const { grid, dataset, status, addCamera, updateCamera, removeCamera, refreshReports } =
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
    spokenAlerts,
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
  /** null = Follow me: show the camera your delayed self is about to pass. */
  const [pinnedFeedId, setPinnedFeedId] = useState<string | null>(null);
  const [reached, setReached] = useState<Set<string>>(new Set());
  const [arrival, setArrival] = useState<{ label: string; note?: string; checkpoint?: boolean } | null>(null);
  /** A place you searched for or long-pressed, just to look at. */
  const [look, setLook] = useState<{ label: string; point: LatLng; token: number } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const clips = useClipsStore((s) => s.clips);
  const addClip = useClipsStore((s) => s.add);
  /** Builds this drive's record; the summary shows when you stop. */
  const recorderRef = useRef<DriveRecorder | null>(null);
  const lastFixRef = useRef<LatLng | null>(null);
  const [summary, setSummary] = useState<DriveRecord | null>(null);
  /** The report you just made, for changing its type or undoing it. */
  const [marked, setMarked] = useState<{ id: string; type: ReportType } | null>(null);
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

  // --- Drive log: distance and what you actually drove past ----------------
  useEffect(() => {
    const rec = recorderRef.current;
    if (!driving || !fix || !rec) return;
    const prev = lastFixRef.current;
    rec.move(fix.point, prev ? haversineMeters(prev, fix.point) : 0);
    lastFixRef.current = fix.point;
    for (const h of grid?.within(fix.point, PASS_METERS) ?? []) rec.pass(h.camera);
  }, [driving, fix, grid]);

  const stopDrive = () => {
    const rec = recorderRef.current;
    if (rec) {
      const record = rec.finish(clips.filter((c) => c.at >= rec.start).length);
      // A few seconds parked isn't a drive worth keeping.
      if (record.meters > 200) {
        saveDrive(record);
        setSummary(record);
      }
    }
    recorderRef.current = null;
    setDriving(false);
  };

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
        if (spokenAlerts && nearest) {
          speak(`${spokenName(nearest.camera)} in ${spokenDistance(nearest.distance)}`);
        }
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
  // --- Police activity ahead (radar-detector style) -------------------------
  const markPolice = () => {
    if (!here) return;
    const r = addReport(here);
    refreshReports();
    setMarked({ id: r.id, type: r.type });
  };
  useEffect(() => {
    if (!marked) return;
    const t = window.setTimeout(() => setMarked(null), 8000);
    return () => window.clearTimeout(t);
  }, [marked]);

  /**
   * The nearest police sign worth a glance: a spot you reported on the road
   * ahead, or a police aircraft / any aircraft circling nearby.
   */
  const policeAhead = useMemo(() => {
    if (!driving || !fix || !dataset) return null;
    let best: { cam: Camera; d: number } | null = null;
    for (const c of dataset.cameras) {
      const report = !!c.policeReport;
      const air = c.kind === "aircraft" && (c.lawEnforcement || c.circling);
      if (!report && !air) continue;
      if (!isShown(c)) continue;
      const d = haversineMeters(fix.point, c);
      if (report) {
        if (d > 5000) continue;
        if (fix.heading != null) {
          const rad = (bearingDelta(fix.heading, bearingDeg(fix.point, c)) * Math.PI) / 180;
          if (rad > Math.PI / 2 || d * Math.sin(rad) > 400) continue;
        }
      } else if (d > 8000) {
        continue;
      }
      if (!best || d < best.d) best = { cam: c, d };
    }
    return best;
  }, [driving, fix, dataset, isShown]);

  useEffect(() => {
    if (policeAhead) recorderRef.current?.sawPolice(policeAhead.cam.id);
  }, [policeAhead]);

  // One chirp when a police aircraft or a circling one first shows up; your
  // own reports already alert through the normal camera alerts.
  const airAlertedRef = useRef(new Set<string>());
  useEffect(() => {
    const c = policeAhead?.cam;
    if (!c || c.kind !== "aircraft" || muted) return;
    const key = `${c.id}:${c.circling ? "circle" : "le"}`;
    if (airAlertedRef.current.has(key)) return;
    airAlertedRef.current.add(key);
    playAlert({ intensity: 0.55, sound: alertSound });
    if (spokenAlerts) {
      speak(`${c.lawEnforcement ? "Police aircraft" : "Aircraft"}${c.circling ? " circling" : ""} nearby`);
    }
  }, [policeAhead, muted, alertSound, spokenAlerts]);

  const darkMap = useDarkMap(here);

  // --- Weather: flooding and the like, where you are or on your route -------
  const weatherAlerts = useWeatherStore((s) => s.alerts);
  const showWeather = settings.showWeather;
  const weatherFC = useMemo(
    () => (showWeather ? alertsAsGeoJSON(weatherAlerts) : null),
    [showWeather, weatherAlerts],
  );
  const weatherHit = useMemo(() => {
    if (!showWeather || !weatherAlerts.length || !here) return null;
    const at = weatherAlerts.find((a) => alertContains(a, here));
    if (at) return { alert: at, where: "here" };
    const onRoute = route ? alertsOnLine(weatherAlerts, route.coordinates)[0] : undefined;
    return onRoute ? { alert: onRoute, where: "on your route" } : null;
  }, [showWeather, weatherAlerts, here, route]);
  const weatherSaidRef = useRef("");
  useEffect(() => {
    const key = weatherHit ? `${weatherHit.alert.id}:${weatherHit.where}` : "";
    if (!driving || key === weatherSaidRef.current) return;
    weatherSaidRef.current = key;
    if (weatherHit && !muted && spokenAlerts) speak(`${weatherHit.alert.event} ${weatherHit.where}`, 0);
  }, [weatherHit, driving, muted, spokenAlerts]);

  // --- No-go roads: don't turn into something with no way out ---------------
  const noGo = useMemo(() => {
    if (!driving || !fix || !osmLayers.includes("deadends")) return null;
    const inside = deadEndNear(fix.point, 12);
    if (inside) return { inside: true, name: String(inside.properties?.name ?? "") };
    if (fix.heading == null) return null;
    // A point a few seconds up the road.
    const ahead = 70;
    const rad = (fix.heading * Math.PI) / 180;
    const p = {
      lat: fix.point.lat + (ahead * Math.cos(rad)) / 110540,
      lon: fix.point.lon + (ahead * Math.sin(rad)) / (111320 * Math.cos((fix.point.lat * Math.PI) / 180)),
    };
    const hit = deadEndNear(p, 18);
    return hit ? { inside: false, name: String(hit.properties?.name ?? "") } : null;
  }, [driving, fix, osmLayers]);

  // Say the no-go warning once per road, not every second you're near it.
  const noGoSaidRef = useRef("");
  useEffect(() => {
    const key = noGo ? `${noGo.inside}:${noGo.name}` : "";
    if (key === noGoSaidRef.current) return;
    noGoSaidRef.current = key;
    if (!noGo || muted || !spokenAlerts) return;
    speak(noGo.inside ? "Dead end. Turn around." : "No-go road ahead", 0);
  }, [noGo, muted, spokenAlerts]);

  // --- Follow me: a delayed live feed of your own drive ----------------------
  // Where you've been, so a delayed frame can be matched to your position then.
  const trackRef = useRef(new Track());
  // Last measured stream delay; every SCDOT stream runs about the same.
  const lagRef = useRef(DEFAULT_LAG_MS);
  const routeMeasure = useMemo(
    () => (route ? new RouteMeasure(route.coordinates) : null),
    [route],
  );
  const camMeasures = useMemo(
    () => new Map<string, { m: number; off: number } | null>(),
    // A fresh cache per route.
    [routeMeasure],
  );
  // The delayed clock moves between GPS fixes too.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!driving) return;
    trackRef.current.clear();
    const t = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [driving]);
  useEffect(() => {
    if (driving && fix) trackRef.current.push(fix.timestamp || Date.now(), fix.point);
  }, [driving, fix]);

  const passes = useMemo(() => {
    if (!driving || !fix) return [];
    const pool = (routeLive ?? liveCams).filter((c) => haversineMeters(fix.point, c) < 7000);
    const gpsSpeed = fix.speed != null && fix.speed >= 0 ? fix.speed : null;
    return schedulePasses({
      cams: pool,
      track: trackRef.current,
      now: clock,
      here: fix.point,
      heading: fix.heading,
      speed: gpsSpeed ?? trackRef.current.speed(),
      route: routeMeasure,
      camMeasures,
    });
  }, [driving, fix, clock, routeLive, liveCams, routeMeasure, camMeasures]);
  const following = driving ? followTarget(passes, clock - lagRef.current) : null;

  const feedCam =
    (pinnedFeedId && liveCams.find((c) => c.id === pinnedFeedId)) ||
    following?.cam ||
    upcoming[0]?.c ||
    null;
  const feedPassRec = feedCam ? passes.find((p) => p.cam.id === feedCam.id) : undefined;
  const feedPass: PassInfo | null =
    feedPassRec && fix && Number.isFinite(feedPassRec.at)
      ? {
          at: feedPassRec.at,
          actual: feedPassRec.actual,
          hint: passHint(feedPassRec.cam, fix.heading, fix.point),
          distanceAt: (t: number) => {
            const p = trackRef.current.at(t);
            return p ? haversineMeters(p, feedPassRec.cam) : null;
          },
        }
      : null;
  // While driving, list the cameras in the order you'll see yourself on them.
  const feedItems = driving
    ? passes.slice(0, 6).map((p) => {
        const shownIn = (p.at + lagRef.current - clock) / 1000;
        return {
          c: p.cam,
          d: Math.abs(p.along),
          note:
            (!Number.isFinite(p.at)
              ? formatDistance(p.along)
              : shownIn > 0
                ? `you in ~${Math.ceil(shownIn)}s`
                : "played") +
            (p.cover === "yours" ? " · your side" : p.cover === "opposite" ? " · far side" : p.cover === "crossing" ? " · cross road" : ""),
        };
      })
    : upcoming;
  const handleClip = (blob: Blob, mime: string) =>
    addClip(blob, mime, feedCam?.name ?? "SCDOT camera");

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
    setSearchOpen(false);
    setSummary(null);
    recorderRef.current = new DriveRecorder();
    lastFixRef.current = null;
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
          title="Shows each camera just as the delayed feed reaches your car, like a delayed live feed of your drive"
        >
          Follow me
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
                onHold={() => setPinnedFeedId(feedCam.id)}
                onLag={(ms) => {
                  // A stalled or paused player stops meaning anything past this.
                  lagRef.current = ms < MAX_TRUSTED_LAG_MS ? ms : DEFAULT_LAG_MS;
                }}
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
      <ClipLibrary since={recorderRef.current?.start} title="This drive's passes" />
      {!driving && liveCams.length > 0 && (
        <p className="tip">
          While driving, the camera you're about to pass is timed for you: it shows when you'll
          appear on screen and records the moment.
        </p>
      )}
      {feedItems.length > 1 && (
        <LiveCamList
          items={feedItems}
          selectedId={feedCam?.id ?? null}
          onPick={setPinnedFeedId}
        />
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
          weather={weatherFC}
          dark={darkMap}
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

        {/* Every map tool lives in this one column, grouped by what it's for:
            moving the map, what the map shows, and editing the camera data. */}
        <div className="map-tools" role="toolbar" aria-label="Map tools">
          <div className="tool-group" aria-label="Move the map">
            {/* Typing a search isn't a driving task; it's back once you stop. */}
            {!driving && (
              <button
                type="button"
                className={`map-tool ${searchOpen ? "on" : ""}`}
                onClick={() => setSearchOpen((v) => !v)}
                aria-expanded={searchOpen}
                title="Go to an address, place or coordinates"
              >
                <Icon name="search" />
                <span>Find</span>
              </button>
            )}
            <button
              type="button"
              className="map-tool"
              onClick={() => setRecenter((n) => n + 1)}
              disabled={!here}
              title={here ? "Center on my location" : "Location is off"}
            >
              <Icon name="locate" />
              <span>Me</span>
            </button>
          </div>
          <div className="tool-group" aria-label="What the map shows">
            <button
              type="button"
              className={`map-tool ${layersOpen ? "on" : ""}`}
              onClick={() => setLayersOpen((v) => !v)}
              aria-expanded={layersOpen}
              title="Basemap, camera types and OpenStreetMap details"
            >
              <Icon name="layers" />
              <span>Layers</span>
            </button>
            {driving && (
            <button
              type="button"
              className={`map-tool tool-feed ${feedOpen ? "on" : ""}`}
              onClick={() => setFeedOpen((v) => !v)}
              aria-pressed={feedOpen}
              title="Live traffic camera near you"
            >
              <Icon name="video" />
              <span>Live</span>
            </button>
            )}
            <button
              type="button"
              className={`map-tool ${muted ? "" : "on"}`}
              onClick={() => setSetting("muted", !muted)}
              aria-pressed={!muted}
              title={muted ? "Camera alerts are silent" : "Camera alerts make a sound"}
            >
              <Icon name={muted ? "mute" : "sound"} />
              <span>{muted ? "Muted" : "Sound"}</span>
            </button>
          </div>
          <div className="tool-group" aria-label="Report">
            <button
              type="button"
              className="map-tool tool-police"
              onClick={markPolice}
              disabled={!here}
              title={
                here
                  ? "Mark police at your location; change it to a hazard after (kept on this device)"
                  : "Location is off"
              }
            >
              <Icon name="shield" />
              <span>Report</span>
            </button>
            {!driving && (
              <button
                type="button"
                className={`map-tool ${addKind ? "on" : ""}`}
                onClick={() => {
                  setAddKind(addKind ? null : "alpr");
                  setAddFacing(null);
                }}
                title="Add a camera the map is missing"
              >
                <Icon name="plus" />
                <span>{addKind ? "Cancel" : "Add"}</span>
              </button>
            )}
          </div>
        </div>

        {layersOpen && <LayersPanel onClose={() => setLayersOpen(false)} />}

        {summary && !driving && (
          <DriveSummary record={summary} onClose={() => setSummary(null)} />
        )}

        {marked && (
          <div className="report-toast" role="status">
            <span className="report-toast-title">
              <Icon name="shield" /> Marked here:{" "}
              {REPORT_TYPES.find((t) => t.type === marked.type)?.label}
            </span>
            <div className="report-toast-actions">
              {REPORT_TYPES.map((t) => (
                <button
                  key={t.type}
                  type="button"
                  className={`chip ${marked.type === t.type ? "on" : ""}`}
                  aria-pressed={marked.type === t.type}
                  onClick={() => {
                    updateReport(marked.id, { type: t.type });
                    refreshReports();
                    setMarked({ ...marked, type: t.type });
                  }}
                >
                  <span aria-hidden="true">{t.symbol}</span> {t.label}
                </button>
              ))}
              <button
                type="button"
                className="ghost-btn"
                onClick={() => {
                  removeReport(marked.id);
                  refreshReports();
                  setMarked(null);
                }}
              >
                Undo
              </button>
            </div>
          </div>
        )}

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

        {feedOpen && driving && !wide && <div className="feed-float">{feedPanel}</div>}

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
                  <MonthLine />
                </div>
              </div>

              {/* On a laptop the rail already shows the trip, so don't repeat it here. */}
              {trip && plan && !wide ? (
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
              {!wide && planSwitcher}

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

          {weatherHit && (
            <div className="weather-hit" role="alert">
              <span className="no-go-icon" aria-hidden="true">⚠️</span>
              <div className="police-ahead-text">
                <span className="police-ahead-title">
                  {weatherHit.alert.event} {weatherHit.where}
                </span>
                <span className="police-ahead-sub">
                  National Weather Service {untilText(weatherHit.alert)}
                </span>
              </div>
            </div>
          )}

          {noGo && (
            <div className="no-go" role="alert">
              <span className="no-go-icon" aria-hidden="true">⛔</span>
              <div className="police-ahead-text">
                <span className="police-ahead-title">
                  {noGo.inside ? "You're on a no-go road" : "No-go road ahead"}
                </span>
                <span className="police-ahead-sub">
                  {noGo.name ? `${noGo.name}: ` : ""}
                  {noGo.inside ? "dead end, the way out is back the way you came" : "dead end, no way through"}
                </span>
              </div>
            </div>
          )}

          {policeAhead && <PoliceAheadBanner hit={policeAhead} />}

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
          <button className="stop-btn" onClick={stopDrive}>
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
              {!driving && (
                <button
                  type="button"
                  className="icon-btn"
                  onClick={onClearTrip}
                  aria-label="Stop following this trip"
                >
                  ✕
                </button>
              )}
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
              Plan a trip with stops, checkpoints and backup plans in the Plan tab, and it shows
              here while you drive.
            </p>
          </section>
        )}
        {feedPanel}
      </aside>
      )}
    </div>
  );
}

function PoliceAheadBanner({ hit }: { hit: { cam: Camera; d: number } }) {
  const { cam, d } = hit;
  const air = cam.kind === "aircraft";
  const age = air ? 0 : Date.now() - Date.parse(cam.reportedAt ?? "");
  const title = air
    ? `${cam.lawEnforcement ? "Police aircraft" : "Aircraft"}${cam.circling ? " circling" : ""}`
    : `${cam.name ?? "Police"} reported ahead`;
  const when = air ? "live" : `${freshness(age)}, ${Math.max(0, Math.round(age / 60000))} min ago`;
  return (
    <div className={`police-ahead ${air ? "air" : ""}`} role="status">
      <span className="police-ahead-icon" aria-hidden="true">
        {air ? "🚁" : "🚔"}
      </span>
      <div className="police-ahead-text">
        <span className="police-ahead-title">{title}</span>
        <span className="police-ahead-sub">
          {formatDistance(d)} {air ? "away" : "ahead"} · {when}
        </span>
      </div>
    </div>
  );
}

/** What to call a camera out loud: short, and the most useful word first. */
function spokenName(c: Camera): string {
  if (c.myReport) return `${c.name ?? "Hazard"} reported`;
  switch (c.kind) {
    case "alpr":
      return c.brand === "Flock Safety" ? "Flock camera" : "Plate reader";
    case "speed":
      return "Speed camera";
    case "traffic":
      return "Traffic camera";
    case "gunshot":
      return "Gunshot detector";
    case "incident":
      return c.name ?? "Incident";
    default:
      return "Camera";
  }
}

/** The month so far, once there is one. */
function MonthLine() {
  const t = useMemo(() => monthTotals(), []);
  if (!t.drives) return null;
  return (
    <p className="month-line">{monthText(t)}</p>
  );
}

/** One screen after each drive: what you passed and what you kept. */
function DriveSummary({ record, onClose }: { record: DriveRecord; onClose: () => void }) {
  const mins = Math.max(1, Math.round((record.end - record.start) / 60000));
  const total = Object.values(record.kinds).reduce((a, b) => a + (b ?? 0), 0);
  const month = monthTotals();
  return (
    <div className="drive-summary" role="dialog" aria-label="Drive summary">
      <div className="drive-summary-head">
        <h3>Drive summary</h3>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="drive-summary-stats">
        <span>
          <b>{(record.meters / 1609.34).toFixed(1)}</b> mi
        </span>
        <span>
          <b>{mins}</b> min
        </span>
        <span>
          <b>{total}</b> camera{total === 1 ? "" : "s"} passed
        </span>
      </div>
      {total > 0 ? (
        <div className="look-nearby">
          {(Object.entries(record.kinds) as [CameraKind, number][])
            .sort((a, b) => b[1] - a[1])
            .map(([kind, n]) => (
              <span key={kind} className="cam-chip">
                {n} {KIND_LABELS[kind].replace(/ \(.*\)$/, "").toLowerCase()}
                {n > 1 && !/s$/.test(KIND_LABELS[kind]) ? "s" : ""}
              </span>
            ))}
          {record.flock > 0 && <span className="cam-chip">{record.flock} Flock</span>}
        </div>
      ) : (
        <p className="tip">No cameras within {PASS_METERS} m of your path.</p>
      )}
      <p className="tip">
        {record.police > 0 ? `Police activity seen ahead: ${record.police}. ` : ""}
        {record.clips > 0 ? "" : "No pass clips this time."}
      </p>
      {record.clips > 0 && <ClipLibrary since={record.start} title="Clips from this drive" />}
      <p className="month-line">{monthText(month)}</p>
    </div>
  );
}
