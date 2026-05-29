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

import { resolveContent, fetchFromCdn, type ValidatorResult } from './content-resolver.js';
import { ContentResolveError } from './content.js';
import { emitContentEvent } from './content-events.js';

export interface Thumb {
  w: number;
  h: number;
  palette: string[];
  /** Flat row-major array of length w*h. -1 = background / outside silhouette. */
  cells: number[];
}

export type ThumbBundle = Record<string, Thumb>;

const HEX6_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Validate + normalise raw thumbs.json text. Used by loadRoomThumbs
 * via the resolver — runs on both cache hits and network responses
 * so a malformed thumbs blob is detected before it can poison the
 * cache or render.
 *
 * Same loose-but-safe rule the puzzle validator uses: only the
 * structurally required fields gate the validation. Each entry
 * needs positive integer w, h with w === h, a palette of >= 1
 * #rrggbb strings, and cells of length w*h with values -1 or in
 * palette range. Partial credit is NOT allowed — a single bad
 * entry invalidates the whole bundle, since the room scene needs
 * every thumb to render its tiles.
 *
 * Returns the validated ThumbBundle on success, or null on hard
 * failure. console.warn's the failing entry + reason + path before
 * returning null so on-device debugging can tell schema drift
 * from a network problem.
 */
export function validateThumbsText(text: string, path: string): ValidatorResult<ThumbBundle> {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    return failT(path, 'validation:json_parse', (err as Error)?.message ?? String(err));
  }
  if (!obj || typeof obj !== 'object') {
    return failT(path, 'validation:not_object');
  }
  const bundle = obj as Record<string, unknown>;
  const out: ThumbBundle = {};
  for (const key of Object.keys(bundle)) {
    const r = validateThumb(bundle[key], path, key);
    if (!r.ok) return r;
    out[key] = r.value;
  }
  return { ok: true, value: out };
}

function validateThumb(obj: unknown, path: string, key: string): ValidatorResult<Thumb> {
  if (!obj || typeof obj !== 'object') {
    return failT(path, 'validation:thumb_not_object', key);
  }
  const t = obj as Record<string, unknown>;
  if (typeof t.w !== 'number' || !Number.isInteger(t.w) || t.w <= 0) {
    return failT(path, 'validation:bad_w', `${key} ${String(t.w)}`);
  }
  if (typeof t.h !== 'number' || !Number.isInteger(t.h) || t.h <= 0) {
    return failT(path, 'validation:bad_h', `${key} ${String(t.h)}`);
  }
  if (t.w !== t.h) {
    return failT(path, 'validation:w_neq_h', `${key} ${t.w}!=${t.h}`);
  }
  if (!Array.isArray(t.palette)) {
    return failT(path, 'validation:no_palette', key);
  }
  if (t.palette.length === 0) {
    return failT(path, 'validation:empty_palette', key);
  }
  for (let i = 0; i < t.palette.length; i++) {
    const c = t.palette[i];
    if (typeof c !== 'string' || !HEX6_RE.test(c)) {
      return failT(path, 'validation:bad_palette_entry', `${key}[${i}]=${String(c)}`);
    }
  }
  const paletteLen = t.palette.length;
  if (!Array.isArray(t.cells)) {
    return failT(path, 'validation:no_cells', key);
  }
  const expected = (t.w as number) * (t.h as number);
  if (t.cells.length !== expected) {
    return failT(path, 'validation:cells_length_mismatch', `${key} ${t.cells.length}!=${expected}`);
  }
  for (let i = 0; i < t.cells.length; i++) {
    const v = t.cells[i];
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      return failT(path, 'validation:bad_cell_value', `${key}[${i}]=${String(v)}`);
    }
    if (v === -1) continue;
    if (v < 0 || v >= paletteLen) {
      return failT(path, 'validation:cell_out_of_range', `${key}[${i}]=${v} palette=${paletteLen}`);
    }
  }
  return {
    ok: true,
    value: {
      w: t.w as number,
      h: t.h as number,
      palette: t.palette as string[],
      cells: t.cells as number[],
    },
  };
}

function failT(path: string, reason: string, detail?: string): ValidatorResult<never> {
  // eslint-disable-next-line no-console
  console.warn(
    `[mozai] thumbs validation failed for ${path} — ${reason}${detail ? ` (${detail})` : ''}`,
  );
  return { ok: false, reason };
}

const bundleCache = new Map<number, Promise<ThumbBundle>>();

/**
 * Fetch (and cache) a room's thumbs.json — STALE-WHILE-REVALIDATE.
 *
 * First call returns the bundled / cached value INSTANTLY (the
 * room scene renders without waiting for the network), then a
 * background CDN fetch runs in parallel. If the live thumbs differ
 * from what we just returned, the in-memory bundleCache is updated
 * AND a 'thumbs-updated' event is dispatched on the content-events
 * bus so scene-room can append new tiles, remove removed ones, and
 * update changed ones without rebuilding the entire grid.
 *
 * Coalesced via the existing bundleCache (in-flight promise stored
 * there) plus a per-room revalidate map below, so a tight burst
 * of loadRoomThumbs(N) calls only triggers one network fetch AND
 * one revalidate.
 *
 * Revalidate failure is silent (no thrown error reaches the user).
 */
const lastBundleSerialised = new Map<number, string>();
const thumbsRevalidateInFlight = new Map<number, Promise<void>>();

export function loadRoomThumbs(roomN: number): Promise<ThumbBundle> {
  const cached = bundleCache.get(roomN);
  if (cached) {
    // Even on cache hit (within session) we want to kick off a
    // revalidate — the first call already did, but a subsequent
    // call from a different scene mount should ALSO see updates.
    // The revalidate's own in-flight coalescing makes this cheap.
    void revalidateThumbsInBackground(roomN);
    return cached;
  }
  const path = `content/room${roomN}/thumbs.json`;
  // A rejected promise is EVICTED from bundleCache so a retry from
  // the scene actually re-runs the resolver.
  const p = resolveContent(path, { validate: validateThumbsText })
    .then((result) => {
      if (result.source === 'FAILED' || !result.parsed) {
        throw new ContentResolveError(path, result.reason ?? 'unknown');
      }
      const bundle = result.parsed as ThumbBundle;
      lastBundleSerialised.set(roomN, JSON.stringify(bundle));
      // Fire-and-forget background revalidate.
      void revalidateThumbsInBackground(roomN);
      return bundle;
    })
    .catch((err) => {
      bundleCache.delete(roomN);
      throw err;
    });
  bundleCache.set(roomN, p);
  return p;
}

/**
 * Background revalidate for a room's thumbs. Always reaches the
 * CDN. Coalesced per room so multiple loadRoomThumbs(N) calls in
 * quick succession only trigger one network fetch.
 *
 * On detected change: updates the in-memory bundleCache so
 * subsequent loadRoomThumbs(N) within this session returns the
 * fresh bundle, AND emits 'thumbs-updated' so the currently
 * mounted scene-room can re-render the diff.
 */
async function revalidateThumbsInBackground(roomN: number): Promise<void> {
  const existing = thumbsRevalidateInFlight.get(roomN);
  if (existing) return existing;
  const path = `content/room${roomN}/thumbs.json`;
  const promise = (async () => {
    try {
      const result = await fetchFromCdn(path, { validate: validateThumbsText });
      if (result.source !== 'network' || !result.parsed) return;
      const fresh = result.parsed as ThumbBundle;
      const freshSerialised = JSON.stringify(fresh);
      if (freshSerialised === lastBundleSerialised.get(roomN)) return;
      lastBundleSerialised.set(roomN, freshSerialised);
      // Update bundleCache so subsequent loadRoomThumbs(N) within
      // this session returns the fresh bundle. We replace the
      // promise (not its resolved value) so the cache stays
      // promise-shaped end-to-end.
      bundleCache.set(roomN, Promise.resolve(fresh));
      emitContentEvent('thumbs-updated', { roomN, bundle: fresh });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[mozai] thumbs revalidate failed for room ${roomN}:`, err);
    } finally {
      thumbsRevalidateInFlight.delete(roomN);
    }
  })();
  thumbsRevalidateInFlight.set(roomN, promise);
  return promise;
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
