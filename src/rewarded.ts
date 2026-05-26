/*
 * Rewarded-ad module.
 *
 * `showRewarded()` displays a single rewarded video. Resolves true ONLY
 * when the user completes the ad and earns the reward. Returns false
 * on dismiss, error, or any state that does NOT grant the reward —
 * the caller can then leave the hint locked without ambiguity.
 *
 * Why separate from banner.ts: the banner is a long-lived background
 * view (init once, leave it up), while the rewarded ad is a transient
 * modal flow that the colour-by-number scene starts in response to a
 * user tap on the hint button. Keeping them split keeps the API
 * surfaces obvious — the paint scene never has to think about banner
 * lifecycle, and main.ts never has to think about rewarded flow.
 *
 * Plugin is lazily imported behind a typeof guard so the web bundle
 * stays free of native code references. Web / dev / preview falls
 * back to `window.confirm` so the rest of the hint flow can be
 * exercised end-to-end without a real ad — the confirm dialog mirrors
 * the "earn / decline" decision the user faces in production.
 */

import type { AdMobConfig } from './env.js';

interface RewardItem {
  type: string;
  amount: number;
}

interface RewardedListener {
  remove: () => Promise<void>;
}

interface AdMobRewardedShape {
  prepareRewardVideoAd: (opts: { adId: string; isTesting?: boolean }) => Promise<void>;
  showRewardVideoAd: () => Promise<RewardItem | undefined>;
  addListener: (
    event:
      | 'onRewardedVideoAdReward'
      | 'onRewardedVideoAdDismissed'
      | 'onRewardedVideoAdFailedToLoad'
      | 'onRewardedVideoAdFailedToShow',
    cb: (info?: unknown) => void,
  ) => Promise<RewardedListener>;
}

interface CapacitorRuntime {
  isNativePlatform: () => boolean;
}

let cachedAdMob: AdMobRewardedShape | null = null;
let cachedConfig: AdMobConfig | null = null;

/**
 * Cache the config the paint scene was booted with. The scene calls
 * this once at mount and again on teardown (with null) so the module
 * never carries a stale config across scene swaps.
 */
export function setRewardedConfig(config: AdMobConfig | null): void {
  cachedConfig = config;
}

function isNative(): boolean {
  const cap = (window as unknown as { Capacitor?: CapacitorRuntime }).Capacitor;
  return !!cap && cap.isNativePlatform();
}

async function loadPlugin(): Promise<AdMobRewardedShape | null> {
  if (cachedAdMob) return cachedAdMob;
  try {
    const mod = await import(/* @vite-ignore */ '@capacitor-community/admob');
    cachedAdMob = mod.AdMob as unknown as AdMobRewardedShape;
    return cachedAdMob;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[Mozai] AdMob plugin missing — rewarded falls back to web confirm.', err);
    return null;
  }
}

/**
 * Show one rewarded ad. Resolves `true` iff the user completed it
 * and earned the reward.
 *
 * Behaviour map:
 *   - Native + plugin available + reward fires → true
 *   - Native + plugin available + ad dismissed without reward → false
 *   - Native + plugin available + load/show error → false (logged)
 *   - Native + plugin missing → web fallback (confirm)
 *   - Web / dev → confirm dialog ("Watch ad? OK = earn, Cancel = skip")
 *
 * Each call prepares a fresh rewarded — the underlying plugin caches
 * one creative at a time, so prepare-on-demand keeps the API simple
 * and the served creative recent.
 */
export async function showRewarded(): Promise<boolean> {
  const config = cachedConfig;
  if (!config) {
    // eslint-disable-next-line no-console
    console.warn('[Mozai] showRewarded() called without setRewardedConfig() — denying.');
    return false;
  }

  if (!isNative()) {
    return webFallback(config.mode);
  }

  const plugin = await loadPlugin();
  if (!plugin) {
    return webFallback(config.mode);
  }

  // Subscribe BEFORE show so we never miss the reward event. The
  // reward listener resolves the outer promise; the dismiss /
  // error listeners resolve it as false. The race is settled by
  // whichever event fires first.
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      Promise.all([
        rewardSub.then((s) => s.remove()).catch(() => undefined),
        dismissSub.then((s) => s.remove()).catch(() => undefined),
        loadFailSub.then((s) => s.remove()).catch(() => undefined),
        showFailSub.then((s) => s.remove()).catch(() => undefined),
      ]).finally(() => resolve(value));
    };

    const rewardSub = plugin.addListener('onRewardedVideoAdReward', () => settle(true));
    const dismissSub = plugin.addListener('onRewardedVideoAdDismissed', () => settle(false));
    const loadFailSub = plugin.addListener('onRewardedVideoAdFailedToLoad', (err) => {
      // eslint-disable-next-line no-console
      console.warn('[Mozai] rewarded ad failed to load', err);
      settle(false);
    });
    const showFailSub = plugin.addListener('onRewardedVideoAdFailedToShow', (err) => {
      // eslint-disable-next-line no-console
      console.warn('[Mozai] rewarded ad failed to show', err);
      settle(false);
    });

    plugin
      .prepareRewardVideoAd({ adId: config.rewardedUnitId, isTesting: config.mode === 'TEST' })
      .then(() => plugin.showRewardVideoAd())
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[Mozai] rewarded prepare/show threw', err);
        settle(false);
      });
  });
}

function webFallback(mode: AdMobConfig['mode']): boolean {
  // window.confirm is synchronous and blocking — fine for dev/preview
  // where the user is interacting in a browser. Wrapped in a runtime
  // check so a headless environment (e.g. tests later) can be detected
  // by replacing window.confirm.
  const granted = window.confirm(
    `[${mode}] Rewarded ad placeholder.\n\nOK = grant reward (reveal hint).\nCancel = decline.`,
  );
  return granted;
}
