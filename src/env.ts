/*
 * Build-time AdMob configuration.
 *
 * Two per-placement ad-unit IDs come from Vite env vars (prefix
 * MOZAI_), which are populated from GitHub Secrets at CI time and
 * from a developer-local `.env` for manual builds:
 *
 *   MOZAI_ADMOB_BANNER_ID    — anchored adaptive banner unit
 *   MOZAI_ADMOB_REWARDED_ID  — rewarded video unit (Hint button)
 *
 * The AdMob App ID itself is HARDCODED in
 * android/app/src/main/AndroidManifest.xml — it's a stable per-app
 * identifier issued by the AdMob console and doesn't vary across
 * builds.
 *
 * When either ad-unit env var is missing, we fall back to Google's
 * official AdMob test ids for that placement so dev and CI never
 * serve real ads. The `mode` is promoted to REAL only when BOTH
 * placement env vars are present.
 *
 *   MOZAI_ADMOB_TESTING — independent of `mode`. When set ("1" /
 *     "true"), forces test-creative behaviour (`isTesting: true`
 *     on every plugin call + `initializeForTesting`) EVEN when
 *     real placement IDs are configured. This is the "I'm
 *     developing on my own phone, please don't ban my AdMob
 *     account for tapping my own ads" switch — real IDs serve
 *     test creatives.
 *
 * Mode matrix:
 *   ids=REAL, testing=false  — production
 *   ids=REAL, testing=true   — real placements, test creatives (dev)
 *   ids=TEST, testing=*      — test placements, always test creatives
 */

// Google's official AdMob test ids. Documented at
// https://developers.google.com/admob/android/test-ads. Identifiable
// by the "ca-app-pub-3940256099942544" publisher prefix, which the
// CI post-build scan greps for to prevent test ids landing in a
// release artifact.
export const ADMOB_TEST_PUBLISHER_PREFIX = 'ca-app-pub-3940256099942544';
export const ADMOB_TEST_BANNER_UNIT_ID = `${ADMOB_TEST_PUBLISHER_PREFIX}/6300978111`;
// Rewarded-video test id — separate AdMob unit type. The banner
// test id does NOT work for rewarded format.
export const ADMOB_TEST_REWARDED_UNIT_ID = `${ADMOB_TEST_PUBLISHER_PREFIX}/5224354917`;

/**
 * AdMob test-device IDs. Devices in this list receive TEST creatives
 * even in production builds that use real ad unit IDs — the AdMob
 * SDK's intended developer workflow for "I want to install the
 * production APK on my own phone without risking real-ad clicks
 * against my own account."
 *
 * How to add your device:
 *   1. Install the APK once with this array empty.
 *   2. Run `adb logcat -s Ads` and look for a line like
 *        Use AdRequest.Builder.addTestDevice("33BE2250B43518CC...")
 *        to get test ads on this device.
 *      The hex string is your device's test ID.
 *   3. Append it to TEST_DEVICE_IDS below, rebuild, reinstall.
 *
 * Account-level test devices configured in the AdMob console
 * (Settings → Test devices) are an alternative — those don't need
 * a code change, but require dashboard access. The TEST_DEVICE_IDS
 * array is the repository-tracked equivalent.
 *
 * NOTE: not secrets — IDs identify a device, not an account.
 */
export const TEST_DEVICE_IDS: string[] = [
  // Add device IDs here (one per developer device that should
  // always serve test creatives in release builds).
];

/**
 * Live CDN base for puzzle content that isn't bundled with the APK
 * (rooms 2+). The folder layout mirrors the app's local
 * `public/content/` 1:1, so any path under `roomN/...` on the CDN
 * resolves to the same `roomN/...` the bundled version would have
 * shipped.
 *
 *   https://moonstreamtech.com/mozai-content/roomN/<id>.json
 *   https://moonstreamtech.com/mozai-content/roomN/thumbs.json
 *
 * There is NO `index.json` on the CDN — `index.json` is always read
 * from the bundled assets so the boot path needs zero network. See
 * src/content-resolver.ts for the bundled-vs-cache-vs-network
 * resolution.
 *
 * Trailing slash is required for the joinUrl() in the resolver to
 * produce clean absolute URLs.
 */
export const CDN_BASE = 'https://moonstreamtech.com/mozai-content/';

type Mode = 'REAL' | 'TEST';

export interface AdMobConfig {
  bannerUnitId: string;
  rewardedUnitId: string;
  /** REAL if both real placement ids are configured; TEST otherwise. */
  mode: Mode;
  /**
   * Force every plugin call to behave as a test request, regardless
   * of `mode`. Lets us run real IDs against test creatives during
   * device QA.
   */
  forceTesting: boolean;
  /** Convenience: forceTesting || mode === 'TEST'. The boolean every plugin call needs. */
  isTesting: boolean;
}

function envFlag(value: string | undefined): boolean {
  if (!value) return false;
  return value !== '0' && value !== 'false' && value !== '';
}

export function readAdMobConfig(): AdMobConfig {
  const envBanner = (import.meta.env.MOZAI_ADMOB_BANNER_ID ?? '').trim();
  const envRewarded = (import.meta.env.MOZAI_ADMOB_REWARDED_ID ?? '').trim();
  const haveReal = envBanner !== '' && envRewarded !== '';
  const forceTesting = envFlag(import.meta.env.MOZAI_ADMOB_TESTING);
  const mode: Mode = haveReal ? 'REAL' : 'TEST';
  return {
    bannerUnitId: haveReal ? envBanner : ADMOB_TEST_BANNER_UNIT_ID,
    rewardedUnitId: haveReal ? envRewarded : ADMOB_TEST_REWARDED_UNIT_ID,
    mode,
    forceTesting,
    isTesting: forceTesting || mode === 'TEST',
  };
}

/**
 * Mask an ad-unit id for diag logs: keep the publisher prefix
 * visible (it's not secret — it's the same for every placement under
 * one publisher) and the trailing 10 chars, hide the middle. The
 * result still tells us "this is the real publisher 6334… vs the
 * test publisher 3940…" without leaking the entire unit id to
 * whoever can read the device's debug popup.
 */
export function maskAdId(id: string): string {
  if (!id) return '(empty)';
  if (id.length <= 20) return id;
  // ca-app-pub-XXXX…/YYYYYYYYYY
  return `${id.slice(0, 15)}…${id.slice(-10)}`;
}

/**
 * Debug-readout toggle. Set MOZAI_DEBUG=1 in .env (or pass
 * --define:MOZAI_DEBUG=1) to enable the on-screen metrics panel.
 */
export function isDebugReadoutEnabled(): boolean {
  return import.meta.env.MOZAI_DEBUG === '1' || import.meta.env.MOZAI_DEBUG === 'true';
}
