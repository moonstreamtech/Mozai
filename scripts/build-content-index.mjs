#!/usr/bin/env node
/*
 * Content index + per-room thumbnails builder.
 *
 * Two outputs per build:
 *
 *  1. public/content/index.json — the slim home-screen index. Loaded
 *     once at app boot. Contains ONLY lightweight per-puzzle metadata:
 *     `{ maxRoom, rooms: { N: [{ id, room, w, h, colors, paintableCells }] } }`.
 *     No `cells` array. No thumbnails. So total payload stays small no
 *     matter how many puzzles we ship.
 *
 *  2. public/content/room<N>/thumbs.json — per-room thumbnail bundle.
 *     Loaded ONLY when the user enters room N. Each entry is the puzzle
 *     downscaled to longest-side ≤ 32 via nearest-neighbour sampling,
 *     aspect ratio preserved, -1 (background / outside silhouette)
 *     cells kept as -1. Shape:
 *       { "<id>": { w, h, palette:[hex...], cells:[int|-1 ...] } }
 *     Sized so the room-interior screen can render every silhouette
 *     without ever loading a full puzzle JSON — that only happens when
 *     a picture is opened for colouring.
 *
 * Per puzzle schema (input):
 *   { id, room, difficulty, w, h, palette:[hex...],
 *     cells:[int|-1 ...], colorCounts:{idx:count}, paintableCells }
 *
 * Runs via npm `predev` and `prebuild` so both files are always fresh.
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_DIR = join(ROOT, 'public', 'content');
const INDEX_FILE = join(CONTENT_DIR, 'index.json');

// Longest edge of every thumbnail. Big enough that a 32x32 nearest-
// -neighbour silhouette reads cleanly on a phone tile, small enough
// that a 100-puzzle room's thumbs.json stays comfortably under 100KB.
const THUMB_MAX_SIDE = 32;

function log(msg) {
  process.stdout.write(`[build-content-index] ${msg}\n`);
}

async function listRoomDirs() {
  if (!existsSync(CONTENT_DIR)) return [];
  const entries = await readdir(CONTENT_DIR, { withFileTypes: true });
  // Match "room<N>" where N is a positive integer. Anything else
  // (e.g. a stray index.json, a README) is ignored without warning.
  return entries
    .filter((e) => e.isDirectory() && /^room\d+$/.test(e.name))
    .map((e) => ({ name: e.name, n: Number(e.name.slice(4)) }))
    .sort((a, b) => a.n - b.n);
}

async function listPuzzlesIn(roomDir) {
  const entries = await readdir(roomDir, { withFileTypes: true });
  return entries
    .filter(
      (e) =>
        e.isFile() &&
        e.name.endsWith('.json') &&
        // Don't recursively re-read our own output during a rebuild
        // — `thumbs.json` lives next to the puzzle JSONs.
        e.name !== 'thumbs.json',
    )
    .map((e) => join(roomDir, e.name));
}

/**
 * Parse a puzzle JSON in full (we need `cells` for the thumbnail).
 * Validates required fields and throws on schema mismatch — better to
 * fail the build than ship a malformed thumbs.json.
 */
async function readPuzzleFull(file, expectedRoom) {
  const raw = await readFile(file, 'utf8');
  let p;
  try {
    p = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${file}: ${err.message}`);
  }
  const required = ['id', 'room', 'w', 'h', 'palette', 'cells', 'paintableCells'];
  for (const k of required) {
    if (!(k in p)) throw new Error(`${file}: missing required field "${k}"`);
  }
  if (p.room !== expectedRoom) {
    throw new Error(`${file}: room=${p.room} but file lives under room${expectedRoom}/`);
  }
  if (!Array.isArray(p.palette) || p.palette.length === 0) {
    throw new Error(`${file}: palette must be a non-empty array of hex strings`);
  }
  if (!Array.isArray(p.cells) || p.cells.length !== p.w * p.h) {
    throw new Error(`${file}: cells.length=${p.cells?.length} but expected ${p.w * p.h}`);
  }
  return p;
}

/**
 * Downscale a puzzle to at most THUMB_MAX_SIDE on its longest edge.
 *
 *   - Nearest-neighbour sampling. We sample the centre of each source
 *     "tile" that a thumb pixel covers, which is sufficient for pixel
 *     art where antialiasing would just muddy silhouettes.
 *   - Aspect ratio preserved.
 *   - Source -1 (background) maps to thumb -1 unchanged.
 *   - Puzzles already ≤ THUMB_MAX_SIDE are emitted unchanged
 *     (identity copy) — the renderer treats both identically.
 */
function makeThumb(p) {
  const longest = Math.max(p.w, p.h);
  if (longest <= THUMB_MAX_SIDE) {
    return {
      w: p.w,
      h: p.h,
      palette: p.palette.slice(),
      cells: p.cells.slice(),
    };
  }
  const scale = THUMB_MAX_SIDE / longest;
  // Round so the thumb has whole-pixel dimensions. Math.max(1, ...)
  // guards against a degenerate puzzle where the shorter axis would
  // round to 0.
  const tw = Math.max(1, Math.round(p.w * scale));
  const th = Math.max(1, Math.round(p.h * scale));
  const cells = new Array(tw * th);
  for (let ty = 0; ty < th; ty++) {
    // Use Math.min(p.h - 1, ...) so the floor at the bottom edge
    // never indexes past the source.
    const sy = Math.min(p.h - 1, Math.floor((ty + 0.5) * (p.h / th)));
    for (let tx = 0; tx < tw; tx++) {
      const sx = Math.min(p.w - 1, Math.floor((tx + 0.5) * (p.w / tw)));
      cells[ty * tw + tx] = p.cells[sy * p.w + sx];
    }
  }
  return {
    w: tw,
    h: th,
    palette: p.palette.slice(),
    cells,
  };
}

function metaFromPuzzle(p) {
  return {
    id: String(p.id),
    room: Number(p.room),
    w: Number(p.w),
    h: Number(p.h),
    colors: p.palette.length,
    paintableCells: Number(p.paintableCells),
  };
}

async function build() {
  const roomDirs = await listRoomDirs();
  if (roomDirs.length === 0) {
    log('No room<N>/ folders found under public/content — writing empty index.');
    await mkdir(CONTENT_DIR, { recursive: true });
    await writeFile(INDEX_FILE, JSON.stringify({ maxRoom: 0, rooms: {} }, null, 2));
    return;
  }

  const rooms = {};
  let maxRoom = 0;
  let totalPuzzles = 0;
  let totalThumbBytes = 0;

  for (const { name, n } of roomDirs) {
    const dir = join(CONTENT_DIR, name);
    const files = await listPuzzlesIn(dir);
    const metas = [];
    const thumbs = {};
    for (const file of files) {
      const p = await readPuzzleFull(file, n);
      metas.push(metaFromPuzzle(p));
      thumbs[p.id] = makeThumb(p);
    }
    // Sort meta entries deterministically by id so the room-interior
    // scene always sees the same picture order across builds —
    // important for progress-mapping integrity once `completed[id]`
    // is keyed in user storage. (thumbs is a map, so order is
    // irrelevant for it.)
    metas.sort((a, b) => a.id.localeCompare(b.id));
    rooms[String(n)] = metas;

    const thumbsFile = join(dir, 'thumbs.json');
    const thumbsJson = JSON.stringify(thumbs);
    await writeFile(thumbsFile, thumbsJson);
    totalThumbBytes += Buffer.byteLength(thumbsJson, 'utf8');

    maxRoom = Math.max(maxRoom, n);
    totalPuzzles += metas.length;
  }

  const out = { maxRoom, rooms };
  await writeFile(INDEX_FILE, JSON.stringify(out, null, 2));
  log(
    `Wrote ${INDEX_FILE} — ${maxRoom} room(s), ${totalPuzzles} puzzle(s); ` +
      `thumbs total ${totalThumbBytes} bytes across ${roomDirs.length} room(s).`,
  );
}

build().catch((err) => {
  process.stderr.write(`[build-content-index] FAIL: ${err.message}\n`);
  process.exit(1);
});
