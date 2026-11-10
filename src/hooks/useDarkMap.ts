import { useEffect, useState } from "react";
import type { LatLng } from "@/types";
import { useSettingsStore } from "@/store/settingsStore";
import { isDarkOut } from "@/services/sun";
import { FALLBACK_CENTER } from "@/services/geo";

/**
 * Whether the map should be dark: always, never, or (Auto) when the sun is
 * down where you are. Re-checked every few minutes so it changes at dusk.
 */
export function useDarkMap(where?: LatLng | null): boolean {
  const theme = useSettingsStore((s) => s.mapTheme);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (theme !== "auto") return;
    const t = window.setInterval(() => setNow(Date.now()), 5 * 60 * 1000);
    return () => window.clearInterval(t);
  }, [theme]);
  if (theme === "dark") return true;
  if (theme === "light") return false;
  const p = where ?? FALLBACK_CENTER;
  return isDarkOut(p.lat, p.lon, new Date(now));
}
