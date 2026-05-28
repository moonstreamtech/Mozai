/*
 * Content resolver — decides bundled vs cache vs network for any
 * content file path, with integrity guarantees against truncated
 * or malformed bodies.
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
 * Integrity:
 *   • If the caller supplies a `validate` function (the recommended
 *     pattern for every content type), the resolver runs it on the
 *     text payload before treating it as valid. A failed validator
 *     on the cache path EVICTS the corrupt blob and falls through
 *     to network; a failed validator on the network path SKIPS the
 *     cache write and returns FAILED. The cache is therefore
 *     guaranteed to only ever hold content that passed validation
 *     at write time.
 *   • The network path also checks Content-Length when the server
 *     supplies one — a truncated body (bytes received ≠ advertised)
 *     is treated as a transient failure and retried.
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
import { readCache, writeCache, clearCache } from './content-cache.js';

export type ContentSource = 'bundled' | 'cache' | 'network' | 'FAILED';

export interface ResolveResult {
  /** Raw text payload. Empty string when source === 'FAILED'. */
  text: string;
  /**
   * Validator's normalised return value, set only when a validator
   * was provided AND it returned a non-null value. Callers can
   * down-cast directly instead of re-parsing the text.
   */
  parsed?: unknown;
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

export interface ResolveOptions {
  /**
   * Optional content validator + normaliser. Runs on the text
   * payload after a cache hit and after a network fetch.
   *
   *   • Returns a non-null value → content is valid. The resolver
   *     attaches the returned value to `ResolveResult.parsed` so
   *     callers don't need to re-parse. Typically the value is a
   *     fully validated AND normalised domain object (e.g. a
   *     Puzzle with any optional fields back-filled from
   *     computation).
   *   • Returns `null` → content is invalid. cache-hit → evict
   *     entry and fall through to network. network-ok → don't
   *     write cache, return FAILED.
   *
   * The optional `path` argument is the same content path the
   * caller passed to resolveContent — useful for log messages
   * inside the validator.
   */
  validate?: (text: string, path: string) => unknown | null;
}

export async function resolveContent(
  path: string,
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  const validate = opts.validate;

  if (isBundledPath(path)) {
    try {
      const res = await fetch(path, { cache: 'no-store' });
      if (!res.ok) return { text: '', source: 'FAILED' };
      const text = await res.text();
      if (validate) {
        const parsed = validate(text, path);
        if (parsed === null) return { text: '', source: 'FAILED' };
        return { text, parsed, source: 'bundled' };
      }
      return { text, source: 'bundled' };
    } catch {
      return { text: '', source: 'FAILED' };
    }
  }

  // Rooms 2+: cache first.
  const cacheKey = stripContentPrefix(path);
  const cached = await readCache(cacheKey);
  if (cached !== null) {
    if (validate) {
      const parsed = validate(cached, path);
      if (parsed !== null) {
        return { text: cached, parsed, source: 'cache' };
      }
      // Cache hit but corrupt (interrupted prior write, schema drift,
      // disk damage). Evict so the next call falls through cleanly,
      // then continue to the network for THIS call too.
      await clearCache(cacheKey);
    } else {
      return { text: cached, source: 'cache' };
    }
  }

  // Network from CDN with retry + timeout. A flaky connection
  // (intermittent "Failed to fetch" between successful requests)
  // would previously fall through to offline on the first failure;
  // we now retry transient errors (network throws, 5xx, Content-
  // Length mismatch) up to MAX_ATTEMPTS times. A definitive 4xx
  // (e.g. 404) is NOT retried — that content genuinely isn't there.
  const cdnUrl = joinUrl(CDN_BASE, cacheKey);
  const fetchOutcome = await fetchWithRetry(cdnUrl);
  if (fetchOutcome.kind === 'ok') {
    const text = fetchOutcome.text;
    if (validate) {
      const parsed = validate(text, path);
      if (parsed === null) {
        // Server returned a complete but malformed body (e.g. corrupt
        // upstream, MITM tampering, schema regression). NEVER cache
        // an invalid payload — that would resurrect the corruption
        // on every later cache hit. Surface as FAILED so the caller
        // can show its retry path.
        return { text: '', source: 'FAILED' };
      }
      // Fire-and-forget cache write. The user has the content already;
      // a write failure (disk full, permission) shouldn't fail the
      // resolve.
      writeCache(cacheKey, text).catch(() => {});
      return { text, parsed, source: 'network' };
    }
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
    let transientFailure = false;
    try {
      const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        const text = await res.text();
        // Content-Length integrity check. A flaky connection can
        // drop the socket after the headers but before the body
        // fully arrives; on some browsers/WebViews this resolves
        // with whatever bytes did make it. Compare the actual
        // received byte length to the advertised Content-Length
        // and treat a mismatch as a transient failure (retry, then
        // bubble up as FAILED). Skipped when the server doesn't
        // send Content-Length (chunked transfer): in that case the
        // caller-supplied content validator catches truncation via
        // JSON.parse / schema check.
        const cl = res.headers.get('content-length');
        if (cl !== null) {
          const expected = parseInt(cl, 10);
          if (Number.isFinite(expected)) {
            const actual = new TextEncoder().encode(text).length;
            if (actual !== expected) {
              lastReason = `truncated body: got ${actual} bytes, expected ${expected}`;
              transientFailure = true;
            }
          }
        }
        if (!transientFailure) {
          return { kind: 'ok', text };
        }
      } else {
        // 4xx (except 408 request-timeout, 429 too-many-requests) is
        // definitive — return without further retry. The caller will
        // surface this as offline / FAILED.
        const transient = res.status >= 500 || res.status === 408 || res.status === 429;
        if (!transient) {
          return { kind: 'failed', reason: `status ${res.status}` };
        }
        lastReason = `status ${res.status}`;
      }
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
