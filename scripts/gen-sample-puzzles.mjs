#!/usr/bin/env node
/*
 * Sample-puzzle generator.
 *
 * Produces all sample puzzles under public/content/roomN/ such that
 * each room's grid side is roomNumber × 10 (the locked design rule):
 *   room 1  → 10×10
 *   room 2  → 20×20
 *   room 3  → 30×30
 *   room 100 → 1000×1000 (mandala — perf test, ~785k paintable cells)
 *
 * Each puzzle is a pixel silhouette filling the grid: background
 * cells outside the shape are -1 (not paintable), inside cells are
 * coloured by a simple rule (radial bands, x stripes, region split)
 * so the painter sees a few distinct colour regions. Palette is
 * chosen per shape (a heart is red/pink, a star is gold/yellow,
 * etc.) — NOT tied to the room number.
 *
 * Each puzzle's colour count stays under the maker's auto rule of
 * autoColorCap(side) = max(4, round(side/4)) as a guideline:
 *   10×10 → up to 4 colours   (we use 2-3)
 *   20×20 → up to 5 colours   (we use 2-4)
 *   30×30 → up to 8 colours   (we use 4-5)
 *   1000×1000 → up to 250    (we use 5)
 *
 * Reproducible: re-running this script produces byte-identical
 * output. No randomness.
 *
 * Run:
 *   node scripts/gen-sample-puzzles.mjs
 *
 * Then the prebuild (npm run build-content-index) updates the
 * derived index.json and per-room thumbs.json.
 */

import { writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_DIR = join(ROOT, 'public', 'content');

// Shape implementations. Each takes (x, y, w, h, palette) and
// returns either a palette index (>= 0) or -1 for background.
// The shape decides its own "is this cell inside" rule and its own
// internal colouring; the palette is whatever the puzzle config
// supplies. Shapes are scale-invariant (work on 10×10, 30×30, or
// 1000×1000 with consistent output).
const SHAPES = {
  /** Circle silhouette with concentric colour rings. */
  rings(x, y, w, h, palette) {
    const cx = (w - 1) / 2;
    const cy = (h - 1) / 2;
    const r = Math.min(w, h) / 2 - 0.5;
    const d = Math.hypot(x - cx, y - cy);
    if (d > r) return -1;
    const band = Math.floor((d / r) * palette.length);
    return Math.min(palette.length - 1, band);
  },

  /** Diamond (taxicab) silhouette with concentric rings. */
  diamond(x, y, w, h, palette) {
    const cx = (w - 1) / 2;
    const cy = (h - 1) / 2;
    const r = Math.min(w, h) / 2 - 0.5;
    const d = Math.abs(x - cx) + Math.abs(y - cy);
    if (d > r) return -1;
    const band = Math.floor((d / r) * palette.length);
    return Math.min(palette.length - 1, band);
  },

  /**
   * Heart. Implicit curve `(x² + y² − 1)³ − x²·y³ ≤ 0` in
   * normalised coords. Interior coloured by radial band.
   */
  heart(x, y, w, h, palette) {
    const cx = (w - 1) / 2;
    // Shift up so the heart sits visually centred (the curve has
    // its centroid above its geometric centre).
    const cy = (h - 1) / 2 - h * 0.08;
    const scale = Math.min(w, h) / 2.4;
    const nx = (x - cx) / scale;
    const ny = -(y - cy) / scale;
    const t = nx * nx + ny * ny - 1;
    const v = t * t * t - nx * nx * ny * ny * ny;
    if (v > 0) return -1;
    // Inside — palette by depth from outline.
    const depth = Math.min(1, -v / 1.2);
    const band = Math.floor(depth * palette.length);
    return Math.min(palette.length - 1, band);
  },

  /**
   * 5-point star. Uses polar coords + a periodic radius envelope.
   * The radius oscillates between r/2 and r as theta sweeps,
   * giving 5 spikes.
   */
  star(x, y, w, h, palette) {
    const cx = (w - 1) / 2;
    const cy = (h - 1) / 2;
    const r = Math.min(w, h) / 2 - 0.5;
    const dx = x - cx;
    const dy = y - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > r) return -1;
    // theta in [0, 2π), origin pointing up.
    const theta = Math.atan2(dy, dx) + Math.PI / 2;
    const segment = ((theta % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    // 5 cycles of triangle wave (peaks at the points, troughs at the inner corners).
    const t = (segment * 5) / (Math.PI * 2);
    const tt = t - Math.floor(t);
    // Inner radius ~0.45 r, outer r.
    const envelope = 0.45 + 0.55 * Math.abs(2 * tt - 1);
    if (dist > envelope * r) return -1;
    const band = Math.floor((dist / r) * palette.length);
    return Math.min(palette.length - 1, band);
  },

  /** Plus / cross. Centre square + 4 arms; centre and arms differ. */
  plus(x, y, w, h, palette) {
    const cx = (w - 1) / 2;
    const cy = (h - 1) / 2;
    const armHalf = Math.max(1, Math.floor(Math.min(w, h) / 6));
    const halfLen = Math.floor(Math.min(w, h) / 2) - 1;
    const dx = Math.abs(x - cx);
    const dy = Math.abs(y - cy);
    const inHoriz = dy <= armHalf && dx <= halfLen;
    const inVert = dx <= armHalf && dy <= halfLen;
    if (!inHoriz && !inVert) return -1;
    if (dx <= armHalf && dy <= armHalf) return 0; // centre
    if (palette.length >= 3) {
      // Tip vs body: tips of arms are palette[2], main body palette[1].
      const tipLen = Math.max(1, Math.floor(halfLen / 3));
      if (dx >= halfLen - tipLen || dy >= halfLen - tipLen) return 2;
    }
    return Math.min(palette.length - 1, 1);
  },

  /**
   * Fish: ellipse body + triangular tail behind it. Eye is a tiny
   * dark square inside the body.
   */
  fish(x, y, w, h, palette) {
    const cx = w * 0.4;
    const cy = h / 2;
    const a = w * 0.32;
    const b = h * 0.22;
    const dx = (x - cx) / a;
    const dy = (y - cy) / b;
    const inBody = dx * dx + dy * dy < 1;
    const tailStart = cx + a * 0.6;
    const tailLen = w - tailStart - 1;
    const inTail =
      x >= tailStart &&
      x < w &&
      Math.abs(y - cy) < ((x - tailStart) / Math.max(1, tailLen)) * h * 0.35;
    if (!inBody && !inTail) return -1;
    // Eye: small square.
    const eyeX = Math.round(cx + a * 0.55);
    const eyeY = Math.round(cy - b * 0.35);
    if (Math.abs(x - eyeX) <= 0 && Math.abs(y - eyeY) <= 0 && palette.length >= 3) return 2;
    if (inTail && !inBody) return Math.min(palette.length - 1, 1);
    return 0; // body
  },

  /**
   * Concentric mandala-style rings — used for the 1000×1000
   * perf-test puzzle in room 100. Identical to the previous
   * gen-large-puzzle generator, just renamed.
   */
  mandala(x, y, w, h, palette) {
    const cx = (w - 1) / 2;
    const cy = (h - 1) / 2;
    const maxR = Math.min(w, h) / 2;
    const d = Math.hypot(x - cx, y - cy);
    if (d > maxR) return -1;
    const NUM_BANDS = 12;
    const band = Math.min(NUM_BANDS - 1, Math.floor((d / maxR) * NUM_BANDS));
    return band % palette.length;
  },
};

// Puzzle list — every committed sample.
//
// Palettes are chosen to fit the shape. Order within a palette
// matters because the shape's band index reads palette[i] for
// inner-to-outer / centre-to-edge.
const PUZZLES = [
  // Room 1: 10×10
  { id: 'r1-001', room: 1, shape: 'heart',   palette: ['#c0233a', '#ef5469', '#fbcad1'] },
  { id: 'r1-002', room: 1, shape: 'star',    palette: ['#e6a017', '#f4c062', '#fff3b0'] },
  { id: 'r1-003', room: 1, shape: 'rings',   palette: ['#1f2a3a', '#3b6aa0', '#7fb2dc', '#cfe5f5'] },
  // Room 2: 20×20
  { id: 'r2-001', room: 2, shape: 'fish',    palette: ['#2f8fd3', '#aee2ff', '#1f2a3a'] },
  { id: 'r2-002', room: 2, shape: 'diamond', palette: ['#5e2bba', '#9a6ed8', '#cba8e6', '#e8d8f5'] },
  { id: 'r2-003', room: 2, shape: 'plus',    palette: ['#c92a4b', '#f06292', '#fbcad1'] },
  // Room 3: 30×30
  { id: 'r3-001', room: 3, shape: 'rings',   palette: ['#1f2a3a', '#3a6e9c', '#5cc4b3', '#a0e8d4', '#fff1a8'] },
  // Room 100: 1000×1000 (perf test). Bands cycle through the palette so
  // each band is distinguishable.
  { id: 'r100-001', room: 100, shape: 'mandala', palette: ['#1f2a3a', '#f4c062', '#64b5f6', '#ba68c8', '#81c784'] },
];

function buildPuzzle(spec) {
  const w = spec.room * 10;
  const h = spec.room * 10;
  const shapeFn = SHAPES[spec.shape];
  if (!shapeFn) throw new Error(`Unknown shape: ${spec.shape}`);
  const cells = new Array(w * h);
  const colorCounts = {};
  let paintable = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = shapeFn(x, y, w, h, spec.palette);
      cells[y * w + x] = v;
      if (v >= 0) {
        paintable++;
        colorCounts[v] = (colorCounts[v] ?? 0) + 1;
      }
    }
  }
  // Difficulty is informational only (the index doesn't expose it
  // to the room screen yet). Set proportional to the side.
  const difficulty = Math.max(1, Math.round(spec.room / 2));
  return {
    id: spec.id,
    room: spec.room,
    difficulty,
    w,
    h,
    palette: spec.palette.slice(),
    cells,
    colorCounts,
    paintableCells: paintable,
  };
}

async function writePuzzle(p) {
  const roomDir = join(CONTENT_DIR, `room${p.room}`);
  await mkdir(roomDir, { recursive: true });
  const file = join(roomDir, `${p.id}.json`);
  // Compact JSON — at 1000×1000 the cells array dominates.
  await writeFile(file, JSON.stringify(p));
  return file;
}

async function clearRoomPuzzles(roomN) {
  // Remove existing rN-* puzzle JSONs so a renamed / removed puzzle
  // doesn't linger between runs. We leave thumbs.json in place (the
  // prebuild will regenerate it).
  const roomDir = join(CONTENT_DIR, `room${roomN}`);
  if (!existsSync(roomDir)) return;
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(roomDir);
  for (const name of entries) {
    if (name === 'thumbs.json') continue;
    if (!/\.json$/.test(name)) continue;
    if (!new RegExp(`^r${roomN}-.+\\.json$`).test(name)) continue;
    await rm(join(roomDir, name));
  }
}

async function main() {
  const roomsTouched = new Set();
  for (const spec of PUZZLES) roomsTouched.add(spec.room);
  for (const room of roomsTouched) {
    await clearRoomPuzzles(room);
  }
  const sizes = [];
  for (const spec of PUZZLES) {
    const p = buildPuzzle(spec);
    const file = await writePuzzle(p);
    const { statSync } = await import('node:fs');
    sizes.push({ id: p.id, room: p.room, w: p.w, h: p.h, paintable: p.paintableCells, bytes: statSync(file).size });
    process.stdout.write(
      `[gen-sample-puzzles] ${p.id}: ${p.w}×${p.h}, paintable=${p.paintableCells}, palette=${p.palette.length}\n`,
    );
  }
  process.stdout.write(`[gen-sample-puzzles] Wrote ${PUZZLES.length} puzzles.\n`);
}

main().catch((err) => {
  process.stderr.write(`[gen-sample-puzzles] FAIL: ${err.message}\n`);
  process.exit(1);
});
