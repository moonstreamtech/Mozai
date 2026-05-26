#!/usr/bin/env node
/*
 * Content index builder.
 *
 * Scans public/content/room<N>/<id>.json and emits
 * public/content/index.json containing only the lightweight metadata
 * the room-select screen and room-interior stub need:
 *
 *   {
 *     maxRoom: int,
 *     rooms: {
 *       "1": [ { id, room, w, h, colors, paintableCells }, ... ],
 *       "2": [ ... ]
 *     }
 *   }
 *
 * The heavy `cells` array (potentially thousands of ints per puzzle)
 * is deliberately NOT inlined — the app loads each full puzzle JSON
 * lazily only when a picture is opened in the paint scene. Keeping the
 * index slim means the home screen boots in one fetch regardless of
 * how many puzzles ship.
 *
 * Per puzzle schema (input):
 *   { id, room, difficulty, w, h, palette:[hex...],
 *     cells:[int|-1 ...], colorCounts:{idx:count}, paintableCells }
 *
 * Runs via npm `predev` and `prebuild` so the index is always fresh.
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_DIR = join(ROOT, 'public', 'content');
const INDEX_FILE = join(CONTENT_DIR, 'index.json');

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
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => join(roomDir, e.name));
}

/**
 * Read just enough of a puzzle JSON to populate one index entry.
 * Validates required fields and throws on schema mismatch — better
 * to fail the build than ship a broken index.
 */
async function readPuzzleMeta(file, expectedRoom) {
  const raw = await readFile(file, 'utf8');
  let p;
  try {
    p = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${file}: ${err.message}`);
  }
  const required = ['id', 'room', 'w', 'h', 'palette', 'paintableCells'];
  for (const k of required) {
    if (!(k in p)) throw new Error(`${file}: missing required field "${k}"`);
  }
  if (p.room !== expectedRoom) {
    throw new Error(`${file}: room=${p.room} but file lives under room${expectedRoom}/`);
  }
  if (!Array.isArray(p.palette) || p.palette.length === 0) {
    throw new Error(`${file}: palette must be a non-empty array of hex strings`);
  }
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

  for (const { name, n } of roomDirs) {
    const dir = join(CONTENT_DIR, name);
    const files = await listPuzzlesIn(dir);
    const entries = [];
    for (const file of files) {
      entries.push(await readPuzzleMeta(file, n));
    }
    // Sort deterministically by id so the room-interior scene always
    // sees the same picture order across builds — important for
    // progress-mapping integrity once `completed[id]` is keyed in
    // user storage.
    entries.sort((a, b) => a.id.localeCompare(b.id));
    rooms[String(n)] = entries;
    maxRoom = Math.max(maxRoom, n);
    totalPuzzles += entries.length;
  }

  const out = { maxRoom, rooms };
  await writeFile(INDEX_FILE, JSON.stringify(out, null, 2));
  log(`Wrote ${INDEX_FILE} — ${maxRoom} room(s), ${totalPuzzles} puzzle(s).`);
}

build().catch((err) => {
  process.stderr.write(`[build-content-index] FAIL: ${err.message}\n`);
  process.exit(1);
});
