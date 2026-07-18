import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Camera, LatLng } from "@/types";
import { BRAND_COLORS } from "@/services/brand";
import { fovConePolygon } from "@/services/geo";

const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/positron";

interface MapViewProps {
  cameras: Camera[];
  highlightIds?: Set<string>;
  center?: LatLng | null;
  heading?: number | null;
  follow?: boolean;
  headingUp?: boolean;
  showFov?: boolean;
  routeLine?: [number, number][] | null;
  /** When true, fit the map to the route bounds once it changes. */
  fitRoute?: boolean;
  onReady?: (map: maplibregl.Map) => void;
}

const CAMERA_SOURCE = "cameras";
const FOV_SOURCE = "fov";
const ROUTE_SOURCE = "route";
const ROUTE_CASING = "route-casing";

const EMPTY_FC: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

function camerasToFC(
  cameras: Camera[],
  highlightIds?: Set<string>,
): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: cameras.map((c) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [c.lon, c.lat] },
      properties: {
        id: c.id,
        color: BRAND_COLORS[c.brand],
        highlight: highlightIds?.has(c.id) ?? false,
      },
    })),
  };
}

function fovToFC(cameras: Camera[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const c of cameras) {
    if (c.omni) {
      // Soft ring for 360° units.
      features.push({
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [fovConePolygon({ ...c, fovHalfAngle: 180 }, 0, 40)],
        },
        properties: { color: BRAND_COLORS[c.brand], omni: true },
      });
      continue;
    }
    for (const dir of c.directions) {
      features.push({
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [fovConePolygon(c, dir)],
        },
        properties: { color: BRAND_COLORS[c.brand], omni: false },
      });
    }
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
  routeLine,
  fitRoute = false,
  onReady,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const readyRef = useRef(false);
  const lastFitKey = useRef("");

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

    map.on("load", () => {
      map.addSource(FOV_SOURCE, { type: "geojson", data: EMPTY_FC });
      map.addLayer({
        id: "fov-fill",
        type: "fill",
        source: FOV_SOURCE,
        paint: {
          "fill-color": ["get", "color"],
          "fill-opacity": 0.22,
        },
      });
      map.addLayer({
        id: "fov-outline",
        type: "line",
        source: FOV_SOURCE,
        paint: {
          "line-color": ["get", "color"],
          "line-width": 1.5,
          "line-opacity": 0.55,
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
          "line-width": 10,
          "line-opacity": 0.35,
        },
      });
      map.addLayer({
        id: "route-line",
        type: "line",
        source: ROUTE_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#2f80ed",
          "line-width": 6,
          "line-opacity": 0.95,
        },
      });

      map.addSource(CAMERA_SOURCE, { type: "geojson", data: EMPTY_FC });
      map.addLayer({
        id: "camera-dots",
        type: "circle",
        source: CAMERA_SOURCE,
        paint: {
          "circle-radius": [
            "case",
            ["boolean", ["get", "highlight"], false],
            10,
            5.5,
          ],
          "circle-color": ["get", "color"],
          "circle-stroke-width": [
            "case",
            ["boolean", ["get", "highlight"], false],
            3,
            1.5,
          ],
          "circle-stroke-color": "#ffffff",
          "circle-opacity": [
            "case",
            ["boolean", ["get", "highlight"], false],
            1,
            0.85,
          ],
        },
      });

      readyRef.current = true;
      onReady?.(map);
    });

    return () => {
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const src = map.getSource(CAMERA_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData(camerasToFC(cameras, highlightIds));
  }, [cameras, highlightIds]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const src = map.getSource(FOV_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData(showFov ? fovToFC(cameras) : EMPTY_FC);
  }, [cameras, showFov]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const src = map.getSource(ROUTE_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData(routeToFC(routeLine ?? null));

    if (fitRoute && routeLine && routeLine.length > 1) {
      const key = `${routeLine.length}:${routeLine[0]}:${routeLine[routeLine.length - 1]}`;
      if (key !== lastFitKey.current) {
        lastFitKey.current = key;
        const bounds = new maplibregl.LngLatBounds(
          routeLine[0],
          routeLine[0],
        );
        for (const c of routeLine) bounds.extend(c);
        map.fitBounds(bounds, { padding: 56, duration: 700, maxZoom: 15 });
      }
    }
  }, [routeLine, fitRoute]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !center) return;

    if (!userMarkerRef.current) {
      const el = document.createElement("div");
      el.className = "user-chevron";
      el.innerHTML =
        '<svg viewBox="0 0 24 24" width="28" height="28"><path d="M12 2 L20 20 L12 16 L4 20 Z" fill="#2f80ed" stroke="#fff" stroke-width="1.5"/></svg>';
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
    }
  }, [center, heading, follow, headingUp]);

  return <div ref={containerRef} className="map-container" />;
}
