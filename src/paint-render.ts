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
 *                                            through, matching the
 *                                            silhouette mode of the
 *                                            room-interior thumbs)
 *
 * Per-cell updates are O(1) — we poke 4 bytes into the buffer. Per
 * frame is also O(1) on the JS side: one `drawImage(offscreen, ...)`
 * call that asks the GPU/compositor to scale the rectangle by the
 * current zoom. `imageSmoothingEnabled = false` gives nearest-
 * neighbour scaling for crisp pixel-art rendering at every zoom.
 *
 * This means a 1000x1000 puzzle stays smooth even at full zoom-out
 * because we never iterate cells in JS during a render — we just
 * blit a 1000x1000 RGBA buffer to a much smaller viewport, which is
 * a single GPU-accelerated operation.
 *
 * Memory: 1000x1000 RGBA = 4 MB for the offscreen. Plus the visible
 * canvas backing store (dpr * cssSize). Cheap on modern phones.
 */

import type { PaintState } from './paint-state.js';

const SILHOUETTE_RGBA: [number, number, number, number] = [192, 200, 209, 255];

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
  /** Frame coalescing. */
  private rafId = 0;

  camera: Camera = { offsetX: 0, offsetY: 0, zoom: 1 };

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

    this.paletteRgba = parsePalette(state.puzzle.palette);

    this.rebuildBuffer();
  }

  /**
   * Walk every cell once and populate the offscreen pixel buffer.
   * Called at boot and after restoring saved state — cheap for any
   * size (1M pixel touches at ~5 ns each ≈ 5 ms).
   */
  rebuildBuffer(): void {
    const { solution, filled, hintRevealed } = this.state;
    const data = this.offscreenData.data;
    for (let i = 0; i < solution.length; i++) {
      const v = solution[i];
      const p = i * 4;
      if (v < 0) {
        data[p] = 0;
        data[p + 1] = 0;
        data[p + 2] = 0;
        data[p + 3] = 0;
      } else if (filled[i]) {
        const pp = v * 4;
        data[p] = this.paletteRgba[pp];
        data[p + 1] = this.paletteRgba[pp + 1];
        data[p + 2] = this.paletteRgba[pp + 2];
        data[p + 3] = this.paletteRgba[pp + 3];
      } else if (hintRevealed.has(v)) {
        data[p] = SILHOUETTE_RGBA[0];
        data[p + 1] = SILHOUETTE_RGBA[1];
        data[p + 2] = SILHOUETTE_RGBA[2];
        data[p + 3] = SILHOUETTE_RGBA[3];
      } else {
        // Unfilled, not hinted — transparent. The white canvas background
        // shows through.
        data[p] = 0;
        data[p + 1] = 0;
        data[p + 2] = 0;
        data[p + 3] = 0;
      }
    }
    this.offscreenCtx.putImageData(this.offscreenData, 0, 0);
  }

  /** Mark cell `i` as freshly filled — update offscreen + schedule a frame. */
  updateCellFilled(i: number): void {
    const v = this.state.solution[i];
    if (v < 0) return;
    const data = this.offscreenData.data;
    const p = i * 4;
    const pp = v * 4;
    data[p] = this.paletteRgba[pp];
    data[p + 1] = this.paletteRgba[pp + 1];
    data[p + 2] = this.paletteRgba[pp + 2];
    data[p + 3] = this.paletteRgba[pp + 3];
    // For a single-cell update, putImageData on the cell rect is far
    // cheaper than re-uploading the whole buffer (puts only 4 bytes).
    this.offscreenCtx.putImageData(this.offscreenData, 0, 0, i % this.state.puzzle.w, Math.floor(i / this.state.puzzle.w), 1, 1);
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
  scheduleFrame(): void {
    if (this.rafId !== 0) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      this.draw();
    });
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
   */
  draw(): boolean {
    const { ctx, canvas, camera } = this;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW === 0 || cssH === 0) return false;
    const dpr = window.devicePixelRatio || 1;
    const bsW = Math.max(1, Math.round(cssW * dpr));
    const bsH = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== bsW) canvas.width = bsW;
    if (canvas.height !== bsH) canvas.height = bsH;

    // White background (for unfilled cells that are transparent in
    // the offscreen).
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, bsW, bsH);

    ctx.imageSmoothingEnabled = false;

    const pxPerCell = camera.zoom * dpr;
    const dstX = -camera.offsetX * pxPerCell;
    const dstY = -camera.offsetY * pxPerCell;
    const dstW = this.state.puzzle.w * pxPerCell;
    const dstH = this.state.puzzle.h * pxPerCell;
    ctx.drawImage(this.offscreen, dstX, dstY, dstW, dstH);

    this.drawGridlines(bsW, bsH, pxPerCell, dstX, dstY);
    this.framesPainted++;
    return true;
  }

  /** Total frames the renderer has actually painted. Diagnostic. */
  framesPainted = 0;

  /**
   * Faint per-cell gridlines so unpainted cells are visible to tap.
   * Skipped when cells are too small (~< 4 backing px per cell) to
   * avoid a solid-grey wash at extreme zoom-out on huge grids.
   * Lines are drawn in CSS-pixel-scaled coordinates (.5 offset to
   * keep 1-device-pixel strokes crisp).
   */
  private drawGridlines(bsW: number, bsH: number, pxPerCell: number, dstX: number, dstY: number): void {
    if (pxPerCell < 4) return;
    const { ctx, state, camera } = this;
    const dpr = window.devicePixelRatio || 1;
    const puzzleW = state.puzzle.w;
    const puzzleH = state.puzzle.h;
    // Visible cell range — only stroke lines that intersect the
    // canvas viewport. Adding +1 on both ends ensures the edge
    // lines on the boundary cells are included.
    const cellsAcross = bsW / pxPerCell;
    const cellsDown = bsH / pxPerCell;
    const cx0 = Math.max(0, Math.floor(camera.offsetX));
    const cx1 = Math.min(puzzleW, Math.ceil(camera.offsetX + cellsAcross) + 1);
    const cy0 = Math.max(0, Math.floor(camera.offsetY));
    const cy1 = Math.min(puzzleH, Math.ceil(camera.offsetY + cellsDown) + 1);

    ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)';
    ctx.lineWidth = Math.max(1, Math.round(dpr));
    ctx.beginPath();
    // Vertical lines.
    for (let cx = cx0; cx <= cx1; cx++) {
      const px = Math.round(dstX + cx * pxPerCell) + 0.5;
      const yStart = Math.max(0, Math.round(dstY));
      const yEnd = Math.min(bsH, Math.round(dstY + puzzleH * pxPerCell));
      ctx.moveTo(px, yStart);
      ctx.lineTo(px, yEnd);
    }
    // Horizontal lines.
    for (let cy = cy0; cy <= cy1; cy++) {
      const py = Math.round(dstY + cy * pxPerCell) + 0.5;
      const xStart = Math.max(0, Math.round(dstX));
      const xEnd = Math.min(bsW, Math.round(dstX + puzzleW * pxPerCell));
      ctx.moveTo(xStart, py);
      ctx.lineTo(xEnd, py);
    }
    ctx.stroke();
  }

  /**
   * Pick a sensible initial camera so the whole puzzle just fits the
   * visible canvas with a small margin. CONTAIN fit: scale =
   * min(viewportW / imgW, viewportH / imgH), so the picture fills
   * its limiting axis edge-to-edge (width when the puzzle is square
   * or wider than the viewport's aspect, height when taller). The
   * resulting fitZoom is also the MIN ZOOM — the user can pinch in
   * but not out past full visibility on the limiting axis.
   *
   * marginCss=8 keeps the picture a hair off the very edges of the
   * viewport so it doesn't visually touch the topbar / palette
   * borders. Set to 0 if true edge-to-edge is preferred later.
   *
   * Returns false (no-op) when the canvas hasn't been laid out yet
   * (clientWidth/Height === 0). The caller is expected to call
   * fitToScreen again from a ResizeObserver once layout settles.
   */
  fitToScreen(marginCss = 8): CameraLimits {
    const cssW = Math.max(1, this.canvas.clientWidth - marginCss * 2);
    const cssH = Math.max(1, this.canvas.clientHeight - marginCss * 2);
    const zX = cssW / this.state.puzzle.w;
    const zY = cssH / this.state.puzzle.h;
    const fitZoom = Math.min(zX, zY);
    this.camera.zoom = fitZoom;
    // Centre the puzzle inside the viewport.
    const visibleCellsW = this.canvas.clientWidth / fitZoom;
    const visibleCellsH = this.canvas.clientHeight / fitZoom;
    this.camera.offsetX = (this.state.puzzle.w - visibleCellsW) / 2;
    this.camera.offsetY = (this.state.puzzle.h - visibleCellsH) / 2;
    this.scheduleFrame();
    // Limits: minZoom = fitZoom locks the zoom-OUT floor at fit, so
    // the user cannot zoom past "fully visible on the limiting
    // axis". maxZoom ~48 CSS px per cell is comfortably tappable.
    return { minZoom: fitZoom, maxZoom: 48 };
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
