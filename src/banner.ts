/*
 * AdMob banner module.
 *
 * Why this exists at all (the bug we are pre-empting from day one):
 *   The AdMob banner on Capacitor / Cordova is a NATIVE view overlaid
 *   ON TOP of the WebView. It does NOT push web content up the way a
 *   DOM element would. Adaptive banners are also NOT a fixed 50px —
 *   the height is device-dependent (anything from ~50 to ~120dp). If
 *   the web layout assumes a fixed height or reads the layout
 *   viewport height directly, the bottom of the play area ends up
 *   hidden under the banner.
 *
 * Contract enforced by this module:
 *   1. Call `initBanner({...})` exactly once at app start.
 *   2. The module shows an anchored adaptive banner pinned to the
 *      bottom of the screen, full width, edge-to-edge.
 *   3. After every load / resize event from the SDK, the module
 *      writes the real banner height (plus the bottom safe-area inset)
 *      into the `--banner-h` CSS variable on :root and dispatches the
 *      `mozai:banner-height-changed` event so resize.ts can re-fit
 *      the play canvas in the same frame.
 *   4. On web / preview (no native plugin available), a DOM
 *      placeholder strip is rendered into #banner with the exact same
 *      reserved height as the native banner would occupy on a typical
 *      phone, so the web layout matches device layout for development.
 *
 * Architectural note on the LastTile fork: Last Tile is native
 * Android / Jetpack Compose, so it reads the banner height directly
 * from `AdView.getAdSize()` and reserves it via a Compose `height`
 * modifier. The web port mirrors this using `--banner-h` because
 * the WebView cannot itself observe the native AdMob view. The
 * Capacitor AdMob plugin's `bannerSize` event is the bridge.
 */

import type { AdMobConfig } from './env.js';

// --- Plugin loading ---
//
// We import the AdMob plugin lazily and behind a typeof guard so the
// web build (which has no Capacitor runtime) doesn't blow up. The
// plugin only exposes a meaningful implementation when the runtime is
// a native shell.
interface BannerSizeInfo {
  width: number;
  height: number;
}

interface AdMobPluginShape {
  initialize: (opts?: { testingDevices?: string[]; initializeForTesting?: boolean }) => Promise<void>;
  showBanner: (opts: {
    adId: string;
    adSize: 'ADAPTIVE_BANNER' | 'BANNER' | 'FULL_BANNER';
    position: 'TOP_CENTER' | 'CENTER' | 'BOTTOM_CENTER';
    margin: number;
    isTesting?: boolean;
  }) => Promise<void>;
  addListener: (
    event: string,
    cb: (info: BannerSizeInfo) => void,
  ) => Promise<{ remove: () => Promise<void> }>;
}

interface CapacitorRuntime {
  isNativePlatform: () => boolean;
  getPlatform: () => string;
}

// Compute the bottom safe-area inset (px) from the rendered DOM. We
// create a temporary element with `padding-bottom: env(...)`, measure,
// and remove. Works on every browser; on platforms with no safe-area
// it just returns 0.
function readBottomSafeAreaPx(): number {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;padding-bottom:env(safe-area-inset-bottom,0px);';
  document.body.appendChild(probe);
  const px = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
  probe.remove();
  return px;
}

/**
 * Writes the new banner height (in CSS pixels — what layout sees)
 * into --banner-h, including the bottom safe-area inset, and notifies
 * the resize controller so it can re-fit in the same frame.
 *
 * Pass 0 to hide the band entirely (e.g. on banner error if you choose
 * to collapse — currently we keep the band reserved so the user never
 * sees the layout jump).
 */
function setBannerHeightCss(heightPx: number): void {
  const safeBottom = readBottomSafeAreaPx();
  const totalPx = Math.max(0, Math.round(heightPx + safeBottom));
  document.documentElement.style.setProperty('--banner-h', `${totalPx}px`);
  // Fire the explicit event so resize.ts re-fits in the same frame.
  // ResizeObserver(#game) will also see the calc() recompute and
  // schedule its own pass, but the event makes the chain deterministic.
  window.dispatchEvent(
    new CustomEvent('mozai:banner-height-changed', {
      detail: { totalPx, bannerPx: Math.round(heightPx), safeBottomPx: Math.round(safeBottom) },
    }),
  );
}

export interface InitBannerOpts {
  config: AdMobConfig;
  /** #banner element — used for the web placeholder strip. */
  bannerEl: HTMLElement;
}

export interface BannerHandle {
  /** PRODUCTION vs TEST (matches AdMobConfig.mode). */
  mode: AdMobConfig['mode'];
  /** 'native' = AdMob plugin active; 'web' = DOM placeholder strip. */
  runtime: 'native' | 'web';
}

export async function initBanner(opts: InitBannerOpts): Promise<BannerHandle> {
  const { config, bannerEl } = opts;

  // Detect Capacitor runtime without statically importing the plugin
  // (so the web bundle stays lean and doesn't try to load native code).
  const cap = (window as unknown as { Capacitor?: CapacitorRuntime }).Capacitor;
  const isNative = !!cap && cap.isNativePlatform();

  if (!isNative) {
    // --- Web / dev fallback ---
    //
    // Reserve a band that matches the typical anchored adaptive banner
    // height on a phone (~60dp). Just enough that the dev experience
    // matches the device experience — the colour-by-number canvas
    // will never paint into this band even before native AdMob loads.
    bannerEl.classList.add('web-placeholder');
    bannerEl.textContent = `AdMob banner placeholder (${config.mode})`;
    setBannerHeightCss(60);
    // eslint-disable-next-line no-console
    console.info(`[Mozai] Banner runtime: WEB (placeholder strip). AdMob mode: ${config.mode}`);
    return { mode: config.mode, runtime: 'web' };
  }

  // --- Native (Android / iOS) ---
  let plugin: AdMobPluginShape;
  try {
    // Lazy import keeps the web bundle free of the native binding.
    // The dynamic specifier silences Vite's static-import-only warning.
    const mod = await import(/* @vite-ignore */ '@capacitor-community/admob');
    plugin = mod.AdMob as unknown as AdMobPluginShape;
  } catch (err) {
    // Treat a missing plugin on native as a fatal-but-non-crashing
    // condition: log and degrade to the web placeholder so the
    // foundation app still launches.
    // eslint-disable-next-line no-console
    console.warn('[Mozai] AdMob plugin missing on native — falling back to placeholder.', err);
    bannerEl.classList.add('web-placeholder');
    bannerEl.textContent = 'AdMob plugin missing';
    setBannerHeightCss(60);
    return { mode: config.mode, runtime: 'web' };
  }

  // Initialise SDK. `initializeForTesting` ensures every device
  // behaves as a test device so we never accidentally bill a real
  // impression during development. It's true when EITHER (a) we're
  // falling back to test placement ids (mode === 'TEST') OR (b) the
  // explicit MOZAI_ADMOB_TESTING flag is set on a real-ids build
  // (developer running QA on their personal phone). When both are
  // off — i.e. a real production build — initializeForTesting is
  // omitted so live ads are served normally.
  await plugin.initialize(config.isTesting ? { initializeForTesting: true } : {});

  // Subscribe BEFORE showBanner so we never miss the first size event.
  // The plugin emits the event with the rendered height in CSS pixels
  // (already DPR-divided), so we can write it straight into --banner-h.
  await plugin.addListener('bannerSize', (info: BannerSizeInfo) => {
    setBannerHeightCss(info.height);
  });

  try {
    await plugin.showBanner({
      adId: config.bannerUnitId,
      adSize: 'ADAPTIVE_BANNER',
      position: 'BOTTOM_CENTER',
      margin: 0,
      isTesting: config.isTesting,
    });
    // eslint-disable-next-line no-console
    console.info(`[Mozai] Banner runtime: NATIVE (anchored adaptive). AdMob mode: ${config.mode}`);
  } catch (err) {
    // Common case: device has no Play Services. Keep the band
    // reserved at the safe-area-only default so the play area still
    // sits above the gesture nav handle.
    // eslint-disable-next-line no-console
    console.warn('[Mozai] showBanner failed — keeping safe-area-only reservation.', err);
  }

  return { mode: config.mode, runtime: 'native' };
}
