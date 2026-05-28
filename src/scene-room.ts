/*
 * Room-interior scene.
 *
 * Layout: white panel that fills #game and scrolls vertically; respects
 * the foundation's --banner-h (#game already excludes it) and the
 * bottom safe-area inset. Header has the back button + room number.
 *
 * Body: a responsive 3-col CSS grid of square tiles. Each tile
 * progresses through three visual states:
 *   • LOADING   — small spinner; tile is non-tappable until the
 *                 puzzle JSON has been downloaded and validated.
 *   • READY     — thumb canvas painted from thumbs.json + the
 *                 picture's saved filled-bitset (silhouette,
 *                 grayscale-with-progress, or full colour).
 *   • FAILED    — retry glyph; tap to re-attempt JUST this puzzle.
 *
 * Loading model:
 *   1. thumbs.json + every picture's filled bitset load in parallel
 *      (both are small and either bundled or local).
 *   2. The grid renders immediately with all tiles in the LOADING
 *      state.
 *   3. The puzzle JSONs (rN/<id>.json) are then fetched ONE AT A
 *      TIME, in display order, via loadPuzzle which routes through
 *      the resolver's bundled → cache → CDN ladder. After each
 *      success that tile transitions to READY; after the resolver
 *      exhausts retries the tile transitions to FAILED. The room
 *      is therefore usable with whatever loaded successfully even
 *      if the network dies mid-room.
 *
 * Integrity:
 *   • The resolver runs validatePuzzleText / validateThumbsText
 *     against every response (cache OR network) before accepting it.
 *     A truncated or schema-violating body is dropped on the floor
 *     and never written to cache, so a corrupt blob can't poison
 *     subsequent loads.
 *
 * Back navigation:
 *   • The back button calls ctx.back() which the scene manager
 *     translates into a re-mount of the room-select scene. Re-mounting
 *     means the room-select grid re-reads progress and reflects any
 *     completion that happened in this session.
 *   • Hardware back is wired in main.ts via @capacitor/app and goes
 *     through the same ctx.back() path.
 */

import type { RoomTarget, SceneContext, SceneMount } from './scenes.js';
import type { PuzzleMeta } from './content.js';
import { isCompleted } from './progress.js';
import { loadFilledBitset } from './paint-state.js';
import { loadRoomThumbs, renderThumb, type Thumb, type ThumbBundle } from './thumbs.js';
import { ContentResolveError, loadPuzzle } from './content.js';
import { t } from './i18n.js';

interface PictureState {
  meta: PuzzleMeta;
  completed: boolean;
  filled: Uint8Array | null;
}

interface TileEntry extends PictureState {
  /** Per-puzzle thumb data from thumbs.json. */
  thumb: Thumb | null;
  /** Tile button element in the DOM. */
  tile: HTMLButtonElement;
  /** Current visual state. */
  status: 'loading' | 'ready' | 'failed';
}

export function makeRoomSceneMount(target: RoomTarget): SceneMount {
  return (host, ctx) => {
    const root = document.createElement('div');
    root.className = 'scene scene-room';
    root.innerHTML = `
      <header class="scene-header">
        <button class="back-btn" type="button" aria-label="${t('backToRooms')}">
          <svg class="back-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 5 L8 12 L15 19" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <h1 class="scene-title">${t('room')} ${target.roomN}</h1>
        <span class="scene-spacer" aria-hidden="true"></span>
      </header>
      <div class="room-body"></div>
    `;
    host.appendChild(root);

    const back = root.querySelector<HTMLButtonElement>('.back-btn')!;
    const onBack = () => ctx.back();
    back.addEventListener('click', onBack);

    const body = root.querySelector<HTMLDivElement>('.room-body')!;
    body.innerHTML = `<p class="scene-note">${t('loadingPictures')}</p>`;

    const pictures = ctx.index.rooms[String(target.roomN)] ?? [];
    let cancelled = false;
    const isCancelled = () => cancelled;

    // Load thumbs + every picture's painted-state bitset in
    // parallel. Each tile's grayscale-of-real-color preview needs
    // BOTH — the thumb palette/cells AND that picture's saved
    // filled bitset. Bitset loads are local-storage reads (cheap)
    // and the thumbs file is small (~9 KB per room), so parallel
    // is fine here — the SEQUENTIAL-loading guarantee applies to
    // the full puzzle JSONs below, which are the heavy network
    // traffic on rooms 2+.
    Promise.all([
      loadRoomThumbs(target.roomN),
      Promise.all(
        pictures.map(async (meta) => {
          if (isCompleted(meta.id)) {
            return { meta, completed: true, filled: null as Uint8Array | null };
          }
          const filled = await loadFilledBitset(meta.id, meta.w * meta.h);
          return { meta, completed: false, filled };
        }),
      ),
    ])
      .then(async ([bundle, pictureStates]) => {
        if (cancelled) return;
        const entries = renderPlaceholderGrid(body, pictureStates, bundle);
        // Sequentially fetch every puzzle JSON, render its thumb
        // as it arrives. Strict order: a fast first-tile fetch
        // never overtakes a slow earlier one in the visual fill-in.
        await loadPuzzlesSequentially(entries, ctx, isCancelled);
      })
      .catch((err) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error('[Mozai] thumbs load failed', err);
        // The localised message stays the primary readable line.
        // Below it, on a smaller / lighter sub-line, we show the
        // resolver's reason code + the failing file basename so a
        // device-side debug session can see WHAT actually went
        // wrong (network:404, validation:cells_length_mismatch, …)
        // without needing the removed debug overlay back. The
        // reason code is intentionally NOT translated — it's a
        // compact diagnostic token, not user-facing copy.
        const reason = err instanceof ContentResolveError ? err.reason : 'unknown';
        const basename = err instanceof ContentResolveError ? fileBasename(err.path) : '';
        const detail = basename ? `${reason} (${basename})` : reason;
        body.innerHTML = `
          <p class="scene-note scene-error">
            ${t('roomLoadFailed')}<br>
            <span class="scene-error-reason">${escapeHtml(detail)}</span><br>
            <button class="cta-btn" type="button" data-retry>${t('retry')}</button>
          </p>`;
        body.querySelector<HTMLButtonElement>('[data-retry]')?.addEventListener('click', () => {
          // Re-mount via REPLACE, not PUSH: a failed retry must not
          // grow the history stack. The previous push-based form
          // turned every retry tap into another "back" press the
          // user later had to undo to leave the room.
          ctx.replace({ scene: 'room', roomN: target.roomN });
        });
      });

    return () => {
      cancelled = true;
      back.removeEventListener('click', onBack);
      root.remove();
    };
  };
}

/**
 * Build the grid with all tiles in the LOADING state. Tiles whose
 * thumb is missing in the bundle (prebuild out of sync) render as a
 * permanent error tile; everything else gets a spinner placeholder
 * that will transition to READY or FAILED via loadPuzzlesSequentially.
 */
function renderPlaceholderGrid(
  host: HTMLElement,
  states: PictureState[],
  bundle: ThumbBundle,
): TileEntry[] {
  host.innerHTML = '';

  if (states.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'scene-note';
    empty.textContent = t('noPicturesYet');
    host.appendChild(empty);
    return [];
  }

  const grid = document.createElement('div');
  grid.className = 'picture-grid';
  grid.setAttribute('role', 'list');
  host.appendChild(grid);

  const entries: TileEntry[] = [];
  for (const ps of states) {
    const thumb = bundle[ps.meta.id] ?? null;
    if (!thumb) {
      grid.appendChild(buildErrorTile(ps.meta.id));
      continue;
    }
    const tile = buildLoadingTile(ps.meta);
    grid.appendChild(tile);
    entries.push({ ...ps, thumb, tile, status: 'loading' });
  }
  return entries;
}

/**
 * Walk the entry list in order, awaiting each puzzle's resolver
 * outcome before starting the next. A successful load transitions
 * the tile to READY; a resolver failure (offline, cache miss,
 * validation reject after exhausting retries) transitions to
 * FAILED with a per-tile retry handler that re-runs just this one.
 *
 * Strictly sequential by design: concurrency=1 keeps the radio
 * powered for one socket at a time on a flaky network, so a drop
 * mid-room loses at most one in-flight request, never the whole
 * queue.
 */
async function loadPuzzlesSequentially(
  entries: TileEntry[],
  ctx: SceneContext,
  isCancelled: () => boolean,
): Promise<void> {
  for (const entry of entries) {
    if (isCancelled()) return;
    await loadOnePuzzleIntoTile(entry, ctx, isCancelled);
  }
}

async function loadOnePuzzleIntoTile(
  entry: TileEntry,
  ctx: SceneContext,
  isCancelled: () => boolean,
): Promise<void> {
  try {
    await loadPuzzle(entry.meta);
    if (isCancelled()) return;
    markTileReady(entry, ctx);
  } catch {
    if (isCancelled()) return;
    markTileFailed(entry, ctx, isCancelled);
  }
}

/**
 * Loading-state tile. Disabled (no click → preview), shows a
 * spinner. Held in this state until the puzzle JSON downloads +
 * validates successfully.
 */
function buildLoadingTile(meta: PuzzleMeta): HTMLButtonElement {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'picture-tile is-loading';
  tile.setAttribute('role', 'listitem');
  tile.setAttribute('aria-label', `${meta.id}, ${t('picStateLoading')}`);
  tile.disabled = true;
  tile.innerHTML = `<span class="picture-tile-spinner" aria-hidden="true"></span>`;
  return tile;
}

function buildErrorTile(id: string): HTMLButtonElement {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'picture-tile is-error';
  tile.disabled = true;
  tile.textContent = `⚠ ${id}`;
  return tile;
}

/**
 * Transition a tile from LOADING (or FAILED → retried) to READY:
 * swap the placeholder for the thumb canvas + completion check,
 * paint the thumb, wire the preview click handler.
 */
function markTileReady(entry: TileEntry, ctx: SceneContext): void {
  entry.status = 'ready';
  const tile = entry.tile;
  tile.classList.remove('is-loading', 'is-failed');
  if (entry.completed) tile.classList.add('is-completed');
  tile.disabled = false;
  const ariaState = entry.completed
    ? t('picStateCompleted')
    : entry.filled
      ? t('picStateInProgress')
      : t('picStateNotStarted');
  tile.setAttribute('aria-label', `${entry.meta.id}, ${ariaState}`);

  tile.replaceChildren();
  const canvas = document.createElement('canvas');
  canvas.className = 'picture-canvas';
  tile.appendChild(canvas);
  if (entry.completed) {
    const check = document.createElement('span');
    check.className = 'tile-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = '✓';
    tile.appendChild(check);
  }
  paintTileCanvas(canvas, entry);

  // Replace any prior click listener (could exist from a previous
  // FAILED → retry cycle). Using onclick for idempotent
  // replacement; the prior listener (if any) is discarded.
  tile.onclick = () => {
    ctx.push({ scene: 'preview', meta: entry.meta });
  };
}

/**
 * Transition a tile to FAILED: retry glyph + tap-to-retry. Tapping
 * resets to LOADING and re-runs loadOnePuzzleIntoTile for THIS
 * entry only — other entries are unaffected.
 */
function markTileFailed(
  entry: TileEntry,
  ctx: SceneContext,
  isCancelled: () => boolean,
): void {
  entry.status = 'failed';
  const tile = entry.tile;
  tile.classList.remove('is-loading');
  tile.classList.add('is-failed');
  tile.disabled = false;
  tile.setAttribute('aria-label', `${entry.meta.id}, ${t('picStateFailed')}`);
  tile.replaceChildren();
  const retry = document.createElement('span');
  retry.className = 'picture-tile-retry';
  retry.setAttribute('aria-hidden', 'true');
  retry.textContent = '⟳';
  tile.appendChild(retry);
  tile.onclick = () => {
    if (isCancelled()) return;
    // Reset to LOADING and retry just this puzzle. The other
    // entries in the room are unaffected; the user is paying the
    // cost of one fetch, not a whole-room re-attempt.
    entry.status = 'loading';
    tile.classList.remove('is-failed');
    tile.classList.add('is-loading');
    tile.disabled = true;
    tile.replaceChildren();
    const spinner = document.createElement('span');
    spinner.className = 'picture-tile-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    tile.appendChild(spinner);
    tile.onclick = null;
    loadOnePuzzleIntoTile(entry, ctx, isCancelled);
  };
}

/**
 * Allocate the canvas backing store and paint the thumb. Sized
 * from the tile's actual CSS pixel box × devicePixelRatio so
 * silhouettes stay crisp on Hi-DPI screens. Read of
 * getBoundingClientRect is cheap — every tile is the same CSS
 * size (set by .picture-canvas in style.css) so layout has long
 * since stabilised by the time we get here.
 */
function paintTileCanvas(canvas: HTMLCanvasElement, entry: TileEntry): void {
  if (!entry.thumb) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  canvas.width = w;
  canvas.height = h;
  renderThumb(canvas, entry.thumb, {
    completed: entry.completed,
    filled: entry.filled,
    sourceW: entry.meta.w,
    sourceH: entry.meta.h,
  });
}

/**
 * `content/roomN/r2-001.json` → `r2-001`. Used to include the
 * specific failing file in the on-device error sub-line so a
 * load failure is traceable without the debug overlay.
 */
function fileBasename(path: string): string {
  const slash = path.lastIndexOf('/');
  const tail = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = tail.lastIndexOf('.');
  return dot > 0 ? tail.slice(0, dot) : tail;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
