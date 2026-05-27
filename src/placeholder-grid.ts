/*
 * Placeholder render — a centred NxN grid drawn into #play-canvas.
 *
 * The grid exists ONLY to prove the resize architecture is correct.
 * It will be removed when the real colour-by-number renderer lands.
 *
 * Properties the grid must satisfy on every device / rotation:
 *   • Always fully visible inside the play area (CONTAIN fit, with a
 *     small visual margin so cells never sit flush against the play
 *     area edge).
 *   • Re-fits on every resize event without leaving stale pixels.
 *   • Crisp on Hi-DPI screens (the canvas backing store is scaled by
 *     devicePixelRatio in resize.ts — we draw in *backing-store*
 *     pixels here, NOT logical CSS pixels).
 *
 * The CONTAIN fit is the same math Last Tile uses on the native side
 * (graphicsLayer scale = min(widthRatio, heightRatio)). Centred via
 * letterbox offsets on whichever axis has slack.
 */

import type { FitInfo, Renderer } from './resize.js';

const GRID_SIDE_CELLS = 16; // 16x16 placeholder grid.
const SAFE_MARGIN_FRAC = 0.04; // 4 % of the smaller axis kept clear as breathing room.

export function makePlaceholderGrid(): Renderer {
  return (info: FitInfo, canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawPlaceholderGrid(ctx, info);
  };
}

function drawPlaceholderGrid(ctx: CanvasRenderingContext2D, info: FitInfo): void {
  const { pixelWidth, pixelHeight, dpr } = info;

  // Wipe — setting canvas.width in resize.ts already clears the
  // bitmap, but clearRect is cheap and makes intent obvious.
  ctx.clearRect(0, 0, pixelWidth, pixelHeight);

  if (pixelWidth === 0 || pixelHeight === 0) return;

  // CONTAIN: square grid. We allocate the largest square that fits
  // inside (pixelWidth, pixelHeight) minus the safe margin.
  const shorterSide = Math.min(pixelWidth, pixelHeight);
  const margin = Math.floor(shorterSide * SAFE_MARGIN_FRAC);
  const gridPx = Math.max(0, shorterSide - margin * 2);
  // Snap cell size to an integer so cell lines stay crisp at any zoom.
  const cellPx = Math.max(1, Math.floor(gridPx / GRID_SIDE_CELLS));
  const realGridPx = cellPx * GRID_SIDE_CELLS;
  // Centre the grid inside the (pixelWidth x pixelHeight) backing store.
  const originX = Math.floor((pixelWidth - realGridPx) / 2);
  const originY = Math.floor((pixelHeight - realGridPx) / 2);

  // Cells.
  ctx.fillStyle = '#1f2a3a';
  ctx.fillRect(originX, originY, realGridPx, realGridPx);

  // Grid lines. lineWidth in *backing-store* pixels. dpr is applied
  // here so the 1-CSS-pixel line stays 1 CSS pixel thick on a Hi-DPI
  // screen rather than disappearing into a half-pixel.
  ctx.strokeStyle = '#324259';
  ctx.lineWidth = Math.max(1, Math.round(dpr));
  ctx.beginPath();
  for (let i = 0; i <= GRID_SIDE_CELLS; i++) {
    const x = originX + i * cellPx + 0.5;
    const y = originY + i * cellPx + 0.5;
    // Vertical line.
    ctx.moveTo(x, originY);
    ctx.lineTo(x, originY + realGridPx);
    // Horizontal line.
    ctx.moveTo(originX, y);
    ctx.lineTo(originX + realGridPx, y);
  }
  ctx.stroke();

  // Centre dot — a visual anchor so it's obvious at a glance whether
  // the grid is actually centred inside #game.
  ctx.fillStyle = '#f4c062';
  const dotR = Math.max(2, Math.round(cellPx * 0.25));
  ctx.beginPath();
  ctx.arc(originX + realGridPx / 2, originY + realGridPx / 2, dotR, 0, Math.PI * 2);
  ctx.fill();
}
