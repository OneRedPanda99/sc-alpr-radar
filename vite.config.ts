import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath, URL } from "node:url";

// Served from a subpath on GitHub Pages (…/sc-alpr-radar/) but also works at root.
// Override with BASE_PATH env at build time if hosting elsewhere.
const base = process.env.BASE_PATH ?? "./";

export default defineConfig({
  base,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "icon.svg", "brands/*.svg", ".nojekyll"],
      manifest: {
        name: "SC ALPR Radar",
        short_name: "ALPR Radar",
        description:
          "South Carolina ALPR camera awareness and camera-avoidance routing (DeFlock/OSM data).",
        theme_color: "#0b1220",
        background_color: "#0b1220",
        display: "standalone",
        orientation: "portrait",
        icons: [
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" },
        ],
      },
      workbox: {
        // Activate a new build immediately instead of waiting for all tabs to
        // close, and drop stale precaches. Prevents users being stuck on an old
        // version after a deploy.
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // NOTE: geojson is intentionally excluded from precache. It is large and
        // served by a CDN that can briefly 503 right after a deploy; a failed
        // precache would abort the whole service-worker install. It is cached at
        // runtime on first load instead (rule below), which still enables offline.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
        // Camera data + basemap tiles: cache-first so drives work offline.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.endsWith("sc-cameras.geojson"),
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "alpr-data",
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            urlPattern: ({ url }) =>
              url.host.includes("basemaps") ||
              url.host.includes("tile") ||
              url.host.includes("openstreetmap") ||
              url.host.includes("openfreemap") ||
              url.host.includes("carto"),
            handler: "CacheFirst",
            options: {
              cacheName: "basemap-tiles",
              expiration: { maxEntries: 5000, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
});
