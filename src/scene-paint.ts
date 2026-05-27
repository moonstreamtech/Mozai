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
 * Guard window after the completion modal becomes visible. The
 * pointer-up of the painting drag that COMPLETED the puzzle can
 * arrive on top of the Done button and auto-dismiss the modal
 * before the user has even seen it. We reject any click during this
 * window AND require the click's pointerdown to have started on
 * the Done button itself (see makePaintSceneMount).
 */
const COMPLETE_DISMISS_GUARD_MS = 500;

/**
 * "Room N · seq" title used in the topbar and in the completion
 * card. Parses the picture id's `rN-...` form to extract the seq
 * suffix; `meta.room` already provides the room number from the
 * JSON. The "Room" word is localized via i18n.
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
        <button class="back-btn" type="button" aria-label="Back to room">
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
        <canvas class="paint-minimap" data-minimap aria-hidden="true" hidden></canvas>
        <div class="paint-zoom-controls" aria-hidden="true">
          <button class="zoom-btn" type="button" data-zoom-out aria-label="Zoom out">−</button>
          <button class="zoom-btn" type="button" data-zoom-in aria-label="Zoom in">+</button>
        </div>
        <div class="paint-loading" data-loading>${t('loadingPuzzle')}</div>
      </div>
      <div class="paint-palette" role="toolbar" aria-label="Colour palette"></div>
      <div class="paint-completion" data-completion hidden>
        <div class="paint-completion-card">
          <h2>${t('completeTitle')}</h2>
          <p>${t('completeFinished', { name: `<strong>${pictureTitle(meta)}</strong>` })}</p>
          <button class="cta-btn" type="button" data-dismiss-complete>${t('done')}</button>
        </div>
      </div>
    `;
    host.appendChild(root);

    const back = root.querySelector<HTMLButtonElement>('.back-btn')!;
    const canvas = root.querySelector<HTMLCanvasElement>('.paint-canvas')!;
    const paletteEl = root.querySelector<HTMLDivElement>('.paint-palette')!;
    const loadingEl = root.querySelector<HTMLDivElement>('[data-loading]')!;
    const hintBtn = root.querySelector<HTMLButtonElement>('[data-hint]')!;
    const overallPctEl = root.querySelector<HTMLSpanElement>('[data-overall-pct]')!;
    const completionEl = root.querySelector<HTMLDivElement>('[data-completion]')!;
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
    // Hardening: the completion modal MUST NOT fire during initial
    // load. Set true once the puzzle has been fully parsed AND
    // restored from saved state. attemptFill / onCellFilled are only
    // ever wired after load anyway (the linear flow below), so this
    // is a belt-and-braces guard against any future refactor that
    // accidentally lets `state.snapshot().complete` short-circuit
    // before the picture is paintable.
    let loadFinished = false;

    const onBack = () => doBack(ctx);
    back.addEventListener('click', onBack);

    // "Done" / "Tamam" button: DISMISS the modal and stay on the
    // finished picture so the user can keep viewing their artwork.
    // Navigation back to the room is done via the back arrow /
    // hardware back, not by auto-navigation here.
    //
    // Anti-drag-tap guard: the pointer-up of the painting drag
    // that COMPLETED the puzzle can land on top of the Done button
    // (the modal becomes visible mid-stroke). The browser then
    // synthesises a click on the button, auto-dismissing the modal
    // before the user sees it. Two gates:
    //   1. modalShownAt + COMPLETE_DISMISS_GUARD_MS — reject any
    //      click for ~500 ms after the modal opens, regardless of
    //      provenance.
    //   2. donePointerArmed — true only after a `pointerdown`
    //      START on the Done button itself. A drag that begins on
    //      the canvas keeps the pointer captured by the canvas, so
    //      the button never sees its own pointerdown — donePointerArmed
    //      stays false and the synthesised click is rejected. A
    //      deliberate, fresh tap on Done arms the button (new
    //      pointerdown → click → dismiss).
    let modalShownAt = 0;
    let donePointerArmed = false;
    const onDonePointerDown = () => {
      donePointerArmed = true;
    };
    const onDismissComplete = () => {
      const elapsed = Date.now() - modalShownAt;
      if (elapsed < COMPLETE_DISMISS_GUARD_MS) {
        donePointerArmed = false;
        return;
      }
      if (!donePointerArmed) return;
      donePointerArmed = false;
      completionEl.hidden = true;
    };
    completionDismissBtn.addEventListener('pointerdown', onDonePointerDown);
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
          onCameraChange: () => updateMinimapVisibility(),
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
        resizeObserver = new ResizeObserver(() => {
          if (!renderer) return;
          if (state && state.isComplete()) {
            renderer.draw();
            updateMinimapVisibility();
            return;
          }
          const oldZoom = renderer.camera.zoom;
          const newLimits = renderer.computeFitLimits();
          if (oldZoom < newLimits.minZoom) renderer.camera.zoom = newLimits.minZoom;
          if (oldZoom > newLimits.maxZoom) renderer.camera.zoom = newLimits.maxZoom;
          renderer.clampCamera();
          limits = newLimits;
          // Synchronous draw so the next frame paints with the new
          // size; scheduleFrame would defer to rAF, but the first
          // post-mount fit needs to land NOW to clear the loading
          // overlay below.
          const painted = renderer.draw();
          if (painted) {
            loadingEl.hidden = true;
          }
          updateMinimapVisibility();
        });
        resizeObserver.observe(root.querySelector('.paint-viewport')!);

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
        updateMinimapVisibility();

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
        // Offline + uncached → needs-internet panel with a Retry
        // button that re-enters the same paint scene (which
        // re-runs the resolver). Other errors get the generic
        // "could not load <title>" message but still offer Retry.
        const isOffline = err instanceof ContentResolveError;
        const message = isOffline
          ? t('needsInternet')
          : t('couldNotLoadPuzzle', { id: pictureTitle(meta) });
        loadingEl.innerHTML = `
          ${message}<br>
          <button class="cta-btn" type="button" data-paint-retry>${t('retry')}</button>
        `;
        loadingEl.classList.add('scene-error');
        loadingEl.querySelector<HTMLButtonElement>('[data-paint-retry]')?.addEventListener(
          'click',
          () => ctx.push({ scene: 'paint', meta }),
        );
      });

    // Tap-to-pan on the minimap: a click maps the tap point into
    // puzzle world coordinates and recentres the camera there.
    // Pointer events on the minimap don't bubble to the canvas
    // because the minimap sits above it via z-index.
    const onMinimapClick = (ev: PointerEvent) => {
      if (!renderer) return;
      if (minimapEl.hidden) return;
      const rect = minimapEl.getBoundingClientRect();
      const local = renderer.minimapToWorld(ev.clientX - rect.left, ev.clientY - rect.top);
      if (!local) return;
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      const visibleCellsW = cssW / renderer.camera.zoom;
      const visibleCellsH = cssH / renderer.camera.zoom;
      renderer.camera.offsetX = local.worldX - visibleCellsW / 2;
      renderer.camera.offsetY = local.worldY - visibleCellsH / 2;
      renderer.clampCamera();
      renderer.scheduleFrame();
      updateMinimapVisibility();
      ev.preventDefault();
      ev.stopPropagation();
    };
    minimapEl.addEventListener('pointerup', onMinimapClick);

    // ----- helpers -----

    /**
     * Show the minimap only when the puzzle is zoomed in past fit.
     * At fit-zoom the minimap and main canvas would show the same
     * picture so the minimap adds no info — hide it. Once zoomed
     * in, the viewport rectangle becomes a useful orientation aid.
     * A small epsilon avoids flicker at the boundary from
     * floating-point noise.
     */
    function updateMinimapVisibility(): void {
      if (!renderer) return;
      const zoomedIn = renderer.camera.zoom > limits.minZoom * 1.01;
      minimapEl.hidden = !zoomedIn;
    }

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
      swatch.setAttribute('aria-label', `Colour ${idx + 1}`);
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
     * Single chokepoint for showing the completion modal. We RE-CHECK
     * state.isComplete() inside (not just at the call site) so the
     * modal can never render in the not-actually-complete state even
     * if a caller forgets the gate. The previous failure was a CSS
     * one (the `hidden` attribute being overridden by `display: flex`);
     * this guard is the JS-layer belt-and-braces.
     */
    function onPuzzleCompleted(): void {
      if (!state) return;
      const complete = state.isComplete();
      if (!complete || !loadFinished) return;
      completionEl.hidden = false;
      modalShownAt = Date.now();
      donePointerArmed = false;
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
      completionDismissBtn.removeEventListener('pointerdown', onDonePointerDown);
      hintBtn.removeEventListener('click', onHint);
      zoomInBtn.removeEventListener('click', onZoomIn);
      zoomOutBtn.removeEventListener('click', onZoomOut);
      minimapEl.removeEventListener('pointerup', onMinimapClick);
      resizeObserver?.disconnect();
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
