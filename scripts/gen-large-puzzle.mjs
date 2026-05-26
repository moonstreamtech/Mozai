#!/usr/bin/env node
/*
 * Performance-test puzzle generator.
 *
 * Emits a 1000x1000 mandala-pattern puzzle at
 * public/content/room100/r100-001.json so the paint scene can be
 * stress-tested for pan/zoom/paint smoothness on a 1M-cell grid.
 * Run once and commit the output:
 *   node scripts/gen-large-puzzle.mjs
 *
 * The pattern is concentric colour bands radiating from the centre,
 * which gives:
 *   • Large runs of same-colour cells (good RLE compression for the
 *     save format — verifies the @capacitor/preferences vs filesystem
 *     spill threshold)
 *   • A circular silhouette where the four corners are background
 *     (-1), so the room-interior thumb shows a circular shape
 *   • Five palette entries, balanced enough that no single colour
 *     dominates
 *
 * Generated content is committed to the repo so CI doesn't have to
 * regenerate (would slow CI and would also be wasteful — the puzzle
 * never changes once committed).
 *
 * Naming follows the existing convention (r<room>-<seq>).
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOM_DIR = join(ROOT, 'public', 'content', 'room100');
const OUT_FILE = join(ROOM_DIR, 'r100-001.json');

const W = 1000;
const H = 1000;
const PALETTE = ['#1f2a3a', '#f4c062', '#64b5f6', '#ba68c8', '#81c784'];
const NUM_BANDS = 12;     // visible colour rings

function build() {
  const cx = (W - 1) / 2;
  const cy = (H - 1) / 2;
  const maxRadius = Math.min(W, H) / 2;
  const cells = new Array(W * H);
  const colorCounts = {};
  let paintable = 0;
  let backgroundCount = 0;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r > maxRadius) {
        cells[y * W + x] = -1;
        backgroundCount++;
        continue;
      }
      // Band index 0..NUM_BANDS-1 from center outward; cycle through
      // palette so adjacent bands are different colours.
      const bandIdx = Math.min(NUM_BANDS - 1, Math.floor((r / maxRadius) * NUM_BANDS));
      const colorIdx = bandIdx % PALETTE.length;
      cells[y * W + x] = colorIdx;
      paintable++;
      colorCounts[colorIdx] = (colorCounts[colorIdx] ?? 0) + 1;
    }
  }

  const puzzle = {
    id: 'r100-001',
    room: 100,
    difficulty: 5,
    w: W,
    h: H,
    palette: PALETTE,
    cells,
    colorCounts,
    paintableCells: paintable,
  };
  process.stdout.write(
    `[gen-large-puzzle] ${W}x${H}, palette ${PALETTE.length}, paintable ${paintable}, ` +
      `background ${backgroundCount}\n`,
  );
  return puzzle;
}

async function main() {
  await mkdir(ROOM_DIR, { recursive: true });
  const puzzle = build();
  // Compact JSON — every byte counts at 1M cells. JSON.stringify with
  // no indent for the cells array stays at ~2.4 MB.
  await writeFile(OUT_FILE, JSON.stringify(puzzle));
  process.stdout.write(`[gen-large-puzzle] Wrote ${OUT_FILE}\n`);
}

main().catch((err) => {
  process.stderr.write(`[gen-large-puzzle] FAIL: ${err.message}\n`);
  process.exit(1);
});
