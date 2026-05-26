/*
 * Content loader.
 *
 * Reads `content/index.json` (built by scripts/build-content-index.mjs)
 * at app start. The index is intentionally LIGHTWEIGHT — just per-puzzle
 * metadata, not the cell data. Full puzzle JSONs are fetched lazily by
 * `loadPuzzle(id)` only when a picture is opened in the paint scene.
 *
 * Both fetches are served from `public/content/` which Vite copies
 * verbatim into the build output and Capacitor packages into
 * `android/app/src/main/assets/public/`. On native the `fetch()` call
 * resolves against the local file URL the WebView is served from, so
 * there is no network round-trip.
 */

import { bootLog } from './error-overlay.js';

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
 * Fetch the content index. Resolves base-relative so the same call
 * works in `npm run dev`, in `vite preview`, and inside the
 * Capacitor WebView (where the page lives at e.g.
 * `https://localhost/index.html`).
 *
 * Error messages include the attempted URL so the on-screen fatal
 * panel can show the developer exactly what the WebView tried to
 * fetch — "content/index.json fetch failed: 404" is far more
 * useful than a bare TypeError on device.
 */
export async function loadContentIndex(): Promise<ContentIndex> {
  const url = 'content/index.json';
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch (err) {
    throw new Error(`fetch('${url}') threw — ${(err as Error)?.message ?? err}`);
  }
  bootLog(`index status: ${res.status} (url=${res.url})`);
  if (!res.ok) {
    throw new Error(`fetch('${url}') status ${res.status}`);
  }
  let data: ContentIndex;
  try {
    data = (await res.json()) as ContentIndex;
  } catch (err) {
    throw new Error(`fetch('${url}') parse failed — ${(err as Error)?.message ?? err}`);
  }
  // Defensive: an empty / malformed index is a content pipeline bug.
  // Surface it loudly here rather than silently rendering an empty
  // room grid that looks like "the user has no progress".
  if (!data || typeof data.maxRoom !== 'number' || !data.rooms) {
    throw new Error(`fetch('${url}') returned malformed payload`);
  }
  return data;
}

/**
 * Fetch a single full puzzle JSON. Cached per id so re-opening the
 * same picture during a session doesn't re-hit storage. Sized for
 * lazy use by the paint scene — NOT called during the room-select
 * boot path.
 */
const puzzleCache = new Map<string, Puzzle>();

export async function loadPuzzle(meta: PuzzleMeta): Promise<Puzzle> {
  const cached = puzzleCache.get(meta.id);
  if (cached) return cached;
  const url = `content/room${meta.room}/${meta.id}.json`;
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch (err) {
    throw new Error(`fetch('${url}') threw — ${(err as Error)?.message ?? err}`);
  }
  if (!res.ok) {
    throw new Error(`fetch('${url}') status ${res.status}`);
  }
  const puzzle = (await res.json()) as Puzzle;
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
