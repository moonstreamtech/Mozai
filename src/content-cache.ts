/*
 * Content cache — Filesystem-backed read-through cache for
 * non-bundled puzzle content (rooms 2+).
 *
 * Layout under Capacitor's Directory.Data:
 *   mozai-cache/room2/r2-001.json
 *   mozai-cache/room2/thumbs.json
 *   mozai-cache/room100/r100-001.json
 *   ...
 *
 * Path mirrors the CDN / bundled `roomN/<file>` layout 1:1, so a
 * single key string flows through the resolver unchanged.
 *
 * No expiry: puzzle content is immutable per id (once a picture
 * with id `rN-MMM` is published to the CDN it never changes). A
 * future migration can clear the cache by version-namespacing the
 * directory (e.g. mozai-cache/v2/) — the simplicity-now-vs-
 * future-migration trade-off is documented here so a reader
 * doesn't think "why no ETag?".
 *
 * Read returns null on any failure (file not found, permission, IO
 * error). The resolver treats null as cache-miss and tries the
 * network — better to re-fetch than to crash on a transient FS
 * hiccup.
 */

import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

const CACHE_DIR = 'mozai-cache';

/** Read a cached content file. Returns null on miss / error. */
export async function readCache(relPath: string): Promise<string | null> {
  try {
    const result = await Filesystem.readFile({
      path: `${CACHE_DIR}/${relPath}`,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
    return typeof result.data === 'string' ? result.data : null;
  } catch {
    // Most common reason: file simply doesn't exist (cache miss).
    // We deliberately don't distinguish from harder errors here —
    // resolver always tries network next.
    return null;
  }
}

/**
 * Write a content file to the cache. Ensures the parent directory
 * exists (Filesystem.mkdir is recursive on Capacitor but still
 * throws "already exists" — we ignore that).
 *
 * Errors propagate to the caller, which can decide whether to log
 * and continue or surface to the user. The current resolver
 * fire-and-forgets: a failed cache write doesn't fail the resolve
 * (the user already has the freshly-fetched content).
 */
export async function writeCache(relPath: string, content: string): Promise<void> {
  const fullPath = `${CACHE_DIR}/${relPath}`;
  const lastSlash = fullPath.lastIndexOf('/');
  if (lastSlash > 0) {
    const parentDir = fullPath.slice(0, lastSlash);
    try {
      await Filesystem.mkdir({
        path: parentDir,
        directory: Directory.Data,
        recursive: true,
      });
    } catch {
      // Already exists — that's the success case for an existing dir.
    }
  }
  await Filesystem.writeFile({
    path: fullPath,
    directory: Directory.Data,
    data: content,
    encoding: Encoding.UTF8,
  });
}

/**
 * Evict a cached file. Best-effort: missing-file errors are swallowed
 * (the cache is already in the desired state). Used by the resolver
 * when a cache read returns content that fails its validator — that
 * blob is corrupt and must not be re-served, so we drop it and fall
 * through to the network on the next read.
 */
export async function clearCache(relPath: string): Promise<void> {
  try {
    await Filesystem.deleteFile({
      path: `${CACHE_DIR}/${relPath}`,
      directory: Directory.Data,
    });
  } catch {
    // File didn't exist or delete failed — fine.
  }
}
