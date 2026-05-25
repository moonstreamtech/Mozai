/*
 * Debug readout overlay.
 *
 * Enabled by MOZAI_DEBUG=1 at build time. Prints live values for the
 * four metrics the acceptance criteria call out:
 *
 *   visualViewport.height  (logical CSS px)
 *   --banner-h             (logical CSS px)
 *   #game height           (logical CSS px)
 *   dpr                    (devicePixelRatio)
 *
 * The acceptance criterion `#game.height == visualViewport.height -
 * --banner-h` is asserted by eyeballing this readout on device. We
 * also flag a mismatch larger than 1 device pixel (dpr-aware) so you
 * can spot drift at a glance.
 */

import type { FitInfo } from './resize.js';

export interface DebugReadoutHandle {
  /** Push fresh metrics on every fit pass. */
  update: (info: FitInfo) => void;
  /** Push the banner-h value when banner.ts sets it. */
  bannerHeightChanged: (totalPx: number) => void;
}

export function mountDebugReadout(host: HTMLElement): DebugReadoutHandle {
  host.hidden = false;

  let lastBannerH = parsePxVar('--banner-h');

  const render = (info: FitInfo) => {
    // visualViewport is universal on Android WebView / iOS WKWebView
    // (every Capacitor 6+ target). On the off chance it is missing,
    // print NaN rather than falling back to a layout-viewport read —
    // the readout is diagnostic, and we would rather notice a missing
    // visualViewport than mask it with a stale number.
    const vvh = window.visualViewport?.height ?? NaN;
    const bannerH = lastBannerH;
    const gameH = info.cssHeight;
    // dpr-tolerant mismatch detection. visualViewport height is the
    // browser's CSS-px count of the visual viewport; #game height +
    // banner reservation should equal it within 1 dpr-pixel rounding.
    const expected = vvh - bannerH;
    const drift = Math.abs(gameH - expected);
    const driftFlag = drift > 1 / info.dpr ? '  <-- DRIFT' : '';
    host.textContent =
      `vv.h    ${fmt(vvh)}\n` +
      `bannerH ${fmt(bannerH)}\n` +
      `#game.h ${fmt(gameH)}${driftFlag}\n` +
      `dpr     ${info.dpr.toFixed(2)}\n` +
      `canvas  ${info.pixelWidth} x ${info.pixelHeight}`;
  };

  return {
    update: render,
    bannerHeightChanged: (totalPx) => {
      lastBannerH = totalPx;
    },
  };
}

function parsePxVar(name: string): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

function fmt(n: number): string {
  return n.toFixed(1).padStart(7, ' ');
}
