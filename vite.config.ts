import { defineConfig } from 'vite';

// Vite output goes to ./dist, which Capacitor copies into the Android assets
// on `cap sync` (webDir in capacitor.config.ts).
//
// base: './' is the safety belt for Capacitor — emits relative paths in
// the built index.html (`./assets/...`) and in any other build-time URL
// rewrites. The Capacitor WebView serves the bundled assets from a
// custom origin (e.g. https://localhost on Android) and absolute paths
// (`/assets/...`) DO usually resolve correctly there, but switching to
// relative removes a class of "works on dev server, blank screen on
// device" failures where the WebView's base URL doesn't match what
// `/` was meant to resolve to.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
  },
  server: {
    host: true,
    port: 5173,
  },
  // Accept both prefixes: MOZAI_ for product config (ad ids, debug
  // readout) and VITE_ for ephemeral / build-flag style toggles like
  // VITE_BOOT_DEBUG that we don't want to bake into the long-term
  // MOZAI_ namespace.
  envPrefix: ['MOZAI_', 'VITE_'],
});
