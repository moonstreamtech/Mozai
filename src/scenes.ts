/*
 * Minimal scene manager.
 *
 * Four scenes, swapped inside #game:
 *   'rooms'   — the room-select grid (entry point)
 *   'room'    — room-interior showing the room's pictures
 *   'preview' — picture preview / cover screen with Start / View button
 *   'paint'   — colour-by-number paint scene
 *
 * Why not a router library: the foundation is intentionally lean —
 * one container, one swap. A library would add an order of magnitude
 * more JS for zero benefit at this stage. Scenes are plain modules
 * that own DOM under `#game` and clean up after themselves on exit.
 *
 * Model: the manager keeps a navigation HISTORY (a stack of targets)
 * and tracks exactly one CURRENT teardown. push() tears down the
 * current scene and mounts a new one; back() tears down the current
 * scene and re-mounts the previous target. Re-mounting (rather than
 * resume / suspend) means the room-select grid always shows fresh
 * progress % after returning from a paint session.
 *
 * --- THE NAVIGATION RULE ---
 *
 * EVERY user navigation in or out of a scene is exactly ONE push,
 * replace, or back. Scenes do NOT chain their own back, and they
 * do NOT push the same target they're already on. This guarantees
 * that one Android back-button press always pops exactly one level.
 *
 * Concretely:
 *   • Entering a new scene → push.
 *   • Skipping the current scene as you go forward (e.g. preview →
 *     paint, where back from paint should land on the room, not
 *     the preview) → replace.
 *   • Retrying a failed mount of the SAME scene → replace (NOT
 *     push — pushing the same scene grows the history stack and
 *     each back tap then only undoes one retry).
 *   • Backing out (back button, hardware back, completion "Tamam"
 *     button) → back.
 */

import type { ContentIndex, PuzzleMeta } from './content.js';

export type SceneId = 'rooms' | 'room' | 'preview' | 'paint';

/**
 * Each scene is asked to mount into a host element and returns a
 * teardown function. The teardown MUST remove every listener it
 * attached and clear the host's children — the scene manager calls
 * it before mounting the next scene.
 */
export type SceneMount = (host: HTMLElement, ctx: SceneContext) => SceneTeardown;
export type SceneTeardown = () => void;

/**
 * Context handed to every scene. Lets a scene navigate forward by
 * pushing a new scene, and read the loaded content index without
 * having to re-fetch it.
 */
export interface SceneContext {
  index: ContentIndex;
  push: (target: SceneTarget) => void;
  /**
   * Replace the current scene in history (no extra back step). Used
   * by the preview interstitial so back from paint returns to the
   * room rather than to the preview the user just dismissed.
   */
  replace: (target: SceneTarget) => void;
  /** Pop the current scene; no-op when at the root. */
  back: () => void;
  /** True iff a back action is possible (used to disable the back button at the root). */
  canBack: () => boolean;
}

/** Targets the room scene can be entered with. */
export interface RoomTarget {
  scene: 'room';
  roomN: number;
}
/** Targets the preview / cover scene can be entered with. */
export interface PreviewTarget {
  scene: 'preview';
  meta: PuzzleMeta;
}
/** Targets the paint scene can be entered with. */
export interface PaintTarget {
  scene: 'paint';
  meta: PuzzleMeta;
}
/** The room-select grid takes no parameters. */
export interface RoomsTarget {
  scene: 'rooms';
}
export type SceneTarget = RoomsTarget | RoomTarget | PreviewTarget | PaintTarget;

export interface SceneRegistry {
  rooms: SceneMount;
  room: (target: RoomTarget) => SceneMount;
  preview: (target: PreviewTarget) => SceneMount;
  paint: (target: PaintTarget) => SceneMount;
}

export interface SceneManagerOpts {
  host: HTMLElement;
  index: ContentIndex;
  registry: SceneRegistry;
}

export class SceneManager {
  private readonly host: HTMLElement;
  private readonly index: ContentIndex;
  private readonly registry: SceneRegistry;
  /** Navigation history. Index 0 is the root, top is the current scene. */
  private history: SceneTarget[] = [];
  /** Teardown for the currently mounted scene, or null when nothing is mounted. */
  private currentTeardown: SceneTeardown | null = null;

  constructor(opts: SceneManagerOpts) {
    this.host = opts.host;
    this.index = opts.index;
    this.registry = opts.registry;
  }

  /** Start at the room-select scene. Safe to call once at boot. */
  start(): void {
    this.push({ scene: 'rooms' });
  }

  push = (target: SceneTarget): void => {
    this.teardownCurrent();
    this.host.replaceChildren();
    this.mountTarget(target);
    this.history.push(target);
  };

  /**
   * Drop the current target from history and mount a new one in its
   * place — total history length is unchanged. Used by the preview
   * → paint transition so back from paint returns to the room.
   */
  replace = (target: SceneTarget): void => {
    this.teardownCurrent();
    this.host.replaceChildren();
    if (this.history.length > 0) this.history.pop();
    this.mountTarget(target);
    this.history.push(target);
  };

  back = (): void => {
    if (this.history.length <= 1) return;
    this.teardownCurrent();
    this.host.replaceChildren();
    this.history.pop();
    const previous = this.history[this.history.length - 1];
    // Re-mount the previous target. We mount THEN leave the history
    // length unchanged (previous is still on top) — back() is a
    // navigation, not a discard.
    this.mountTarget(previous);
  };

  canBack = (): boolean => this.history.length > 1;

  private teardownCurrent(): void {
    if (this.currentTeardown) {
      this.currentTeardown();
      this.currentTeardown = null;
    }
  }

  private mountTarget(target: SceneTarget): void {
    const mount = this.resolveMount(target);
    const ctx: SceneContext = {
      index: this.index,
      push: this.push,
      replace: this.replace,
      back: this.back,
      canBack: this.canBack,
    };
    this.currentTeardown = mount(this.host, ctx);
  }

  private resolveMount(target: SceneTarget): SceneMount {
    switch (target.scene) {
      case 'rooms':
        return this.registry.rooms;
      case 'room':
        return this.registry.room(target);
      case 'preview':
        return this.registry.preview(target);
      case 'paint':
        return this.registry.paint(target);
    }
  }
}
