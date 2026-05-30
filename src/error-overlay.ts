/*
 * Fatal-error overlay.
 *
 * Catches anything thrown to the global `error` / `unhandledrejection`
 * handlers and surfaces it as a full-screen red panel — the safety
 * net for crashes the user would otherwise see as a blank screen.
 * Lazily created on the first reportError() call so an idle session
 * carries zero overlay DOM.
 *
 * Inline styles only so a broken CSS bundle can't hide the
 * diagnostics — exactly the failure mode this thing is designed to
 * expose.
 */

const Z_ERROR = 9999;

let errorEl: HTMLDivElement | null = null;
let errorLogEl: HTMLPreElement | null = null;
const errorBuffer: string[] = [];

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
  pre.style.cssText =
    'margin:0;color:#ffb4b4;font-family:inherit;white-space:pre-wrap;word-break:break-word';
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

/** Force the error overlay open even if nothing has thrown. */
export function showOverlay(): void {
  ensureErrorOverlay();
}

/**
 * Install global error / unhandled-rejection handlers. Idempotent —
 * safe to call twice (the second call no-ops). Called as the very
 * first runtime side-effect from main.ts so even an exception thrown
 * from a top-level import is captured.
 */
let installed = false;
export function installErrorOverlay(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('error', (e) => {
    // "ResizeObserver loop limit exceeded" / "…completed with
    // undelivered notifications" is a BENIGN browser notice — the
    // observer simply deferred the rest of its work to the next frame,
    // nothing actually broke, and the browser self-recovers. Chrome
    // raises it as a global `error` event (empty filename, 0:0). We must
    // NOT surface it as a fatal overlay: doing so buried the whole paint
    // scene on tablets. Swallow it (log only); genuine errors still flow
    // through to reportError below. Defence-in-depth — even if a stray
    // ResizeObserver notice fires anywhere, it can never take down the UI.
    if (isBenignResizeObserverError(e.message) || isBenignResizeObserverError((e.error as Error | undefined)?.message)) {
      // eslint-disable-next-line no-console
      console.warn('[Mozai] ignored benign ResizeObserver notice:', e.message);
      return;
    }
    reportError(`window.error @ ${e.filename}:${e.lineno}:${e.colno}`, e.error ?? e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    reportError('unhandledrejection', e.reason);
  });
}

/**
 * The two well-known benign ResizeObserver loop notices. These never
 * indicate a real fault, so they must not trigger the fatal overlay.
 */
const BENIGN_RESIZE_OBSERVER =
  /ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)/;

function isBenignResizeObserverError(message: unknown): boolean {
  return typeof message === 'string' && BENIGN_RESIZE_OBSERVER.test(message);
}
