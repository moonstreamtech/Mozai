/*
 * Room-level puzzle prefetch.
 *
 * When the user enters a room (room-interior scene) we kick off a
 * background download of every puzzle JSON in that room. The
 * silhouettes are shown immediately from thumbs.json; full puzzles
 * stream in concurrently and get written to the Filesystem cache
 * via the same resolver path that loadPuzzle uses. After the
 * prefetch finishes, every picture in the room opens offline.
 *
 * Concurrency is intentionally low (2). The target connection on
 * many devices is flaky enough that hammering it with 10 parallel
 * requests would just trigger more retries. Two-at-a-time still
 * finishes a 30-puzzle room in well under a minute on a healthy
 * link, and is gentle on a poor one.
 *
 * onItem is fired after EACH puzzle settles (ok or failed) so the
 * scene can update a "downloading … N/M" indicator in real time.
 * The returned promise resolves with the aggregate ok/failed
 * counts after the entire queue drains.
 *
 * Room 1 is bundled, so loadPuzzle resolves from local assets
 * essentially instantly. We still run prefetch on it so the
 * in-memory puzzleCache fills (tap → open is then a pure cache
 * hit) — the cost is negligible and the code stays uniform.
 */

import { loadPuzzle, type PuzzleMeta } from './content.js';

const DEFAULT_CONCURRENCY = 2;

export interface PrefetchResult {
  ok: number;
  failed: number;
}

export async function prefetchPuzzles(
  metas: PuzzleMeta[],
  opts?: {
    concurrency?: number;
    onItem?: (ok: boolean, meta: PuzzleMeta) => void;
    /** Optional bail-out flag. Caller sets to true on scene teardown. */
    isCancelled?: () => boolean;
  },
): Promise<PrefetchResult> {
  const concurrency = Math.max(1, opts?.concurrency ?? DEFAULT_CONCURRENCY);
  const onItem = opts?.onItem;
  const isCancelled = opts?.isCancelled ?? (() => false);

  let ok = 0;
  let failed = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < metas.length) {
      if (isCancelled()) return;
      const meta = metas[cursor++];
      if (!meta) return;
      try {
        await loadPuzzle(meta);
        if (isCancelled()) return;
        ok++;
        onItem?.(true, meta);
      } catch {
        if (isCancelled()) return;
        failed++;
        onItem?.(false, meta);
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return { ok, failed };
}
