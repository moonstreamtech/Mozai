/*
 * Paint scene renderer.
 *
 * Strategy: a SINGLE `ImageData`-backed offscreen canvas at the
 * puzzle's native pixel resolution (w x h, 1 ImageData pixel == 1
 * cell). The offscreen IS the source of truth for what every cell
 * currently LOOKS like:
 *
 *   - background cells (-1)               → transparent (RGBA 0,0,0,0)
 *   - filled cells                        → palette[i] RGBA
 *   - unfilled, hint-revealed cells       → silhouette grey RGBA
 *   - unfilled, not hinted                → transparent (the white
 *                                            canvas background shows
 *                                            through; gridlines on
 *                                            top distinguish the
 *                                            cell from the empty
 *                                            -1 field)
 *
 * Per-cell updates are O(1) — we poke 4 bytes into the buffer. Per
 * frame is also O(1) on the JS side: one `drawImage(offscreen, ...)`
 * call that asks the GPU/compositor to scale the rectangle by the
 * current zoom. `imageSmoothingEnabled = false` gives nearest-
 * neighbour scaling for crisp pixel-art rendering at every zoom.
 *
 * Frame composition (bottom → top):
 *   1. White fill of the visible canvas.
 *   2. Offscreen blit at the camera transform — paints palette
 *      colour on filled cells and silhouette grey on hint-revealed
 *      cells. -1 background and unfilled+no-hint cells stay
 *      transparent (white shows through).
 *   3. Light-grey gridlines on every PAINTABLE cell. Skipped at
 *      pxPerCell < 6 where they alias into noise.
 *   4. Per-cell faded MOZAI logo tile on every -1 BACKGROUND cell.
 *      Distinguishes the empty field from paintable cells at a
 *      glance. Skipped at pxPerCell < BG_LOGO_MIN_PX_PER_CELL where
 *      the tile is sub-pixel; the cell-colour contrast carries the
 *      visual at that zoom range.
 *   5. Selection outlines (only when a hint is unlocked).
 *   6. Minimap (when bound).
 *
 * This means a 1000x1000 puzzle stays smooth even at full zoom-out
 * because we never iterate cells in JS during a render — we just
 * blit a 1000x1000 RGBA buffer to a much smaller viewport, which is
 * a single GPU-accelerated operation. At zoomed-in views we DO
 * iterate the visible cell range (typically < 5000 cells) twice
 * — once for gridlines, once for background logo tiles — both
 * viewport-bounded, never grid-bounded.
 *
 * Memory: 1000x1000 RGBA = 4 MB for the offscreen. Plus the visible
 * canvas backing store (dpr * cssSize). Cheap on modern phones.
 */

import type { PaintState } from './paint-state.js';
import type { PaintPerfSink } from './paint-perf.js';

/**
 * Opacity of the per-cell MOZAI app-logo tile drawn on every -1
 * BACKGROUND cell. 0.15 is enough to clearly read "this is empty
 * space" without competing with the actual picture. Baked once
 * into a pre-faded offscreen at icon-load time so the per-frame
 * path is plain drawImage with no globalAlpha churn. Single
 * retune knob — bump up or down here.
 */
const BG_LOGO_OPACITY = 0.15;

/**
 * Below this many backing pixels per cell the logo tile is
 * sub-pixel and would just contribute noise. We skip the tile
 * pass entirely at that zoom; the cells render plain.
 */
const BG_LOGO_MIN_PX_PER_CELL = 12;

const SILHOUETTE_RGBA: [number, number, number, number] = [192, 200, 209, 255];

/**
 * Cap on the effective devicePixelRatio used for the MAIN paint-canvas
 * backing store. Very high-DPR phones (dpr 3+) blow the backing store
 * up to a size where the per-frame white fill + offscreen blit + deco
 * rebuild become fill-rate bound. 2.5 keeps nearest-neighbour pixel-art
 * crisp while cutting backing-store area to ~44% of a dpr-3 buffer.
 * Coordinate math (screenToCell, pan/zoom) is in CSS px and unaffected;
 * only the render resolution changes. Single tunable knob. The minimap
 * deliberately keeps full dpr (it is tiny, and minimapToWorld must agree
 * with its backing store) — only the big canvas is capped.
 */
const MAX_PAINT_DPR = 2.5;

// -------- Module-shared background-logo loader --------
//
// One image, one pre-faded offscreen canvas, shared by every
// PaintRenderer in the session. Loaded lazily on first use; while
// loading, callers register a callback (typically scheduleFrame)
// so they redraw once the asset is ready. A load failure leaves
// bgLogoFaded null and drawBackgroundLogos quietly no-ops — the
// tile is decorative, NOT load-bearing for gameplay.

let bgLogoFaded: HTMLCanvasElement | null = null;
let bgLogoLoadStarted = false;
const bgLogoOnLoadCallbacks: Array<() => void> = [];

function getBackgroundLogo(onLoad: () => void): HTMLCanvasElement | null {
  if (bgLogoFaded) return bgLogoFaded;
  bgLogoOnLoadCallbacks.push(onLoad);
  if (bgLogoLoadStarted) return null;
  bgLogoLoadStarted = true;
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext('2d');
    if (cx) {
      // Bake the alpha in once. Subsequent per-cell drawImage calls
      // can stay alpha-state-clean — important for the per-frame
      // visible-cell loop on huge grids.
      cx.globalAlpha = BG_LOGO_OPACITY;
      cx.drawImage(img, 0, 0);
      bgLogoFaded = c;
    }
    // Wake every renderer that was waiting.
    const cbs = bgLogoOnLoadCallbacks.splice(0);
    for (const cb of cbs) cb();
  };
  img.onerror = () => {
    // Stay un-loaded; tile pass becomes a no-op forever for this
    // session. Decorative loss only.
    bgLogoLoadStarted = false;
  };
  // Resolve relative to the document so the path works under both
  // the Vite dev server (root) and the Capacitor WebView origin
  // (https://localhost/). Vite copies public/mozai-icon.png to
  // dist/mozai-icon.png; Capacitor serves dist/ from the WebView
  // root, so the same URL works in production.
  img.src = new URL('mozai-icon.png', location.href).href;
  return null;
}

/**
 * True once the faded background-logo asset has loaded. The decoration
 * cache keys on this so it rebuilds the one time the logo pops in
 * (otherwise a puzzle opened before the asset loaded would never show
 * the watermark on a static camera).
 */
function isBackgroundLogoReady(): boolean {
  return bgLogoFaded !== null;
}

export interface Camera {
  /** Top-left visible cell coords (float — sub-cell pan is allowed). */
  offsetX: number;
  offsetY: number;
  /** CSS pixels per cell. */
  zoom: number;
}

export interface CameraLimits {
  minZoom: number;
  maxZoom: number;
}

export class PaintRenderer {
  readonly state: PaintState;
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** Offscreen at puzzle native resolution. */
  private readonly offscreen: HTMLCanvasElement;
  private readonly offscreenCtx: CanvasRenderingContext2D;
  private readonly offscreenData: ImageData;
  /** Pre-parsed RGBA per palette index. */
  private readonly paletteRgba: Uint8ClampedArray;
  /**
   * Pre-parsed grayscale (luminance) RGBA per palette index. Used by
   * the minimap offscreen so unpainted paintable cells render as a
   * faded silhouette in the palette's own greyscale — the player
   * sees progress as colour-fills-in-over-grayscale, mirroring the
   * room-interior thumb convention.
   */
  private readonly paletteRgbaGray: Uint8ClampedArray;
  /**
   * Parallel offscreen rendered for the minimap. Same w×h as the
   * main offscreen, but unpainted paintable cells render in their
   * palette's grayscale luminance (not transparent / not the main
   * canvas's silhouette grey). Lets the minimap show "discovery
   * progress" at a glance.
   */
  private readonly minimapOffscreen: HTMLCanvasElement;
  private readonly minimapOffscreenCtx: CanvasRenderingContext2D;
  private readonly minimapOffscreenData: ImageData;
  /** Frame coalescing. */
  private rafId = 0;

  /**
   * Optional diagnostic perf sink (paint-perf.ts). Null in production
   * (MOZAI_DEBUG off): draw() then pays only a single null check per
   * frame. When set, draw() reports its per-frame JS duration here.
   */
  perf: PaintPerfSink | null = null;

  camera: Camera = { offsetX: 0, offsetY: 0, zoom: 1 };

  /**
   * Currently selected palette index, or -1 for none. Drives the
   * inner-border "this colour goes here" overlay drawn in
   * drawSelectionOutlines(). Use setSelectedColor() to mutate —
   * direct assignment won't schedule a redraw.
   */
  selectedColor = -1;

  /**
   * Optional minimap canvas. When set, every draw() also paints a
   * scaled-down copy of the offscreen into this canvas with the
   * current viewport rectangle overlaid. Cleared by setMinimap(null).
   */
  private minimap: HTMLCanvasElement | null = null;
  private minimapCtx: CanvasRenderingContext2D | null = null;

  // ---- Cached viewport metrics (hoisted layout reads) ----
  // Refreshed ONLY on real size changes (refreshViewMetrics(), called
  // from the scene ResizeObserver + lazily on the first draw) — never
  // per pointermove or per frame. The hot paths (draw, clampCamera,
  // drawMinimap viewport rect) read these instead of touching
  // clientWidth / clientHeight / devicePixelRatio every event, so a
  // drag / pinch causes zero forced reflow.
  private viewCssW = 0;
  private viewCssH = 0;
  /** Effective (capped) dpr for the main canvas — see MAX_PAINT_DPR. */
  private viewDpr = 1;

  // ---- Decoration cache (gridlines + background-logo tiles) ----
  // These depend ONLY on the camera (zoom + pan) and the static puzzle
  // shape, NOT on which cells are painted. So during a paint stroke
  // (camera fixed) they are identical every frame — we render them ONCE
  // into this offscreen and blit it, skipping the per-visible-cell loops
  // that dominated the old per-frame cost. Rebuilt only when the camera /
  // backing-store size / logo-loaded state actually changes.
  private decoCanvas: HTMLCanvasElement | null = null;
  private decoCtx: CanvasRenderingContext2D | null = null;
  private decoZoom = NaN;
  private decoOffsetX = NaN;
  private decoOffsetY = NaN;
  private decoLogoReady = false;

  // ---- Minimap silhouette cache ----
  // The silhouette only changes when a CELL is painted, never on
  // pan/zoom. Cache the scaled silhouette; per frame just blit it +
  // stroke the (cheap, moving) "you are here" viewport rect.
  private minimapCache: HTMLCanvasElement | null = null;
  private minimapCacheCtx: CanvasRenderingContext2D | null = null;
  private minimapCacheDirty = true;

  constructor(canvas: HTMLCanvasElement, state: PaintState) {
    this.canvas = canvas;
    this.state = state;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;

    this.offscreen = document.createElement('canvas');
    this.offscreen.width = state.puzzle.w;
    this.offscreen.height = state.puzzle.h;
    const offCtx = this.offscreen.getContext('2d', { willReadFrequently: false });
    if (!offCtx) throw new Error('Offscreen canvas 2D context unavailable');
    this.offscreenCtx = offCtx;
    this.offscreenData = offCtx.createImageData(state.puzzle.w, state.puzzle.h);

    // Parallel offscreen for the minimap: same w×h, different per-
    // cell colour rule (grayscale unpainted vs true-colour painted)
    // so the minimap shows discovery progress at a glance.
    this.minimapOffscreen = document.createElement('canvas');
    this.minimapOffscreen.width = state.puzzle.w;
    this.minimapOffscreen.height = state.puzzle.h;
    const mmCtx = this.minimapOffscreen.getContext('2d', { willReadFrequently: false });
    if (!mmCtx) throw new Error('Minimap offscreen canvas 2D context unavailable');
    this.minimapOffscreenCtx = mmCtx;
    this.minimapOffscreenData = mmCtx.createImageData(state.puzzle.w, state.puzzle.h);

    this.paletteRgba = parsePalette(state.puzzle.palette);
    this.paletteRgbaGray = parsePaletteGray(state.puzzle.palette);

    this.rebuildBuffer();
    // Best-effort first read; the canvas may not be laid out yet (CSS
    // sizing lands after mount). draw() refreshes lazily when the cache
    // is still empty, and the scene's ResizeObserver refreshes on every
    // real size change thereafter.
    this.refreshViewMetrics();
  }

  /**
   * Re-read the canvas CSS box + devicePixelRatio and cache them. This
   * is the ONLY place the renderer touches layout-reading DOM APIs, and
   * it is called from cold paths only (construct + the scene's
   * ResizeObserver + a lazy first-frame read) — NEVER per pointermove
   * or per frame. Returns true if the cached box is non-empty.
   */
  refreshViewMetrics(): boolean {
    this.viewCssW = this.canvas.clientWidth;
    this.viewCssH = this.canvas.clientHeight;
    this.viewDpr = Math.min(window.devicePixelRatio || 1, MAX_PAINT_DPR);
    return this.viewCssW > 0 && this.viewCssH > 0;
  }

  /**
   * Walk every cell once and populate BOTH offscreen buffers (the
   * main paint-canvas one and the minimap one). Called at boot and
   * after restoring saved state. Cheap for any size (2 × 1M pixel
   * touches at ~5 ns each ≈ 10 ms even on 1000×1000).
   *
   * Main offscreen rules:
   *   -1 → transparent | painted → palette | hint → silhouette grey
   *   | unpainted+no-hint → transparent
   *
   * Minimap offscreen rules:
   *   -1 → transparent | painted → palette
   *   | unpainted (regardless of hint) → palette grayscale luminance
   * The minimap deliberately ignores hint reveal: the minimap shows
   * "discovery progress" (colour fills in over grayscale), not the
   * main canvas's silhouette/hint state.
   */
  rebuildBuffer(): void {
    const { solution, filled, hintRevealed } = this.state;
    const data = this.offscreenData.data;
    const mmData = this.minimapOffscreenData.data;
    for (let i = 0; i < solution.length; i++) {
      const v = solution[i];
      const p = i * 4;
      if (v < 0) {
        // Both buffers: transparent.
        data[p] = 0;
        data[p + 1] = 0;
        data[p + 2] = 0;
        data[p + 3] = 0;
        mmData[p] = 0;
        mmData[p + 1] = 0;
        mmData[p + 2] = 0;
        mmData[p + 3] = 0;
      } else if (filled[i]) {
        // Both buffers: true palette colour.
        const pp = v * 4;
        data[p] = this.paletteRgba[pp];
        data[p + 1] = this.paletteRgba[pp + 1];
        data[p + 2] = this.paletteRgba[pp + 2];
        data[p + 3] = this.paletteRgba[pp + 3];
        mmData[p] = this.paletteRgba[pp];
        mmData[p + 1] = this.paletteRgba[pp + 1];
        mmData[p + 2] = this.paletteRgba[pp + 2];
        mmData[p + 3] = this.paletteRgba[pp + 3];
      } else {
        // Unfilled. Main canvas: silhouette grey only if hinted,
        // else transparent. Minimap: always grayscale of palette
        // colour so the silhouette stays visible there regardless
        // of hint state.
        const pp = v * 4;
        mmData[p] = this.paletteRgbaGray[pp];
        mmData[p + 1] = this.paletteRgbaGray[pp + 1];
        mmData[p + 2] = this.paletteRgbaGray[pp + 2];
        mmData[p + 3] = this.paletteRgbaGray[pp + 3];
        if (hintRevealed.has(v)) {
          data[p] = SILHOUETTE_RGBA[0];
          data[p + 1] = SILHOUETTE_RGBA[1];
          data[p + 2] = SILHOUETTE_RGBA[2];
          data[p + 3] = SILHOUETTE_RGBA[3];
        } else {
          // Unfilled, not hinted — transparent on the main canvas.
          // The white canvas background shows through; gridlines on
          // top distinguish each cell. Per-cell background-logo
          // tiles (drawn over -1 cells only) make the empty field
          // visibly different from this paintable-but-empty state.
          data[p] = 0;
          data[p + 1] = 0;
          data[p + 2] = 0;
          data[p + 3] = 0;
        }
      }
    }
    this.offscreenCtx.putImageData(this.offscreenData, 0, 0);
    this.minimapOffscreenCtx.putImageData(this.minimapOffscreenData, 0, 0);
    this.minimapCacheDirty = true;
  }

  /**
   * Mark cell `i` as freshly filled — update BOTH offscreens (main +
   * minimap) and schedule a frame. The minimap offscreen transitions
   * the cell from grayscale → true colour at the same instant the
   * main canvas transitions from transparent/silhouette → true
   * colour, so progress on both renders synchronously.
   */
  updateCellFilled(i: number): void {
    const v = this.state.solution[i];
    if (v < 0) return;
    const data = this.offscreenData.data;
    const mmData = this.minimapOffscreenData.data;
    const p = i * 4;
    const pp = v * 4;
    const r = this.paletteRgba[pp];
    const g = this.paletteRgba[pp + 1];
    const b = this.paletteRgba[pp + 2];
    const a = this.paletteRgba[pp + 3];
    data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = a;
    mmData[p] = r; mmData[p + 1] = g; mmData[p + 2] = b; mmData[p + 3] = a;
    // Single-cell partial putImageData is far cheaper than re-
    // uploading the whole buffer (puts only 4 bytes).
    const cx = i % this.state.puzzle.w;
    const cy = Math.floor(i / this.state.puzzle.w);
    this.offscreenCtx.putImageData(this.offscreenData, 0, 0, cx, cy, 1, 1);
    this.minimapOffscreenCtx.putImageData(this.minimapOffscreenData, 0, 0, cx, cy, 1, 1);
    // A cell changed → the minimap silhouette is stale. (The deco cache
    // is camera-keyed and unaffected by a fill, so it is NOT invalidated
    // here — that is exactly why a paint stroke stays loop-free.)
    this.minimapCacheDirty = true;
    this.scheduleFrame();
  }

  /**
   * After revealing a hint for one colour, repaint just that colour's
   * unfilled cells in silhouette grey. O(cells) — only acceptable
   * because it's user-initiated and rare (one ad per hint).
   */
  updateHintReveal(colorIdx: number): void {
    const { solution, filled } = this.state;
    const data = this.offscreenData.data;
    for (let i = 0; i < solution.length; i++) {
      if (solution[i] !== colorIdx) continue;
      if (filled[i]) continue;
      const p = i * 4;
      data[p] = SILHOUETTE_RGBA[0];
      data[p + 1] = SILHOUETTE_RGBA[1];
      data[p + 2] = SILHOUETTE_RGBA[2];
      data[p + 3] = SILHOUETTE_RGBA[3];
    }
    this.offscreenCtx.putImageData(this.offscreenData, 0, 0);
    this.scheduleFrame();
  }

  /** Re-render after a viewport / camera change. */
  /**
   * Change the selected colour and schedule a redraw if it actually
   * changed. Pass -1 to clear the selection (no outlines drawn).
   */
  setSelectedColor(idx: number): void {
    if (this.selectedColor === idx) return;
    this.selectedColor = idx;
    this.scheduleFrame();
  }

  scheduleFrame(): void {
    if (this.rafId !== 0) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      this.draw();
    });
  }

  /**
   * Bind (or clear) a minimap canvas. The renderer paints into it
   * on every frame: scaled offscreen + viewport rectangle overlay.
   * Pass null to detach (the canvas stays in the DOM but is no
   * longer updated). Caller is responsible for show/hide.
   */
  setMinimap(canvas: HTMLCanvasElement | null): void {
    this.minimap = canvas;
    this.minimapCtx = canvas ? canvas.getContext('2d') : null;
    // Force a silhouette re-render on (re)bind.
    this.minimapCacheDirty = true;
    if (canvas) this.scheduleFrame();
  }

  /**
   * Convert a minimap-local CSS coordinate to puzzle world cell
   * coordinates. Returns null when the point falls outside the
   * scaled puzzle area inside the minimap (e.g. letterboxing on
   * non-square puzzles). Used by minimap tap-to-pan.
   */
  minimapToWorld(cssX: number, cssY: number): { worldX: number; worldY: number } | null {
    const canvas = this.minimap;
    if (!canvas) return null;
    const dpr = window.devicePixelRatio || 1;
    const bsW = canvas.width;
    const bsH = canvas.height;
    if (bsW === 0 || bsH === 0) return null;
    const puzzleW = this.state.puzzle.w;
    const puzzleH = this.state.puzzle.h;
    const scale = Math.min(bsW / puzzleW, bsH / puzzleH);
    const drawnW = puzzleW * scale;
    const drawnH = puzzleH * scale;
    const offX = (bsW - drawnW) / 2;
    const offY = (bsH - drawnH) / 2;
    const px = cssX * dpr;
    const py = cssY * dpr;
    if (px < offX || px > offX + drawnW) return null;
    if (py < offY || py > offY + drawnH) return null;
    return {
      worldX: (px - offX) / scale,
      worldY: (py - offY) / scale,
    };
  }

  /**
   * Single-call render: one drawImage from offscreen at native
   * resolution into the visible canvas at the camera transform. The
   * compositor handles the scaling. We do clip to the visible
   * rectangle (so off-screen cells are never touched).
   *
   * Returns true if a frame was actually painted (canvas had a real
   * size); false otherwise. Callers can use this to schedule a
   * retry once layout has settled.
   *
   * Layer order (bottom → top):
   *   1. White background.
   *   2. Offscreen blit — fills paintable cells; -1 and unfilled+no-
   *      hint cells stay transparent so the white shows through.
   *   3. Gridlines on EVERY paintable cell. Drawn AFTER the blit so
   *      filled cells get a visible hairline border too — critical
   *      when cells are white or painted white. Skipped at
   *      pxPerCell < 6 where the lines alias into noise.
   *   4. Per-cell faded MOZAI logo tile on every -1 cell. The same
   *      viewport-bounded loop the gridlines use; skipped at
   *      pxPerCell < BG_LOGO_MIN_PX_PER_CELL where the tile is
   *      sub-pixel.
   *   5. Selection outlines (only when a hint is unlocked).
   *   6. Minimap.
   */
  draw(): boolean {
    // Perf timing brackets the whole draw body (incl. the minimap).
    // Off (null perf) → no performance.now() call at all.
    const perf = this.perf;
    const drawStart = perf ? performance.now() : 0;
    const { ctx, canvas, camera } = this;
    // CACHED metrics — no per-frame layout read. Prime them lazily on
    // the first frame (the canvas just got its CSS size); every real
    // resize thereafter refreshes via the scene's ResizeObserver.
    if (this.viewCssW === 0 || this.viewCssH === 0) this.refreshViewMetrics();
    const cssW = this.viewCssW;
    const cssH = this.viewCssH;
    if (cssW === 0 || cssH === 0) return false;
    const dpr = this.viewDpr;
    const bsW = Math.max(1, Math.round(cssW * dpr));
    const bsH = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== bsW) canvas.width = bsW;
    if (canvas.height !== bsH) canvas.height = bsH;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, bsW, bsH);

    ctx.imageSmoothingEnabled = false;

    const pxPerCell = camera.zoom * dpr;
    const dstX = -camera.offsetX * pxPerCell;
    const dstY = -camera.offsetY * pxPerCell;
    const dstW = this.state.puzzle.w * pxPerCell;
    const dstH = this.state.puzzle.h * pxPerCell;

    // One cheap GPU blit of the cached artwork raster at the camera
    // transform — already handles pan (translate) + zoom (scale).
    ctx.drawImage(this.offscreen, dstX, dstY, dstW, dstH);

    // Gridlines + background-logo tiles come from the camera-keyed deco
    // cache. On a paint stroke (camera fixed) this is a single blit with
    // NO per-cell loop; the loops run only when the cache is (re)built,
    // i.e. when the camera / size / logo-loaded state actually changed.
    const deco = this.ensureDecoCache(bsW, bsH, pxPerCell, dstX, dstY);
    if (deco) {
      ctx.drawImage(deco, 0, 0);
    } else {
      // Context-creation fallback: draw decorations live (pre-cache
      // behaviour). Correct, just not cached.
      this.drawGridlines(ctx, bsW, bsH, pxPerCell, dstX, dstY);
      this.drawBackgroundLogos(ctx, bsW, bsH, pxPerCell, dstX, dstY);
    }

    // Selection outlines depend on which cells are filled, so they
    // can't be cached across a paint stroke — draw them live onto the
    // main canvas. Cheap: gated on an unlocked hint + a current
    // selection, iterating only that one colour's visible cells.
    this.drawSelectionOutlines(ctx, bsW, bsH, pxPerCell, dstX, dstY);

    this.drawMinimap();

    // Record only frames that actually painted (the early cssW/cssH
    // bail above does not count as a frame).
    if (perf) perf.recordDraw(performance.now() - drawStart);
    return true;
  }

  /**
   * Build (or reuse) the decoration cache — gridlines + background-logo
   * tiles rendered into a transparent offscreen the size of the main
   * backing store. Reused verbatim while the camera, backing-store size
   * and logo-loaded state are unchanged; rebuilt (running the per-cell
   * loops ONCE) when any of those change. Returns the cache canvas, or
   * null if a 2D context could not be created (caller then draws live).
   */
  private ensureDecoCache(
    bsW: number,
    bsH: number,
    pxPerCell: number,
    dstX: number,
    dstY: number,
  ): HTMLCanvasElement | null {
    if (!this.decoCanvas) {
      this.decoCanvas = document.createElement('canvas');
      this.decoCtx = this.decoCanvas.getContext('2d');
    }
    const dctx = this.decoCtx;
    const cv = this.decoCanvas;
    if (!dctx) return null;

    const logoReady = isBackgroundLogoReady();
    const sizeChanged = cv.width !== bsW || cv.height !== bsH;
    // decoZoom starts as NaN so the first call always rebuilds.
    const camChanged =
      this.camera.zoom !== this.decoZoom ||
      this.camera.offsetX !== this.decoOffsetX ||
      this.camera.offsetY !== this.decoOffsetY;
    const logoChanged = logoReady !== this.decoLogoReady;

    if (sizeChanged || camChanged || logoChanged) {
      if (sizeChanged) {
        // Assigning width/height also clears the bitmap.
        cv.width = bsW;
        cv.height = bsH;
      } else {
        dctx.clearRect(0, 0, bsW, bsH);
      }
      dctx.imageSmoothingEnabled = false;
      this.drawGridlines(dctx, bsW, bsH, pxPerCell, dstX, dstY);
      this.drawBackgroundLogos(dctx, bsW, bsH, pxPerCell, dstX, dstY);
      this.decoZoom = this.camera.zoom;
      this.decoOffsetX = this.camera.offsetX;
      this.decoOffsetY = this.camera.offsetY;
      this.decoLogoReady = logoReady;
    }
    return cv;
  }

  /**
   * Faded MOZAI app-logo drawn into every visible -1 BACKGROUND
   * cell so the empty field reads as visibly different from a
   * white paintable cell. The faded variant is pre-baked once at
   * icon-load time, so this loop is just per-cell drawImage with
   * no alpha-state changes.
   *
   * Performance gates (in the order they short-circuit):
   *   • pxPerCell < BG_LOGO_MIN_PX_PER_CELL → sub-pixel rendering
   *     would be invisible AND would dominate the frame on huge
   *     grids; skip entirely.
   *   • logo asset not yet loaded → register a redraw callback and
   *     no-op for this frame.
   *   • iteration is bounded by the VISIBLE cell range, never the
   *     full grid: a 1000×1000 puzzle at zoom 12 still touches
   *     only ~viewport_w/12 × viewport_h/12 cells per frame.
   */
  private drawBackgroundLogos(
    tctx: CanvasRenderingContext2D,
    bsW: number,
    bsH: number,
    pxPerCell: number,
    dstX: number,
    dstY: number,
  ): void {
    if (pxPerCell < BG_LOGO_MIN_PX_PER_CELL) return;
    const logo = getBackgroundLogo(() => this.scheduleFrame());
    if (!logo) return;

    const ctx = tctx;
    const { state, camera } = this;
    const puzzleW = state.puzzle.w;
    const puzzleH = state.puzzle.h;
    const cellsAcross = bsW / pxPerCell;
    const cellsDown = bsH / pxPerCell;
    const cx0 = Math.max(0, Math.floor(camera.offsetX));
    const cx1 = Math.min(puzzleW, Math.ceil(camera.offsetX + cellsAcross) + 1);
    const cy0 = Math.max(0, Math.floor(camera.offsetY));
    const cy1 = Math.min(puzzleH, Math.ceil(camera.offsetY + cellsDown) + 1);
    const sz = Math.round(pxPerCell);
    for (let cy = cy0; cy < cy1; cy++) {
      const py = Math.round(dstY + cy * pxPerCell);
      const rowBase = cy * puzzleW;
      for (let cx = cx0; cx < cx1; cx++) {
        if (state.solution[rowBase + cx] !== -1) continue;
        const px = Math.round(dstX + cx * pxPerCell);
        ctx.drawImage(logo, px, py, sz, sz);
      }
    }
  }

  /**
   * Paint the minimap (if set): scaled offscreen + viewport overlay
   * rect. Cheap — the scale-down is a single drawImage and the rect
   * is one strokeRect. Caller controls visibility (this paints
   * unconditionally when a minimap canvas is bound).
   */
  private drawMinimap(): void {
    const canvas = this.minimap;
    const ctx = this.minimapCtx;
    if (!canvas || !ctx) return;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW === 0 || cssH === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const bsW = Math.max(1, Math.round(cssW * dpr));
    const bsH = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== bsW) canvas.width = bsW;
    if (canvas.height !== bsH) canvas.height = bsH;

    const puzzleW = this.state.puzzle.w;
    const puzzleH = this.state.puzzle.h;
    const scale = Math.min(bsW / puzzleW, bsH / puzzleH);
    const drawnW = puzzleW * scale;
    const drawnH = puzzleH * scale;
    const offX = (bsW - drawnW) / 2;
    const offY = (bsH - drawnH) / 2;

    // Silhouette cache: white background + the scaled-down minimap
    // offscreen. This only changes when a CELL is painted
    // (minimapCacheDirty) or the minimap backing store resizes — NEVER
    // on pan/zoom. So a pan/zoom frame just blits this cache 1:1 and
    // strokes the (cheap, moving) viewport rect below: no per-frame
    // scale-down of the whole silhouette.
    //
    // The MINIMAP offscreen (grayscale unpainted + true-colour painted)
    // is used — NOT the main offscreen (whose unpainted cells are
    // transparent). The minimap is too small for the per-cell BG logos
    // that distinguish -1 from paintable on the main canvas, so palette
    // grayscale carries that information here.
    if (!this.minimapCache) {
      this.minimapCache = document.createElement('canvas');
      this.minimapCacheCtx = this.minimapCache.getContext('2d');
    }
    const cacheCtx = this.minimapCacheCtx;
    const cache = this.minimapCache;
    if (cacheCtx && cache) {
      const cacheSizeChanged = cache.width !== bsW || cache.height !== bsH;
      if (this.minimapCacheDirty || cacheSizeChanged) {
        if (cacheSizeChanged) {
          cache.width = bsW;
          cache.height = bsH;
        }
        cacheCtx.fillStyle = '#ffffff';
        cacheCtx.fillRect(0, 0, bsW, bsH);
        cacheCtx.imageSmoothingEnabled = false;
        cacheCtx.drawImage(this.minimapOffscreen, offX, offY, drawnW, drawnH);
        this.minimapCacheDirty = false;
      }
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(cache, 0, 0);
    } else {
      // Context-creation fallback: render the silhouette live.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, bsW, bsH);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.minimapOffscreen, offX, offY, drawnW, drawnH);
    }

    // Viewport rectangle: maps the visible cell range in the main
    // canvas to the minimap. Clamped to the puzzle area so a
    // wider-than-puzzle viewport (fit-zoom on a tall puzzle) still
    // shows a sensible box. Uses the CACHED main-canvas CSS size — no
    // per-frame layout read.
    const visibleW = this.viewCssW / this.camera.zoom;
    const visibleH = this.viewCssH / this.camera.zoom;
    const rx = offX + Math.max(0, this.camera.offsetX) * scale;
    const ry = offY + Math.max(0, this.camera.offsetY) * scale;
    const rw = Math.min(puzzleW - Math.max(0, this.camera.offsetX), visibleW) * scale;
    const rh = Math.min(puzzleH - Math.max(0, this.camera.offsetY), visibleH) * scale;

    ctx.strokeStyle = 'rgba(20, 30, 45, 0.9)';
    ctx.lineWidth = Math.max(1, Math.round(dpr));
    ctx.strokeRect(rx + 0.5, ry + 0.5, Math.max(0, rw - 1), Math.max(0, rh - 1));
  }

  /**
   * Selection guide. For every cell whose target colour matches
   * `this.selectedColor` AND that is NOT yet painted, stroke an
   * outline FLUSH WITH THE CELL'S OUTER EDGE in the selected
   * palette colour. Visually the cell's gray gridline border just
   * turns the selected colour — no inset, no floating box.
   *
   * Performance:
   *   - Skipped entirely when no colour is selected (-1).
   *   - Skipped at extreme zoom-out (pxPerCell < ~8 device px) —
   *     1M outlines on a 1000×1000 grid would be an unreadable
   *     wash anyway, and would dominate the frame.
   *   - Iterates only the VISIBLE cell range, not the whole grid.
   *   - One ctx.beginPath() / ctx.stroke() pair for the entire
   *     overlay; up to thousands of rect paths batched into a
   *     single stroke call.
   *
   * On a 1000×1000 puzzle fully zoomed-in this iterates roughly
   * the viewport's worth of cells (typically <2k), well under a
   * frame budget. Zoomed-out hits the skip threshold first.
   */
  private drawSelectionOutlines(
    tctx: CanvasRenderingContext2D,
    bsW: number,
    bsH: number,
    pxPerCell: number,
    dstX: number,
    dstY: number,
  ): void {
    const sel = this.selectedColor;
    if (sel < 0) return;
    // Outline is gated on a per-colour hint UNLOCK. By default a
    // selected colour shows no outline — the player paints blind.
    // Spending a rewarded Hint ad calls state.revealHint(colour),
    // which adds the colour to state.hintRevealed; from then on the
    // outline appears whenever that colour is the selection. The
    // unlock persists with paint state (PersistEnvelope.hints[]).
    if (!this.state.hintRevealed.has(sel)) return;
    if (pxPerCell < 8) return;
    const ctx = tctx;
    const { state } = this;
    const palettePos = sel * 4;
    if (palettePos < 0 || palettePos + 3 >= this.paletteRgba.length) return;
    const pr = this.paletteRgba[palettePos];
    const pg = this.paletteRgba[palettePos + 1];
    const pb = this.paletteRgba[palettePos + 2];

    const puzzleW = state.puzzle.w;
    const puzzleH = state.puzzle.h;
    const cellsAcross = bsW / pxPerCell;
    const cellsDown = bsH / pxPerCell;
    const cx0 = Math.max(0, Math.floor(this.camera.offsetX));
    const cx1 = Math.min(puzzleW, Math.ceil(this.camera.offsetX + cellsAcross) + 1);
    const cy0 = Math.max(0, Math.floor(this.camera.offsetY));
    const cy1 = Math.min(puzzleH, Math.ceil(this.camera.offsetY + cellsDown) + 1);

    const dpr = this.viewDpr;
    // Thin, flush. Same lineWidth as the gridlines themselves
    // (Math.max(1, round(dpr))) so the outline is exactly the
    // grid border in a different colour — no thicker frame.
    ctx.strokeStyle = `rgb(${pr}, ${pg}, ${pb})`;
    ctx.lineWidth = Math.max(1, Math.round(dpr));

    ctx.beginPath();
    for (let cy = cy0; cy < cy1; cy++) {
      // Cell top edge is at world y = cy → screen y; bottom edge at
      // y = cy + 1. .5 offset keeps the 1-device-px stroke on a
      // single pixel row instead of straddling two (which would
      // render blurry / half-transparent on every device).
      const top = Math.round(dstY + cy * pxPerCell) + 0.5;
      const bottom = Math.round(dstY + (cy + 1) * pxPerCell) + 0.5;
      const rowBase = cy * puzzleW;
      for (let cx = cx0; cx < cx1; cx++) {
        const i = rowBase + cx;
        if (state.solution[i] !== sel) continue;
        if (state.filled[i]) continue;
        const left = Math.round(dstX + cx * pxPerCell) + 0.5;
        const right = Math.round(dstX + (cx + 1) * pxPerCell) + 0.5;
        ctx.moveTo(left, top);
        ctx.lineTo(right, top);
        ctx.lineTo(right, bottom);
        ctx.lineTo(left, bottom);
        ctx.closePath();
      }
    }
    ctx.stroke();
  }

  /**
   * Light-grey hairline outlines on EVERY paintable cell. Drawn
   * AFTER the offscreen blit (see draw()) so painted cells —
   * including pure-white palette entries — still read as discrete
   * cells. Background (-1) cells are explicitly skipped so the
   * watermark + clean empty field stay intact.
   *
   * Skipped entirely when cells are too small (< 6 backing px per
   * cell) to avoid the lines aliasing into noise at extreme
   * zoom-out on huge grids — the cell-colour contrast and the
   * watermark backdrop carry visual clarity at that zoom range.
   * Per-cell rect outlines keep the JS work bounded by the
   * VISIBLE cell count, not the puzzle size: one beginPath /
   * stroke pair per frame, paths batched in between.
   */
  private drawGridlines(
    tctx: CanvasRenderingContext2D,
    bsW: number,
    bsH: number,
    pxPerCell: number,
    dstX: number,
    dstY: number,
  ): void {
    if (pxPerCell < 6) return;
    const ctx = tctx;
    const { state, camera } = this;
    const dpr = this.viewDpr;
    const puzzleW = state.puzzle.w;
    const puzzleH = state.puzzle.h;
    const cellsAcross = bsW / pxPerCell;
    const cellsDown = bsH / pxPerCell;
    const cx0 = Math.max(0, Math.floor(camera.offsetX));
    const cx1 = Math.min(puzzleW, Math.ceil(camera.offsetX + cellsAcross) + 1);
    const cy0 = Math.max(0, Math.floor(camera.offsetY));
    const cy1 = Math.min(puzzleH, Math.ceil(camera.offsetY + cellsDown) + 1);

    ctx.strokeStyle = '#d8d8d8';
    ctx.lineWidth = Math.max(1, Math.round(dpr));
    ctx.beginPath();
    const psz = Math.max(1, Math.round(pxPerCell) - 1);
    for (let cy = cy0; cy < cy1; cy++) {
      const py = Math.round(dstY + cy * pxPerCell) + 0.5;
      const rowBase = cy * puzzleW;
      for (let cx = cx0; cx < cx1; cx++) {
        const i = rowBase + cx;
        // Background cells never get a gridline: the watermark +
        // clean empty field MUST stay legible there.
        if (state.solution[i] < 0) continue;
        // Filled cells DO get a gridline now (no skip): a white-
        // painted cell needs the border to remain visible against
        // the bright island.
        const px = Math.round(dstX + cx * pxPerCell) + 0.5;
        // Single rect path per cell — batched into one stroke().
        ctx.moveTo(px, py);
        ctx.lineTo(px + psz, py);
        ctx.lineTo(px + psz, py + psz);
        ctx.lineTo(px, py + psz);
        ctx.closePath();
      }
    }
    ctx.stroke();
  }

  /**
   * Compute the zoom limits for the current canvas + puzzle WITHOUT
   * mutating the camera. fitToScreen() calls this; the scene's
   * ResizeObserver also calls it on viewport changes so the user's
   * zoom and pan are preserved across resizes (the old fitToScreen()
   * destructively reset camera.zoom and offsetX/Y on every call,
   * which wiped the user's view on palette-empty / keyboard /
   * rotation events).
   *
   * minZoom = fit (CONTAIN). The user cannot zoom out past full
   * visibility on the limiting axis.
   *
   * maxZoom = max(fitZoom * 4, 96). At least 4x the fit so a tiny
   * puzzle still has meaningful zoom-in headroom; at least 96 CSS
   * px per cell so a huge grid like the 1000x1000 perf-test
   * remains comfortably tappable when fully zoomed in. The
   * fitZoom*4 floor is the actual fix for the user-reported
   * "+ toggles" bug: the old hardcoded maxZoom of 48 was BELOW
   * fitZoom for any puzzle that comfortably fits the viewport, so
   * clamp(v, fitZoom, 48) collapsed to one of two values
   * (fitZoom or 48) depending on whether v was above or below
   * fitZoom — a binary toggle, exactly the symptom.
   */
  computeFitLimits(marginCss = 8): CameraLimits {
    const cssW = Math.max(1, this.canvas.clientWidth - marginCss * 2);
    const cssH = Math.max(1, this.canvas.clientHeight - marginCss * 2);
    const zX = cssW / this.state.puzzle.w;
    const zY = cssH / this.state.puzzle.h;
    const fitZoom = Math.min(zX, zY);
    const maxZoom = Math.max(fitZoom * 4, 96);
    return { minZoom: fitZoom, maxZoom };
  }

  /**
   * Reset camera to "fit, centred". Called explicitly on scene
   * mount; NOT called from the resize observer (so the user's
   * zoom/pan survive layout changes).
   */
  resetCameraToFit(marginCss = 8): CameraLimits {
    const limits = this.computeFitLimits(marginCss);
    this.camera.zoom = limits.minZoom;
    const visibleCellsW = this.canvas.clientWidth / limits.minZoom;
    const visibleCellsH = this.canvas.clientHeight / limits.minZoom;
    // Centre the PAINTABLE bounding box in the viewport (not the
    // whole grid). Puzzles whose silhouette only fills part of the
    // grid — e.g. a heart in rows 0-7 of a 10×10 — would otherwise
    // appear visually off-centre because the empty grid rows are
    // indistinguishable from the canvas background. Falls back to
    // grid centre for the degenerate all-background case.
    const b = this.state.paintableBounds;
    const w = this.state.puzzle.w;
    const h = this.state.puzzle.h;
    // +1 because the bounds are inclusive cell indices and a cell
    // spans [i, i+1] in world coordinates.
    const centreX = b ? (b.minX + b.maxX + 1) / 2 : w / 2;
    const centreY = b ? (b.minY + b.maxY + 1) / 2 : h / 2;
    this.camera.offsetX = centreX - visibleCellsW / 2;
    this.camera.offsetY = centreY - visibleCellsH / 2;
    this.scheduleFrame();
    return limits;
  }

  /**
   * Backwards-compatible alias. New code should call either
   * computeFitLimits (just-the-numbers) or resetCameraToFit
   * (also reset). Kept here so existing call sites don't break.
   */
  fitToScreen(marginCss = 8): CameraLimits {
    return this.resetCameraToFit(marginCss);
  }

  /**
   * Clamp camera offset so the puzzle is never dragged completely
   * off-screen. When the puzzle is smaller than the viewport on an
   * axis (zoom near or below fit), centre it on that axis.
   * Otherwise allow panning up to but not past the puzzle's edge
   * — equivalent to "no empty void next to the puzzle on any side".
   */
  clampCamera(): void {
    // Cached metrics — clampCamera runs on every pan/zoom move, so it
    // must not read layout. The scene refreshes the cache (via
    // refreshViewMetrics) on real resizes before clamping.
    const cssW = this.viewCssW;
    const cssH = this.viewCssH;
    if (cssW === 0 || cssH === 0) return;
    const visibleW = cssW / this.camera.zoom;
    const visibleH = cssH / this.camera.zoom;
    const puzzleW = this.state.puzzle.w;
    const puzzleH = this.state.puzzle.h;
    if (visibleW >= puzzleW) {
      this.camera.offsetX = (puzzleW - visibleW) / 2;
    } else {
      this.camera.offsetX = clamp(this.camera.offsetX, 0, puzzleW - visibleW);
    }
    if (visibleH >= puzzleH) {
      this.camera.offsetY = (puzzleH - visibleH) / 2;
    } else {
      this.camera.offsetY = clamp(this.camera.offsetY, 0, puzzleH - visibleH);
    }
  }

  /**
   * Convert a screen (CSS pixel) coord — relative to the canvas's
   * top-left — to a cell index, or -1 if outside the puzzle.
   */
  screenToCell(screenX: number, screenY: number): number {
    const cellX = Math.floor(this.camera.offsetX + screenX / this.camera.zoom);
    const cellY = Math.floor(this.camera.offsetY + screenY / this.camera.zoom);
    if (cellX < 0 || cellY < 0) return -1;
    if (cellX >= this.state.puzzle.w || cellY >= this.state.puzzle.h) return -1;
    return cellY * this.state.puzzle.w + cellX;
  }

  /**
   * Cancel pending frame — called on teardown so a half-scheduled
   * raf doesn't tick after the scene is gone.
   */
  dispose(): void {
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }
}

/**
 * Parse the hex palette into a flat Uint8ClampedArray of RGBA values
 * (4 bytes per palette entry). Done once at construction so the per-
 * cell render path is pure indexing.
 */
function parsePalette(palette: string[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(palette.length * 4);
  for (let i = 0; i < palette.length; i++) {
    const hex = palette[i];
    // Accept #rgb, #rrggbb, #rrggbbaa. Default alpha to 255.
    let r = 0, g = 0, b = 0, a = 255;
    if (hex.startsWith('#')) {
      const s = hex.slice(1);
      if (s.length === 3) {
        r = parseInt(s[0] + s[0], 16);
        g = parseInt(s[1] + s[1], 16);
        b = parseInt(s[2] + s[2], 16);
      } else if (s.length === 6) {
        r = parseInt(s.slice(0, 2), 16);
        g = parseInt(s.slice(2, 4), 16);
        b = parseInt(s.slice(4, 6), 16);
      } else if (s.length === 8) {
        r = parseInt(s.slice(0, 2), 16);
        g = parseInt(s.slice(2, 4), 16);
        b = parseInt(s.slice(4, 6), 16);
        a = parseInt(s.slice(6, 8), 16);
      }
    }
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = a;
  }
  return out;
}

/**
 * Parse the hex palette into a flat Uint8ClampedArray of GRAYSCALE
 * RGBA values (4 bytes per entry). Each palette colour is converted
 * to its perceptual luminance via the standard Rec. 601 weighting,
 * then stored as (luma, luma, luma, original_alpha). Used by the
 * minimap offscreen so unpainted cells show the palette colour's
 * grayscale silhouette — matching the room-interior thumb's
 * grayscale-of-real-colour convention.
 */
function parsePaletteGray(palette: string[]): Uint8ClampedArray {
  const rgba = parsePalette(palette);
  const out = new Uint8ClampedArray(palette.length * 4);
  for (let i = 0; i < palette.length; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3];
    // Rec. 601 luma — matches the room-interior thumbs (thumbs.ts
    // renderThumb) so the silhouette greys agree across screens.
    const luma = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    out[i * 4] = luma;
    out[i * 4 + 1] = luma;
    out[i * 4 + 2] = luma;
    out[i * 4 + 3] = a;
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  // Defensive: if lo > hi the input is malformed; return lo. The
  // CameraLimits constructor in computeFitLimits guarantees
  // maxZoom > minZoom (maxZoom = max(fitZoom * 4, 96) >= fitZoom),
  // so this should never hit in practice — it's just a safety
  // net against future refactors.
  if (lo > hi) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}
