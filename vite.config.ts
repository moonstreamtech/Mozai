import { defineConfig } from 'vite';

// Vite output goes to ./dist, which Capacitor copies into the Android assets
// on `cap sync` (webDir in capacitor.config.ts).
export default defineConfig({
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
  envPrefix: 'MOZAI_',
});
