/*
 * Content loader.
 *
 * Reads `content/index.json` (built by scripts/build-content-index.mjs)
 * at app start, and individual puzzle JSONs on demand. Both go
 * through src/content-resolver.ts which picks bundled vs cache vs
 * network:
 *   - index.json is ALWAYS bundled (boot has no network dependency)
 *   - room1/* is ALWAYS bundled (entry-point room plays offline)
 *   - room2+/*  is cache-first, then CDN, then a localized "needs
 *     internet" fallback at the scene layer
 *
 * `ContentResolveError` is thrown when the resolver returns
 * source='FAILED'. The scene-room / scene-paint catch blocks check
 * for this specific error class and render the i18n "needsInternet"
 * panel + a Retry button, rather than the generic "could not load"
 * message.
 */

import { resolveContent } from './content-resolver.js';

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
 * Thrown when the resolver could not produce content for a path
 * (cache miss + network failure for rooms 2+, or a missing bundled
 * file for room 1 / index.json). Scenes catch this specifically
 * and render the i18n "needsInternet" panel; any other error is a
 * parse / data bug surfaced via the existing couldNotLoad strings.
 */
export class ContentResolveError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`Content unavailable: ${path}`);
    this.name = 'ContentResolveError';
    this.path = path;
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
 * Validate raw puzzle JSON text. Used both by loadPuzzle (post
 * resolve) and by resolveContent itself (pre-cache-write / cache
 * read) so a malformed body is detected the first place it could
 * possibly cause downstream damage.
 *
 * Returns true iff:
 *   • JSON.parse succeeds
 *   • required fields are present and correctly typed
 *   • w === h, both positive integers
 *   • cells.length === w*h
 *   • every cell is an integer; either -1 or 0 ≤ v < palette.length
 *   • palette entries match HEX6_RE
 *   • paintableCells (if present) equals the count of non -1 cells
 *
 * A truncated body almost always trips JSON.parse; a body that
 * happens to parse but lost data in transit trips the length check.
 * No partial credit — a single failure invalidates the file.
 */
export function validatePuzzleText(text: string): boolean {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return false;
  }
  if (!obj || typeof obj !== 'object') return false;
  const p = obj as Record<string, unknown>;
  if (typeof p.id !== 'string' || p.id.length === 0) return false;
  if (typeof p.room !== 'number' || !Number.isInteger(p.room) || p.room <= 0) return false;
  if (typeof p.w !== 'number' || !Number.isInteger(p.w) || p.w <= 0) return false;
  if (typeof p.h !== 'number' || !Number.isInteger(p.h) || p.h <= 0) return false;
  if (p.w !== p.h) return false;
  if (!Array.isArray(p.palette)) return false;
  for (const c of p.palette) {
    if (typeof c !== 'string' || !HEX6_RE.test(c)) return false;
  }
  const paletteLen = p.palette.length;
  if (paletteLen === 0) return false;
  if (!Array.isArray(p.cells)) return false;
  const expectedLen = (p.w as number) * (p.h as number);
  if (p.cells.length !== expectedLen) return false;
  let paintable = 0;
  for (const v of p.cells) {
    if (typeof v !== 'number' || !Number.isInteger(v)) return false;
    if (v === -1) continue;
    if (v < 0 || v >= paletteLen) return false;
    paintable++;
  }
  if (typeof p.paintableCells === 'number') {
    if (p.paintableCells !== paintable) return false;
  }
  return true;
}

/**
 * Fetch the content index. ALWAYS bundled — never fetched from the
 * CDN — so the home screen renders on a cold boot with no network.
 */
export async function loadContentIndex(): Promise<ContentIndex> {
  const path = 'content/index.json';
  const result = await resolveContent(path);
  if (result.source === 'FAILED') {
    throw new ContentResolveError(path);
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
 * Throws ContentResolveError when offline + uncached AND when a
 * fetched body fails validation (treated equivalently — the user
 * cannot proceed with this puzzle).
 */
const puzzleCache = new Map<string, Puzzle>();

export async function loadPuzzle(meta: PuzzleMeta): Promise<Puzzle> {
  const cached = puzzleCache.get(meta.id);
  if (cached) return cached;
  const path = `content/room${meta.room}/${meta.id}.json`;
  const result = await resolveContent(path, { validate: validatePuzzleText });
  if (result.source === 'FAILED') {
    throw new ContentResolveError(path);
  }
  // The resolver already validated, so JSON.parse is guaranteed to
  // succeed here. Wrapping in try/catch belt-and-braces against any
  // future refactor that loosens the validator.
  let puzzle: Puzzle;
  try {
    puzzle = JSON.parse(result.text) as Puzzle;
  } catch (err) {
    throw new Error(`${path} parse failed — ${(err as Error)?.message ?? err}`);
  }
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
