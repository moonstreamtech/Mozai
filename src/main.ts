/*
 * Mozai entry. Wires the three foundation modules:
 *
 *   resize.ts          — keeps #play-canvas fitted to #game's box
 *   banner.ts          — shows the AdMob banner and reports its height
 *                        into --banner-h, which #game's calc() reads
 *   placeholder-grid.ts — temporary renderer that paints the grid;
 *                        replaced by the real colour-by-number renderer
 *                        in a later PR.
 *
 * No game logic lives here. The order matters: resize controller is
 * mounted BEFORE banner.ts so the first fit pass happens against the
 * safe-area-only default --banner-h, and banner.ts can then update
 * --banner-h once the SDK reports the real value (which triggers a
 * second fit via the mozai:banner-height-changed event).
 */

import { attachResize } from './resize.js';
import { makePlaceholderGrid } from './placeholder-grid.js';
import { initBanner } from './banner.js';
import { isDebugReadoutEnabled, readAdMobConfig } from './env.js';
import { mountDebugReadout } from './debug-readout.js';

function requireEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} — index.html out of sync with main.ts`);
  return el as T;
}

function boot(): void {
  const gameEl = requireEl<HTMLDivElement>('game');
  const canvasEl = requireEl<HTMLCanvasElement>('play-canvas');
  const bannerEl = requireEl<HTMLDivElement>('banner');
  const debugEl = requireEl<HTMLDivElement>('debug');

  const debug = isDebugReadoutEnabled() ? mountDebugReadout(debugEl) : null;

  const controller = attachResize({
    game: gameEl,
    canvas: canvasEl,
    render: makePlaceholderGrid(),
    onFit: (info) => debug?.update(info),
  });

  // Subscribe to banner-height events for the debug readout. The
  // resize controller is already listening for the same event for the
  // re-fit; this listener only updates the debug overlay's bannerH
  // mirror so the printed value matches what --banner-h was last
  // written with.
  if (debug) {
    window.addEventListener('mozai:banner-height-changed', (e: Event) => {
      const detail = (e as CustomEvent<{ totalPx: number }>).detail;
      debug.bannerHeightChanged(detail.totalPx);
      // Force one extra readout update so the new bannerH lands on
      // screen even on platforms where the chained ResizeObserver
      // fit doesn't fire a follow-up onFit (rare, but worth the
      // belt-and-braces).
      const current = controller.current();
      if (current) debug.update(current);
    });
  }

  const adConfig = readAdMobConfig();
  // eslint-disable-next-line no-console
  console.info(
    `[Mozai] Boot. AdMob mode: ${adConfig.mode} (test ids ${adConfig.mode === 'TEST' ? 'IN USE' : 'NOT USED'})`,
  );

  // Fire-and-forget. The banner will inform the resize controller
  // via the custom event once it knows its real height; nothing in
  // the foundation depends on the await.
  initBanner({ config: adConfig, bannerEl }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[Mozai] initBanner threw', err);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
