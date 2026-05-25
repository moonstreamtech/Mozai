/*
 * Build-time configuration. All values come from Vite env vars
 * (prefix MOZAI_) which are populated from GitHub Secrets at CI
 * time and from a developer-local `.env` for manual builds.
 *
 * Mirrors Last Tile's approach: real ids come from secrets, test ids
 * are used as a fallback so dev and CI never serve real ads. The mode
 * (`PRODUCTION` vs `TEST`) is logged at startup; the actual id values
 * are not.
 *
 * On the Capacitor side the AdMob "app id" is wired into the native
 * AndroidManifest via a manifest placeholder set at build time; the
 * value here is informational only (for the startup log and the debug
 * readout).
 */

// Google's official AdMob test ids. Documented at
// https://developers.google.com/admob/android/test-ads. Identifiable
// by the "ca-app-pub-3940256099942544" publisher prefix, which the CI
// post-build scan greps for to prevent test ids landing in a release
// artifact.
export const ADMOB_TEST_PUBLISHER_PREFIX = 'ca-app-pub-3940256099942544';
export const ADMOB_TEST_APP_ID = `${ADMOB_TEST_PUBLISHER_PREFIX}~3347511713`;
export const ADMOB_TEST_BANNER_UNIT_ID = `${ADMOB_TEST_PUBLISHER_PREFIX}/6300978111`;

type Mode = 'PRODUCTION' | 'TEST';

export interface AdMobConfig {
  appId: string;
  bannerUnitId: string;
  mode: Mode;
}

/**
 * Read the AdMob configuration from build-time env. Empty / missing
 * values fall back to the official Google test ids.
 */
export function readAdMobConfig(): AdMobConfig {
  const envAppId = (import.meta.env.MOZAI_ADMOB_APP_ID ?? '').trim();
  const envBanner = (import.meta.env.MOZAI_ADMOB_BANNER_UNIT_ID ?? '').trim();
  const haveReal = envAppId !== '' && envBanner !== '';
  return {
    appId: haveReal ? envAppId : ADMOB_TEST_APP_ID,
    bannerUnitId: haveReal ? envBanner : ADMOB_TEST_BANNER_UNIT_ID,
    mode: haveReal ? 'PRODUCTION' : 'TEST',
  };
}

/**
 * Debug-readout toggle. Set MOZAI_DEBUG=1 in .env (or pass
 * --define:MOZAI_DEBUG=1) to enable the on-screen metrics panel.
 */
export function isDebugReadoutEnabled(): boolean {
  return import.meta.env.MOZAI_DEBUG === '1' || import.meta.env.MOZAI_DEBUG === 'true';
}
