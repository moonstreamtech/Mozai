/*
 * Room-interior scene — STUB.
 *
 * Shows the room number, a back button, and the room's picture ids as
 * tappable items that route to the paint stub. Silhouette previews
 * land in a later prompt.
 *
 * Keeps the same outer chrome conventions as the room-select scene
 * (white panel, scrollable, banner-aware) so the visual jump between
 * scenes is just the content swap.
 */

import type { RoomTarget, SceneMount } from './scenes.js';
import { isCompleted } from './progress.js';

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
      <p class="scene-note">Pick a picture to colour.</p>
      <div class="picture-list" role="list"></div>
    `;
    host.appendChild(root);

    const back = root.querySelector<HTMLButtonElement>('.back-btn')!;
    back.addEventListener('click', () => ctx.back());

    const list = root.querySelector<HTMLDivElement>('.picture-list')!;
    const pictures = ctx.index.rooms[String(target.roomN)] ?? [];

    if (pictures.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'rooms-empty';
      empty.textContent = `Room ${target.roomN} has no pictures yet.`;
      list.appendChild(empty);
    } else {
      for (const meta of pictures) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'picture-item' + (isCompleted(meta.id) ? ' is-completed' : '');
        item.setAttribute('role', 'listitem');
        item.innerHTML = `
          <span class="picture-id">${meta.id}</span>
          <span class="picture-meta">${meta.w}×${meta.h}, ${meta.colors} colour${meta.colors === 1 ? '' : 's'}</span>
          ${isCompleted(meta.id) ? '<span class="picture-check" aria-label="Completed">✓</span>' : ''}
        `;
        item.addEventListener('click', () => ctx.push({ scene: 'paint', meta }));
        list.appendChild(item);
      }
    }

    return () => {
      root.remove();
    };
  };
}
