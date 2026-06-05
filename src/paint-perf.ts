/*
 * Paint-scene performance overlay (diagnostic only).
 *
 * OFF by default. Mounted only when the existing MOZAI_DEBUG build flag
 * is set (isDebugReadoutEnabled() in env.ts) — the same switch that
 * drives the app-level #debug readout. When off, PaintRenderer and
 * PaintInput hold a null `perf` sink and the hot paths pay only a
 * single null check per draw() / per pointermove; none of this runs.
 *
 * What it answers (the paint-perf stutter investigation):
 *
 *   fps     — rolling average of the interval BETWEEN consecutive
 *             painted frames over the last ~30 frames. During a drag /
 *             pinch the renderer paints one frame per rAF, so this is
 *             the achieved frame rate while the stutter is happening.
 *             Reads "idle" when no frame has painted in the last second.
 *   draw ms — average and worst time spent INSIDE PaintRenderer.draw()
 *             over the recent window. This is the direct "is each frame
 *             too expensive on the CPU/JS side?" number. NOTE: canvas
 *             2D commands are largely async on the GPU, so this measures
 *             the JS time spent ISSUING the frame (per-cell loops, path
 *             building, layout reads), not GPU fill time — which is the
 *             useful split, see the PR notes.
 *   draws/s — painted frames per second over the display window.
 *   moves/s — pointermove events processed per second. Compared with
 *             draws/s this confirms rAF coalescing: many moves should
 *             collapse to <= refresh-rate draws. moves/s ~= draws/s with
 *             both well above 60 would mean coalescing is broken.
 *   grid    — puzzle w x h.
 *   zoom    — current zoom (CSS px per cell).
 *
 * Cost control: the DOM text is rewritten on a low-frequency timer
 * (OVERLAY_HZ), never per frame. recordDraw / recordPointerMove are a
 * counter bump plus one ring-buffer write — allocation-free. Rates are
 * computed from the ACTUAL elapsed time since the last tick, so they
 * stay accurate even if the timer is delayed by a busy main thread.
 */

/**
 * The hooks PaintRenderer / PaintInput call. Kept tiny so the hot-path
 * cost when enabled is a counter bump, and a single null check when not.
 */
export interface PaintPerfSink {
  /** Called once per painted frame with the draw() body duration (ms). */
  recordDraw(durationMs: number): void;
  /** Called once per processed pointermove event. */
  recordPointerMove(): void;
}

/** Live grid + camera snapshot the overlay prints on every tick. */
export interface PaintPerfInfo {
  w: number;
  h: number;
  /** CSS pixels per cell (camera.zoom). */
  zoom: number;
}

/** FPS / draw-ms rolling window, in frames. */
const FRAME_RING = 30;
/** Overlay text refresh rate (times per second). */
const OVERLAY_HZ = 4;
/** No painted frame in this long → report "idle" rather than a stale FPS. */
const IDLE_AFTER_MS = 1000;

export class PaintPerf implements PaintPerfSink {
  private readonly el: HTMLDivElement;
  private readonly getInfo: () => PaintPerfInfo;

  // Interval between consecutive painted frames (ms). FPS source.
  private readonly frameTimes = new Float64Array(FRAME_RING);
  private frameLen = 0;
  private frameHead = 0;
  private lastDrawTs = 0;

  // Time spent inside draw() (ms).
  private readonly drawMs = new Float64Array(FRAME_RING);
  private drawMsLen = 0;
  private drawMsHead = 0;

  // Windowed counters, reset on every overlay tick.
  private drawsThisWindow = 0;
  private movesThisWindow = 0;
  private windowStart = 0;

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(host: HTMLElement, getInfo: () => PaintPerfInfo) {
    this.getInfo = getInfo;
    const el = document.createElement('div');
    el.className = 'paint-perf';
    el.setAttribute('aria-hidden', 'true');
    el.textContent = 'perf…';
    host.appendChild(el);
    this.el = el;
    this.windowStart = performance.now();
    this.timer = setInterval(() => this.render(), Math.round(1000 / OVERLAY_HZ));
  }

  recordDraw(durationMs: number): void {
    const now = performance.now();
    // Inter-draw interval (skip the very first sample — no prior frame).
    if (this.lastDrawTs !== 0) {
      this.frameTimes[this.frameHead] = now - this.lastDrawTs;
      this.frameHead = (this.frameHead + 1) % FRAME_RING;
      if (this.frameLen < FRAME_RING) this.frameLen++;
    }
    this.lastDrawTs = now;
    // draw() body duration.
    this.drawMs[this.drawMsHead] = durationMs;
    this.drawMsHead = (this.drawMsHead + 1) % FRAME_RING;
    if (this.drawMsLen < FRAME_RING) this.drawMsLen++;
    this.drawsThisWindow++;
  }

  recordPointerMove(): void {
    this.movesThisWindow++;
  }

  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.el.remove();
  }

  private render(): void {
    const now = performance.now();
    // Guard against a zero/negative window (clock granularity) before
    // dividing the rate counters by it.
    const windowSec = Math.max(1e-3, (now - this.windowStart) / 1000);

    const idle = now - this.lastDrawTs >= IDLE_AFTER_MS;

    // FPS from the mean inter-draw interval over the ring.
    let fps = 0;
    if (this.frameLen > 0 && !idle) {
      let sum = 0;
      for (let i = 0; i < this.frameLen; i++) sum += this.frameTimes[i];
      const avg = sum / this.frameLen;
      fps = avg > 0 ? 1000 / avg : 0;
    }

    // draw() ms: average + worst over the ring.
    let drawAvg = 0;
    let drawMax = 0;
    if (this.drawMsLen > 0) {
      let sum = 0;
      for (let i = 0; i < this.drawMsLen; i++) {
        const v = this.drawMs[i];
        sum += v;
        if (v > drawMax) drawMax = v;
      }
      drawAvg = sum / this.drawMsLen;
    }

    const drawsPerSec = this.drawsThisWindow / windowSec;
    const movesPerSec = this.movesThisWindow / windowSec;
    this.drawsThisWindow = 0;
    this.movesThisWindow = 0;
    this.windowStart = now;

    const info = this.getInfo();
    this.el.textContent =
      `fps     ${idle ? '  idle' : fps.toFixed(0).padStart(6)}\n` +
      `draw ms ${drawAvg.toFixed(1).padStart(6)}  max ${drawMax.toFixed(1)}\n` +
      `draws/s ${drawsPerSec.toFixed(0).padStart(6)}\n` +
      `moves/s ${movesPerSec.toFixed(0).padStart(6)}\n` +
      `grid    ${info.w}×${info.h}\n` +
      `zoom    ${info.zoom.toFixed(2)} px/cell`;
  }
}
