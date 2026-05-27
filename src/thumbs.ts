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
export type ThumbMode = 'silhouette' | 'color';

/**
 * Paint `thumb` into `canvas` at its current backing-store size.
 *
 * The canvas's `width` and `height` attributes (backing-store pixels)
 * must be set by the caller BEFORE calling this — typically to
 * cssSize * devicePixelRatio so the thumb renders crisp at any
 * physical resolution. The function fills the entire canvas with
 * white first, then paints non-background cells as integer-sized
 * blocks. Pixel-perfect rendering relies on `image-rendering:
 * pixelated` on the canvas's CSS box (set in style.css).
 */
export function renderThumb(canvas: HTMLCanvasElement, thumb: Thumb, mode: ThumbMode): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const pxW = canvas.width;
  const pxH = canvas.height;
  if (pxW === 0 || pxH === 0) return;

  // Fill background — white in both modes; -1 cells just stay white
  // because we never overpaint them.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, pxW, pxH);

  // CONTAIN-fit the thumb inside the canvas. Block size is floored to
  // an integer so cell edges stay crisp (no half-pixel bleed at the
  // edges of a silhouette).
  const blockPx = Math.max(1, Math.floor(Math.min(pxW / thumb.w, pxH / thumb.h)));
  const drawnW = blockPx * thumb.w;
  const drawnH = blockPx * thumb.h;
  const offX = Math.floor((pxW - drawnW) / 2);
  const offY = Math.floor((pxH - drawnH) / 2);

  // Disable canvas-level smoothing for safety; we draw rectangles
  // ourselves at integer positions so this is belt-and-braces.
  ctx.imageSmoothingEnabled = false;

  // Silhouette tone — matches --scene-locked-bg roughly, dark enough
  // to read against white but neutral so the shape stands out.
  const silhouetteColor = '#c0c8d1';

  for (let y = 0; y < thumb.h; y++) {
    for (let x = 0; x < thumb.w; x++) {
      const v = thumb.cells[y * thumb.w + x];
      if (v < 0) continue; // background — leave white
      if (mode === 'silhouette') {
        ctx.fillStyle = silhouetteColor;
      } else {
        // Palette out-of-bounds shouldn't happen in well-formed thumbs
        // but fall back gracefully rather than throwing — a partial
        // render is better than no render.
        ctx.fillStyle = thumb.palette[v] ?? silhouetteColor;
      }
      ctx.fillRect(offX + x * blockPx, offY + y * blockPx, blockPx, blockPx);
    }
  }
}
