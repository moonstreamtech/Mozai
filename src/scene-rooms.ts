/*
 * Room-select scene.
 *
 * Layout (all CSS, no canvas):
 *   • A white panel that fills #game and scrolls vertically.
 *   • Bottom safe-area padding equal to env(safe-area-inset-bottom) so
 *     the last row of room cells is never hidden behind anything that
 *     might paint into the bottom safe area. The horizontal padding
 *     consumes left/right safe-area insets too (landscape notches).
 *   • A CSS grid with 5 fixed columns. Cells are square via
 *     `aspect-ratio: 1`. Numbering is left-to-right, top-to-bottom,
 *     starting at 1.
 *
 * Per cell:
 *   • Room number, large.
 *   • Bottom-up coloured fill = completed / total puzzles in the room.
 *     Implemented as an absolutely-positioned <div> whose height is a
 *     percentage — keeps it crisp at any size and trivially animatable
 *     later if we want a "filling up" transition.
 *   • Locked rooms dim + show a lock glyph and don't accept clicks.
 *
 * Lock rule (from spec): room 1 always open; room K (K>=2) unlocked
 * iff completedCountForRoom(K-1) >= K. The unlock check lives in
 * content.ts so it stays testable without DOM.
 *
 * Renderer is engine-agnostic from #game's perspective — it just
 * paints DOM into the container the foundation provides. The banner
 * stays visible (foundation reserves --banner-h on :root).
 */

import type { SceneContext, SceneMount } from './scenes.js';
import { isRoomUnlocked } from './content.js';
import { completedCountForRoom } from './progress.js';
import { bootLog } from './error-overlay.js';

const COLUMNS = 5;

export const roomsSceneMount: SceneMount = (host, ctx) => {
  // The scene owns one root element appended to #game. Tearing this
  // root down on teardown() is sufficient — every listener attached
  // inside lives on a descendant.
  const root = document.createElement('div');
  root.className = 'scene scene-rooms';
  root.innerHTML = `
    <header class="rooms-header">
      <h1 class="rooms-title">Mozai</h1>
      <p class="rooms-subtitle">Choose a room</p>
    </header>
    <div class="rooms-grid" role="list"></div>
  `;
  host.appendChild(root);

  const grid = root.querySelector<HTMLDivElement>('.rooms-grid')!;
  grid.style.setProperty('--rooms-columns', String(COLUMNS));

  // Build cells in render order: 1..maxRoom. The CSS grid's
  // `grid-auto-flow: row` + the fixed 5 columns lay them out
  // left-to-right, top-to-bottom automatically.
  const maxRoom = ctx.index.maxRoom;
  for (let n = 1; n <= maxRoom; n++) {
    grid.appendChild(buildRoomCell(n, ctx));
  }
  // Explicit boot-strip telemetry so a "0 rooms" failure mode is
  // visibly distinguishable from "scene didn't mount at all". The
  // tile count is read off the live DOM so it confirms the appended
  // children actually landed.
  bootLog(
    `scene-rooms render: maxRoom=${maxRoom} tilesAppended=${grid.children.length}`,
  );
  if (maxRoom === 0 || grid.children.length === 0) {
    bootLog('WARNING rooms=0 — scene-rooms produced an empty grid');
  }

  if (maxRoom === 0) {
    // Empty-state fallback. Should only be hit before any puzzle JSON
    // is committed — the build-content-index script logs the same
    // condition.
    const empty = document.createElement('p');
    empty.className = 'rooms-empty';
    empty.textContent = 'No content yet — add puzzle JSONs under public/content/.';
    root.appendChild(empty);
  }

  return () => {
    root.remove();
  };
};

function buildRoomCell(n: number, ctx: SceneContext): HTMLElement {
  const total = ctx.index.rooms[String(n)]?.length ?? 0;
  const done = completedCountForRoom(n, ctx.index);
  const unlocked = isRoomUnlocked(n, (k) => completedCountForRoom(k, ctx.index));
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const cell = document.createElement('button');
  cell.className = 'room-cell' + (unlocked ? '' : ' is-locked');
  cell.type = 'button';
  cell.disabled = !unlocked;
  cell.setAttribute('role', 'listitem');
  cell.setAttribute(
    'aria-label',
    unlocked
      ? `Room ${n}, ${done} of ${total} complete (${pct}%)`
      : `Room ${n} locked. Complete ${n} pictures in room ${n - 1} to unlock.`,
  );

  // Inner DOM order matters for layering: fill must be the first
  // child so the number sits on top via CSS `position: relative` +
  // the fill being absolute. The lock/unlock distinction is conveyed
  // by colour contrast alone (locked = dimmed grey number on grey
  // background) — no glyph; see .room-cell.is-locked in style.css.
  cell.innerHTML = `
    <span class="room-fill" style="height: ${pct}%"></span>
    <span class="room-number">${n}</span>
    <span class="room-progress">${done}/${total}</span>
  `;

  if (unlocked) {
    cell.addEventListener('click', () => {
      ctx.push({ scene: 'room', roomN: n });
    });
  }

  return cell;
}
