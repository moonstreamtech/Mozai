/*
 * Room-interior scene.
 *
 * Layout: white panel that fills #game and scrolls vertically; respects
 * the foundation's --banner-h (#game already excludes it) and the
 * bottom safe-area inset. Header has the back button + room number.
 *
 * Body: a responsive 3-col CSS grid of square tiles. Each tile holds a
 * small <canvas> rendered from the room's thumbs.json:
 *   • NOT completed → SILHOUETTE (grey shape on white)
 *   • Completed     → FULL COLOUR + a small check badge
 *
 * Efficiency:
 *   • Only the room's slim thumbs.json is fetched. The full puzzle
 *     JSONs (which carry the heavy `cells` array) are NOT touched
 *     here — they load lazily when a tile is tapped in the next PR.
 *   • Tiles render lazily via IntersectionObserver: canvases are
 *     painted only when they intersect the scroll viewport (with a
 *     generous rootMargin so scrolling fast still keeps a paint-ahead
 *     buffer). Off-screen tiles stay empty <canvas> placeholders —
 *     cheap, and the dpr-sized backing store is allocated only when
 *     the tile actually becomes visible.
 *   • devicePixelRatio is applied to each canvas's backing store so
 *     the silhouettes stay crisp on Hi-DPI screens.
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
import { loadRoomThumbs, renderThumb, type Thumb, type ThumbBundle, type ThumbMode } from './thumbs.js';

// Generous over-scan so a fast flick still finds the next tile painted.
// 400 px ahead/behind the viewport is ~4 grid rows on a typical phone.
const VIEWPORT_OVER_SCAN = '400px';

// Per-tile thumb payload. WeakMap so removing a tile from the DOM
// releases the thumb reference for GC without manual bookkeeping.
const thumbForTile = new WeakMap<HTMLElement, { thumb: Thumb; mode: ThumbMode }>();

export function makeRoomSceneMount(target: RoomTarget): SceneMount {
  return (host, ctx) => {
    const root = document.createElement('div');
    root.className = 'scene scene-room';
    root.innerHTML = `
      <header class="scene-header">
        <button class="back-btn" type="button" aria-label="Back to rooms">←</button>
        <h1 class="scene-title">Room ${target.roomN}</h1>
        <span class="scene-spacer" aria-hidden="true"></span>
      </header>
      <div class="room-body"></div>
    `;
    host.appendChild(root);

    const back = root.querySelector<HTMLButtonElement>('.back-btn')!;
    const onBack = () => ctx.back();
    back.addEventListener('click', onBack);

    const body = root.querySelector<HTMLDivElement>('.room-body')!;

    // Loading placeholder. Replaced by the grid once thumbs.json
    // resolves; replaced by an error state if the fetch fails.
    body.innerHTML = '<p class="scene-note">Loading pictures…</p>';

    const pictures = ctx.index.rooms[String(target.roomN)] ?? [];

    // Hold references to per-tile rendering jobs so we can cancel
    // them on teardown.
    let cancelled = false;
    let intersectionObserver: IntersectionObserver | null = null;

    loadRoomThumbs(target.roomN)
      .then((bundle) => {
        if (cancelled) return;
        intersectionObserver = renderGrid(body, pictures, bundle, ctx);
      })
      .catch((err) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error('[Mozai] thumbs load failed', err);
        body.innerHTML = `
          <p class="scene-note scene-error">
            Could not load room ${target.roomN} thumbnails.<br>
            <button class="cta-btn" type="button" data-retry>Retry</button>
          </p>`;
        body.querySelector<HTMLButtonElement>('[data-retry]')?.addEventListener('click', () => {
          // Re-mount the scene by routing forward to the same target.
          ctx.push({ scene: 'room', roomN: target.roomN });
        });
      });

    return () => {
      cancelled = true;
      intersectionObserver?.disconnect();
      back.removeEventListener('click', onBack);
      root.remove();
    };
  };
}

function renderGrid(
  host: HTMLElement,
  pictures: PuzzleMeta[],
  bundle: ThumbBundle,
  ctx: SceneContext,
): IntersectionObserver | null {
  host.innerHTML = '';

  if (pictures.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'scene-note';
    empty.textContent = 'No pictures in this room yet.';
    host.appendChild(empty);
    return null;
  }

  const grid = document.createElement('div');
  grid.className = 'picture-grid';
  grid.setAttribute('role', 'list');
  host.appendChild(grid);

  // IntersectionObserver paints tiles only when they're (almost) on
  // screen. rootMargin gives us a paint-ahead buffer so scrolling
  // fast doesn't reveal blank tiles. We render once per tile, then
  // stop observing — re-painting on every scroll-by would cost more
  // than the small persistent backing store.
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const tile = entry.target as HTMLElement;
        renderTileCanvas(tile);
        io.unobserve(tile);
      }
    },
    {
      rootMargin: `${VIEWPORT_OVER_SCAN} 0px ${VIEWPORT_OVER_SCAN} 0px`,
      threshold: 0,
    },
  );

  for (const meta of pictures) {
    const thumb = bundle[meta.id];
    if (!thumb) {
      // A meta entry without a matching thumb means the prebuild was
      // out-of-sync with the committed thumbs.json. Render an empty
      // tile rather than crashing the whole room.
      grid.appendChild(buildErrorTile(meta.id));
      continue;
    }
    const tile = buildPictureTile(meta, thumb, ctx);
    grid.appendChild(tile);
    io.observe(tile);
  }

  return io;
}

function buildPictureTile(meta: PuzzleMeta, thumb: Thumb, ctx: SceneContext): HTMLButtonElement {
  const completed = isCompleted(meta.id);
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'picture-tile' + (completed ? ' is-completed' : '');
  tile.setAttribute('role', 'listitem');
  tile.setAttribute(
    'aria-label',
    completed ? `${meta.id}, completed` : `${meta.id}, silhouette`,
  );

  const canvas = document.createElement('canvas');
  canvas.className = 'picture-canvas';
  tile.appendChild(canvas);
  thumbForTile.set(tile, { thumb, mode: completed ? 'color' : 'silhouette' });

  if (completed) {
    const check = document.createElement('span');
    check.className = 'tile-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = '✓';
    tile.appendChild(check);
  }

  tile.addEventListener('click', () => {
    // Hand the meta straight through to the paint scene. It'll lazy-
    // load the full puzzle JSON itself when the colouring engine lands.
    ctx.push({ scene: 'paint', meta });
  });

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
 * Allocate the canvas backing store and paint it once.
 *
 * Sized from the tile's actual CSS pixel box × devicePixelRatio.
 * Reading getBoundingClientRect once per tile when it first enters
 * the viewport is cheap — every tile is the same CSS size (set by
 * .picture-canvas in style.css), so the layout has long since
 * stabilised by the time IntersectionObserver fires.
 */
function renderTileCanvas(tile: HTMLElement): void {
  const canvas = tile.querySelector<HTMLCanvasElement>('.picture-canvas');
  const payload = thumbForTile.get(tile);
  if (!canvas || !payload) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  canvas.width = w;
  canvas.height = h;
  renderThumb(canvas, payload.thumb, payload.mode);
}
