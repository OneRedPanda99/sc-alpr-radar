export type Brand =
  | "Flock Safety"
  | "Motorola"
  | "Genetec"
  | "Leonardo"
  | "Neology"
  | "Other";

/**
 * Broad category of a mapped surveillance point, used for coloring, filtering
 * and alerts. Not everything here is a camera — `gunshot` is an acoustic sensor
 * and `police` is a station — but they share the same pipeline (grid, map
 * layers, proximity card) so they share the same shape.
 */
export type CameraKind =
  | "alpr"
  | "speed"
  | "traffic"
  | "gunshot"
  | "police"
  | "radio"
  | "incident"
  | "aircraft";

/** Kinds that are never alerted on or routed around (reference points only). */
export const PASSIVE_KINDS: ReadonlySet<CameraKind> = new Set<CameraKind>([
  "police",
  "radio",
]);

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
  /** Live HLS (.m3u8) stream, for SCDOT 511 traffic cameras. */
  streamUrl?: string;
  /** Approximate FOV half-angle in degrees (full cone = 2x). */
  fovHalfAngle: number;
  /** True if the user added this camera manually (stored on device). */
  custom?: boolean;
  /**
   * Derived from an RF signature (e.g. a WiGLE WiFi observation) rather than a
   * human-verified mapping. Strong evidence, but not proof — a business with a
   * matching network name looks the same from a passing car. These render
   * differently and never alert until you confirm one by eye.
   */
  unconfirmed?: boolean;
  /** Where an unconfirmed sighting came from, shown on the detail card. */
  evidence?: string;
  /** Radio frequencies in MHz, for `radio` transmitter sites. */
  frequencies?: number[];
  /** Where a live `incident` came from (SCDOT or Waze). */
  source?: string;
  /** ISO time a live `incident` was reported, when the feed provides one. */
  reportedAt?: string;
  /**
   * Operator is unambiguously law enforcement. Set for `aircraft` (from the
   * ADS-B owner field) and `radio` sites (from the FCC licensee), both of which
   * carry plenty of non-police traffic that shouldn't be implied to be police.
   */
  lawEnforcement?: boolean;
}

export interface CameraDataset {
  generatedAt: string;
  syncedAt?: string;
  count: number;
  cameras: Camera[];
  /**
   * Bumped whenever the pack gains fields or kinds. A cached pack with an older
   * version is rebuilt from the bundle on launch, so shipping new sources
   * actually reaches people who already have the app installed.
   */
  schemaVersion?: number;
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

export type AppMode = "drive" | "route" | "watch" | "settings";

export type AlertSoundId =
  | "chirp"
  | "pulse"
  | "siren"
  | "ping"
  | "klaxon"
  | "triple"
  | "digital";

export interface Settings {
  alertDistanceFeet: number;
  muted: boolean;
  flockOnly: boolean;
  headingUp: boolean;
  escalate: boolean;
  showFov: boolean;
  /** Alert tone played when a camera enters range. */
  alertSound: AlertSoundId;
  /** Show/hide plate readers (ALPR). */
  showAlpr: boolean;
  /** Show/hide traffic + speed cameras. */
  showTraffic: boolean;
  /** Show/hide gunshot detectors (ShotSpotter / SoundThinking). */
  showGunshot: boolean;
  /** Show/hide police stations. */
  showPolice: boolean;
  /** Show/hide licensed police/public-safety radio transmitter sites. */
  showRadio: boolean;
  /** Show/hide unconfirmed RF-derived camera sightings. */
  showUnconfirmed: boolean;
  /** Show/hide live road incidents (SCDOT 511 + Waze). */
  showIncidents: boolean;
  /** Show/hide live aircraft overhead (ADS-B). */
  showAircraft: boolean;
  /** Play alert sound when approaching a live incident. */
  alertIncidents: boolean;
  /** Also play alert sound for traffic/CCTV + gunshot detectors. */
  alertTraffic: boolean;
  /** Also play alert sound for unconfirmed RF sightings. */
  alertUnconfirmed: boolean;
  /**
   * Headlight dimmer for live camera feeds. Night traffic cams blow out
   * headlights badly; dimming plus added contrast makes the rest of the frame
   * readable. Off by default because it hurts an already-dark daytime feed.
   */
  dimHeadlights: boolean;
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
