/*
 * Progress persistence.
 *
 * Stores under one Capacitor Preferences key:
 *   mozai.progress = { version: 1, completed: { "<pictureId>": true, ... } }
 *
 * Why a single object rather than one key per picture: Preferences
 * write is a round-trip into the native bridge — batching keeps
 * "mark this puzzle complete" cheap and atomic. The completed map
 * also serialises trivially to JSON and is small enough that the
 * round-trip cost is negligible even at hundreds of pictures.
 *
 * `version` is included so a future schema change (e.g. tracking
 * partial progress per picture) can migrate the saved blob in
 * `load()` without losing the user's completion history.
 */

import { Preferences } from '@capacitor/preferences';
import type { ContentIndex } from './content.js';

const STORAGE_KEY = 'mozai.progress';
const CURRENT_VERSION = 1;

export interface ProgressData {
  version: number;
  completed: Record<string, true>;
}

let cache: ProgressData | null = null;

function emptyProgress(): ProgressData {
  return { version: CURRENT_VERSION, completed: {} };
}

/**
 * Load progress from native storage. Returns the cached copy on
 * subsequent calls so the room-select grid can render synchronously
 * after the first await.
 *
 * Corrupted / missing data is treated as a fresh install. This is the
 * sane default — a user with a broken progress blob would prefer to
 * "lose their progress" silently rather than have the app refuse to
 * boot.
 */
export async function load(): Promise<ProgressData> {
  if (cache) return cache;
  try {
    const { value } = await Preferences.get({ key: STORAGE_KEY });
    if (!value) {
      cache = emptyProgress();
      return cache;
    }
    const parsed = JSON.parse(value) as Partial<ProgressData>;
    cache = {
      version: typeof parsed.version === 'number' ? parsed.version : CURRENT_VERSION,
      completed:
        parsed.completed && typeof parsed.completed === 'object'
          ? (parsed.completed as Record<string, true>)
          : {},
    };
    return cache;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[Mozai] progress.load() failed — starting fresh.', err);
    cache = emptyProgress();
    return cache;
  }
}

/**
 * Synchronous check. Callers MUST have awaited `load()` at least once
 * before calling this — typically done once at app boot.
 */
export function isCompleted(id: string): boolean {
  return !!cache?.completed[id];
}

/**
 * Mark a picture complete and persist immediately. Safe to call
 * repeatedly with the same id — no-op when the id is already
 * complete.
 */
export async function markCompleted(id: string): Promise<void> {
  const p = cache ?? (await load());
  if (p.completed[id]) return;
  p.completed[id] = true;
  await Preferences.set({ key: STORAGE_KEY, value: JSON.stringify(p) });
}

/**
 * Number of completed pictures whose puzzle belongs to room N.
 * Resolved against the in-memory content index so the count stays
 * truthful even if the user previously completed pictures that have
 * since been removed from the content set.
 */
export function completedCountForRoom(roomN: number, index: ContentIndex): number {
  const list = index.rooms[String(roomN)];
  if (!list) return 0;
  let n = 0;
  for (const entry of list) {
    if (isCompleted(entry.id)) n++;
  }
  return n;
}

/**
 * Debug helper — marks an arbitrary picture complete so the % fill on
 * the room-select grid can be exercised without playing a real puzzle.
 * Exposed on `window.__mozaiDebug` only when MOZAI_DEBUG=1; never
 * referenced from production code paths.
 */
export async function debugMarkCompleted(id: string): Promise<void> {
  await markCompleted(id);
}

/**
 * Debug helper — wipe all progress. Useful for verifying the lock
 * logic without uninstalling the app.
 */
export async function debugReset(): Promise<void> {
  cache = emptyProgress();
  await Preferences.remove({ key: STORAGE_KEY });
}
