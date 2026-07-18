import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Camera, LatLng } from "@/types";
import { BRAND_COLORS } from "@/services/brand";

// Free vector basemap; tiles are cached by the service worker for offline use.
const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/positron";

interface MapViewProps {
  cameras: Camera[];
  /** Ids to emphasize (upcoming / in-range). */
  highlightIds?: Set<string>;
  center?: LatLng | null;
  heading?: number | null;
  follow?: boolean;
  headingUp?: boolean;
  routeLine?: [number, number][] | null;
  onReady?: (map: maplibregl.Map) => void;
}

const CAMERA_SOURCE = "cameras";
const ROUTE_SOURCE = "route";

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
  routeLine,
  onReady,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const readyRef = useRef(false);

  // Init map once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASEMAP_STYLE,
      center: center ? [center.lon, center.lat] : [-81.0, 34.0], // SC-ish
      zoom: center ? 14 : 7,
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    map.on("load", () => {
      map.addSource(CAMERA_SOURCE, {
        type: "geojson",
        data: EMPTY_FC,
      });
      map.addLayer({
        id: "camera-dots",
        type: "circle",
        source: CAMERA_SOURCE,
        paint: {
          "circle-radius": [
            "case",
            ["boolean", ["get", "highlight"], false],
            9,
            5,
          ],
          "circle-color": ["get", "color"],
          "circle-stroke-width": [
            "case",
            ["boolean", ["get", "highlight"], false],
            3,
            1,
          ],
          "circle-stroke-color": "#0b1220",
          "circle-opacity": [
            "case",
            ["boolean", ["get", "highlight"], false],
            1,
            0.6,
          ],
        },
      });

      map.addSource(ROUTE_SOURCE, {
        type: "geojson",
        data: EMPTY_FC,
      });
      map.addLayer({
        id: "route-line",
        type: "line",
        source: ROUTE_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#4895ef", "line-width": 5, "line-opacity": 0.85 },
      });

      readyRef.current = true;
      onReady?.(map);
    });

    return () => {
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
    };
    // Map is initialized once; later prop changes are handled by the effects below.
  }, []);

  // Update camera features.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const src = map.getSource(CAMERA_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData(camerasToFC(cameras, highlightIds));
  }, [cameras, highlightIds]);

  // Update route line.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const src = map.getSource(ROUTE_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData(routeToFC(routeLine ?? null));
  }, [routeLine]);

  // User marker + follow camera.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !center) return;

    if (!userMarkerRef.current) {
      const el = document.createElement("div");
      el.className = "user-dot";
      userMarkerRef.current = new maplibregl.Marker({ element: el }).setLngLat([
        center.lon,
        center.lat,
      ]);
      userMarkerRef.current.addTo(map);
    } else {
      userMarkerRef.current.setLngLat([center.lon, center.lat]);
    }

    if (follow) {
      map.easeTo({
        center: [center.lon, center.lat],
        bearing: headingUp && heading != null ? heading : 0,
        duration: 600,
        zoom: Math.max(map.getZoom(), 14),
      });
    }
  }, [center, heading, follow, headingUp]);

  return <div ref={containerRef} className="map-container" />;
}
