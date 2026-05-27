/*
 * Rewarded-ad module.
 *
 * `showRewarded()` displays a single rewarded video. Resolves true ONLY
 * when the user completes the ad and earns the reward. Returns false
 * on dismiss, error, or any state that does NOT grant the reward —
 * the caller can then leave the hint locked without ambiguity. NEVER
 * throws an unhandled rejection (every native call is wrapped).
 *
 * Why separate from banner.ts: the banner is a long-lived background
 * view (init once, leave it up), while the rewarded ad is a transient
 * modal flow that the colour-by-number scene starts in response to a
 * user tap on the hint button.
 *
 * --- The "AdMob.then() not implemented" trap ---
 *
 * Capacitor's plugin proxy intercepts ALL property access on the
 * plugin object, including the standard `.then` property that
 * JavaScript uses to detect thenables. Returning the proxy from an
 * `async` function (e.g. `async function loadPlugin() { return AdMob }`)
 * makes the runtime treat AdMob as a thenable, call `AdMob.then(...)`,
 * which the proxy forwards to native — native has no `then` method
 * and the call rejects with `"AdMob.then() is not implemented on
 * android"`. That landed as an unhandled rejection and crashed the
 * Hint button. Fix: wrap the plugin in a plain object (`{ mod }`)
 * before returning it from any async function, and never await the
 * plugin proxy directly. We use `holder.mod.AdMob` at the call site
 * so the proxy is only ever used as a method receiver, never as a
 * thenable.
 *
 * Web/dev (no native AdMob): falls back to window.confirm so the rest
 * of the hint flow can be exercised end-to-end without a real ad.
 */

import { maskAdId, type AdMobConfig } from './env.js';
import { diagLog } from './error-overlay.js';

type AdMobModule = typeof import('@capacitor-community/admob');

interface CapacitorRuntime {
  isNativePlatform: () => boolean;
}

let cachedHolder: { mod: AdMobModule } | null = null;
let moduleLoadAttempted = false;
let cachedConfig: AdMobConfig | null = null;

/**
 * Cache the config the paint scene was booted with. main.ts calls this
 * once at boot.
 */
export function setRewardedConfig(config: AdMobConfig | null): void {
  cachedConfig = config;
}

function isNative(): boolean {
  const cap = (window as unknown as { Capacitor?: CapacitorRuntime }).Capacitor;
  return !!cap && cap.isNativePlatform();
}

/**
 * Lazy-import @capacitor-community/admob. The dynamic import keeps
 * the plugin out of the web bundle when no Capacitor runtime is
 * present (where the plugin proxy would no-op anyway). We wrap the
 * loaded module in `{ mod: ... }` so the AdMob proxy is never the
 * direct value of any awaited Promise — see the file header for the
 * "AdMob.then()" trap that motivated this.
 */
async function ensureHolder(): Promise<{ mod: AdMobModule } | null> {
  if (cachedHolder) return cachedHolder;
  if (moduleLoadAttempted) return null;
  moduleLoadAttempted = true;
  if (!isNative()) return null;
  try {
    const mod = await import(/* @vite-ignore */ '@capacitor-community/admob');
    cachedHolder = { mod: mod as unknown as AdMobModule };
    return cachedHolder;
  } catch (err) {
    diagLog(`hint: plugin import failed: ${(err as Error)?.message ?? String(err)}`);
    return null;
  }
}

/**
 * Show one rewarded ad. Resolves `true` iff the user completed it
 * and earned the reward.
 *
 * Flow:
 *   1. prepareRewardVideoAd — loads the creative
 *   2. showRewardVideoAd    — presents it; returns AdMobRewardItem
 *                              when the reward is earned, REJECTS on
 *                              dismiss / no-fill / error
 *   3. interpret return value (amount > 0 => reward earned)
 *
 * Every plugin call is awaited inside a try/catch so any failure
 * (network, no-fill, user dismiss, plugin proxy quirks) becomes a
 * `return false` rather than an uncaught rejection.
 */
export async function showRewarded(): Promise<boolean> {
  const config = cachedConfig;
  if (!config) {
    diagLog('hint: showRewarded() with no config — denying');
    return false;
  }

  if (!isNative()) {
    return webFallback(config.mode);
  }

  const holder = await ensureHolder();
  if (!holder) {
    diagLog('hint: native AdMob plugin unavailable — falling back to confirm');
    return webFallback(config.mode);
  }

  // Local reference. NEVER awaited directly — only used as a method
  // receiver for `AdMob.somethingAsync()`.
  const AdMob = holder.mod.AdMob;

  try {
    diagLog(
      `hint: prepare adId=${maskAdId(config.rewardedUnitId)} ` +
        `isTesting=${config.isTesting} mode=${config.mode} ` +
        `forceTesting=${config.forceTesting}`,
    );
    await AdMob.prepareRewardVideoAd({
      adId: config.rewardedUnitId,
      isTesting: config.isTesting,
    });
    diagLog('hint: show');
    const reward = await AdMob.showRewardVideoAd();
    const amount = reward && typeof reward.amount === 'number' ? reward.amount : 0;
    const type = reward && typeof reward.type === 'string' ? reward.type : '';
    const rewarded = amount > 0;
    diagLog(`hint: rewarded type=${type || '?'} amount=${amount} -> grant=${rewarded}`);
    return rewarded;
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    diagLog(`hint: dismissed/failed reason=${msg}`);
    return false;
  }
}

function webFallback(mode: AdMobConfig['mode']): boolean {
  const granted = window.confirm(
    `[${mode}] Rewarded ad placeholder.\n\nOK = grant reward (reveal hint).\nCancel = decline.`,
  );
  diagLog(`hint: web fallback confirm -> grant=${granted}`);
  return granted;
}
