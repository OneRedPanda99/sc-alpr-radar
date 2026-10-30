import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Camera, LatLng } from "@/types";
import { cameraColor } from "@/services/brand";
import {
  fetchOsmDetails,
  FRIENDLY_TAGS,
  OSM_CATEGORY_BY_ID,
  type Bbox,
} from "@/services/osmDetails";
import { fovConePolygon } from "@/services/geo";
import {
  aimBearingFor,
  ALL_SYMBOLS,
  hasSymbol,
  mapSymbol,
  rasterizeSymbol,
} from "@/services/symbols";

const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/positron";

// Raster satellite overlay (Esri World Imagery — free, no key).
const SATELLITE_SOURCE = "satellite";
const SATELLITE_TILES = [
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
];
const SATELLITE_ATTRIB = "Imagery © Esri, Maxar, Earthstar Geographics";

interface MapViewProps {
  cameras: Camera[];
  highlightIds?: Set<string>;
  center?: LatLng | null;
  heading?: number | null;
  follow?: boolean;
  headingUp?: boolean;
  showFov?: boolean;
  basemap?: "streets" | "satellite";
  routeLine?: [number, number][] | null;
  /** When true, fit the map to the route bounds once it changes. */
  fitRoute?: boolean;
  /** Called with a camera id when a camera dot is tapped. */
  onSelectCamera?: (id: string) => void;
  /** When true, taps on the map (not on a dot) report a location to place a camera. */
  placing?: boolean;
  /** Called with a tapped location while `placing` is true. */
  onMapClick?: (point: LatLng) => void;
  onReady?: (map: maplibregl.Map) => void;
  /** Turn the map to this bearing. Bumping the token re-triggers the turn. */
  aimBearing?: { bearing: number; token: number } | null;
  /** Other candidate routes (Plan B/C, the fastest alternative), drawn faint. */
  altRoutes?: { coordinates: [number, number][]; color?: string }[];
  /** Colour of the main route line. */
  routeColor?: string;
  /** Numbered pins for a plan's start, stops and destination. */
  stops?: MapStop[];
  /** Bump to fly back to `center`. */
  recenterToken?: number;
  /** Extra padding when fitting a route, e.g. for a sheet covering the map. */
  fitPadding?: { top: number; bottom: number; left: number; right: number };
  /** Enabled OpenStreetMap detail categories. */
  osmLayers?: string[];
  /** Fly to a place and mark it with a pin; bump the token to fly again. */
  lookAt?: { point: LatLng; token: number } | null;
  /** Long-press (touch) or right-click: "what's here?" at that spot. */
  onLongPress?: (point: LatLng) => void;
}

export interface MapStop {
  id: string;
  point: LatLng;
  label: string;
  role: "start" | "stop" | "end";
  checkpoint?: boolean;
  /** Text inside the pin (A, 1, 2, B…). */
  badge: string;
}

interface OsmPick {
  osmType: string;
  osmId: number;
  category: string;
  tags: Record<string, string>;
}

const CAMERA_SOURCE = "cameras";
const FOV_SOURCE = "fov";
const SYMBOL_SOURCE = "symbols";
const SYMBOL_LAYER = "symbol-glyphs";
const ROUTE_SOURCE = "route";
const ROUTE_CASING = "route-casing";
const ALT_SOURCE = "route-alt";
const OSM_POINTS = "osm-points";
const OSM_LINES = "osm-lines";
const OSM_LINE_LABELS = "osm-line-labels";
/** Half-size of the box a tap searches for the nearest camera. */
const TAP_SLOP_PX = 16;

const EMPTY_FC: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

const isFiniteCoord = (c: Camera) =>
  Number.isFinite(c.lat) && Number.isFinite(c.lon);

function camerasToFC(
  cameras: Camera[],
  highlightIds?: Set<string>,
): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: cameras.filter((c) => isFiniteCoord(c) && !hasSymbol(c)).map((c) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [c.lon, c.lat] },
      properties: {
        id: c.id,
        color: cameraColor(c),
        highlight: highlightIds?.has(c.id) ?? false,
        unconfirmed: c.unconfirmed ?? false,
      },
    })),
  };
}

function fovToFC(cameras: Camera[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const c of cameras) {
    if (!isFiniteCoord(c)) continue;
    // Symbol layers carry their own meaning; a cone under a glyph reads as
    // noise and, for aircraft, implies a field of view they don't have.
    if (hasSymbol(c)) continue;
    if (c.omni) {
      // Soft ring for 360° units.
      features.push({
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [fovConePolygon({ ...c, fovHalfAngle: 180 }, 0, 40)],
        },
        properties: { color: cameraColor(c), omni: true },
      });
      continue;
    }
    for (const dir of c.directions) {
      if (!Number.isFinite(dir)) continue;
      features.push({
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [fovConePolygon(c, dir, 80)],
        },
        properties: { color: cameraColor(c), omni: false },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

/** Points rendered as a glyph rather than a dot (incidents, aircraft, …). */
function symbolsToFC(
  cameras: Camera[],
  highlightIds?: Set<string>,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const c of cameras) {
    if (!isFiniteCoord(c)) continue;
    const symbol = mapSymbol(c);
    if (!symbol) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [c.lon, c.lat] },
      properties: {
        id: c.id,
        symbol,
        highlight: highlightIds?.has(c.id) ?? false,
      },
    });
  }
  return { type: "FeatureCollection", features };
}

function routeToFC(routeLine: [number, number][] | null): GeoJSON.FeatureCollection {
  if (!routeLine || routeLine.length < 2) return EMPTY_FC;
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "LineString", coordinates: routeLine },
        properties: {},
      },
    ],
  };
}

export function MapView({
  cameras,
  highlightIds,
  center,
  heading,
  follow = false,
  headingUp = false,
  showFov = true,
  basemap = "streets",
  routeLine,
  fitRoute = false,
  onSelectCamera,
  placing = false,
  onMapClick,
  onReady,
  aimBearing,
  altRoutes,
  routeColor = "#16e0b8",
  stops,
  recenterToken,
  fitPadding,
  osmLayers,
  lookAt,
  onLongPress,
}: MapViewProps) {
  const lookMarkerRef = useRef<maplibregl.Marker | null>(null);
  const onLongPressRef = useRef(onLongPress);
  onLongPressRef.current = onLongPress;
  // Tiles drawn at least once: until then a skeleton covers the canvas, so
  // the map fades in instead of popping in square by square.
  const [painted, setPainted] = useState(false);
  const [osmPick, setOsmPick] = useState<OsmPick | null>(null);
  const [osmStatus, setOsmStatus] = useState<{
    loading: boolean;
    needZoom: string[];
    error: string | null;
  }>({ loading: false, needZoom: [], error: null });
  const stopMarkersRef = useRef<maplibregl.Marker[]>([]);
  const fitPaddingRef = useRef(fitPadding);
  fitPaddingRef.current = fitPadding;
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const [ready, setReady] = useState(false);
  const lastFitKey = useRef("");
  const didInitialCenter = useRef(false);
  const onSelectCameraRef = useRef(onSelectCamera);
  onSelectCameraRef.current = onSelectCamera;
  // The map's handlers are registered once on load, so they'd otherwise close
  // over the first render's camera array forever.
  const camerasRef = useRef(cameras);
  camerasRef.current = cameras;
  const [bearing, setBearing] = useState(0);
  const placingRef = useRef(placing);
  placingRef.current = placing;
  const onMapClickRef = useRef(onMapClick);
  onMapClickRef.current = onMapClick;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASEMAP_STYLE,
      center: center ? [center.lon, center.lat] : [-81.0, 34.0],
      zoom: center ? 14 : 7,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.once("idle", () => setPainted(true));
    // Never leave the skeleton up forever on a dead connection.
    const paintTimer = setTimeout(() => setPainted(true), 6000);

    map.on("load", () => {
      map.addSource(SATELLITE_SOURCE, {
        type: "raster",
        tiles: SATELLITE_TILES,
        tileSize: 256,
        attribution: SATELLITE_ATTRIB,
        maxzoom: 19,
      });
      map.addLayer({
        id: "satellite",
        type: "raster",
        source: SATELLITE_SOURCE,
        layout: { visibility: "none" },
        paint: { "raster-opacity": 1 },
      });

      map.addSource(FOV_SOURCE, { type: "geojson", data: EMPTY_FC });
      map.addLayer({
        id: "fov-fill",
        type: "fill",
        source: FOV_SOURCE,
        paint: {
          "fill-color": ["get", "color"],
          "fill-opacity": 0.32,
        },
      });
      map.addLayer({
        id: "fov-outline",
        type: "line",
        source: FOV_SOURCE,
        paint: {
          "line-color": ["get", "color"],
          "line-width": 2,
          "line-opacity": 0.85,
        },
      });

      // OSM detail lines (speed limits) sit under the routes so a planned
      // route is never hidden by road colouring.
      map.addSource(OSM_LINES, { type: "geojson", data: EMPTY_FC });
      map.addLayer({
        id: OSM_LINES,
        type: "line",
        source: OSM_LINES,
        layout: { "line-cap": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": 3,
          "line-opacity": 0.55,
        },
      });
      // Reuse whatever font the basemap ships, so labels never request a
      // glyph set the tile server doesn't have.
      const font = (map.getStyle().layers ?? [])
        .map((l) => (l.layout as Record<string, unknown> | undefined)?.["text-font"])
        .find((f): f is string[] => Array.isArray(f));
      if (font) {
        map.addLayer({
          id: OSM_LINE_LABELS,
          type: "symbol",
          source: OSM_LINES,
          minzoom: 14,
          layout: {
            "symbol-placement": "line",
            "text-field": ["get", "label"],
            "text-font": font,
            "text-size": 12,
            "symbol-spacing": 220,
          },
          paint: {
            "text-color": "#ffffff",
            "text-halo-color": "#4c1d95",
            "text-halo-width": 2,
          },
        });
      }

      map.addSource(ALT_SOURCE, { type: "geojson", data: EMPTY_FC });
      map.addLayer({
        id: "route-alt",
        type: "line",
        source: ALT_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["coalesce", ["get", "color"], "#8a96aa"],
          "line-width": 5,
          "line-opacity": 0.45,
          "line-dasharray": [1.5, 1.2],
        },
      });

      map.addSource(ROUTE_SOURCE, { type: "geojson", data: EMPTY_FC });
      map.addLayer({
        id: ROUTE_CASING,
        type: "line",
        source: ROUTE_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#0b1220",
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 8, 14, 12],
          "line-opacity": 0.55,
        },
      });
      map.addLayer({
        id: "route-line",
        type: "line",
        source: ROUTE_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": routeColor,
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 4.5, 14, 7],
          "line-opacity": 0.95,
        },
      });

      map.addSource(OSM_POINTS, { type: "geojson", data: EMPTY_FC });
      map.addLayer({
        id: OSM_POINTS,
        type: "circle",
        source: OSM_POINTS,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 3, 16, 6],
          "circle-color": ["get", "color"],
          "circle-stroke-color": "#0b1220",
          "circle-stroke-width": 1.5,
          "circle-opacity": 0.9,
        },
      });
      const pickOsm = (e: maplibregl.MapLayerMouseEvent) => {
        if (placingRef.current) return;
        // A camera under the tap wins: it's what people are here for.
        const r = TAP_SLOP_PX;
        const cams = map.queryRenderedFeatures(
          [
            [e.point.x - r, e.point.y - r],
            [e.point.x + r, e.point.y + r],
          ],
          { layers: ["camera-dots", SYMBOL_LAYER].filter((l) => map.getLayer(l)) },
        );
        if (cams.length) return;
        const p = e.features?.[0]?.properties;
        if (!p) return;
        let tags: Record<string, string> = {};
        try {
          tags = JSON.parse(String(p.tags));
        } catch {
          // keep empty
        }
        setOsmPick({
          osmType: String(p.osmType),
          osmId: Number(p.osmId),
          category: String(p.category),
          tags,
        });
      };
      map.on("click", OSM_POINTS, pickOsm);
      map.on("click", OSM_LINES, pickOsm);
      for (const l of [OSM_POINTS, OSM_LINES]) {
        map.on("mouseenter", l, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", l, () => {
          map.getCanvas().style.cursor = "";
        });
      }

      map.addSource(CAMERA_SOURCE, { type: "geojson", data: EMPTY_FC });
      map.addLayer({
        id: "camera-dots",
        type: "circle",
        source: CAMERA_SOURCE,
        paint: {
          // Smaller at state scale, where ~5,000 dots otherwise bury every
          // road (and any planned route) in solid colour.
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            8,
            ["case", ["boolean", ["get", "highlight"], false], 6, 2.5],
            12,
            ["case", ["boolean", ["get", "highlight"], false], 8, 4],
            15,
            ["case", ["boolean", ["get", "highlight"], false], 10, 6],
          ],
          // Unconfirmed RF sightings render hollow — a ring in the brand colour
          // with a near-transparent centre — so they read as "maybe" at a
          // glance and can never be mistaken for a verified camera.
          "circle-color": ["get", "color"],
          "circle-stroke-width": [
            "case",
            ["boolean", ["get", "highlight"], false],
            3,
            ["boolean", ["get", "unconfirmed"], false],
            2,
            1.5,
          ],
          "circle-stroke-color": [
            "case",
            ["boolean", ["get", "unconfirmed"], false],
            ["get", "color"],
            "#ffffff",
          ],
          "circle-opacity": [
            "case",
            ["boolean", ["get", "highlight"], false],
            1,
            ["boolean", ["get", "unconfirmed"], false],
            0.18,
            0.85,
          ],
        },
      });

      // Emoji must be registered as images, not drawn via `text-field`: that
      // path goes through the basemap's monochrome SDF glyph atlas and renders
      // every emoji as a solid black silhouette.
      for (const symbol of ALL_SYMBOLS) {
        if (map.hasImage(symbol)) continue;
        const img = rasterizeSymbol(symbol);
        if (img) map.addImage(symbol, img, { pixelRatio: 2 });
      }

      map.addSource(SYMBOL_SOURCE, { type: "geojson", data: EMPTY_FC });
      map.addLayer({
        id: SYMBOL_LAYER,
        type: "symbol",
        source: SYMBOL_SOURCE,
        layout: {
          "icon-image": ["get", "symbol"],
          "icon-size": [
            "case",
            ["boolean", ["get", "highlight"], false],
            1.25,
            0.85,
          ],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      });

      // Routes draw above the camera dots: along highways the traffic cams
      // sit shoulder to shoulder and hid the route line completely. The
      // cameras that are actually on the route are then redrawn on top.
      for (const id of ["route-alt", ROUTE_CASING, "route-line"]) map.moveLayer(id);
      map.addLayer({
        id: "camera-dots-hl",
        type: "circle",
        source: CAMERA_SOURCE,
        filter: ["==", ["get", "highlight"], true],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 6, 12, 8, 15, 10],
          "circle-color": ["get", "color"],
          "circle-stroke-width": 3,
          "circle-stroke-color": "#ffffff",
        },
      });

      map.on("click", SYMBOL_LAYER, (e) => {
        if (placingRef.current) return;
        const id = e.features?.[0]?.properties?.id;
        if (id != null) onSelectCameraRef.current?.(String(id));
      });
      map.on("mouseenter", SYMBOL_LAYER, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", SYMBOL_LAYER, () => {
        map.getCanvas().style.cursor = "";
      });

      map.on("click", "camera-dots", (e) => {
        if (placingRef.current) return; // in placing mode, taps drop a pin
        const f = e.features?.[0];
        const id = f?.properties?.id;
        if (id != null) onSelectCameraRef.current?.(String(id));
      });
      // Double-click a camera to look the way it looks. MapLibre's default
      // dblclick is zoom-in, so that's suppressed for this gesture only --
      // preventDefault on the event stops the zoom without disabling it
      // everywhere else on the map.
      const aimAtCamera = (e: maplibregl.MapLayerMouseEvent) => {
        if (placingRef.current) return;
        const id = e.features?.[0]?.properties?.id;
        if (id == null) return;
        const cam = camerasRef.current.find((c) => c.id === String(id));
        if (!cam) return;
        const dir = aimBearingFor(cam);
        if (dir == null) return;
        e.preventDefault();
        map.easeTo({ bearing: dir, duration: 500 });
      };
      map.on("dblclick", "camera-dots", aimAtCamera);
      map.on("dblclick", SYMBOL_LAYER, aimAtCamera);

      // Touch devices don't emit dblclick on a double-tap, so the gesture is
      // detected manually: two taps on the same feature inside 320ms.
      let lastTap = { id: "", at: 0 };
      const onTouchTap = (e: maplibregl.MapLayerMouseEvent) => {
        const id = e.features?.[0]?.properties?.id;
        if (id == null) return;
        const now = Date.now();
        const key = String(id);
        if (lastTap.id === key && now - lastTap.at < 320) {
          lastTap = { id: "", at: 0 };
          aimAtCamera(e);
        } else {
          lastTap = { id: key, at: now };
        }
      };
      map.on("click", "camera-dots", onTouchTap);
      map.on("click", SYMBOL_LAYER, onTouchTap);

      map.on("rotate", () => setBearing(map.getBearing()));

      // Right-click on a laptop; on phones most browsers turn a long press on
      // the canvas into the same contextmenu event.
      map.on("contextmenu", (e) => {
        e.preventDefault();
        onLongPressRef.current?.({ lat: e.lngLat.lat, lon: e.lngLat.lng });
      });
      // Touch browsers don't reliably send contextmenu from the map canvas,
      // so time a still, single-finger press ourselves.
      let pressTimer: ReturnType<typeof setTimeout> | null = null;
      const cancelPress = () => {
        if (pressTimer) clearTimeout(pressTimer);
        pressTimer = null;
      };
      map.on("touchstart", (e) => {
        cancelPress();
        if (e.originalEvent.touches.length !== 1) return;
        const at = e.lngLat;
        pressTimer = setTimeout(() => {
          pressTimer = null;
          onLongPressRef.current?.({ lat: at.lat, lon: at.lng });
        }, 550);
      });
      map.on("touchmove", cancelPress);
      map.on("touchend", cancelPress);
      map.on("touchcancel", cancelPress);
      map.on("movestart", cancelPress);

      map.on("click", (e) => {
        if (placingRef.current) {
          onMapClickRef.current?.({ lat: e.lngLat.lat, lon: e.lngLat.lng });
          return;
        }
        // Dots are ~10px; a fingertip is ~40. Treat a near miss as a tap on
        // the closest camera instead of making people zoom in to hit one.
        const r = TAP_SLOP_PX;
        const hits = map.queryRenderedFeatures(
          [
            [e.point.x - r, e.point.y - r],
            [e.point.x + r, e.point.y + r],
          ],
          { layers: ["camera-dots", SYMBOL_LAYER] },
        );
        let best: { id: string; d: number } | null = null;
        for (const f of hits) {
          if (f.geometry.type !== "Point" || f.properties?.id == null) continue;
          const p = map.project(f.geometry.coordinates as [number, number]);
          const d = Math.hypot(p.x - e.point.x, p.y - e.point.y);
          if (!best || d < best.d) best = { id: String(f.properties.id), d };
        }
        if (best) onSelectCameraRef.current?.(best.id);
      });
      map.on("mouseenter", "camera-dots", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "camera-dots", () => {
        map.getCanvas().style.cursor = "";
      });

      setReady(true);
      onReady?.(map);
    });

    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>;
      w.__map = map;
      w.__maps = [...((w.__maps as maplibregl.Map[] | undefined) ?? []), map];
    }

    return () => {
      clearTimeout(paintTimer);
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !map.getLayer("route-line")) return;
    map.setPaintProperty("route-line", "line-color", routeColor);
  }, [routeColor, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource(ALT_SOURCE) as maplibregl.GeoJSONSource | undefined;
    src?.setData({
      type: "FeatureCollection",
      features: (altRoutes ?? [])
        .filter((r) => r.coordinates.length > 1)
        .map((r) => ({
          type: "Feature",
          geometry: { type: "LineString", coordinates: r.coordinates },
          properties: r.color ? { color: r.color } : {},
        })),
    });
  }, [altRoutes, ready]);

  // Stop pins are DOM markers: they need a badge, a label and to sit above
  // every layer, which is clumsy to do with symbol layers.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const m of stopMarkersRef.current) m.remove();
    stopMarkersRef.current = (stops ?? []).map((s) => {
      const el = document.createElement("div");
      el.className = `stop-pin stop-pin-${s.role}${s.checkpoint ? " stop-pin-check" : ""}`;
      el.title = s.label;
      const badge = document.createElement("span");
      badge.textContent = s.badge;
      el.appendChild(badge);
      return new maplibregl.Marker({ element: el, anchor: "bottom" })
        .setLngLat([s.point.lon, s.point.lat])
        .addTo(map);
    });
  }, [stops, ready]);

  useEffect(
    () => () => {
      for (const m of stopMarkersRef.current) m.remove();
    },
    [],
  );

  // --- OpenStreetMap detail layers -----------------------------------------
  const osmKey = (osmLayers ?? []).slice().sort().join(",");
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const ids = osmKey ? osmKey.split(",") : [];
    const pts = map.getSource(OSM_POINTS) as maplibregl.GeoJSONSource | undefined;
    const lns = map.getSource(OSM_LINES) as maplibregl.GeoJSONSource | undefined;
    if (!ids.length) {
      pts?.setData(EMPTY_FC);
      lns?.setData(EMPTY_FC);
      setOsmStatus({ loading: false, needZoom: [], error: null });
      return;
    }

    let ctrl: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // The box last fetched (padded), and which categories it holds.
    let have: { bbox: Bbox; cats: string } | null = null;

    const load = async () => {
      const zoom = map.getZoom();
      const cats = ids
        .map((id) => OSM_CATEGORY_BY_ID.get(id))
        .filter((c): c is NonNullable<typeof c> => !!c);
      const usable = cats.filter((c) => zoom >= c.minZoom);
      const needZoom = cats.filter((c) => zoom < c.minZoom).map((c) => c.label);
      const b = map.getBounds();
      const view: Bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
      const catsKey = usable.map((c) => c.id).join(",");
      if (!usable.length) {
        setOsmStatus({ loading: false, needZoom, error: null });
        return;
      }
      if (
        have &&
        have.cats === catsKey &&
        view[0] >= have.bbox[0] &&
        view[1] >= have.bbox[1] &&
        view[2] <= have.bbox[2] &&
        view[3] <= have.bbox[3]
      ) {
        setOsmStatus((s) => ({ ...s, needZoom }));
        return;
      }
      // Pad by half a screen so small pans don't refetch.
      const dLat = (view[2] - view[0]) / 2;
      const dLon = (view[3] - view[1]) / 2;
      const padded: Bbox = [view[0] - dLat, view[1] - dLon, view[2] + dLat, view[3] + dLon];
      ctrl?.abort();
      ctrl = new AbortController();
      setOsmStatus({ loading: true, needZoom, error: null });
      try {
        const fc = await fetchOsmDetails(usable, padded, ctrl.signal);
        pts?.setData({
          type: "FeatureCollection",
          features: fc.features.filter((f) => f.geometry.type === "Point"),
        });
        lns?.setData({
          type: "FeatureCollection",
          features: fc.features.filter((f) => f.geometry.type === "LineString"),
        });
        have = { bbox: padded, cats: catsKey };
        setOsmStatus({ loading: false, needZoom, error: null });
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setOsmStatus({
          loading: false,
          needZoom,
          error: "Map details unavailable right now (OpenStreetMap is busy).",
        });
      }
    };

    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 650);
    };
    void load();
    map.on("moveend", schedule);
    return () => {
      map.off("moveend", schedule);
      if (timer) clearTimeout(timer);
      ctrl?.abort();
    };
  }, [osmKey, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!lookAt) {
      lookMarkerRef.current?.remove();
      lookMarkerRef.current = null;
      return;
    }
    const at: [number, number] = [lookAt.point.lon, lookAt.point.lat];
    if (!lookMarkerRef.current) {
      const el = document.createElement("div");
      el.className = "look-pin";
      lookMarkerRef.current = new maplibregl.Marker({ element: el, anchor: "bottom" });
    }
    lookMarkerRef.current.setLngLat(at).addTo(map);
    map.flyTo({ center: at, zoom: Math.max(map.getZoom(), 16), duration: 1200, essential: true });
  }, [lookAt, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !recenterToken || !center) return;
    map.easeTo({
      center: [center.lon, center.lat],
      zoom: Math.max(map.getZoom(), 15),
      duration: 600,
    });
    // Only the token triggers this; plain center changes are handled below.
  }, [recenterToken, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource(CAMERA_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData(camerasToFC(cameras, highlightIds));
    const sym = map.getSource(SYMBOL_SOURCE) as
      | maplibregl.GeoJSONSource
      | undefined;
    sym?.setData(symbolsToFC(cameras, highlightIds));
  }, [cameras, highlightIds, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource(FOV_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData(showFov ? fovToFC(cameras) : EMPTY_FC);
  }, [cameras, showFov, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.getCanvas().style.cursor = placing ? "crosshair" : "";
  }, [placing, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !map.getLayer("satellite")) return;
    map.setLayoutProperty(
      "satellite",
      "visibility",
      basemap === "satellite" ? "visible" : "none",
    );
  }, [basemap, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource(ROUTE_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData(routeToFC(routeLine ?? null));

    if (fitRoute && routeLine && routeLine.length > 1) {
      // Fit to every candidate line, keyed on all of them, so flipping between
      // Plan A and B doesn't make the map lurch each time.
      const lines = [routeLine, ...(altRoutes ?? []).map((r) => r.coordinates)]
        .filter((l) => l.length > 1);
      const key = lines
        .map((l) => `${l.length}:${l[0]}:${l[l.length - 1]}`)
        .sort()
        .join("|");
      if (key !== lastFitKey.current) {
        lastFitKey.current = key;
        const bounds = new maplibregl.LngLatBounds(
          routeLine[0],
          routeLine[0],
        );
        for (const l of lines) for (const c of l) bounds.extend(c);
        const p = fitPaddingRef.current;
        map.fitBounds(bounds, {
          padding: p
            ? { top: p.top + 40, bottom: p.bottom + 40, left: p.left + 40, right: p.right + 40 }
            : 56,
          duration: 700,
          maxZoom: 15,
        });
      }
    }
  }, [routeLine, altRoutes, fitRoute, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !center) return;

    if (!userMarkerRef.current) {
      const el = document.createElement("div");
      el.className = "user-chevron";
      el.innerHTML =
        '<svg viewBox="0 0 24 24" width="28" height="28"><path d="M12 2 L20 20 L12 16 L4 20 Z" fill="#16e0b8" stroke="#fff" stroke-width="1.5"/></svg>';
      userMarkerRef.current = new maplibregl.Marker({
        element: el,
        rotationAlignment: "map",
        pitchAlignment: "map",
      }).setLngLat([center.lon, center.lat]);
      userMarkerRef.current.addTo(map);
    } else {
      userMarkerRef.current.setLngLat([center.lon, center.lat]);
    }

    if (heading != null) {
      userMarkerRef.current.setRotation(heading);
    }

    if (follow) {
      map.easeTo({
        center: [center.lon, center.lat],
        bearing: headingUp && heading != null ? heading : 0,
        duration: 500,
        zoom: Math.max(map.getZoom(), 15),
      });
    } else if (!didInitialCenter.current) {
      // Browsing (not driving): center on the user once so nearby cameras are visible.
      didInitialCenter.current = true;
      map.easeTo({
        center: [center.lon, center.lat],
        zoom: Math.max(map.getZoom(), 14.5),
        duration: 700,
      });
    }
  }, [center, heading, follow, headingUp, ready]);

  // Driven by a token rather than the bearing alone, so aiming twice at the
  // same camera still turns the map back after you've spun it away.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !aimBearing) return;
    map.easeTo({ bearing: aimBearing.bearing, duration: 500 });
  }, [aimBearing, ready]);

  const resetNorth = () => {
    mapRef.current?.easeTo({ bearing: 0, pitch: 0, duration: 400 });
  };

  return (
    <div className="map-container">
      <div ref={containerRef} className="map-canvas" />
      <div className={`map-skeleton ${painted ? "gone" : ""}`} aria-hidden="true">
        <div className="map-skeleton-label">
          <span className="spinner" /> Loading map
        </div>
      </div>
      {(osmStatus.loading || osmStatus.needZoom.length > 0 || osmStatus.error) && (
        <div className="osm-status" role="status">
          {osmStatus.loading ? (
            <>
              <span className="spinner sm" /> Loading map details
            </>
          ) : osmStatus.error ? (
            osmStatus.error
          ) : (
            `Zoom in to see ${osmStatus.needZoom.join(", ").toLowerCase()}`
          )}
        </div>
      )}
      {osmPick && <OsmInspector pick={osmPick} onClose={() => setOsmPick(null)} />}
      {/* Only appears once the map is actually turned — a permanently visible
          reset control on a north-up map is a button that does nothing. */}
      {Math.abs(bearing) > 0.5 && (
        <button
          type="button"
          className="map-compass"
          onClick={resetNorth}
          aria-label="Reset map to north"
          title="Reset to north"
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <g transform={`rotate(${-bearing} 12 12)`}>
              <path d="M12 3 L15.4 12 L12 10.3 L8.6 12 Z" fill="var(--hot)" />
              <path d="M12 21 L8.6 12 L12 13.7 L15.4 12 Z" fill="var(--muted)" />
            </g>
          </svg>
        </button>
      )}
    </div>
  );
}

/** Every tag OpenStreetMap has for a tapped feature, friendliest first. */
function OsmInspector({ pick, onClose }: { pick: OsmPick; onClose: () => void }) {
  const cat = OSM_CATEGORY_BY_ID.get(pick.category);
  const rows = useMemo(() => {
    const entries = Object.entries(pick.tags);
    const friendly = entries
      .filter(([k]) => k in FRIENDLY_TAGS)
      .map(([k, v]) => [FRIENDLY_TAGS[k], v] as const);
    const rest = entries.filter(([k]) => !(k in FRIENDLY_TAGS) && k !== "name");
    return { friendly, rest };
  }, [pick]);
  const title = pick.tags.name ?? pick.tags.ref ?? cat?.label ?? "Map feature";

  return (
    <div className="osm-inspector" role="dialog" aria-label={title}>
      <div className="osm-inspector-head">
        <span className="osm-swatch" style={{ background: cat?.color }} />
        <div className="osm-inspector-title">
          <strong>{title}</strong>
          <span>{cat?.label}</span>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {rows.friendly.length > 0 && (
        <dl className="osm-friendly">
          {rows.friendly
            .filter(([label]) => label !== "Name")
            .map(([label, v]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{v}</dd>
              </div>
            ))}
        </dl>
      )}
      <details className="osm-raw">
        <summary>All OpenStreetMap tags ({rows.rest.length})</summary>
        <table>
          <tbody>
            {rows.rest.map(([k, v]) => (
              <tr key={k}>
                <th>{k}</th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      <a
        className="osm-link"
        href={`https://www.openstreetmap.org/${pick.osmType}/${pick.osmId}`}
        target="_blank"
        rel="noreferrer"
      >
        Open on openstreetmap.org
      </a>
    </div>
  );
}
