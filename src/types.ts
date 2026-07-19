export type Brand =
  | "Flock Safety"
  | "Motorola"
  | "Genetec"
  | "Leonardo"
  | "Neology"
  | "Other";

/** Broad category of camera, used for coloring, filtering and alerts. */
export type CameraKind = "alpr" | "speed" | "traffic";

export interface Camera {
  /** OSM node id (stable across syncs). */
  id: string;
  lat: number;
  lon: number;
  /** Broad category (plate reader, speed camera, traffic/CCTV). */
  kind: CameraKind;
  brand: Brand;
  /** Raw manufacturer/brand string from OSM. */
  rawBrand?: string;
  /** Display name if tagged. */
  name?: string;
  /** Operator / agency if tagged. */
  operator?: string;
  /** Facing direction(s) in degrees if tagged, e.g. [90, 270]. */
  directions: number[];
  /** Whether the camera covers all directions. */
  omni: boolean;
  /** OSM surveillance:zone or similar. */
  zone?: string;
  /** Human-readable purpose derived from tags + brand. */
  purpose: string;
  /** Absolute image URL if OSM has image / wikimedia_commons. */
  imageUrl?: string;
  /** Approximate FOV half-angle in degrees (full cone = 2x). */
  fovHalfAngle: number;
  /** True if the user added this camera manually (stored on device). */
  custom?: boolean;
}

export interface CameraDataset {
  generatedAt: string;
  syncedAt?: string;
  count: number;
  cameras: Camera[];
}

export interface LatLng {
  lat: number;
  lon: number;
}

export interface RouteStep {
  instruction: string;
  name: string;
  distanceMeters: number;
  durationSeconds: number;
  maneuverType: string;
  /** [lon, lat] of the maneuver location. */
  location: [number, number];
}

export interface SavedRoute {
  id: string;
  createdAt: string;
  origin: LatLng;
  destination: LatLng;
  destinationLabel: string;
  /** [lon, lat] pairs (GeoJSON order) for the chosen (avoidance) route. */
  coordinates: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
  camerasOnFastest: number;
  camerasUnavoidable: number;
  steps: RouteStep[];
}

export type AppMode = "drive" | "route" | "settings";

export interface Settings {
  alertDistanceFeet: number;
  muted: boolean;
  flockOnly: boolean;
  headingUp: boolean;
  escalate: boolean;
  showFov: boolean;
  /** Show/hide plate readers (ALPR). */
  showAlpr: boolean;
  /** Show/hide traffic + speed cameras. */
  showTraffic: boolean;
  /** Also play alert sound for traffic/CCTV cameras (off = visual only). */
  alertTraffic: boolean;
  /** Basemap style key. */
  basemap: "streets" | "satellite";
  /** Route avoidance: Flock Safety plate readers. */
  avoidFlock: boolean;
  /** Route avoidance: other ALPRs (Motorola, Genetec, etc.). */
  avoidOtherAlpr: boolean;
  /** Route avoidance: traffic / DOT / CCTV cameras. */
  avoidTraffic: boolean;
  /** Route avoidance: cameras you added on this device. */
  avoidCustom: boolean;
  /** Route avoidance: community-submitted cameras. */
  avoidCommunity: boolean;
}
