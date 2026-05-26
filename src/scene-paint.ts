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
import { loadPuzzle } from './content.js';
import { markCompleted } from './progress.js';
import { PaintState } from './paint-state.js';
import { PaintRenderer, type CameraLimits } from './paint-render.js';
import { PaintInput } from './paint-input.js';
import { showRewarded } from './rewarded.js';
import { diagLog } from './error-overlay.js';

const SAVE_DEBOUNCE_MS = 400;

export function makePaintSceneMount(target: PaintTarget): SceneMount {
  return (host, ctx) => {
    const meta = target.meta;
    const root = document.createElement('div');
    root.className = 'scene scene-paint';
    root.innerHTML = `
      <header class="paint-topbar">
        <button class="back-btn" type="button" aria-label="Back to room">←</button>
        <div class="paint-title-block">
          <span class="paint-title">${meta.id}</span>
          <span class="paint-progress-label" data-overall-pct>0%</span>
        </div>
        <button class="hint-btn" type="button" data-hint disabled>💡 Hint</button>
      </header>
      <div class="paint-viewport">
        <canvas class="paint-canvas"></canvas>
        <div class="paint-zoom-controls" aria-hidden="true">
          <button class="zoom-btn" type="button" data-zoom-out aria-label="Zoom out">−</button>
          <button class="zoom-btn" type="button" data-zoom-in aria-label="Zoom in">+</button>
        </div>
        <div class="paint-loading" data-loading>Loading puzzle…</div>
      </div>
      <div class="paint-palette" role="toolbar" aria-label="Colour palette"></div>
      <div class="paint-completion" data-completion hidden>
        <div class="paint-completion-card">
          <h2>Complete!</h2>
          <p>You finished <strong>${meta.id}</strong>.</p>
          <button class="cta-btn" type="button" data-back-after-complete>Back to room</button>
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
    const completionBackBtn = root.querySelector<HTMLButtonElement>('[data-back-after-complete]')!;

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
    completionBackBtn.addEventListener('click', onBack);

    const onHint = () => {
      if (selectedColor < 0) return;
      // Capture which colour the user requested the hint for AT
      // TAP TIME — if the ad takes a few seconds and the user
      // changes selection mid-wait, the reward must reveal what
      // they originally asked for.
      const colorForHint = selectedColor;
      hintBtn.disabled = true;
      hintBtn.textContent = '💡 Loading…';
      showRewarded()
        .then((granted) => {
          if (cancelled || !state || !renderer) return;
          if (granted) {
            state.revealHint(colorForHint);
            renderer.updateHintReveal(colorForHint);
            scheduleSave();
          }
        })
        .finally(() => {
          if (cancelled) return;
          updateHintBtn();
        });
    };
    hintBtn.addEventListener('click', onHint);

    const onZoomIn = () => input?.zoomCentered(1.4);
    const onZoomOut = () => input?.zoomCentered(1 / 1.4);
    zoomInBtn.addEventListener('click', onZoomIn);
    zoomOutBtn.addEventListener('click', onZoomOut);

    // Load full puzzle + restore previous session.
    loadPuzzle(meta)
      .then(async (puzzle) => {
        if (cancelled) return;

        // Rich pre-construction diagnostic so a malformed puzzle is
        // visible on device via the debug popup (and console). We
        // inspect the RAW cells field to catch the exotic failure
        // modes the previous guard couldn't reach — e.g. cells
        // arrived as a string, or as an array of strings, or
        // length-0, or all-(-1). Counting non-negative entries here
        // gives the TRUE paintable count, which we cross-check
        // against PaintState's computed value below.
        const cells = puzzle.cells as unknown;
        const cellsIsArray = Array.isArray(cells);
        const cellsType = cellsIsArray ? 'array' : typeof cells;
        const cellsLen = cellsIsArray ? (cells as unknown[]).length : -1;
        let rawBg = 0;
        let rawPaint = 0;
        if (cellsIsArray) {
          for (const v of cells as unknown[]) {
            const n = typeof v === 'number' ? v : Number(v);
            if (Number.isFinite(n) && n < 0) rawBg++;
            else if (Number.isFinite(n) && n >= 0) rawPaint++;
          }
        }
        diagLog(
          `paint entry id=${puzzle.id} ` +
            `cells.type=${cellsType} cells.length=${cellsLen} w*h=${puzzle.w * puzzle.h} ` +
            `#(-1)=${rawBg} #(>=0)=${rawPaint} ` +
            `palette.length=${puzzle.palette.length} ` +
            `paintableCells(json)=${puzzle.paintableCells}`,
        );

        state = new PaintState(puzzle);
        await state.load();
        if (cancelled) return;

        const snap = state.snapshot();
        diagLog(
          `paint state id=${puzzle.id} ` +
            `paintableCount(computed)=${snap.paintableCount} ` +
            `filledCount=${snap.filledCount} ` +
            `complete=${snap.complete}`,
        );
        if (snap.paintableCount === 0) {
          diagLog(
            `WARNING paintableCount=0 for ${puzzle.id} — treating as malformed, NOT firing completion.`,
          );
        }
        if (rawPaint !== snap.paintableCount) {
          // Cross-check: if PaintState's computed count disagrees
          // with our raw scan, something is up. Log loudly so we
          // can see it on device.
          diagLog(
            `WARNING paintable mismatch: raw scan=${rawPaint} vs PaintState=${snap.paintableCount} for ${puzzle.id}`,
          );
        }

        renderer = new PaintRenderer(canvas, state);
        // First fit pass — canvas already has its CSS size because the
        // .paint-viewport flex box sized it in the previous frame.
        limits = renderer.fitToScreen();
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
        // keyboard) so the picture always fills the viewport sensibly.
        resizeObserver = new ResizeObserver(() => {
          if (!renderer) return;
          // Preserve current zoom unless we'd fall below minZoom in
          // the new viewport. Re-derive limits.
          const oldZoom = renderer.camera.zoom;
          const newLimits = renderer.fitToScreen();
          // If the user had zoomed in before, restore that.
          if (oldZoom > newLimits.minZoom) {
            renderer.camera.zoom = Math.min(oldZoom, newLimits.maxZoom);
          }
          limits = newLimits;
          renderer.scheduleFrame();
        });
        resizeObserver.observe(root.querySelector('.paint-viewport')!);

        renderPalette();
        updateOverall();
        loadingEl.hidden = true;

        // Load is finished — completion modal is now allowed to fire
        // from a real fill OR (if the saved progress is already at
        // 100%) from this resume-time check. Setting the flag BEFORE
        // the snapshot check lets a legitimate resume show the
        // completion overlay; future fills also gate on this flag
        // via onCellFilled below.
        loadFinished = true;
        const finalSnap = state.snapshot();
        if (finalSnap.complete) {
          // Resume of an already-completed picture — show the modal.
          onPuzzleCompleted();
        } else {
          const first = firstAvailableColor();
          if (first >= 0) selectColor(first);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error('[Mozai] loadPuzzle failed', err);
        loadingEl.textContent = `Could not load puzzle ${meta.id}.`;
        loadingEl.classList.add('scene-error');
      });

    // ----- helpers -----

    function selectColor(idx: number): void {
      selectedColor = idx;
      paletteEl.querySelectorAll('.swatch').forEach((el) => {
        const swatchIdx = Number((el as HTMLElement).dataset.idx);
        el.classList.toggle('is-selected', swatchIdx === idx);
      });
      updateHintBtn();
    }

    function firstAvailableColor(): number {
      if (!state) return -1;
      for (let i = 0; i < state.colorTotal.length; i++) {
        if (state.colorTotal[i] > 0 && state.colorFilled[i] < state.colorTotal[i]) {
          return i;
        }
      }
      return -1;
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
      const pct = s.paintableCount > 0 ? Math.round((s.filledCount / s.paintableCount) * 100) : 100;
      overallPctEl.textContent = `${pct}%`;
    }

    function updateHintBtn(): void {
      if (!state) {
        hintBtn.disabled = true;
        hintBtn.textContent = '💡 Hint';
        return;
      }
      if (selectedColor < 0) {
        hintBtn.disabled = true;
        hintBtn.textContent = '💡 Hint';
        return;
      }
      const already = state.hintRevealed.has(selectedColor);
      hintBtn.disabled = already;
      hintBtn.textContent = already ? '💡 Hinted' : '💡 Hint';
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
      // Auto-advance selection to another not-yet-done colour so the
      // player can keep painting without an extra tap.
      if (selectedColor === idx) {
        const next = firstAvailableColor();
        if (next >= 0) selectColor(next);
        else selectedColor = -1;
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

    function onPuzzleCompleted(): void {
      if (!state) return;
      completionEl.hidden = false;
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
      completionBackBtn.removeEventListener('click', onBack);
      hintBtn.removeEventListener('click', onHint);
      zoomInBtn.removeEventListener('click', onZoomIn);
      zoomOutBtn.removeEventListener('click', onZoomOut);
      resizeObserver?.disconnect();
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

function doBack(ctx: SceneContext): void {
  ctx.back();
}
