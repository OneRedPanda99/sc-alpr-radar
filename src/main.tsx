import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "@/App";
import "@/styles.css";

/**
 * Reload once when a new service worker takes control.
 *
 * `registerType: "autoUpdate"` installs the new worker and activates it
 * (skipWaiting), but the already-loaded page keeps running the *old* bundle
 * until something reloads it — and the precached index.html points at the old
 * asset hashes. The practical effect is that a deploy silently doesn't arrive
 * until you happen to open the app twice, which reads as "the update broke
 * things" or "the feeds aren't updating".
 *
 * `hadController` has to be sampled now, at load: by the time
 * controllerchange fires, `controller` is already the new worker, so checking
 * it inside the handler can't tell a first install from an update — and
 * reloading on first install is a reload loop.
 */
if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
