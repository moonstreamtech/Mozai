/*
 * Thumbnail loader + renderer.
 *
 * Each room's thumbs live in `public/content/room<N>/thumbs.json`, a
 * single JSON blob keyed by picture id. The blob is built by
 * scripts/build-content-index.mjs (longest side ≤ 32 px, nearest-
 * -neighbour, -1 cells preserved). One fetch per room visit, cached
 * for the session so re-entering a room is instant.
 *
 * Two render modes:
 *   'silhouette' — non-background cells in a single neutral tone on
 *                  white. Used for NOT-completed pictures so the
 *                  player sees the shape, not the colours.
 *   'color'      — full palette render. Used for completed pictures.
 *
 * The renderer writes into the caller-owned <canvas>. It NEVER reads
 * the host page's layout viewport — it scales to whatever pixel size
 * the caller has chosen (typically CSS width × dpr).
 */

import { resolveContent } from './content-resolver.js';
import { ContentResolveError } from './content.js';

export interface Thumb {
  w: number;
  h: number;
  palette: string[];
  /** Flat row-major array of length w*h. -1 = background / outside silhouette. */
  cells: number[];
}

export type ThumbBundle = Record<string, Thumb>;

const bundleCache = new Map<number, Promise<ThumbBundle>>();

/**
 * Fetch (and cache) a room's thumbs.json. Two callers for the same
 * room share the in-flight promise — no double fetch on rapid
 * back-and-forth navigation.
 */
export function loadRoomThumbs(roomN: number): Promise<ThumbBundle> {
  const cached = bundleCache.get(roomN);
  if (cached) return cached;
  const path = `content/room${roomN}/thumbs.json`;
  // Route through the bundled-vs-cache-vs-network resolver. Room 1's
  // thumbs are bundled; rooms 2+ are cache-first / CDN-fallback.
  // The resolver returns source='FAILED' for offline + uncached,
  // which we surface as ContentResolveError so the scene shows the
  // localized "needs internet" panel.
  // A rejected promise is EVICTED from bundleCache so a retry from
  // the scene actually re-runs the resolver.
  const p = resolveContent(path)
    .then((result) => {
      if (result.source === 'FAILED') {
        throw new ContentResolveError(path);
      }
      return JSON.parse(result.text) as ThumbBundle;
    })
    .catch((err) => {
      bundleCache.delete(roomN);
      throw err;
    });
  bundleCache.set(roomN, p);
  return p;
}

/** Render mode. */
export interface ThumbRenderOpts {
  /**
   * When true, every non-background cell renders as its real
   * palette colour (the picture is complete or otherwise treated
   * as fully painted). Wins over `filled` if both supplied.
   */
  completed?: boolean;
  /**
   * Full-resolution painted-state from PaintState (or
   * loadFilledBitset). Each thumb cell is mapped to its source
   * cell via nearest-neighbour, then rendered as:
   *   - real palette colour if filled[source] === 1
   *   - grayscale luminance of the palette colour otherwise
   * Pass null / undefined for "no progress yet" — the thumb
   * renders fully grayscale, which is the new silhouette.
   */
  filled?: Uint8Array | null;
  /**
   * Source puzzle dimensions. Required when `filled` is provided so
   * the thumb cell → source cell mapping is correct.
   */
  sourceW?: number;
  sourceH?: number;
}

/**
 * Paint `thumb` into `canvas` at its current backing-store size.
 *
 * Three visual states:
 *   1. `completed: true`                     → all cells real colour
 *   2. `filled` present (partial progress)   → painted cells real
 *                                              colour, unpainted
 *                                              grayscale luminance
 *   3. neither (no progress, or just opened) → all cells grayscale
 *
 * Background (-1) cells always stay white.
 *
 * Pixel-perfect rendering relies on `image-rendering: pixelated`
 * on the canvas's CSS box (set in style.css).
 */
export function renderThumb(
  canvas: HTMLCanvasElement,
  thumb: Thumb,
  opts: ThumbRenderOpts = {},
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const pxW = canvas.width;
  const pxH = canvas.height;
  if (pxW === 0 || pxH === 0) return;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, pxW, pxH);

  // CONTAIN-fit the thumb inside the canvas. Block size is floored
  // to an integer so cell edges stay crisp (no half-pixel bleed).
  const blockPx = Math.max(1, Math.floor(Math.min(pxW / thumb.w, pxH / thumb.h)));
  const drawnW = blockPx * thumb.w;
  const drawnH = blockPx * thumb.h;
  const offX = Math.floor((pxW - drawnW) / 2);
  const offY = Math.floor((pxH - drawnH) / 2);

  ctx.imageSmoothingEnabled = false;

  // Pre-parse the palette into RGB + grayscale variants so the inner
  // loop is one branch + indexed lookup.
  const colorHex: string[] = [];
  const grayHex: string[] = [];
  for (const hex of thumb.palette) {
    const rgb = parseHex(hex);
    colorHex.push(`rgb(${rgb.r},${rgb.g},${rgb.b})`);
    const luma = Math.round(0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b);
    grayHex.push(`rgb(${luma},${luma},${luma})`);
  }

  const useFilled = !opts.completed && opts.filled && opts.sourceW && opts.sourceH;
  const filledArr = useFilled ? opts.filled! : null;
  const srcW = useFilled ? opts.sourceW! : 0;
  const srcH = useFilled ? opts.sourceH! : 0;

  for (let ty = 0; ty < thumb.h; ty++) {
    for (let tx = 0; tx < thumb.w; tx++) {
      const v = thumb.cells[ty * thumb.w + tx];
      if (v < 0) continue;
      let painted: boolean;
      if (opts.completed) {
        painted = true;
      } else if (filledArr) {
        // Nearest-neighbour from thumb (tx, ty) to source (sx, sy).
        const sx = Math.min(srcW - 1, Math.floor(((tx + 0.5) * srcW) / thumb.w));
        const sy = Math.min(srcH - 1, Math.floor(((ty + 0.5) * srcH) / thumb.h));
        painted = filledArr[sy * srcW + sx] !== 0;
      } else {
        painted = false;
      }
      ctx.fillStyle = painted
        ? colorHex[v] ?? grayHex[v] ?? '#c0c8d1'
        : grayHex[v] ?? '#c0c8d1';
      ctx.fillRect(offX + tx * blockPx, offY + ty * blockPx, blockPx, blockPx);
    }
  }
}

/**
 * Parse a `#rrggbb` (or `#rgb`) hex string into RGB triplet. Falls
 * back to grey on malformed input — the only place this is called
 * is renderThumb and a thumb with a malformed palette is a content-
 * pipeline bug we surface visually (grey blob) rather than throw.
 */
function parseHex(hex: string): { r: number; g: number; b: number } {
  if (!hex || hex[0] !== '#') return { r: 192, g: 192, b: 192 };
  const s = hex.slice(1);
  if (s.length === 3) {
    return {
      r: parseInt(s[0] + s[0], 16) || 0,
      g: parseInt(s[1] + s[1], 16) || 0,
      b: parseInt(s[2] + s[2], 16) || 0,
    };
  }
  if (s.length >= 6) {
    return {
      r: parseInt(s.slice(0, 2), 16) || 0,
      g: parseInt(s.slice(2, 4), 16) || 0,
      b: parseInt(s.slice(4, 6), 16) || 0,
    };
  }
  return { r: 192, g: 192, b: 192 };
}
