/*
 * Paint state — compact in-memory model for the colour-by-number
 * scene plus persistence to Capacitor Preferences (small puzzles) or
 * Filesystem (large ones).
 *
 * Memory layout
 * -------------
 * For a w*h puzzle:
 *   solution: Int16Array(length=w*h)  -1 = background, 0..255 = palette index
 *   filled:   Uint8Array(length=w*h)  0 = not filled, 1 = filled
 *   colorFilled: Uint32Array(length=palette.length)  per-colour fill count
 *
 * A 1000x1000 picture is therefore ~1MB resident — solution dominates
 * (2 MB Int16) and filled costs another 1 MB. Bigger than the puzzle
 * JSON but well within mobile WebView heap headroom, and the per-fill
 * mutation is O(1).
 *
 * Why Int16 for the solution
 * --------------------------
 * Real puzzles will have palettes up to ~32 colours. Int16 covers
 * that comfortably AND lets us use -1 as the background sentinel
 * directly (no allocation for an extra "isBackground" array). Int32
 * would just waste memory on 1M-cell grids.
 *
 * Persistence format
 * ------------------
 * Compact RLE of the `filled` byte array:
 *   Concatenated little-endian uint32 pairs: [runValue, runLength]+
 * where runValue is 0 or 1. We base64 the resulting byte buffer for
 * Preferences (which only stores strings); for large blobs (above
 * PREFERENCES_BYTE_THRESHOLD), we write the raw binary to a file
 * under @capacitor/filesystem and store a marker JSON in Preferences
 * pointing at the file.
 *
 * The `hintRevealed` set (a few colour indices) goes alongside the
 * filled-state blob — it's tiny.
 *
 * Storage key per picture: `mozai.pic.<id>`.
 */

import { Preferences } from '@capacitor/preferences';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import type { Puzzle } from './content.js';

const PREFERENCES_BYTE_THRESHOLD = 50 * 1024;     // 50 KB threshold to spill to Filesystem
const STORAGE_KEY_PREFIX = 'mozai.pic.';
const FILESYSTEM_DIR_NAME = 'mozai-paint';        // under Directory.Data
const CURRENT_FORMAT_VERSION = 1;

export interface PaintProgress {
  filledCount: number;
  paintableCount: number;
  /** filledCount === paintableCount. */
  complete: boolean;
  /** Per-colour filled count. Indexed by palette index. */
  colorFilled: Uint32Array;
  /** Per-colour target count. Indexed by palette index. */
  colorTotal: Uint32Array;
}

export interface FillResult {
  /** True iff the painted cell actually changed (was paintable & correct). */
  changed: boolean;
  /** True iff this fill completes the picture. */
  completed: boolean;
}

interface PersistEnvelope {
  v: number;                  // format version
  /** Either 'inline' (base64 RLE here) or 'fs' (path inside Directory.Data). */
  kind: 'inline' | 'fs';
  rle?: string;               // base64 RLE of filled bytes (inline only)
  fsPath?: string;            // path under Directory.Data/FILESYSTEM_DIR_NAME (fs only)
  /** Hint-revealed palette indices. */
  hints: number[];
  filledCount: number;
  /** Sanity: detect a puzzle definition change between sessions. */
  w: number;
  h: number;
}

export class PaintState {
  readonly puzzle: Puzzle;
  readonly solution: Int16Array;
  readonly filled: Uint8Array;
  readonly colorTotal: Uint32Array;
  readonly colorFilled: Uint32Array;
  private readonly paintableCount: number;
  private filledCount = 0;
  readonly hintRevealed = new Set<number>();

  constructor(puzzle: Puzzle) {
    this.puzzle = puzzle;
    const n = puzzle.w * puzzle.h;
    if (puzzle.cells.length !== n) {
      throw new Error(`Puzzle ${puzzle.id} cells.length=${puzzle.cells.length} but expected ${n}`);
    }
    this.solution = new Int16Array(n);
    this.filled = new Uint8Array(n);
    this.colorTotal = new Uint32Array(puzzle.palette.length);
    this.colorFilled = new Uint32Array(puzzle.palette.length);

    let paintable = 0;
    for (let i = 0; i < n; i++) {
      const v = puzzle.cells[i];
      if (v < 0) {
        this.solution[i] = -1;
      } else {
        this.solution[i] = v;
        paintable++;
        this.colorTotal[v]++;
      }
    }
    this.paintableCount = paintable;
  }

  /** Attempt to paint cell `i` with `colorIdx`. */
  attemptFill(i: number, colorIdx: number): FillResult {
    if (i < 0 || i >= this.solution.length) return { changed: false, completed: false };
    if (this.filled[i]) return { changed: false, completed: false };
    const target = this.solution[i];
    if (target < 0 || target !== colorIdx) return { changed: false, completed: false };
    this.filled[i] = 1;
    this.filledCount++;
    this.colorFilled[colorIdx]++;
    return {
      changed: true,
      completed: this.isComplete(),
    };
  }

  /**
   * Single source of truth for "is this puzzle done?". Requires BOTH:
   *   - at least one paintable cell (paintableCount > 0)
   *   - every paintable cell filled
   *
   * The paintableCount > 0 guard catches the trivial-completion bug:
   * a puzzle whose cells array is empty or all-background (-1) has
   * paintableCount == 0, and `filledCount >= 0` would otherwise fire
   * the completion modal on entry before any painting happens.
   */
  isComplete(): boolean {
    return this.paintableCount > 0 && this.filledCount >= this.paintableCount;
  }

  /** Convenience: snapshot for UI binding. */
  snapshot(): PaintProgress {
    return {
      filledCount: this.filledCount,
      paintableCount: this.paintableCount,
      complete: this.isComplete(),
      colorFilled: this.colorFilled,
      colorTotal: this.colorTotal,
    };
  }

  /** Reveal a colour as a hint. Caller persists. */
  revealHint(colorIdx: number): void {
    if (colorIdx < 0 || colorIdx >= this.puzzle.palette.length) return;
    this.hintRevealed.add(colorIdx);
  }

  // -----------------------
  // Persistence
  // -----------------------

  static keyFor(id: string): string {
    return `${STORAGE_KEY_PREFIX}${id}`;
  }

  /**
   * Save to Preferences when small; spill to Filesystem when the RLE
   * blob exceeds PREFERENCES_BYTE_THRESHOLD. Either way, the Preferences
   * key contains the small envelope JSON so callers can look up
   * progress without touching the filesystem.
   */
  async save(): Promise<void> {
    const rleBytes = rleEncode(this.filled);
    const envelope: PersistEnvelope = {
      v: CURRENT_FORMAT_VERSION,
      kind: rleBytes.byteLength > PREFERENCES_BYTE_THRESHOLD ? 'fs' : 'inline',
      hints: Array.from(this.hintRevealed),
      filledCount: this.filledCount,
      w: this.puzzle.w,
      h: this.puzzle.h,
    };
    if (envelope.kind === 'inline') {
      envelope.rle = bytesToBase64(rleBytes);
    } else {
      const path = `${FILESYSTEM_DIR_NAME}/${this.puzzle.id}.rle.b64`;
      envelope.fsPath = path;
      try {
        await Filesystem.mkdir({
          path: FILESYSTEM_DIR_NAME,
          directory: Directory.Data,
          recursive: true,
        });
      } catch {
        // mkdir throws if the directory already exists — that's fine,
        // any other error will resurface from the writeFile below.
      }
      await Filesystem.writeFile({
        path,
        directory: Directory.Data,
        data: bytesToBase64(rleBytes),
        encoding: Encoding.UTF8,
      });
    }
    await Preferences.set({
      key: PaintState.keyFor(this.puzzle.id),
      value: JSON.stringify(envelope),
    });
  }

  /**
   * Restore filled state + revealed hints from previous session.
   * No-op if nothing is stored or the stored puzzle dimensions don't
   * match the current puzzle (treat schema drift as "fresh start" —
   * better than silently corrupting state).
   */
  async load(): Promise<void> {
    const { value } = await Preferences.get({ key: PaintState.keyFor(this.puzzle.id) });
    if (!value) return;
    let env: PersistEnvelope;
    try {
      env = JSON.parse(value) as PersistEnvelope;
    } catch {
      return;
    }
    if (env.v !== CURRENT_FORMAT_VERSION) return;
    if (env.w !== this.puzzle.w || env.h !== this.puzzle.h) return;

    let rleB64: string | undefined;
    if (env.kind === 'inline') {
      rleB64 = env.rle;
    } else if (env.kind === 'fs' && env.fsPath) {
      try {
        const read = await Filesystem.readFile({
          path: env.fsPath,
          directory: Directory.Data,
          encoding: Encoding.UTF8,
        });
        rleB64 = typeof read.data === 'string' ? read.data : '';
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[Mozai] paint state filesystem read failed for ${this.puzzle.id}`, err);
        return;
      }
    }
    if (!rleB64) return;
    const rleBytes = base64ToBytes(rleB64);
    rleDecodeInto(rleBytes, this.filled);

    // Recompute per-cell counts from the freshly restored filled +
    // solution arrays. Cheaper than persisting them and survives
    // any out-of-sync between filledCount and the actual byte array.
    this.filledCount = 0;
    this.colorFilled.fill(0);
    for (let i = 0; i < this.filled.length; i++) {
      if (this.filled[i]) {
        this.filledCount++;
        const v = this.solution[i];
        if (v >= 0) this.colorFilled[v]++;
      }
    }
    // Hints — set from envelope.
    this.hintRevealed.clear();
    for (const h of env.hints ?? []) this.hintRevealed.add(h);
  }
}

// -------- RLE helpers --------

/**
 * RLE-encode a Uint8Array of 0s and 1s as a sequence of (uint32 runLength)
 * values, alternating between runs of 0 and runs of 1, always starting
 * with a 0-run (which may be of length 0). The choice of starting
 * value-by-position rather than tagging each run keeps the encoding
 * dense — typical puzzles produce O(painterly-region-count) runs.
 */
function rleEncode(filled: Uint8Array): Uint8Array {
  const runs: number[] = [];
  let currentValue = 0;
  let runLength = 0;
  for (let i = 0; i < filled.length; i++) {
    const v = filled[i] ? 1 : 0;
    if (v === currentValue) {
      runLength++;
    } else {
      runs.push(runLength);
      currentValue = v;
      runLength = 1;
    }
  }
  runs.push(runLength);
  // Serialise as little-endian uint32. 4 bytes per run.
  const out = new Uint8Array(runs.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < runs.length; i++) {
    view.setUint32(i * 4, runs[i] >>> 0, true);
  }
  return out;
}

/**
 * Decode an RLE byte stream back into the caller-owned `dest` array.
 * Silently truncates if the RLE describes more cells than dest holds
 * (defensive against a corrupted blob taking the runtime down).
 */
function rleDecodeInto(bytes: Uint8Array, dest: Uint8Array): void {
  if (bytes.byteLength % 4 !== 0) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const runs = bytes.byteLength / 4;
  let pos = 0;
  let currentValue = 0;
  dest.fill(0);
  for (let r = 0; r < runs; r++) {
    const len = view.getUint32(r * 4, true);
    if (currentValue === 1 && len > 0) {
      const end = Math.min(dest.length, pos + len);
      for (let i = pos; i < end; i++) dest[i] = 1;
    }
    pos += len;
    if (pos > dest.length) return;
    currentValue = currentValue ? 0 : 1;
  }
}

// -------- base64 helpers (works in both Capacitor WebView and dev) --------

function bytesToBase64(bytes: Uint8Array): string {
  // btoa wants a binary string. For sizes up to ~1MB this is fast
  // enough and doesn't require pulling in a library.
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
