/*
 * Visible error surface + temporary boot diagnostics strip.
 *
 * Two overlays managed here:
 *
 *  1. ERROR overlay — fullscreen red panel, created lazily on the
 *     first reportError() call. Catches anything thrown to the global
 *     'error' / 'unhandledrejection' handlers.
 *
 *  2. BOOT DEBUG STRIP — top-of-screen, semi-transparent dark strip
 *     that ALWAYS shows when VITE_BOOT_DEBUG is enabled (default ON
 *     while we chase a blank-screen-on-device bug). Mounted by
 *     installErrorOverlay(); every bootLog() call appends a
 *     timestamped line. Max ~40% of viewport height; scrolls
 *     internally. Stays under the error overlay's z-index so a real
 *     error still covers it.
 *
 * Both overlays use inline styles only, so a broken CSS bundle —
 * which is exactly the failure mode this thing is designed to expose
 * — can't take them down.
 */

const Z_ERROR = 9999;
const Z_BOOT_STRIP = 9990;

let errorEl: HTMLDivElement | null = null;
let errorLogEl: HTMLPreElement | null = null;
const errorBuffer: string[] = [];

let stripEl: HTMLDivElement | null = null;
let stripLogEl: HTMLPreElement | null = null;
const stripBuffer: string[] = [];
let stripEnabled = false;
const bootStart = Date.now();

function isBootDebugEnabled(): boolean {
  const v = import.meta.env.VITE_BOOT_DEBUG;
  // Default ON: only DISABLE when the env var is explicitly set to
  // a falsy literal. Keeps the diagnostic visible by default while
  // we're still debugging blank-screen-on-device.
  if (v === undefined) return true;
  return v !== '0' && v !== 'false' && v !== '';
}

// -------- error overlay --------

function ensureErrorOverlay(): HTMLDivElement {
  if (errorEl) return errorEl;
  const el = document.createElement('div');
  el.id = 'mozai-error-overlay';
  el.style.cssText = [
    'position:fixed',
    'inset:0',
    `z-index:${Z_ERROR}`,
    'background:rgba(20,4,4,0.96)',
    'color:#ffb4b4',
    'font:12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    'padding:calc(12px + env(safe-area-inset-top,0px)) 12px calc(12px + env(safe-area-inset-bottom,0px))',
    'overflow:auto',
    '-webkit-overflow-scrolling:touch',
    'white-space:pre-wrap',
    'word-break:break-word',
  ].join(';');
  const header = document.createElement('div');
  header.textContent = '⚠ Mozai — runtime error';
  header.style.cssText = 'font-weight:700;font-size:14px;color:#ff7a7a;margin:0 0 6px 0';
  el.appendChild(header);
  const subtitle = document.createElement('div');
  subtitle.textContent = 'The app hit an error during boot or scene render. Details:';
  subtitle.style.cssText = 'font-size:11px;color:#cf9090;margin:0 0 10px 0';
  el.appendChild(subtitle);
  const pre = document.createElement('pre');
  pre.style.cssText = 'margin:0;color:#ffb4b4;font-family:inherit;white-space:pre-wrap;word-break:break-word';
  el.appendChild(pre);
  document.body.appendChild(el);
  errorEl = el;
  errorLogEl = pre;
  if (errorBuffer.length) {
    pre.textContent = errorBuffer.join('\n\n');
  }
  return el;
}

function appendError(text: string): void {
  errorBuffer.push(text);
  if (errorLogEl) {
    errorLogEl.textContent = errorBuffer.join('\n\n');
    if (errorEl) errorEl.scrollTop = errorEl.scrollHeight;
  }
}

/**
 * Render a single error / message to the error overlay. The overlay
 * is created on first call (idempotent). Safe to call from any
 * synchronous context, including inside another error handler.
 */
export function reportError(label: string, err?: unknown): void {
  ensureErrorOverlay();
  const stack = err && (err as Error).stack ? `\n${(err as Error).stack}` : '';
  const message =
    err === undefined
      ? label
      : `${label}: ${(err as Error)?.message ?? String(err)}${stack}`;
  // eslint-disable-next-line no-console
  console.error('[Mozai]', label, err);
  appendError(message);
}

// -------- boot debug strip --------

function ensureBootStrip(): HTMLDivElement | null {
  if (!stripEnabled) return null;
  if (stripEl) return stripEl;
  // <body> must exist by the time module-bottom <script> runs, but be
  // defensive against an install call landing before that.
  if (!document.body) return null;
  const el = document.createElement('div');
  el.id = 'mozai-boot-strip';
  el.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    'right:0',
    `z-index:${Z_BOOT_STRIP}`,
    // Cap at 40% viewport height; scroll internally if more lines.
    'max-height:40vh',
    'overflow:auto',
    '-webkit-overflow-scrolling:touch',
    'background:rgba(8,12,18,0.86)',
    'color:#c5d2e6',
    'font:10.5px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    // Top safe-area pad — the strip must clear the status bar / notch.
    'padding:calc(6px + env(safe-area-inset-top,0px)) 10px 6px',
    'border-bottom:1px solid #324259',
    'white-space:pre-wrap',
    'word-break:break-word',
    // Don't block touches in the area below — but the strip itself
    // should stay tappable so the user can scroll it. We set
    // pointer-events:auto on the strip and a CSS rule below would
    // delegate touches to children. For our purposes auto is fine
    // because the strip floats at the top and the user can scroll
    // within it; clicks bubble up to native scroll handling.
    'pointer-events:auto',
  ].join(';');
  const header = document.createElement('div');
  header.textContent = '🛠 Mozai boot diagnostics (VITE_BOOT_DEBUG=1)';
  header.style.cssText =
    'font-weight:700;color:#8fb1ff;margin:0 0 4px 0;font-size:10.5px;letter-spacing:0.5px';
  el.appendChild(header);
  const pre = document.createElement('pre');
  pre.style.cssText =
    'margin:0;color:#c5d2e6;font-family:inherit;white-space:pre-wrap;word-break:break-word';
  el.appendChild(pre);
  document.body.appendChild(el);
  stripEl = el;
  stripLogEl = pre;
  if (stripBuffer.length) {
    pre.textContent = stripBuffer.join('\n');
    el.scrollTop = el.scrollHeight;
  }
  return el;
}

function appendStrip(text: string): void {
  stripBuffer.push(text);
  if (stripLogEl) {
    stripLogEl.textContent = stripBuffer.join('\n');
    if (stripEl) stripEl.scrollTop = stripEl.scrollHeight;
  }
}

/**
 * Push a single boot-step line. When VITE_BOOT_DEBUG is on (default),
 * the line is also rendered to the visible boot strip at the top of
 * the screen. Even when the strip is off the message goes to the
 * console + the buffer that the error overlay reads on a later
 * reportError() — so failure context is never lost.
 */
export function bootLog(msg: string): void {
  const t = ((Date.now() - bootStart) / 1000).toFixed(2);
  const line = `${t.padStart(6, ' ')}s  ${msg}`;
  appendStrip(line);
  // Also flow into the error overlay buffer so that, if anything
  // throws later, the user can see what boot steps preceded it.
  errorBuffer.push(`[boot ${t}s] ${msg}`);
  if (errorLogEl) errorLogEl.textContent = errorBuffer.join('\n\n');
  // eslint-disable-next-line no-console
  console.info('[Mozai][boot]', msg);
}

/** Force the error overlay open even if nothing has thrown. */
export function showOverlay(): void {
  ensureErrorOverlay();
}

/**
 * Install the global error / unhandled-rejection handlers + boot
 * strip. Idempotent — safe to call twice (the second call no-ops).
 */
let installed = false;
export function installErrorOverlay(): void {
  if (installed) return;
  installed = true;
  stripEnabled = isBootDebugEnabled();
  // Try to mount the strip immediately so module-import-time logs
  // are visible. If <body> isn't ready (very early throw) the strip
  // mounts on the first bootLog() that comes after DOMContentLoaded.
  ensureBootStrip();
  window.addEventListener('error', (e) => {
    reportError(`window.error @ ${e.filename}:${e.lineno}:${e.colno}`, e.error ?? e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    reportError('unhandledrejection', e.reason);
  });
}
