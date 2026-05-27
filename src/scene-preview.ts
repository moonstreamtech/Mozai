/*
 * Picture preview / cover scene.
 *
 * Acts as an interstitial between the room-interior tile tap and the
 * paint scene. Shows:
 *
 *   • Title: "Room N · seq" (the same form as the paint topbar).
 *   • Thumbnail: grayscale-of-real-color progress preview for an
 *     in-progress picture, full-colour for a completed one,
 *     fully-grayscale silhouette for a never-started one.
 *   • Info row: image dimensions ("10 × 10") + a row of palette
 *     colour dots.
 *   • CTA button: "Start" / "Başla" for not-yet-finished pictures,
 *     "View" for completed ones (paint scene already supports
 *     opening a completed picture for viewing — it just doesn't pop
 *     the completion modal again and the palette is empty).
 *
 * The thumbnail uses the same renderThumb() pipeline as the room
 * tiles, so a single bundle fetch covers both screens; the bundle is
 * cached so this is free after the first room visit.
 */

import type { PreviewTarget, SceneMount } from './scenes.js';
import type { PuzzleMeta } from './content.js';
import { isCompleted } from './progress.js';
import { loadFilledBitset } from './paint-state.js';
import { loadRoomThumbs, renderThumb, type Thumb } from './thumbs.js';
import { t } from './i18n.js';

function pictureTitle(meta: PuzzleMeta): string {
  const dash = meta.id.indexOf('-');
  const seq = dash >= 0 ? meta.id.slice(dash + 1) : meta.id;
  return `${t('room')} ${meta.room} · ${seq}`;
}

export function makePreviewSceneMount(target: PreviewTarget): SceneMount {
  return (host, ctx) => {
    const meta = target.meta;
    const completed = isCompleted(meta.id);
    const ctaKey = completed ? 'view' : 'start';
    const root = document.createElement('div');
    root.className = 'scene scene-preview';
    root.innerHTML = `
      <header class="scene-header">
        <button class="back-btn" type="button" aria-label="Back to room">
          <svg class="back-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 5 L8 12 L15 19" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <h1 class="scene-title">${pictureTitle(meta)}</h1>
        <span class="scene-spacer" aria-hidden="true"></span>
      </header>
      <div class="preview-body">
        <div class="preview-thumb-frame">
          <canvas class="preview-thumb-canvas"></canvas>
        </div>
        <div class="preview-info">
          <div class="preview-dim">${meta.w} × ${meta.h}</div>
          <div class="preview-palette"></div>
        </div>
        <button class="cta-btn preview-cta" type="button" data-preview-cta>${t(ctaKey)}</button>
      </div>
    `;
    host.appendChild(root);

    const back = root.querySelector<HTMLButtonElement>('.back-btn')!;
    const cta = root.querySelector<HTMLButtonElement>('[data-preview-cta]')!;
    const paletteRow = root.querySelector<HTMLDivElement>('.preview-palette')!;
    const thumbCanvas = root.querySelector<HTMLCanvasElement>('.preview-thumb-canvas')!;

    let cancelled = false;

    const onBack = () => ctx.back();
    // Replace (not push) so back from paint returns to the room,
    // not to this just-dismissed preview.
    const onStart = () => ctx.replace({ scene: 'paint', meta });
    back.addEventListener('click', onBack);
    cta.addEventListener('click', onStart);

    // Load + render the thumbnail. Both inputs (thumb bundle + the
    // picture's saved filled bitset) are room-cached so subsequent
    // preview opens for the same room are instant.
    Promise.all([
      loadRoomThumbs(meta.room),
      completed
        ? Promise.resolve(null as Uint8Array | null)
        : loadFilledBitset(meta.id, meta.w * meta.h),
    ])
      .then(([bundle, filled]) => {
        if (cancelled) return;
        const thumb = bundle[meta.id];
        if (!thumb) return;
        renderPaletteRow(paletteRow, thumb);
        // Defer the canvas paint by one rAF so the canvas's CSS box
        // has resolved its computed size — getBoundingClientRect on
        // an unlaid-out element returns 0 and we'd paint into a 1×1
        // backing store.
        requestAnimationFrame(() => {
          if (cancelled) return;
          paintThumb(thumbCanvas, thumb, meta, completed, filled);
        });
      })
      .catch(() => {
        // Quiet failure — the preview still shows the title +
        // dimensions + palette + CTA, just without the thumbnail.
      });

    return () => {
      cancelled = true;
      back.removeEventListener('click', onBack);
      cta.removeEventListener('click', onStart);
      root.remove();
    };
  };
}

function renderPaletteRow(host: HTMLElement, thumb: Thumb): void {
  host.replaceChildren();
  for (const hex of thumb.palette) {
    const dot = document.createElement('span');
    dot.className = 'preview-palette-dot';
    dot.style.background = hex;
    host.appendChild(dot);
  }
}

function paintThumb(
  canvas: HTMLCanvasElement,
  thumb: Thumb,
  meta: PuzzleMeta,
  completed: boolean,
  filled: Uint8Array | null,
): void {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  canvas.width = w;
  canvas.height = h;
  renderThumb(canvas, thumb, {
    completed,
    filled,
    sourceW: meta.w,
    sourceH: meta.h,
  });
}
