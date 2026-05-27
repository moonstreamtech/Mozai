/*
 * Content resolver — decides bundled vs cache vs network for any
 * content file path.
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
import { readCache, writeCache } from './content-cache.js';

export type ContentSource = 'bundled' | 'cache' | 'network' | 'FAILED';

export interface ResolveResult {
  /** Raw text payload. Empty string when source === 'FAILED'. */
  text: string;
  source: ContentSource;
}

// Retry knobs for the network path. Per-attempt timeout fires via
// AbortController (Chrome 66+, supported on the target Chrome 92
// WebView). Three attempts with 500/1000/2000ms backoff between
// them — total worst case is 3*8s + 500 + 1000 = ~25.5s, which is
// long but bounded.
const MAX_ATTEMPTS = 3;
const PER_ATTEMPT_TIMEOUT_MS = 8000;
const BACKOFF_BASE_MS = 500;

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
  if (isBundledPath(path)) {
    try {
      const res = await fetch(path, { cache: 'no-store' });
      if (!res.ok) return { text: '', source: 'FAILED' };
      const text = await res.text();
      return { text, source: 'bundled' };
    } catch {
      return { text: '', source: 'FAILED' };
    }
  }

  // Rooms 2+: cache first.
  const cacheKey = stripContentPrefix(path);
  const cached = await readCache(cacheKey);
  if (cached !== null) {
    return { text: cached, source: 'cache' };
  }

  // Network from CDN with retry + timeout. A flaky connection
  // (intermittent "Failed to fetch" between successful requests)
  // would previously fall through to offline on the first failure;
  // we now retry transient errors (network throws, 5xx) up to
  // MAX_ATTEMPTS times. A definitive 4xx (e.g. 404) is NOT retried —
  // that content genuinely isn't there.
  const cdnUrl = joinUrl(CDN_BASE, cacheKey);
  const fetchOutcome = await fetchWithRetry(cdnUrl);
  if (fetchOutcome.kind === 'ok') {
    const text = fetchOutcome.text;
    // Fire-and-forget cache write. The user has the content already;
    // a write failure (disk full, permission) shouldn't fail the
    // resolve.
    writeCache(cacheKey, text).catch(() => {});
    return { text, source: 'network' };
  }
  return { text: '', source: 'FAILED' };
}

type FetchOutcome =
  | { kind: 'ok'; text: string }
  | { kind: 'failed'; reason: string };

/**
 * Fetch with per-attempt timeout + small retry loop for transient
 * failures (network throws, 5xx). Definitive 4xx responses are
 * returned to the caller without retry — content genuinely isn't
 * there. The caller (resolveContent) treats any non-ok response
 * as a FAILED resolve.
 */
async function fetchWithRetry(url: string): Promise<FetchOutcome> {
  let lastReason = 'unknown';
  for (let k = 1; k <= MAX_ATTEMPTS; k++) {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), PER_ATTEMPT_TIMEOUT_MS);
    try {
      const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        const text = await res.text();
        return { kind: 'ok', text };
      }
      // 4xx (except 408 request-timeout, 429 too-many-requests) is
      // definitive — return without further retry. The caller will
      // surface this as offline / FAILED.
      const transient = res.status >= 500 || res.status === 408 || res.status === 429;
      if (!transient) {
        return { kind: 'failed', reason: `status ${res.status}` };
      }
      lastReason = `status ${res.status}`;
    } catch (err) {
      clearTimeout(timeoutId);
      // AbortError, "Failed to fetch", and other network errors all
      // land here. Treat them all as transient — they're exactly
      // the case the retry loop exists for.
      lastReason = (err as Error)?.message ?? String(err);
    }
    if (k < MAX_ATTEMPTS) {
      const wait = BACKOFF_BASE_MS * (1 << (k - 1)); // 500, 1000, 2000
      await sleep(wait);
    }
  }
  return { kind: 'failed', reason: `${lastReason} after ${MAX_ATTEMPTS} attempts` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
