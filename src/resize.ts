/*
 * Resize controller — engine-agnostic.
 *
 * Responsibility: keep the #play-canvas sized exactly to the #game
 * container box, on every device, orientation and viewport reflow.
 *
 *  • Single source of truth is `ResizeObserver(#game)`. We NEVER read
 *    the window layout-viewport height for play-area sizing —
 *    adaptive banners are NOT a fixed 50px and the layout viewport
 *    does not account for the `--banner-h` reservation. The grep
 *    gate in CI enforces this (see README for the gate command).
 *
 *  • Triggers that schedule a re-fit (all coalesced into one
 *    rAF-batched pass so a burst of events doesn't cause N relayouts):
 *      - ResizeObserver(#game)           — the main signal
 *      - visualViewport 'resize'/'scroll' — soft keyboard, address bar
 *      - window 'orientationchange'      — rotation
 *      - MutationObserver(style.--banner-h)
 *        via a custom CustomEvent('mozai:banner-height-changed')
 *        dispatched from banner.ts
 *
 *  • devicePixelRatio is applied to the canvas backing store (width /
 *    height attributes) while the CSS box stays at the logical size.
 *    Without this the canvas would blur on every modern phone.
 *
 *  • The renderer is a plain callback. The placeholder grid passes one
 *    in; later PRs (real colour-by-number renderer) will swap it.
 */

export interface FitInfo {
  /** Logical CSS pixels (what layout sees). */
  cssWidth: number;
  cssHeight: number;
  /** Backing-store pixels (canvas .width / .height — cssWidth * dpr, rounded). */
  pixelWidth: number;
  pixelHeight: number;
  /** devicePixelRatio at the time of the fit. */
  dpr: number;
}

export type Renderer = (info: FitInfo, canvas: HTMLCanvasElement) => void;

export interface ResizeController {
  /** Force an immediate re-fit. Use after layout-affecting state changes. */
  refit: () => void;
  /** Tear down all listeners — for HMR / tests. */
  dispose: () => void;
  /** Last fit info, or null before the first pass. Read-only snapshot. */
  current: () => FitInfo | null;
}

export interface AttachResizeOpts {
  game: HTMLElement;
  canvas: HTMLCanvasElement;
  render: Renderer;
  /**
   * Optional callback that fires after every successful fit. The
   * debug-readout overlay subscribes to this to print live metrics.
   */
  onFit?: (info: FitInfo) => void;
}

export function attachResize(opts: AttachResizeOpts): ResizeController {
  const { game, canvas, render, onFit } = opts;

  let last: FitInfo | null = null;
  let rafId = 0;
  let disposed = false;

  // Coalesce a burst of events into a single rAF-scheduled fit.
  const scheduleFit = () => {
    if (rafId !== 0 || disposed) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      if (disposed) return;
      runFit();
    });
  };

  const runFit = () => {
    // Read the live ResizeObserver-tracked box of #game. getBoundingClientRect
    // returns the *post-padding* content area + border which is what the
    // canvas's CSS box (width:100%; height:100%) actually fills.
    const rect = game.getBoundingClientRect();
    const cssWidth = Math.max(0, Math.floor(rect.width));
    const cssHeight = Math.max(0, Math.floor(rect.height));
    const dpr = window.devicePixelRatio || 1;
    // Round to integers — Chrome on Android will silently downsample a
    // sub-pixel-sized canvas backing store, which manifests as a 1px
    // gap on the bottom edge after rotation.
    const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
    const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));

    // Only mutate the canvas attributes if they actually changed —
    // setting canvas.width clears the bitmap, so a no-op fit during a
    // visualViewport scroll would wipe the rendered frame.
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

    const info: FitInfo = { cssWidth, cssHeight, pixelWidth, pixelHeight, dpr };
    last = info;
    render(info, canvas);
    if (onFit) onFit(info);
  };

  // --- triggers ---

  // 1. The main signal. ResizeObserver fires whenever #game's box
  // changes — including when --banner-h is updated (because
  // #game.height = calc(100dvh - var(--banner-h)) recomputes).
  const ro = new ResizeObserver(scheduleFit);
  ro.observe(game);

  // 2. visualViewport — covers soft keyboard, URL bar collapse, and
  // mobile zoom in/out. Both 'resize' and 'scroll' matter: scroll
  // fires when the keyboard pushes the viewport up without resizing
  // the layout viewport (iOS Safari case).
  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener('resize', scheduleFit);
    vv.addEventListener('scroll', scheduleFit);
  }

  // 3. Orientation change. ResizeObserver covers this in most cases,
  // but some Android WebView builds skip an RO callback during
  // rotation and only emit the window-level event.
  window.addEventListener('orientationchange', scheduleFit);

  // 4. Custom event from banner.ts whenever --banner-h is updated.
  // ResizeObserver will eventually fire from the layout reflow too,
  // but the explicit event guarantees the fit happens in the same
  // frame so the player never sees a banner-sized gap.
  const onBannerHeightChanged = () => scheduleFit();
  window.addEventListener('mozai:banner-height-changed', onBannerHeightChanged);

  // First pass — synchronous so the placeholder paints on the first
  // frame instead of after a microtask.
  runFit();

  return {
    refit: runFit,
    current: () => last,
    dispose: () => {
      disposed = true;
      if (rafId !== 0) cancelAnimationFrame(rafId);
      ro.disconnect();
      if (vv) {
        vv.removeEventListener('resize', scheduleFit);
        vv.removeEventListener('scroll', scheduleFit);
      }
      window.removeEventListener('orientationchange', scheduleFit);
      window.removeEventListener('mozai:banner-height-changed', onBannerHeightChanged);
    },
  };
}
