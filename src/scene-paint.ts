/*
 * Paint scene — the colour-by-number gameplay.
 *
 * Layout (top → bottom, inside #game, above the AdMob banner):
 *
 *   ┌───────────────────────────────────────┐
 *   │ ← title (id)         42%    HINT 💡   │   .paint-topbar
 *   ├───────────────────────────────────────┤
 *   │                                       │
 *   │             paint canvas              │   .paint-viewport
 *   │       (pan / pinch / 1-finger paint)  │
 *   │                                       │
 *   ├───────────────────────────────────────┤
 *   │  ● ● ● ● ● ●   (zoom in/out)          │   .paint-palette
 *   └───────────────────────────────────────┘
 *
 * The scene owns the lifetime of the renderer + input + state. On
 * teardown it persists progress (best-effort) and frees the renderer's
 * raf. On every successful fill it updates the palette swatch
 * percentages and overall %; when a colour reaches 100% the swatch
 * fades out and (after a short delay so the UI doesn't jump
 * mid-tap) is removed from the palette.
 *
 * Discovery-only model (Model 1):
 *   - No numbers on cells.
 *   - Wrong paints are silently dropped (paint-state.attemptFill
 *     returns changed=false).
 *   - Background cells (-1) never fill.
 *   - Drag paints along the finger path; pan/zoom take over on a
 *     second finger touch.
 */

import type { PaintTarget, SceneContext, SceneMount } from './scenes.js';
import { ContentResolveError, loadPuzzle } from './content.js';
import { markCompleted } from './progress.js';
import { PaintState } from './paint-state.js';
import { PaintRenderer, type CameraLimits } from './paint-render.js';
import { PaintInput } from './paint-input.js';
import { showRewarded } from './rewarded.js';
import type { PuzzleMeta } from './content.js';
import { t } from './i18n.js';

const SAVE_DEBOUNCE_MS = 400;
/**
 * Duration of the smooth zoom-to-fit animation that plays the moment
 * the last cell is filled. Keeps the camera frozen to interactions
 * during the reveal so the player can't fight the easing.
 */
const COMPLETION_REVEAL_MS = 400;

/**
 * "Room N · seq" title used in the topbar. Parses the picture id's
 * `rN-...` form to extract the seq suffix; `meta.room` already
 * provides the room number from the JSON. The "Room" word is
 * localized via i18n.
 */
function pictureTitle(meta: PuzzleMeta): string {
  const dash = meta.id.indexOf('-');
  const seq = dash >= 0 ? meta.id.slice(dash + 1) : meta.id;
  return `${t('room')} ${meta.room} · ${seq}`;
}

export function makePaintSceneMount(target: PaintTarget): SceneMount {
  return (host, ctx) => {
    const meta = target.meta;
    const root = document.createElement('div');
    root.className = 'scene scene-paint';
    root.innerHTML = `
      <header class="paint-topbar">
        <button class="back-btn" type="button" aria-label="${t('backToRoom')}">
          <svg class="back-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 5 L8 12 L15 19" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <div class="paint-title-block">
          <span class="paint-title">${pictureTitle(meta)}</span>
          <span class="paint-progress-label" data-overall-pct>0%</span>
        </div>
        <button class="hint-btn" type="button" data-hint disabled>💡 ${t('hint')}</button>
      </header>
      <div class="paint-viewport">
        <canvas class="paint-canvas"></canvas>
        <div class="paint-zoom-controls" aria-hidden="true">
          <button class="zoom-btn" type="button" data-zoom-out aria-label="${t('zoomOut')}">−</button>
          <button class="zoom-btn" type="button" data-zoom-in aria-label="${t('zoomIn')}">+</button>
        </div>
        <div class="paint-loading" data-loading>${t('loadingPuzzle')}</div>
      </div>
      <div class="paint-bottom-strip">
        <div class="paint-palette" role="toolbar" aria-label="${t('colourPalette')}"></div>
        <div class="paint-completion-banner" data-completion hidden>
          <span class="paint-completion-banner-text">${t('completeTitle')}</span>
          <button class="paint-completion-banner-btn" type="button" data-dismiss-complete>${t('done')}</button>
        </div>
        <canvas class="paint-minimap" data-minimap aria-label="${t('minimap')}"></canvas>
      </div>
    `;
    host.appendChild(root);

    const back = root.querySelector<HTMLButtonElement>('.back-btn')!;
    const canvas = root.querySelector<HTMLCanvasElement>('.paint-canvas')!;
    const paletteEl = root.querySelector<HTMLDivElement>('.paint-palette')!;
    const loadingEl = root.querySelector<HTMLDivElement>('[data-loading]')!;
    const hintBtn = root.querySelector<HTMLButtonElement>('[data-hint]')!;
    const overallPctEl = root.querySelector<HTMLSpanElement>('[data-overall-pct]')!;
    const completionBannerEl = root.querySelector<HTMLDivElement>('[data-completion]')!;
    const zoomInBtn = root.querySelector<HTMLButtonElement>('[data-zoom-in]')!;
    const zoomOutBtn = root.querySelector<HTMLButtonElement>('[data-zoom-out]')!;
    const completionDismissBtn = root.querySelector<HTMLButtonElement>('[data-dismiss-complete]')!;
    const minimapEl = root.querySelector<HTMLCanvasElement>('[data-minimap]')!;

    let state: PaintState | null = null;
    let renderer: PaintRenderer | null = null;
    let input: PaintInput | null = null;
    let limits: CameraLimits = { minZoom: 0.1, maxZoom: 48 };
    let selectedColor = -1;
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let resizeObserver: ResizeObserver | null = null;
    // rAF coalescing + last-observed size for the paint-viewport
    // ResizeObserver. The refit work mutates layout-affecting state, so
    // it MUST run outside the observer's synchronous delivery (see the
    // observer below) or tablets trip "ResizeObserver loop limit
    // exceeded".
    let resizeRaf = 0;
    let lastViewportW = -1;
    let lastViewportH = -1;
    // Hardening: the completion banner MUST NOT fire during initial
    // load. Set true once the puzzle has been fully parsed AND
    // restored from saved state. attemptFill / onCellFilled are only
    // ever wired after load anyway (the linear flow below), so this
    // is a belt-and-braces guard against any future refactor that
    // accidentally lets `state.snapshot().complete` short-circuit
    // before the picture is paintable.
    let loadFinished = false;
    // Belt-and-braces: even with loadFinished as the inner gate, this
    // outer flag makes onPuzzleCompleted strictly idempotent for the
    // life of the scene. The reveal animation + banner only ever run
    // ONCE per mount.
    let completionShown = false;

    const onBack = () => doBack(ctx);
    back.addEventListener('click', onBack);

    // Completion banner dismiss. The banner lives inside the bottom
    // strip (not over the canvas), so the drag-tap-tail bug that
    // plagued the old centred modal can't reach this button: a
    // paint stroke's pointer is captured by the canvas and never
    // sees the banner.
    //
    // "Tamam" now navigates back to the room-interior scene rather
    // than just dismissing the banner. The 400 ms zoom-to-fit
    // reveal that ran before the banner appeared has already given
    // the player the "linger on finished art" beat; from this
    // moment on, the natural next action is to pick another
    // picture or see the next room unlock — both happen in the
    // room scene. Reopening a completed picture later is unchanged
    // (no banner, no animation, just fit-zoom + "✓ Done" in topbar).
    const onDismissComplete = () => {
      ctx.back();
    };
    completionDismissBtn.addEventListener('click', onDismissComplete);

    const onHint = () => {
      if (selectedColor < 0) return;
      // Capture which colour the user requested the hint for AT
      // TAP TIME — if the ad takes a few seconds and the user
      // changes selection mid-wait, the reward must apply to what
      // they originally asked for.
      const colorForHint = selectedColor;
      hintBtn.disabled = true;
      hintBtn.textContent = '💡 …';
      showRewarded()
        .then((granted) => {
          if (cancelled || !state || !renderer) return;
          if (!granted) return;
          // Hint behaviour: UNLOCK the selection outline for this
          // colour for the rest of this picture's life. revealHint()
          // adds the index to state.hintRevealed; the renderer's
          // drawSelectionOutlines checks that set on every frame, so
          // a single scheduleFrame() is enough to make the outline
          // appear. Persisted via PersistEnvelope.hints[] on the
          // next save.
          state.revealHint(colorForHint);
          renderer.scheduleFrame();
          scheduleSave();
          showToast(root, t('hintUnlocked'));
        })
        .finally(() => {
          if (cancelled) return;
          updateHintBtn();
        });
    };
    hintBtn.addEventListener('click', onHint);

    // 1.25 step (not 1.4): smaller per-tap step gives the user a
    // finer feel for the zoom, and lets ~6 taps span the full
    // minZoom→maxZoom range on a typical puzzle (1.25^6 ≈ 3.8x).
    const onZoomIn = () => input?.zoomCentered(1.25);
    const onZoomOut = () => input?.zoomCentered(1 / 1.25);
    zoomInBtn.addEventListener('click', onZoomIn);
    zoomOutBtn.addEventListener('click', onZoomOut);

    // Load full puzzle + restore previous session.
    loadPuzzle(meta)
      .then(async (puzzle) => {
        if (cancelled) return;

        state = new PaintState(puzzle);
        await state.load();
        if (cancelled) return;

        renderer = new PaintRenderer(canvas, state);
        // First fit pass — canvas already has its CSS size because the
        // .paint-viewport flex box sized it in the previous frame.
        limits = renderer.fitToScreen();
        // Bind the minimap canvas. The renderer paints into it on
        // every frame; the scene toggles visibility (hidden when
        // the puzzle fully fits the viewport, shown otherwise).
        renderer.setMinimap(minimapEl);
        input = new PaintInput({
          canvas,
          renderer,
          state,
          limits: () => limits,
          getSelectedColor: () => selectedColor,
          onCellFilled: (_cell, colorIdx, completed) => {
            updatePalette();
            updateOverall();
            scheduleSave();
            if (state && state.colorFilled[colorIdx] >= state.colorTotal[colorIdx]) {
              maybeDropSwatch(colorIdx);
            }
            // Belt-and-braces: never fire the completion modal until
            // the puzzle has finished loading. Today the PaintInput
            // is only constructed AFTER load so this can only fire
            // post-load, but a future refactor that pre-wires the
            // input would be silently caught here.
            if (completed && loadFinished) onPuzzleCompleted();
          },
        });

        // Re-fit on container resize (banner height changes, rotation,
        // keyboard) so the picture stays sensibly sized. We
        // deliberately do NOT call resetCameraToFit() here — that
        // would wipe the user's zoom and pan on every viewport
        // resize. Instead, recompute the limits and just CLAMP the
        // existing zoom into the new range, then clamp the pan
        // offset so the puzzle stays on-screen.
        //
        // When the puzzle is COMPLETE we additionally freeze the
        // camera entirely: even a sub-pixel viewport reflow (e.g.
        // 100% → "✓ Done" topbar text width change, palette swatch
        // removal vs the min-height pin, banner-h late refinement)
        // would otherwise re-clamp the camera and translate the
        // finished image by a few pixels. The "image still shifts
        // slightly downward on completion" symptom traces here.
        // The refit below mutates layout-affecting state (the canvas
        // backing store via draw(), and loadingEl.hidden). Running it
        // SYNCHRONOUSLY inside the ResizeObserver callback can re-enter
        // the observer within the same delivery cycle and trip Chrome's
        // "ResizeObserver loop limit exceeded" — which fired reliably on
        // tablet aspect ratios and, via the global error overlay, buried
        // the whole paint scene. So we (a) ignore callbacks whose
        // observed box hasn't actually changed (damps the width⇄height
        // oscillation a tablet's aspect ratio can drive) and (b) defer
        // the refit to requestAnimationFrame so the mutation lands
        // OUTSIDE the observer's synchronous cycle. One coalesced rAF is
        // kept in flight at a time. (Mirrors resize.ts, already loop-safe.)
        const paintViewport = root.querySelector<HTMLElement>('.paint-viewport')!;
        const applyResizeFit = () => {
          resizeRaf = 0;
          if (cancelled || !renderer) return;
          if (state && state.isComplete()) {
            renderer.draw();
            return;
          }
          const oldZoom = renderer.camera.zoom;
          const newLimits = renderer.computeFitLimits();
          if (oldZoom < newLimits.minZoom) renderer.camera.zoom = newLimits.minZoom;
          if (oldZoom > newLimits.maxZoom) renderer.camera.zoom = newLimits.maxZoom;
          renderer.clampCamera();
          limits = newLimits;
          // The first post-mount fit still clears the loading overlay,
          // just one frame later than before — the synchronous draw() a
          // few lines below already hides it on the common path.
          const painted = renderer.draw();
          if (painted) {
            loadingEl.hidden = true;
          }
        };
        resizeObserver = new ResizeObserver((entries) => {
          const box = entries[0]?.contentRect;
          const w = box ? box.width : paintViewport.clientWidth;
          const h = box ? box.height : paintViewport.clientHeight;
          // Sub-pixel deltas can't change the fit and are exactly what
          // the loop produces — ignore them to break the oscillation.
          if (Math.abs(w - lastViewportW) < 1 && Math.abs(h - lastViewportH) < 1) return;
          lastViewportW = w;
          lastViewportH = h;
          if (resizeRaf !== 0) return; // a refit is already scheduled
          resizeRaf = requestAnimationFrame(applyResizeFit);
        });
        resizeObserver.observe(paintViewport);

        renderPalette();
        updateOverall();
        // Try one synchronous draw — when the viewport already has a
        // CSS size (common in dev), the ResizeObserver may not fire
        // a follow-up callback and we'd be left with the loading
        // overlay covering a paintable canvas. Only hide the loading
        // overlay AFTER a successful paint (painted === true) so a
        // collapsed-viewport case stays visible until layout settles.
        const initialPainted = renderer.draw();
        if (initialPainted) {
          loadingEl.hidden = true;
        }

        // Load is finished — completion modal is now allowed to fire
        // from a real fill OR (if the saved progress is already at
        // 100%) from this resume-time check. Setting the flag BEFORE
        // the snapshot check lets a legitimate resume show the
        // completion overlay; future fills also gate on this flag
        // via onCellFilled below.
        loadFinished = true;
        const finalSnap = state.snapshot();
        if (finalSnap.complete) {
          // Resume of an already-completed picture: show the finished
          // art, NOT the completion modal. The modal is a celebration
          // for the moment of finishing — popping it every time the
          // user opens a completed picture would cover the artwork
          // they came to look at. updateOverall() below renders a
          // "✓ Done" label in the topbar so the completion state is
          // still visible without obscuring the canvas.
          // (selectedColor stays -1; no swatch to pre-select on a
          // fully done picture.)
        } else {
          // No auto-selection: the user picks a palette swatch
          // themselves. selectedColor stays at -1 until they tap.
          // The Hint button stays disabled until then; canvas
          // taps don't paint until then. The intent is that
          // colour selection is always a deliberate user choice,
          // never silently imposed by the engine.
        }
      })
      .catch((err) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error('[Mozai] loadPuzzle failed', err);
        // Localised message stays primary; the resolver's reason
        // code goes on a smaller sub-line so a device-side debug
        // session can see the precise cause without the removed
        // debug overlay. Reason codes are NOT translated — they're
        // compact diagnostic tokens (`validation:cells_length_mismatch`,
        // `network:404`, …), not user-facing copy.
        const reason = err instanceof ContentResolveError ? err.reason : 'unknown';
        loadingEl.innerHTML = `
          ${t('couldNotLoadPuzzle', { id: pictureTitle(meta) })}<br>
          <span class="scene-error-reason">${escapeHtml(`${reason} (${meta.id})`)}</span><br>
          <button class="cta-btn" type="button" data-paint-retry>${t('retry')}</button>
        `;
        loadingEl.classList.add('scene-error');
        loadingEl.querySelector<HTMLButtonElement>('[data-paint-retry]')?.addEventListener(
          'click',
          // Re-mount via REPLACE: a failed retry must not grow the
          // history stack — otherwise each tap adds a back-press the
          // user has to undo.
          () => ctx.replace({ scene: 'paint', meta }),
        );
      });

    // Minimap pointer flow. The minimap lives in the bottom strip
    // (sibling of the palette, NOT inside the paint viewport), so
    // pointer events never reach the paint canvas — no z-stacking
    // tricks needed. One unified flow handles tap-to-jump AND
    // drag-to-pan:
    //   • pointerdown → setPointerCapture, recentre once
    //   • pointermove (while captured) → recentre on every event
    //                                     (live drag-pan, redraw on
    //                                     each move)
    //   • pointerup / cancel           → end the drag
    // A pure tap (down + immediate up, no move) lands a single
    // recentre — same observable behaviour as the previous tap-only
    // flow.
    let minimapDragging = false;
    const minimapRecentre = (clientX: number, clientY: number): void => {
      if (!renderer) return;
      const rect = minimapEl.getBoundingClientRect();
      const local = renderer.minimapToWorld(clientX - rect.left, clientY - rect.top);
      if (!local) return;
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      const visibleCellsW = cssW / renderer.camera.zoom;
      const visibleCellsH = cssH / renderer.camera.zoom;
      renderer.camera.offsetX = local.worldX - visibleCellsW / 2;
      renderer.camera.offsetY = local.worldY - visibleCellsH / 2;
      renderer.clampCamera();
      renderer.scheduleFrame();
    };
    const onMinimapDown = (ev: PointerEvent) => {
      if (input?.paused) return;
      if (!renderer) return;
      minimapDragging = true;
      try { minimapEl.setPointerCapture(ev.pointerId); } catch { /* fine */ }
      minimapRecentre(ev.clientX, ev.clientY);
      ev.preventDefault();
    };
    const onMinimapMove = (ev: PointerEvent) => {
      if (!minimapDragging) return;
      minimapRecentre(ev.clientX, ev.clientY);
      ev.preventDefault();
    };
    const onMinimapUp = (ev: PointerEvent) => {
      if (!minimapDragging) return;
      minimapDragging = false;
      try { minimapEl.releasePointerCapture(ev.pointerId); } catch { /* fine */ }
      ev.preventDefault();
    };
    minimapEl.addEventListener('pointerdown', onMinimapDown);
    minimapEl.addEventListener('pointermove', onMinimapMove);
    minimapEl.addEventListener('pointerup', onMinimapUp);
    minimapEl.addEventListener('pointercancel', onMinimapUp);

    // ----- helpers -----

    function selectColor(idx: number): void {
      selectedColor = idx;
      // Notify the renderer so the inset selection outlines redraw.
      // setSelectedColor is a no-op when the index hasn't changed.
      renderer?.setSelectedColor(idx);
      paletteEl.querySelectorAll('.swatch').forEach((el) => {
        const swatchIdx = Number((el as HTMLElement).dataset.idx);
        el.classList.toggle('is-selected', swatchIdx === idx);
      });
      updateHintBtn();
    }

    function renderPalette(): void {
      if (!state) return;
      paletteEl.replaceChildren();
      for (let i = 0; i < state.puzzle.palette.length; i++) {
        if (state.colorTotal[i] === 0) continue;
        paletteEl.appendChild(buildSwatch(i));
      }
      updatePalette();
    }

    function buildSwatch(idx: number): HTMLElement {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'swatch';
      swatch.dataset.idx = String(idx);
      swatch.setAttribute('aria-label', t('colourLabel', { n: idx + 1 }));
      swatch.innerHTML = `
        <span class="swatch-dot" style="background:${state!.puzzle.palette[idx]}"></span>
        <span class="swatch-pct" data-pct>0%</span>
      `;
      swatch.addEventListener('click', () => selectColor(idx));
      return swatch;
    }

    function updatePalette(): void {
      if (!state) return;
      paletteEl.querySelectorAll<HTMLElement>('.swatch').forEach((el) => {
        const idx = Number(el.dataset.idx);
        const total = state!.colorTotal[idx];
        const done = state!.colorFilled[idx];
        const pct = total > 0 ? Math.round((done / total) * 100) : 100;
        const pctEl = el.querySelector<HTMLElement>('[data-pct]');
        if (pctEl) pctEl.textContent = `${pct}%`;
        el.classList.toggle('is-done', pct >= 100);
      });
    }

    function updateOverall(): void {
      if (!state) return;
      const s = state.snapshot();
      const pct = s.paintableCount > 0 ? Math.round((s.filledCount / s.paintableCount) * 100) : 0;
      // Render "✓ Done" instead of "100%" on a completed picture so
      // the user opening an already-finished puzzle sees a clear
      // completion indicator in the topbar without the modal
      // covering the canvas.
      overallPctEl.textContent = s.complete ? t('doneBadge') : `${pct}%`;
    }

    function updateHintBtn(): void {
      // Hint button is enabled iff there's a selected colour, that
      // colour's outline isn't already unlocked, AND that colour
      // isn't already 100% filled. All other cases disable it (no
      // double-purchase, no wasted reward on a finished colour).
      if (!state || selectedColor < 0) {
        hintBtn.disabled = true;
        hintBtn.textContent = `💡 ${t('hint')}`;
        return;
      }
      const total = state.colorTotal[selectedColor] ?? 0;
      const done = state.colorFilled[selectedColor] ?? 0;
      if (total === 0 || done >= total) {
        hintBtn.disabled = true;
        hintBtn.textContent = `💡 ${t('hint')}`;
        return;
      }
      const already = state.hintRevealed.has(selectedColor);
      hintBtn.disabled = already;
      hintBtn.textContent = already ? `💡 ${t('hinted')}` : `💡 ${t('hint')}`;
    }

    /**
     * When a colour reaches 100%, fade its swatch out then drop it.
     * Slight delay so the user gets visual confirmation that "this
     * colour is done" before it disappears.
     */
    function maybeDropSwatch(idx: number): void {
      const swatch = paletteEl.querySelector<HTMLElement>(`.swatch[data-idx="${idx}"]`);
      if (!swatch) return;
      swatch.classList.add('is-done');
      // No auto-advance: when the just-completed colour was the
      // selected one, clear selection back to none. The player picks
      // the next colour themselves on their next tap. Matches the
      // "selection is always deliberate" rule applied at scene mount.
      if (selectedColor === idx) {
        selectColor(-1);
      }
      window.setTimeout(() => {
        // Re-check inside the timer in case the scene tore down or
        // the user re-selected this colour somehow.
        if (cancelled) return;
        if (!state) return;
        if (state.colorFilled[idx] >= state.colorTotal[idx]) {
          swatch.remove();
        }
      }, 600);
    }

    /**
     * Reveal-then-banner completion flow. Fired only at the moment
     * of the final paint stroke (NOT on resume of an already-
     * completed picture). Three gates protect against spurious
     * triggers:
     *   1. caller passes `completed = true` from onCellFilled
     *   2. loadFinished is set true only after a clean load+restore
     *   3. completionShown latches false→true on first run so a
     *      future refactor can never re-fire mid-session
     *
     * Sequence:
     *   1. Mark completionShown and persist progress in parallel.
     *   2. Lock all pan/zoom input (paint, pinch, +/-, minimap drag).
     *   3. Animate camera to fit-zoom centred on the paintable
     *      bounds over COMPLETION_REVEAL_MS — uninterruptible.
     *   4. Recompute zoom limits (fit is the new minZoom anyway,
     *      but the camera state changed so reset for safety).
     *   5. Unlock input.
     *   6. Swap palette → completion banner inside the bottom strip.
     *
     * The minimap stays visible throughout; the picture above the
     * strip remains fully unobstructed by the banner (which sits
     * in the freed-up palette space, NOT over the canvas).
     */
    async function onPuzzleCompleted(): Promise<void> {
      if (!state || !renderer) return;
      const complete = state.isComplete();
      if (!complete || !loadFinished) return;
      if (completionShown) return;
      completionShown = true;

      // Persist progress (best-effort) before notifying the global
      // progress store. markCompleted writes to a different key so
      // both must succeed for the room-select grid to update.
      Promise.all([
        state.save(),
        markCompleted(state.puzzle.id),
      ]).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[Mozai] completion persist threw', err);
      });

      // Lock pan/zoom while the reveal animation plays so the player
      // can't fight the easing curve or land an accidental fill mid-
      // transition. Minimap drag is gated on input?.paused too.
      if (input) input.paused = true;
      await animateZoomToFit(COMPLETION_REVEAL_MS);
      if (cancelled) return;
      // Camera moved; fit-zoom is now the active zoom. Recompute
      // limits so subsequent user zooming sees the right minZoom.
      if (renderer) limits = renderer.computeFitLimits();
      if (input) input.paused = false;
      // Swap palette (now empty — all colours hit 100% during the
      // final stroke) for the completion banner. The minimap to the
      // right stays put through the swap.
      paletteEl.hidden = true;
      completionBannerEl.hidden = false;
    }

    /**
     * One-shot ease-out-cubic camera animation to fit-zoom centred
     * on the paintable bounds. Used by the completion reveal — the
     * one place we deliberately overwrite the user's camera state
     * (every other code path preserves user pan/zoom across resize
     * / completion / etc.).
     *
     * Resolves when the final frame lands OR when the scene tears
     * down mid-animation (cancelled). The await in the caller
     * naturally short-circuits via the early-return cancel checks.
     */
    function animateZoomToFit(durationMs: number): Promise<void> {
      return new Promise((resolve) => {
        if (!renderer || !state) {
          resolve();
          return;
        }
        const r = renderer;
        const s = state;
        const startZoom = r.camera.zoom;
        const startOffsetX = r.camera.offsetX;
        const startOffsetY = r.camera.offsetY;
        const fit = r.computeFitLimits();
        const endZoom = fit.minZoom;
        const cssW = canvas.clientWidth;
        const cssH = canvas.clientHeight;
        const visW = cssW / endZoom;
        const visH = cssH / endZoom;
        const b = s.paintableBounds;
        const w = s.puzzle.w;
        const h = s.puzzle.h;
        const centreX = b ? (b.minX + b.maxX + 1) / 2 : w / 2;
        const centreY = b ? (b.minY + b.maxY + 1) / 2 : h / 2;
        const endOffsetX = centreX - visW / 2;
        const endOffsetY = centreY - visH / 2;
        const start = performance.now();
        const step = (now: number): void => {
          if (cancelled || !renderer) {
            resolve();
            return;
          }
          const t = Math.min(1, (now - start) / durationMs);
          // ease-out cubic — snappy at first, gentle landing.
          const e = 1 - Math.pow(1 - t, 3);
          renderer.camera.zoom = startZoom + (endZoom - startZoom) * e;
          renderer.camera.offsetX = startOffsetX + (endOffsetX - startOffsetX) * e;
          renderer.camera.offsetY = startOffsetY + (endOffsetY - startOffsetY) * e;
          renderer.scheduleFrame();
          if (t < 1) {
            requestAnimationFrame(step);
          } else {
            resolve();
          }
        };
        requestAnimationFrame(step);
      });
    }

    function scheduleSave(): void {
      if (saveTimer != null) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        if (cancelled || !state) return;
        state.save().catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[Mozai] paint state save threw', err);
        });
      }, SAVE_DEBOUNCE_MS);
    }

    // ----- teardown -----

    return () => {
      cancelled = true;
      back.removeEventListener('click', onBack);
      completionDismissBtn.removeEventListener('click', onDismissComplete);
      hintBtn.removeEventListener('click', onHint);
      zoomInBtn.removeEventListener('click', onZoomIn);
      zoomOutBtn.removeEventListener('click', onZoomOut);
      minimapEl.removeEventListener('pointerdown', onMinimapDown);
      minimapEl.removeEventListener('pointermove', onMinimapMove);
      minimapEl.removeEventListener('pointerup', onMinimapUp);
      minimapEl.removeEventListener('pointercancel', onMinimapUp);
      resizeObserver?.disconnect();
      if (resizeRaf !== 0) cancelAnimationFrame(resizeRaf);
      renderer?.setMinimap(null);
      input?.dispose();
      renderer?.dispose();
      if (saveTimer != null) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      // Final flush — if there's unsaved state, persist it before the
      // scene root is removed. Fire-and-forget; the WebView will
      // keep the in-flight Preferences call alive across DOM removal.
      if (state) {
        state.save().catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[Mozai] paint state final save threw', err);
        });
      }
      root.remove();
    };
  };
}

/**
 * Brief top-of-scene confirmation banner used by the Hint unlock
 * flow ("Hint unlocked for this colour."). Fades in on the next
 * frame, fades out after ~1.5 s, removes itself. Multiple toasts
 * can stack — each is independent.
 */
function showToast(scene: HTMLElement, message: string): void {
  const toast = document.createElement('div');
  toast.className = 'paint-toast';
  toast.textContent = message;
  scene.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('paint-toast-visible'));
  window.setTimeout(() => {
    toast.classList.remove('paint-toast-visible');
    window.setTimeout(() => toast.remove(), 300);
  }, 1500);
}

function doBack(ctx: SceneContext): void {
  ctx.back();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
