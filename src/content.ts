/*
 * Content loader.
 *
 * Reads `content/index.json` (built by scripts/build-content-index.mjs)
 * at app start, and individual puzzle JSONs on demand. Both go
 * through src/content-resolver.ts which picks bundled vs cache vs
 * network:
 *   - index.json is ALWAYS bundled (boot has no network dependency)
 *   - room1/* is ALWAYS bundled (entry-point room plays offline)
 *   - room2+/*  is cache-first, then CDN, then a localized
 *     "roomLoadFailed" fallback at the scene layer
 *
 * `ContentResolveError` is thrown when the resolver returns
 * source='FAILED'. The scene-room / scene-paint catch blocks
 * surface it via a neutral "couldn't load" message + Retry; we
 * deliberately don't try to distinguish offline from schema-drift
 * in the UI, since either case routes through the same Retry path
 * and miscategorising the cause (the old "internet required" copy
 * vs a truly-corrupt-cache scenario) misled users.
 */

import { resolveContent, type ValidatorResult } from './content-resolver.js';

export interface PuzzleMeta {
  id: string;
  room: number;
  w: number;
  h: number;
  colors: number;
  paintableCells: number;
}

export interface ContentIndex {
  maxRoom: number;
  rooms: Record<string, PuzzleMeta[]>;
}

/** Full puzzle payload returned by `loadPuzzle(id)`. */
export interface Puzzle {
  id: string;
  room: number;
  difficulty: number;
  w: number;
  h: number;
  palette: string[];
  /** Flat array of length w*h. -1 = background / outside silhouette. */
  cells: number[];
  colorCounts: Record<string, number>;
  paintableCells: number;
}

/**
 * Thrown when the resolver could not produce content for a path —
 * cache miss + network failure for rooms 2+, validation failure on
 * a fetched body, or a missing bundled file for room 1 /
 * index.json.
 *
 * Carries both:
 *   • `path`   — full content path the loader tried
 *   • `reason` — short snake-case code from the resolver
 *                 (e.g. `validation:cells_length_mismatch`,
 *                  `network:404`, `network:timeout`)
 *
 * Scenes catch this and surface the neutral `roomLoadFailed`
 * message + the reason code in a smaller sub-line, so a
 * device-side debug session can see the precise cause without
 * needing the removed debug overlay back.
 */
export class ContentResolveError extends Error {
  readonly path: string;
  readonly reason: string;
  constructor(path: string, reason: string) {
    super(`Content unavailable: ${path} (${reason})`);
    this.name = 'ContentResolveError';
    this.path = path;
    this.reason = reason;
  }
}

/**
 * Hex colour regex used by every palette validator. Strict 6-digit
 * form — the prebuild generator only emits #rrggbb so anything else
 * (truncated `#fff`, alpha `#rrggbbaa`, RGBA tuples) is a sign of
 * corruption.
 */
const HEX6_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Validate + normalise raw puzzle JSON text. Used by loadPuzzle via
 * the resolver — runs on both cache hits and network responses so a
 * malformed body is detected the first place it could possibly
 * cause downstream damage.
 *
 * The validator is intentionally LOOSE on metadata fields: only the
 * fields strictly required to render the puzzle safely are gated.
 * Older sample JSONs (committed before validation existed) and any
 * future variant that omits informational fields still pass.
 *
 * REQUIRED — null returned if any of these fail:
 *   • JSON.parse succeeds
 *   • w, h are positive integers and w === h
 *   • palette is an array of >= 1 #rrggbb strings
 *   • cells is an array of length w*h
 *   • every cell is an integer, either -1 or 0 <= v < palette.length
 *
 * OPTIONAL — back-filled / warned about, NOT a reason to reject:
 *   • id (string)              — loadPuzzle overrides from meta
 *   • room (number)            — loadPuzzle overrides from meta
 *   • difficulty (number)      — defaults to 1
 *   • paintableCells (number)  — warn on mismatch, use computed value
 *   • colorCounts (object)     — computed when absent, accepted as-is
 *
 * Returns the normalised Puzzle on success, or null on hard
 * validation failure. Both paths console.warn with the reason and
 * the file path so a follow-up on-device debug session can tell
 * "network" from "content schema" at a glance.
 */
export function validatePuzzleText(text: string, path: string): ValidatorResult<Puzzle> {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    return fail(path, 'validation:json_parse', (err as Error)?.message ?? String(err));
  }
  if (!obj || typeof obj !== 'object') {
    return fail(path, 'validation:not_object');
  }
  const p = obj as Record<string, unknown>;

  const w = p.w;
  const h = p.h;
  if (typeof w !== 'number' || !Number.isInteger(w) || w <= 0) {
    return fail(path, 'validation:bad_w', String(w));
  }
  if (typeof h !== 'number' || !Number.isInteger(h) || h <= 0) {
    return fail(path, 'validation:bad_h', String(h));
  }
  if (w !== h) {
    return fail(path, 'validation:w_neq_h', `${w}!=${h}`);
  }

  if (!Array.isArray(p.palette)) {
    return fail(path, 'validation:no_palette');
  }
  if (p.palette.length === 0) {
    return fail(path, 'validation:empty_palette');
  }
  for (let i = 0; i < p.palette.length; i++) {
    const c = p.palette[i];
    if (typeof c !== 'string' || !HEX6_RE.test(c)) {
      return fail(path, 'validation:bad_palette_entry', `[${i}]=${String(c)}`);
    }
  }
  const paletteLen = p.palette.length;

  if (!Array.isArray(p.cells)) {
    return fail(path, 'validation:no_cells');
  }
  const expectedLen = w * h;
  if (p.cells.length !== expectedLen) {
    return fail(path, 'validation:cells_length_mismatch', `${p.cells.length}!=${expectedLen}`);
  }
  let computedPaintable = 0;
  const computedColorCounts: Record<string, number> = {};
  const cells = p.cells as unknown[];
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i];
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      return fail(path, 'validation:bad_cell_value', `[${i}]=${String(v)}`);
    }
    if (v === -1) continue;
    if (v < 0 || v >= paletteLen) {
      return fail(path, 'validation:cell_out_of_range', `[${i}]=${v} palette=${paletteLen}`);
    }
    computedPaintable++;
    const key = String(v);
    computedColorCounts[key] = (computedColorCounts[key] ?? 0) + 1;
  }

  // Optional: paintableCells. Warn on mismatch, but ALWAYS use the
  // computed value — declared count from older / hand-written
  // puzzles can drift, and rendering correctness should track the
  // actual cell array.
  if (typeof p.paintableCells === 'number' && p.paintableCells !== computedPaintable) {
    // eslint-disable-next-line no-console
    console.warn(
      `[mozai] puzzle ${path}: paintableCells declared=${p.paintableCells} computed=${computedPaintable}; using computed value`,
    );
  }

  // Build normalised Puzzle. id/room get default empty/zero values
  // here — loadPuzzle overrides them with the meta values supplied
  // by the content index. That way the puzzle JSON does NOT need
  // to carry id/room — they're informational only.
  const normalised: Puzzle = {
    id: typeof p.id === 'string' ? p.id : '',
    room: typeof p.room === 'number' && Number.isInteger(p.room) && p.room > 0 ? p.room : 0,
    difficulty:
      typeof p.difficulty === 'number' && Number.isFinite(p.difficulty) ? p.difficulty : 1,
    w,
    h,
    palette: p.palette as string[],
    cells: p.cells as number[],
    colorCounts:
      p.colorCounts && typeof p.colorCounts === 'object'
        ? (p.colorCounts as Record<string, number>)
        : computedColorCounts,
    paintableCells: computedPaintable,
  };
  return { ok: true, value: normalised };
}

function fail(path: string, reason: string, detail?: string): ValidatorResult<never> {
  // eslint-disable-next-line no-console
  console.warn(
    `[mozai] puzzle validation failed for ${path} — ${reason}${detail ? ` (${detail})` : ''}`,
  );
  return { ok: false, reason };
}

/**
 * Fetch the content index. ALWAYS bundled — never fetched from the
 * CDN — so the home screen renders on a cold boot with no network.
 */
export async function loadContentIndex(): Promise<ContentIndex> {
  const path = 'content/index.json';
  const result = await resolveContent(path);
  if (result.source === 'FAILED') {
    throw new ContentResolveError(path, result.reason ?? 'unknown');
  }
  let data: ContentIndex;
  try {
    data = JSON.parse(result.text) as ContentIndex;
  } catch (err) {
    throw new Error(`${path} parse failed — ${(err as Error)?.message ?? err}`);
  }
  // Defensive: an empty / malformed index is a content-pipeline bug.
  if (!data || typeof data.maxRoom !== 'number' || !data.rooms) {
    throw new Error(`${path} returned malformed payload`);
  }
  return data;
}

/**
 * Fetch a single full puzzle JSON. In-memory cache per id so
 * re-opening the same picture during a session doesn't re-hit
 * storage. Underlying read is bundled (room1) or
 * cache-then-network (rooms 2+) via resolveContent, with
 * validatePuzzleText gating both cache reads and cache writes.
 *
 * The validator returns the fully normalised Puzzle (parsed,
 * back-filled, range-checked) on the resolver's `parsed` slot, so
 * loadPuzzle never re-parses. We override `id` and `room` with the
 * meta values from the content index — those are the source of
 * truth in the running app, and treating them as required in the
 * JSON itself blocked older sample files that omit them.
 *
 * Throws ContentResolveError when offline + uncached OR when the
 * fetched body fails validation (treated equivalently — the user
 * cannot proceed with this puzzle either way). The validator
 * console.warn's the precise reason before returning null, so the
 * connected-device log shows "validation failed" vs the resolver's
 * own "FAILED" rather than the user just seeing a generic offline
 * panel.
 */
const puzzleCache = new Map<string, Puzzle>();

export async function loadPuzzle(meta: PuzzleMeta): Promise<Puzzle> {
  const cached = puzzleCache.get(meta.id);
  if (cached) return cached;
  const path = `content/room${meta.room}/${meta.id}.json`;
  const result = await resolveContent(path, { validate: validatePuzzleText });
  if (result.source === 'FAILED' || !result.parsed) {
    throw new ContentResolveError(path, result.reason ?? 'unknown');
  }
  // Override id/room with the meta values — the content index is
  // the source of truth in the running app, and the JSON file's
  // own id/room (if present) are informational only.
  const puzzle: Puzzle = {
    ...(result.parsed as Puzzle),
    id: meta.id,
    room: meta.room,
  };
  puzzleCache.set(meta.id, puzzle);
  return puzzle;
}

/**
 * Lock rule from the spec:
 *   Room 1 is always open.
 *   Room K (K >= 2) is unlocked iff completedCountForRoom(K-1) >= K.
 *
 * The "progress" callback is passed in (rather than imported from
 * progress.ts directly) so this function stays pure-ish and trivially
 * testable.
 */
export function isRoomUnlocked(
  roomN: number,
  completedInRoom: (n: number) => number,
): boolean {
  if (roomN <= 1) return true;
  return completedInRoom(roomN - 1) >= roomN;
}
