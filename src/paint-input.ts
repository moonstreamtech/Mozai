/*
 * Paint scene input.
 *
 * Mode contract:
 *   1 finger down → start a paint stroke at the cell under the
 *                  finger; subsequent move events paint each cell
 *                  along the finger path (correct ones fill, wrong
 *                  ones silently rejected by paint-state).
 *   2 fingers     → cancel any in-flight paint stroke and switch to
 *                  pan / pinch-zoom: the midpoint of the two fingers
 *                  is the pan anchor; the change in finger distance
 *                  drives zoom.
 *   1 → 0         → end the paint stroke. The state's filledCount
 *                  is checked by the scene for completion.
 *
 * Why pointer events: Capacitor's WebView delivers pointer events
 * for both touch and mouse with the same API. Touch tap → mouse
 * synthesis would lose multi-finger pinch and confuse the mode
 * machine, so we work in pointer-event space.
 */

import type { PaintRenderer, CameraLimits } from './paint-render.js';
import type { PaintState } from './paint-state.js';
import type { PaintPerfSink } from './paint-perf.js';

export interface PaintInputDeps {
  canvas: HTMLCanvasElement;
  renderer: PaintRenderer;
  state: PaintState;
  /** Currently selected palette index, or -1 if none. */
  getSelectedColor: () => number;
  /**
   * Called whenever a cell is successfully filled. Lets the scene
   * update the palette swatch percentages, the overall %, and
   * react to puzzle completion.
   */
  onCellFilled: (cellIndex: number, colorIndex: number, completed: boolean) => void;
  /**
   * Called whenever a pan or zoom changes the camera. Used by the
   * scene to toggle the minimap on/off as the user zooms past fit.
   */
  onCameraChange?: () => void;
  limits: () => CameraLimits;
}

type ActivePointer = { id: number; x: number; y: number };

export class PaintInput {
  private readonly deps: PaintInputDeps;
  private readonly pointers = new Map<number, ActivePointer>();
  /**
   * Master gate for ALL pointer / wheel input. Set true to make
   * every handler short-circuit — used by the scene's completion
   * reveal animation (the camera glides to fit-zoom over a few
   * hundred ms and the user must not be able to fight the easing
   * or land an accidental paint mid-transition). Set back to false
   * once the reveal completes. Direct property; the scene owns the
   * toggle.
   */
  paused = false;
  /**
   * Optional diagnostic perf sink (paint-perf.ts). Null in production;
   * when set, each processed pointermove is counted so the overlay can
   * compare moves/s against draws/s (the rAF-coalescing check).
   */
  perf: PaintPerfSink | null = null;
  /** True iff a single-finger paint stroke is in progress. */
  private painting = false;
  /** Cells already attempted during the current stroke (avoid retrying). */
  private strokeAttempted = new Set<number>();
  /**
   * Cell (cx, cy) the active stroke last visited, or -1 for "none".
   * Used to interpolate (Bresenham line walk) between consecutive
   * pointer-move events: a fast swipe fires move events 16+ CSS px
   * apart, which on a small-celled view skips intervening cells.
   * Walking the line from lastCellXY to the current cell paints
   * every cell along the swipe even when the move-event rate
   * can't keep up. Reset to -1 on stroke end so the next stroke
   * starts fresh (no phantom line connecting end-of-stroke A to
   * start-of-stroke B).
   */
  private lastCellX = -1;
  private lastCellY = -1;
  /** Pinch-zoom baseline: distance between the two pointers at gesture start. */
  private pinchStartDist = 0;
  private pinchStartZoom = 1;
  /** Pan baseline (cells) at gesture start. */
  private panStartOffsetX = 0;
  private panStartOffsetY = 0;
  /** Midpoint of two pointers at gesture start (CSS px, canvas-local). */
  private gestureStartMidX = 0;
  private gestureStartMidY = 0;
  /** Bound listener refs for clean removal. */
  private readonly onDown: (e: PointerEvent) => void;
  private readonly onMove: (e: PointerEvent) => void;
  private readonly onUp: (e: PointerEvent) => void;
  private readonly onWheel: (e: WheelEvent) => void;

  constructor(deps: PaintInputDeps) {
    this.deps = deps;
    this.onDown = this.handleDown.bind(this);
    this.onMove = this.handleMove.bind(this);
    this.onUp = this.handleUp.bind(this);
    this.onWheel = this.handleWheel.bind(this);
    deps.canvas.addEventListener('pointerdown', this.onDown);
    deps.canvas.addEventListener('pointermove', this.onMove);
    deps.canvas.addEventListener('pointerup', this.onUp);
    deps.canvas.addEventListener('pointercancel', this.onUp);
    deps.canvas.addEventListener('pointerleave', this.onUp);
    // Desktop / browser preview: mouse wheel zooms in/out around the
    // cursor. Mobile pinch is handled via pointer events above.
    deps.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    // Disable browser-native touch panning / pinch — we own those.
    deps.canvas.style.touchAction = 'none';
  }

  dispose(): void {
    const { canvas } = this.deps;
    canvas.removeEventListener('pointerdown', this.onDown);
    canvas.removeEventListener('pointermove', this.onMove);
    canvas.removeEventListener('pointerup', this.onUp);
    canvas.removeEventListener('pointercancel', this.onUp);
    canvas.removeEventListener('pointerleave', this.onUp);
    canvas.removeEventListener('wheel', this.onWheel);
  }

  private getLocalPos(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.deps.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private handleDown(e: PointerEvent): void {
    if (this.paused) return;
    const pos = this.getLocalPos(e);
    this.pointers.set(e.pointerId, { id: e.pointerId, x: pos.x, y: pos.y });
    this.deps.canvas.setPointerCapture(e.pointerId);

    if (this.pointers.size === 1) {
      // Start a paint stroke immediately on first touch so the cell
      // tapped on a quick tap-and-release also fills.
      this.painting = this.deps.getSelectedColor() >= 0;
      this.strokeAttempted.clear();
      this.lastCellX = -1;
      this.lastCellY = -1;
      if (this.painting) {
        const { cx, cy } = this.screenToCellCoords(pos.x, pos.y);
        this.attemptCellXY(cx, cy);
        this.lastCellX = cx;
        this.lastCellY = cy;
      }
    } else if (this.pointers.size === 2) {
      // Two fingers: cancel any in-flight paint and lock into pan/zoom.
      this.painting = false;
      this.strokeAttempted.clear();
      this.lastCellX = -1;
      this.lastCellY = -1;
      this.beginPanZoom();
    }
    // 3+ fingers: ignore — pan/zoom uses the first two and the rest
    // are observers. handleMove handles whichever pair shows up.
    e.preventDefault();
  }

  private handleMove(e: PointerEvent): void {
    if (this.paused) return;
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.perf?.recordPointerMove();
    const pos = this.getLocalPos(e);
    p.x = pos.x;
    p.y = pos.y;

    if (this.pointers.size === 1 && this.painting) {
      const { cx, cy } = this.screenToCellCoords(pos.x, pos.y);
      if (this.lastCellX < 0) {
        // First in-stroke move (or first paint after re-entering the
        // grid from outside). Just attempt this cell — no prior
        // point to interpolate from.
        this.attemptCellXY(cx, cy);
      } else if (cx !== this.lastCellX || cy !== this.lastCellY) {
        // Walk every cell on the straight line between the previous
        // pointer cell and the current one, so a fast swipe doesn't
        // leave gaps when pointermove events skip cells. The walk's
        // cost is bounded by the segment length (max(|dx|,|dy|)) —
        // never the whole grid.
        this.paintLineXY(this.lastCellX, this.lastCellY, cx, cy);
      }
      this.lastCellX = cx;
      this.lastCellY = cy;
    } else if (this.pointers.size >= 2) {
      this.applyPanZoom();
    }
    e.preventDefault();
  }

  private handleUp(e: PointerEvent): void {
    // Note: we deliberately DO NOT bail on `paused` here. If the
    // user was painting when the scene paused, the existing pointers
    // must still be cleared on pointerup so they don't get
    // resurrected when the pause lifts.
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    try {
      this.deps.canvas.releasePointerCapture(e.pointerId);
    } catch {
      // Already released — fine.
    }
    if (this.pointers.size < 2) {
      // Leaving pan/zoom either fully or back to one-finger. Either way,
      // re-prime so the remaining finger does NOT silently resume paint
      // (would surprise the user, who was probably mid-pan and lifted
      // one finger by accident).
      this.painting = false;
      this.strokeAttempted.clear();
      this.lastCellX = -1;
      this.lastCellY = -1;
      if (this.pointers.size === 1) {
        // Re-arm pan from the remaining finger as the new anchor in
        // case the second finger comes back down (rare, but smooths
        // the transition).
        const remaining = Array.from(this.pointers.values())[0];
        this.gestureStartMidX = remaining.x;
        this.gestureStartMidY = remaining.y;
        this.panStartOffsetX = this.deps.renderer.camera.offsetX;
        this.panStartOffsetY = this.deps.renderer.camera.offsetY;
      }
    }
    e.preventDefault();
  }

  private handleWheel(e: WheelEvent): void {
    if (this.paused) return;
    e.preventDefault();
    const pos = this.getLocalPos(e);
    // Negative deltaY = scroll up = zoom in (matches Google Maps).
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    this.zoomAround(pos.x, pos.y, factor);
  }

  private beginPanZoom(): void {
    const ps = Array.from(this.pointers.values());
    const [a, b] = ps;
    this.pinchStartDist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    this.pinchStartZoom = this.deps.renderer.camera.zoom;
    this.gestureStartMidX = (a.x + b.x) / 2;
    this.gestureStartMidY = (a.y + b.y) / 2;
    this.panStartOffsetX = this.deps.renderer.camera.offsetX;
    this.panStartOffsetY = this.deps.renderer.camera.offsetY;
  }

  private applyPanZoom(): void {
    const ps = Array.from(this.pointers.values()).slice(0, 2);
    if (ps.length < 2) return;
    const [a, b] = ps;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    // Pinch math: zoom scales linearly with the ratio of current to
    // start finger distance. Fingers SPREADING (dist > startDist)
    // → ratio > 1 → desiredZoom > startZoom → zoom IN. This is the
    // standard "fingers spread = bigger" mental model. Anchored at
    // the gesture midpoint via the world-coord pin below so the
    // image scales about the fingers, not a corner.
    const desiredZoom = this.pinchStartZoom * (dist / this.pinchStartDist);
    const newZoom = this.applyZoom(desiredZoom);

    // World coordinate that was under the gesture midpoint at start —
    // we keep it pinned under the moving midpoint as zoom changes.
    const worldX = this.panStartOffsetX + this.gestureStartMidX / this.pinchStartZoom;
    const worldY = this.panStartOffsetY + this.gestureStartMidY / this.pinchStartZoom;
    this.deps.renderer.camera.offsetX = worldX - midX / newZoom;
    this.deps.renderer.camera.offsetY = worldY - midY / newZoom;
    this.deps.renderer.clampCamera();
    this.deps.renderer.scheduleFrame();
    this.deps.onCameraChange?.();
  }

  /**
   * Zoom around a screen point — used for wheel zoom and the +/- UI
   * buttons. Keeps the cell currently under the anchor stationary.
   */
  zoomAround(screenX: number, screenY: number, factor: number): void {
    const cam = this.deps.renderer.camera;
    const oldZoom = cam.zoom;
    const desired = oldZoom * factor;
    const worldX = cam.offsetX + screenX / oldZoom;
    const worldY = cam.offsetY + screenY / oldZoom;
    const newZoom = this.applyZoom(desired);
    if (newZoom === oldZoom) return;
    cam.offsetX = worldX - screenX / newZoom;
    cam.offsetY = worldY - screenY / newZoom;
    this.deps.renderer.clampCamera();
    this.deps.renderer.scheduleFrame();
    this.deps.onCameraChange?.();
  }

  /** Centre-anchored zoom (for the +/- UI buttons). */
  zoomCentered(factor: number): void {
    if (this.paused) return;
    const r = this.deps.canvas.getBoundingClientRect();
    this.zoomAround(r.width / 2, r.height / 2, factor);
  }

  /**
   * Single chokepoint for changing camera.zoom. Every zoom-change
   * path (pinch, +, −, wheel) MUST go through here — the previous
   * bug was a hardcoded maxZoom < fitZoom in the renderer which
   * made clamp() collapse to a binary toggle. Routing through one
   * helper keeps the assertion in one place.
   */
  private applyZoom(desired: number): number {
    const cam = this.deps.renderer.camera;
    const limits = this.deps.limits();
    let clamped = desired;
    if (clamped < limits.minZoom) clamped = limits.minZoom;
    if (clamped > limits.maxZoom) clamped = limits.maxZoom;
    cam.zoom = clamped;
    return clamped;
  }

  /**
   * Convert a canvas-local CSS pixel to integer cell coordinates.
   * Mirrors PaintRenderer.screenToCell but returns (cx, cy)
   * separately — needed for line interpolation. Returns possibly
   * out-of-grid coords; bounds are enforced in attemptCellXY.
   */
  private screenToCellCoords(screenX: number, screenY: number): { cx: number; cy: number } {
    const cam = this.deps.renderer.camera;
    const cx = Math.floor(cam.offsetX + screenX / cam.zoom);
    const cy = Math.floor(cam.offsetY + screenY / cam.zoom);
    return { cx, cy };
  }

  /**
   * Attempt to fill a single cell at integer grid coords. Silently
   * drops out-of-grid coords, already-attempted cells (the stroke
   * dedupe set), wrong-colour cells (state.attemptFill rejects),
   * and the no-colour-selected case. Single chokepoint so both the
   * tap path and the line-interpolation path go through the same
   * fill logic.
   */
  private attemptCellXY(cx: number, cy: number): void {
    const puzzle = this.deps.state.puzzle;
    if (cx < 0 || cy < 0) return;
    if (cx >= puzzle.w || cy >= puzzle.h) return;
    const cell = cy * puzzle.w + cx;
    if (this.strokeAttempted.has(cell)) return;
    this.strokeAttempted.add(cell);
    const colorIdx = this.deps.getSelectedColor();
    if (colorIdx < 0) return;
    const result = this.deps.state.attemptFill(cell, colorIdx);
    if (result.changed) {
      this.deps.renderer.updateCellFilled(cell);
      this.deps.onCellFilled(cell, colorIdx, result.completed);
    }
  }

  /**
   * Bresenham line walk from (x0, y0) to (x1, y1), attempting to
   * fill each cell along the way. Skips the starting cell — it was
   * already attempted on the previous move event — and emits the
   * destination cell last. Cost is O(max(|dx|, |dy|)) per call,
   * never proportional to the grid size; safe on 1000×1000.
   */
  private paintLineXY(x0: number, y0: number, x1: number, y1: number): void {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0;
    let y = y0;
    // Bound the loop length defensively. The natural termination is
    // (x === x1 && y === y1), which Bresenham always reaches, but
    // an explicit cap protects against any degenerate input from
    // ever spinning forever.
    const maxSteps = dx + dy + 1;
    for (let i = 0; i < maxSteps; i++) {
      // Skip the starting cell on the first iteration — already
      // attempted by the caller's previous move event.
      if (i > 0) this.attemptCellXY(x, y);
      if (x === x1 && y === y1) return;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
    }
  }
}
