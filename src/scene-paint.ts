/*
 * Paint scene — STUB.
 *
 * Real coloring engine is a later prompt. This stub just shows the
 * picture id, a back button, and a "Mark complete" button that
 * exercises the progress save path end-to-end so the room-select %
 * fill can be verified.
 *
 * Once the real coloring engine lands, this file becomes the
 * canvas-renderer scene. The mount signature is already what the
 * scene manager expects, so swapping is a one-file change.
 */

import type { PaintTarget, SceneMount } from './scenes.js';
import { isCompleted, markCompleted } from './progress.js';

export function makePaintSceneMount(target: PaintTarget): SceneMount {
  return (host, ctx) => {
    const meta = target.meta;
    const root = document.createElement('div');
    root.className = 'scene scene-paint';
    root.innerHTML = `
      <header class="scene-header">
        <button class="back-btn" type="button" aria-label="Back to room">←</button>
        <h1 class="scene-title">${meta.id}</h1>
        <span class="scene-spacer" aria-hidden="true"></span>
      </header>
      <p class="scene-note">
        Room ${meta.room} · ${meta.w}×${meta.h} · ${meta.colors} colour${meta.colors === 1 ? '' : 's'}<br>
        Coloring engine lands in a future PR.
      </p>
      <div class="paint-stub-canvas" aria-hidden="true"></div>
      <button class="cta-btn" type="button" data-action="mark-complete">
        ${isCompleted(meta.id) ? 'Completed ✓' : 'Mark complete (stub)'}
      </button>
    `;
    host.appendChild(root);

    const back = root.querySelector<HTMLButtonElement>('.back-btn')!;
    back.addEventListener('click', () => ctx.back());

    const mark = root.querySelector<HTMLButtonElement>('[data-action="mark-complete"]')!;
    mark.addEventListener('click', async () => {
      mark.disabled = true;
      await markCompleted(meta.id);
      mark.textContent = 'Completed ✓';
      // We do NOT auto-navigate here. The user can press Back to
      // return to the room scene, where the picture will then show a
      // ✓ — and the room-select grid will reflect the updated %
      // because every scene re-mounts on back navigation.
    });

    return () => {
      root.remove();
    };
  };
}
