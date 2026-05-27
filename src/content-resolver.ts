/*
 * Content resolver — decides bundled vs cache vs network for any
 * content file path, with diagnostics in the 🐞 popup.
 *
 * Three resolution buckets:
 *
 *  1. BUNDLED  — `content/index.json` AND `content/room1/*`. Read
 *     from the local app assets via fetch(). Works fully offline.
 *     index.json is bundled because the home screen needs it
 *     synchronously; room1 is bundled so the entry-point puzzles
 *     play without a network on first launch.
 *
 *  2. CACHE    — `content/room<N>/*` for N >= 2, previously
 *     fetched from the CDN and stored under
 *     Directory.Data/mozai-cache/roomN/<file>. Read-through:
 *     populated on the first successful network fetch. No expiry
 *     (content is immutable per id; future migration via dir
 *     namespacing).
 *
 *  3. NETWORK  — `<CDN_BASE>/roomN/<file>` for N >= 2 not in the
 *     cache. On success the response is written to the cache
 *     async (fire-and-forget — the user already has the content).
 *
 * If all three fail (e.g. cache miss + network down on first room-2+
 * open), resolve returns `{ source: 'FAILED' }`. Scenes that catch
 * this surface a localized "needs internet" message + retry button
 * rather than crashing or rendering blank.
 *
 * The resolver does NOT throw on its own — every failure is a
 * `source: 'FAILED'` return. Callers throw `ContentResolveError`
 * (defined in content.ts) so the scene's catch block can
 * distinguish "no content available" from a JSON parse error.
 */

import { CDN_BASE } from './env.js';
import { diagLog } from './error-overlay.js';
import { readCache, writeCache } from './content-cache.js';

export type ContentSource = 'bundled' | 'cache' | 'network' | 'FAILED';

export interface ResolveResult {
  /** Raw text payload. Empty string when source === 'FAILED'. */
  text: string;
  source: ContentSource;
}

/**
 * Is this content path served from the bundled app assets?
 *   - `content/index.json`               (boot index)
 *   - `content/room1/<anything>`         (entry-point room)
 * Everything else is rooms 2+ and goes through cache+network.
 */
function isBundledPath(path: string): boolean {
  if (path === 'content/index.json') return true;
  if (path.startsWith('content/room1/')) return true;
  return false;
}

/**
 * Strip the leading `content/` prefix from a path. The CDN and the
 * filesystem cache both use the `roomN/...` form (no `content/`
 * prefix); only the bundled assets and the WebView's local server
 * use `content/`. Keeping this conversion in one place stops the
 * mismatch from leaking into individual call sites.
 */
function stripContentPrefix(path: string): string {
  return path.startsWith('content/') ? path.slice('content/'.length) : path;
}

/** Concatenate base + path with exactly one slash, no doubles. */
function joinUrl(base: string, path: string): string {
  const b = base.endsWith('/') ? base : `${base}/`;
  const p = path.startsWith('/') ? path.slice(1) : path;
  return `${b}${p}`;
}

export async function resolveContent(path: string): Promise<ResolveResult> {
  const start = Date.now();

  if (isBundledPath(path)) {
    try {
      const res = await fetch(path, { cache: 'no-store' });
      if (!res.ok) {
        diagLog(
          `content resolve ${path}: source=bundled ok=false status=${res.status} ms=${Date.now() - start}`,
        );
        return { text: '', source: 'FAILED' };
      }
      const text = await res.text();
      diagLog(
        `content resolve ${path}: source=bundled ok=true ms=${Date.now() - start}`,
      );
      return { text, source: 'bundled' };
    } catch (err) {
      diagLog(
        `content resolve ${path}: source=bundled ok=false err=${(err as Error)?.message ?? err} ms=${Date.now() - start}`,
      );
      return { text: '', source: 'FAILED' };
    }
  }

  // Rooms 2+: cache first.
  const cacheKey = stripContentPrefix(path);
  const cached = await readCache(cacheKey);
  if (cached !== null) {
    diagLog(
      `content resolve ${path}: source=cache ok=true ms=${Date.now() - start}`,
    );
    return { text: cached, source: 'cache' };
  }

  // Network from CDN.
  const cdnUrl = joinUrl(CDN_BASE, cacheKey);
  try {
    diagLog(`content fetch: ${cdnUrl}`);
    const res = await fetch(cdnUrl, { cache: 'no-store' });
    diagLog(`content status: ${res.status} for ${cdnUrl}`);
    if (!res.ok) {
      diagLog(
        `content offline: ${path} no cache, network status ${res.status}`,
      );
      return { text: '', source: 'FAILED' };
    }
    const text = await res.text();
    // Fire-and-forget cache write. The user has the content already;
    // a write failure (disk full, permission) shouldn't fail the
    // resolve. Log so future debug sessions can tell.
    writeCache(cacheKey, text).catch((err) => {
      diagLog(
        `cache write failed for ${cacheKey}: ${(err as Error)?.message ?? err}`,
      );
    });
    diagLog(
      `content resolve ${path}: source=network ok=true ms=${Date.now() - start}`,
    );
    return { text, source: 'network' };
  } catch (err) {
    diagLog(
      `content offline: ${path} no cache, no network (${(err as Error)?.message ?? err})`,
    );
    return { text: '', source: 'FAILED' };
  }
}
