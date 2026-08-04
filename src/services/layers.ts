import type { Camera, CameraKind, Settings } from "@/types";
import { PASSIVE_KINDS } from "@/types";

/**
 * Takes the whole Settings object rather than a hand-listed Pick: every new
 * layer previously meant updating this type *and* the literal spelled out at
 * each call site, which broke the build every time and taught nothing.
 */
type VisibilitySettings = Settings;

/** Which layer toggle governs a given kind. */
export function kindVisible(kind: CameraKind, s: VisibilitySettings): boolean {
  switch (kind) {
    case "alpr":
      return s.showAlpr;
    case "speed":
    case "traffic":
      return s.showTraffic;
    case "gunshot":
      return s.showGunshot;
    case "police":
      return s.showPolice;
    case "radio":
      return s.showRadio;
    case "incident":
      return s.showIncidents;
    case "aircraft":
      return s.showAircraft;
  }
}

/**
 * Map/list visibility. `flockOnly` narrows the camera layers only — gunshot
 * detectors, police stations and radio sites have their own toggles, so it
 * would be surprising for a camera-brand filter to also hide them.
 */
export function makeIsShown(s: VisibilitySettings): (c: Camera) => boolean {
  return (c) => {
    if (!kindVisible(c.kind, s)) return false;
    if (c.unconfirmed && !s.showUnconfirmed) return false;
    if (
      c.kind === "gunshot" ||
      c.kind === "police" ||
      c.kind === "radio" ||
      c.kind === "incident" ||
      c.kind === "aircraft"
    ) {
      return true;
    }
    return !s.flockOnly || c.brand === "Flock Safety" || !!c.custom;
  };
}

/**
 * Whether a point should produce an audible proximity alert. Everything
 * detectable alerts by default and can be switched off per kind.
 *
 * Passive kinds are the one hard exception: they never beep at any setting.
 * There are ~1,600 radio towers and ~260 police stations in the pack, and they
 * sit at fixed places you drive past constantly — alerting on them would mean a
 * near-continuous tone that trains you to tune out the alerts that matter. They
 * stay visible on the map as reference points instead.
 */
export function makeIsAlertable(
  s: Settings,
): (c: Camera) => boolean {
  const isShown = makeIsShown(s);
  return (c) => {
    if (!isShown(c)) return false;
    if (PASSIVE_KINDS.has(c.kind)) return false;
    if (c.unconfirmed) return s.alertUnconfirmed;
    if (c.kind === "incident") return s.alertIncidents;
    if (c.kind === "traffic" || c.kind === "gunshot") return s.alertTraffic;
    return true;
  };
}
