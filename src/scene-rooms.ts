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
import { isRoomUnlocked, type ContentIndex } from './content.js';
import { completedCountForRoom } from './progress.js';
import { subscribeContentEvent } from './content-events.js';
import { t } from './i18n.js';

const COLUMNS = 5;

/**
 * Bypass the lock-chain rule (completedCountForRoom(K-1) >= K) and
 * make every room tappable regardless of progress. Useful while
 * testing high-room puzzles (e.g. room 100's 1000×1000 perf test)
 * without grinding through earlier rooms. OFF in production — the
 * real lock chain is the gameplay progression.
 *
 * Flip on temporarily for local QA, rebuild, then flip back.
 */
const UNLOCK_ALL_ROOMS = false;

export const roomsSceneMount: SceneMount = (host, ctx) => {
  // The scene owns one root element appended to #game. Tearing this
  // root down on teardown() is sufficient — every listener attached
  // inside lives on a descendant.
  const root = document.createElement('div');
  root.className = 'scene scene-rooms';
  root.innerHTML = `
    <header class="rooms-header">
      <h1 class="rooms-title">Mozai</h1>
      <p class="rooms-subtitle">${t('chooseRoom')}</p>
    </header>
    <div class="rooms-grid" role="list"></div>
  `;
  host.appendChild(root);

  const grid = root.querySelector<HTMLDivElement>('.rooms-grid')!;
  grid.style.setProperty('--rooms-columns', String(COLUMNS));

  // Local index reference so the SWR 'index-updated' event can
  // swap it in place without bouncing through SceneManager.index
  // (which is set once at construction).
  let currentIndex: ContentIndex = ctx.index;
  let emptyEl: HTMLElement | null = null;

  const renderGrid = (): void => {
    grid.replaceChildren();
    const maxRoom = currentIndex.maxRoom;
    for (let n = 1; n <= maxRoom; n++) {
      grid.appendChild(buildRoomCell(n, currentIndex, ctx));
    }
    // Empty-state fallback. Should only be hit before any puzzle
    // JSON is committed — the build-content-index script logs the
    // same condition.
    if (maxRoom === 0) {
      if (!emptyEl) {
        emptyEl = document.createElement('p');
        emptyEl.className = 'rooms-empty';
        emptyEl.textContent = 'No content yet — add puzzle JSONs under public/content/.';
        root.appendChild(emptyEl);
      }
    } else if (emptyEl) {
      emptyEl.remove();
      emptyEl = null;
    }
  };

  renderGrid();

  // SWR subscription: when loadContentIndex's background revalidate
  // detects new content (a new room unlocked, an existing room
  // gained a puzzle, …), re-render the grid with the new index.
  // No flicker — the previous tiles are replaced in one DOM swap,
  // and progress counts stay correct because they're read off the
  // (local, synchronous) progress store.
  const offIndex = subscribeContentEvent('index-updated', (next) => {
    currentIndex = next;
    renderGrid();
  });

  return () => {
    offIndex();
    root.remove();
  };
};

function buildRoomCell(n: number, index: ContentIndex, ctx: SceneContext): HTMLElement {
  const total = index.rooms[String(n)]?.length ?? 0;
  const done = completedCountForRoom(n, index);
  const unlocked =
    UNLOCK_ALL_ROOMS ||
    isRoomUnlocked(n, (k) => completedCountForRoom(k, index));
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const cell = document.createElement('button');
  cell.className = 'room-cell' + (unlocked ? '' : ' is-locked');
  cell.type = 'button';
  cell.disabled = !unlocked;
  cell.setAttribute('role', 'listitem');
  cell.setAttribute(
    'aria-label',
    unlocked
      ? t('roomCellLabel', { n, done, total, pct })
      : t('roomCellLocked', { n, prev: n - 1 }),
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
