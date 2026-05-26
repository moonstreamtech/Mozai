/*
 * Visible error surface.
 *
 * On a real device a thrown exception during boot used to manifest as
 * a silent white screen — the console messages went to logcat but the
 * user (and the developer doing a device test) saw nothing. This
 * module fixes that.
 *
 * `installErrorOverlay()` is called as the FIRST line of main.ts so
 * even an exception thrown from a top-level import is caught and
 * rendered. The overlay is a fixed-position div appended to <body> at
 * a high z-index above #game and the AdMob banner placeholder; it is
 * scrollable so a long stack trace stays readable.
 *
 * It listens to:
 *   window.error              — synchronous throws
 *   window.unhandledrejection — async / promise throws
 *
 * `reportError(msg)` is exported so call sites can surface a
 * specific failure (e.g. "couldn't fetch content/index.json")
 * without having to throw to trigger the global handler.
 *
 * The overlay deliberately uses inline styles so a broken CSS bundle
 * — a perfectly plausible failure mode — doesn't take the error
 * surface down with it.
 */

let overlayEl: HTMLDivElement | null = null;
let logEl: HTMLPreElement | null = null;
const buffer: string[] = [];

function ensureOverlay(): HTMLDivElement {
  if (overlayEl) return overlayEl;
  const el = document.createElement('div');
  el.id = 'mozai-error-overlay';
  // Inline styles only — no class hooks, so a corrupt CSS bundle
  // can't hide this from the user. Top safe-area is respected so
  // the panel doesn't sit under the status bar.
  el.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:9999',
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

  // Append to <body> rather than to #game so the overlay survives
  // even if a scene's teardown blew up halfway and removed #game's
  // children.
  document.body.appendChild(el);
  overlayEl = el;
  logEl = pre;
  // Replay any buffered messages that arrived before <body> existed.
  if (buffer.length) {
    pre.textContent = buffer.join('\n\n');
  }
  return el;
}

function append(text: string): void {
  buffer.push(text);
  if (logEl) {
    logEl.textContent = buffer.join('\n\n');
    // Scroll to bottom so the newest entry is visible.
    if (overlayEl) overlayEl.scrollTop = overlayEl.scrollHeight;
  }
}

/**
 * Render a single error / message to the overlay. The overlay is
 * created on first call (idempotent). Safe to call from any
 * synchronous context, including inside another error handler.
 */
export function reportError(label: string, err?: unknown): void {
  ensureOverlay();
  const stack = err && (err as Error).stack ? `\n${(err as Error).stack}` : '';
  const message =
    err === undefined
      ? label
      : `${label}: ${(err as Error)?.message ?? String(err)}${stack}`;
  // eslint-disable-next-line no-console
  console.error('[Mozai]', label, err);
  append(message);
}

/**
 * Drop a one-line "boot step" line into the overlay (and the
 * console). Useful for confirming progress when debugging on a
 * device — e.g. "config ok", "index fetch: content/index.json",
 * "rooms scene mounted". The boot lines stay buffered even if the
 * overlay is never SHOWN — calling reportError after a boot success
 * still surfaces context for the failure.
 */
export function bootLog(msg: string): void {
  buffer.push(`[boot] ${msg}`);
  if (logEl) logEl.textContent = buffer.join('\n\n');
  // eslint-disable-next-line no-console
  console.info('[Mozai][boot]', msg);
}

/**
 * Show the overlay even if no error has been reported yet. Useful
 * when a caller wants to surface the boot-step log proactively
 * (we don't call this on a clean boot — silent success is fine).
 */
export function showOverlay(): void {
  ensureOverlay();
}

/**
 * Install the global error / unhandled-rejection handlers.
 * Idempotent — safe to call twice (the second call no-ops).
 */
let installed = false;
export function installErrorOverlay(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('error', (e) => {
    reportError(`window.error @ ${e.filename}:${e.lineno}:${e.colno}`, e.error ?? e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    reportError('unhandledrejection', e.reason);
  });
}
