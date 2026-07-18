import { useEffect } from "react";

/** Keeps the screen awake while driving. No-op where unsupported. */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let sentinel: any = null;
    let released = false;

    const request = async () => {
      try {
        sentinel = await (navigator as any).wakeLock?.request("screen");
      } catch {
        // Ignored: user can keep the display on manually.
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible" && !released) void request();
    };

    void request();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      released = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void sentinel?.release?.();
    };
  }, [active]);
}
