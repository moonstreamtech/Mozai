/*
 * Content resolver — decides bundled vs cache vs network for any
 * content file path, with integrity guarantees against malformed
 * bodies.
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
 *   • A short / incomplete body is caught by the caller-supplied
 *     validator's JSON.parse + schema check, NOT by a byte-level
 *     compare against Content-Length. Transparent gzip on the CDN
 *     means the header's byte count is the compressed size while
 *     res.text() returns the decompressed string, so a length
 *     compare fires false positives on every healthy gzipped
 *     response.
 *
 * If all three fail (e.g. cache miss + network down on first room-2+
 * open), resolve returns `{ source: 'FAILED' }`. Scenes that catch
 * this surface a localized error + retry button rather than
 * crashing or rendering blank.
 *
 * The resolver does NOT throw on its own — every failure is a
 * `source: 'FAILED'` return. Callers throw `ContentResolveError`
 * (defined in content.ts) so the scene's catch block can
 * distinguish "no content available" from a JSON parse error.
 */

import { CDN_BASE } from './env.js';
import { readCache, writeCache, clearCache } from './content-cache.js';

export type ContentSource = 'bundled' | 'cache' | 'network' | 'FAILED';

/**
 * Discriminated union returned by content validators. On success
 * the validator returns `{ ok: true, value }`; on failure it
 * returns `{ ok: false, reason }` where `reason` is a short
 * snake-case token with a namespace prefix (`validation:cells_length`,
 * `validation:bad_palette_entry`, etc.). The reason flows through
 * to the resolver and surfaces in the on-device error UI so a
 * device-side debug session can see the actual cause without
 * needing the removed debug overlay back.
 */
export type ValidatorResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

export interface ResolveResult {
  /** Raw text payload. Empty string when source === 'FAILED'. */
  text: string;
  /**
   * Validator's normalised return value, set only when a validator
   * was provided AND it returned ok. Callers can down-cast directly
   * instead of re-parsing the text.
   */
  parsed?: unknown;
  /**
   * Short snake-case failure code (e.g. `validation:cells_length`,
   * `network:404`, `network:abort`, `bundled:missing`). Set only
   * when `source === 'FAILED'`. The room scene appends this to the
   * localised error message so a device-side debug session can see
   * the precise cause.
   */
  reason?: string;
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
   *   • Returns `{ ok: true, value }` → content is valid. The
   *     resolver attaches `value` to `ResolveResult.parsed` so
   *     callers don't need to re-parse.
   *   • Returns `{ ok: false, reason }` → content is invalid.
   *     cache-hit → evict entry and fall through to network.
   *     network-ok → don't write cache, return FAILED with the
   *     reason propagated to ResolveResult.reason.
   *
   * The `path` argument is the same content path the caller passed
   * to resolveContent — useful for log messages inside the
   * validator.
   */
  validate?: (text: string, path: string) => ValidatorResult;
}

export async function resolveContent(
  path: string,
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  const validate = opts.validate;

  if (isBundledPath(path)) {
    try {
      const res = await fetch(path, { cache: 'no-store' });
      if (!res.ok) return { text: '', source: 'FAILED', reason: `bundled:${res.status}` };
      const text = await res.text();
      if (validate) {
        const r = validate(text, path);
        if (!r.ok) return { text: '', source: 'FAILED', reason: r.reason };
        return { text, parsed: r.value, source: 'bundled' };
      }
      return { text, source: 'bundled' };
    } catch (err) {
      return { text: '', source: 'FAILED', reason: `bundled:throw:${(err as Error)?.message ?? String(err)}` };
    }
  }

  // Rooms 2+: cache first.
  const cacheKey = stripContentPrefix(path);
  const cached = await readCache(cacheKey);
  if (cached !== null) {
    if (validate) {
      const r = validate(cached, path);
      if (r.ok) {
        return { text: cached, parsed: r.value, source: 'cache' };
      }
      // Cache hit but corrupt (interrupted prior write, schema drift,
      // disk damage). Evict so the next call falls through cleanly,
      // then continue to the network for THIS call too. We DON'T
      // surface the cache reason — if the network then succeeds the
      // user sees content; if it fails they see the network reason.
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
      const r = validate(text, path);
      if (!r.ok) {
        // Server returned a complete but malformed body. NEVER cache
        // an invalid payload — that would resurrect the corruption
        // on every later cache hit. Surface the reason so the
        // device error UI can show it.
        return { text: '', source: 'FAILED', reason: r.reason };
      }
      // Fire-and-forget cache write. The user has the content already;
      // a write failure (disk full, permission) shouldn't fail the
      // resolve.
      writeCache(cacheKey, text).catch(() => {});
      return { text, parsed: r.value, source: 'network' };
    }
    writeCache(cacheKey, text).catch(() => {});
    return { text, source: 'network' };
  }
  return { text: '', source: 'FAILED', reason: fetchOutcome.reason };
}

/**
 * Fetch a path DIRECTLY from the CDN, bypassing both the bundled
 * fast-path and the on-disk cache. Used by the SWR revalidate
 * paths (loadContentIndex, loadRoomThumbs) — they always want to
 * see what the CDN is currently serving, regardless of what was
 * bundled at install or written to cache on the last fetch.
 *
 * On success the response is written to the read-through cache
 * so the NEXT regular resolveContent() call short-circuits to the
 * fresh value. For bundled paths (index.json, room1/*) this cache
 * write is harmless but ignored by the normal resolveContent flow
 * — the resolver only consults cache for non-bundled paths. SWR
 * works there anyway via the in-memory caches in content.ts /
 * thumbs.ts.
 *
 * Returns FAILED on any error (network, validator reject). Callers
 * treat this as "no update, the stale value stays in use" and
 * silently move on — SWR revalidate is best-effort by design.
 */
export async function fetchFromCdn(
  path: string,
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  const cacheKey = stripContentPrefix(path);
  const cdnUrl = joinUrl(CDN_BASE, cacheKey);
  const fetchOutcome = await fetchWithRetry(cdnUrl);
  if (fetchOutcome.kind !== 'ok') {
    return { text: '', source: 'FAILED', reason: fetchOutcome.reason };
  }
  const text = fetchOutcome.text;
  const validate = opts.validate;
  if (validate) {
    const r = validate(text, path);
    if (!r.ok) return { text: '', source: 'FAILED', reason: r.reason };
    writeCache(cacheKey, text).catch(() => {});
    return { text, parsed: r.value, source: 'network' };
  }
  writeCache(cacheKey, text).catch(() => {});
  return { text, source: 'network' };
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
  // Reasons are normalised to `network:<token>` so the room UI
  // gets a compact diagnostic string instead of a free-form
  // English error message. `lastReason` holds whichever code we
  // most recently encountered; we return it after the retry loop
  // gives up.
  let lastReason = 'network:unknown';
  for (let k = 1; k <= MAX_ATTEMPTS; k++) {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), PER_ATTEMPT_TIMEOUT_MS);
    try {
      const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        const text = await res.text();
        // No byte-count integrity check here: GitHub Pages (and
        // any CDN with transparent gzip) sends the COMPRESSED size
        // in Content-Length while res.text() returns the
        // DECOMPRESSED string, so comparing lengths fires false
        // positives on every healthy gzipped response. Real
        // corruption — incomplete bodies, dropped sockets,
        // half-arrived chunks — is caught one step later by
        // JSON.parse (throws on incomplete JSON) and the schema
        // validator (catches partial cell arrays, missing palette,
        // wrong w/h, etc.).
        return { kind: 'ok', text };
      }
      // 4xx (except 408 request-timeout, 429 too-many-requests) is
      // definitive — return without further retry.
      const transient = res.status >= 500 || res.status === 408 || res.status === 429;
      if (!transient) {
        return { kind: 'failed', reason: `network:${res.status}` };
      }
      lastReason = `network:${res.status}`;
    } catch (err) {
      clearTimeout(timeoutId);
      // AbortError = our per-attempt timeout; "Failed to fetch"
      // and other network errors collapse to `network:offline`.
      const name = (err as Error)?.name;
      lastReason = name === 'AbortError' ? 'network:timeout' : 'network:offline';
    }
    if (k < MAX_ATTEMPTS) {
      const wait = BACKOFF_BASE_MS * (1 << (k - 1)); // 500, 1000, 2000
      await sleep(wait);
    }
  }
  return { kind: 'failed', reason: lastReason };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
