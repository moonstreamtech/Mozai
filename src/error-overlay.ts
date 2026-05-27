/*
 * Visible error surface + boot-diagnostics strip + debug-log popup.
 *
 * Three overlays managed here, plus one canonical log buffer that all
 * three read from:
 *
 *  1. ERROR overlay (z 9999) — full-screen red panel, created lazily
 *     on the first reportError() call. Catches anything thrown to
 *     the global 'error' / 'unhandledrejection' handlers.
 *
 *  2. BOOT DEBUG STRIP (z 9990) — top-of-screen, semi-transparent
 *     dark strip showing every bootLog() entry. OFF by default; opt
 *     in via VITE_BOOT_DEBUG=1 at build time.
 *
 *  3. DEBUG BUTTON + POPUP (button z 8990, popup z 9000) — a small
 *     fixed 🐞 button in the top-right corner that opens a scrollable
 *     monospace popup of the full diagnostic buffer. Always present
 *     while SHOW_DEBUG_BUTTON is true (default). The popup includes
 *     a Copy button (Clipboard API with execCommand fallback for the
 *     Chrome 92 Android WebView) and a Close button.
 *
 * All log entries flow through the SAME `diagBuffer`: bootLog(),
 * reportError(), and the paint-engine entry diagnostic. That means a
 * device debug session is "open the popup, hit Copy, paste into
 * chat" — no logcat or adb required.
 *
 * Inline styles only on every overlay so a broken CSS bundle can't
 * hide the diagnostics — exactly the failure mode this thing is
 * designed to expose.
 */

// Flip to true to surface the 🐞 button + overlay popup. OFF in
// production — flip on temporarily for an on-device debug session,
// re-build, install, then flip back before release.
const SHOW_DEBUG_BUTTON = false;

const Z_ERROR = 9999;
const Z_BOOT_STRIP = 9990;
const Z_DEBUG_POPUP = 9000;
const Z_DEBUG_BUTTON = 8990;

// Canonical diagnostic buffer — every bootLog / reportError pushes
// here, popup reads from here.
const diagBuffer: string[] = [];
const bootStart = Date.now();

let errorEl: HTMLDivElement | null = null;
let errorLogEl: HTMLPreElement | null = null;
const errorBuffer: string[] = [];

let stripEl: HTMLDivElement | null = null;
let stripLogEl: HTMLPreElement | null = null;
let stripEnabled = false;

let debugBtnEl: HTMLButtonElement | null = null;
let debugPopupEl: HTMLDivElement | null = null;

function isBootDebugEnabled(): boolean {
  const v = import.meta.env.VITE_BOOT_DEBUG;
  // Default OFF. To re-enable for a one-off device debug session:
  //   VITE_BOOT_DEBUG=1 npm run build && npx cap sync android
  if (v === undefined || v === '') return false;
  return v !== '0' && v !== 'false';
}

/**
 * Single switch that governs whether the diagnostic pipeline is
 * active. When false, bootLog / diagLog early-return — no console
 * noise, no diagnostic buffer growth, no overlay updates. The
 * red-panel error overlay (reportError) is INDEPENDENT and stays
 * armed regardless: a thrown exception still surfaces.
 *
 * Set from the two build-time flags only:
 *   SHOW_DEBUG_BUTTON   (constant above)
 *   VITE_BOOT_DEBUG     (env at build time)
 * Computed once at module load so each log call is a single boolean
 * check, not a re-read of env / DOM.
 */
const DIAGNOSTICS_ENABLED = SHOW_DEBUG_BUTTON || isBootDebugEnabled();

function timestamp(): string {
  return ((Date.now() - bootStart) / 1000).toFixed(2).padStart(6, ' ') + 's';
}

// -------- ERROR overlay (red, lazy) --------

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
  diagBuffer.push(`[${timestamp()}] ERROR ${message}`);
  refreshDebugPopupIfOpen();
}

// -------- BOOT STRIP (top of screen, OFF by default) --------

function ensureBootStrip(): HTMLDivElement | null {
  if (!stripEnabled) return null;
  if (stripEl) return stripEl;
  if (!document.body) return null;
  const el = document.createElement('div');
  el.id = 'mozai-boot-strip';
  el.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    'right:0',
    `z-index:${Z_BOOT_STRIP}`,
    'max-height:40vh',
    'overflow:auto',
    '-webkit-overflow-scrolling:touch',
    'background:rgba(8,12,18,0.86)',
    'color:#c5d2e6',
    'font:10.5px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    'padding:calc(6px + env(safe-area-inset-top,0px)) 10px 6px',
    'border-bottom:1px solid #324259',
    'white-space:pre-wrap',
    'word-break:break-word',
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
  // Populate from the canonical buffer.
  pre.textContent = diagBuffer.join('\n');
  el.scrollTop = el.scrollHeight;
  scheduleStripHeightUpdate();
  return el;
}

function appendStrip(): void {
  if (!stripEnabled) return;
  if (stripLogEl) {
    stripLogEl.textContent = diagBuffer.join('\n');
    if (stripEl) stripEl.scrollTop = stripEl.scrollHeight;
    scheduleStripHeightUpdate();
  }
}

let stripHeightRaf = 0;
function scheduleStripHeightUpdate(): void {
  if (stripHeightRaf !== 0) return;
  stripHeightRaf = requestAnimationFrame(() => {
    stripHeightRaf = 0;
    if (!stripEl) {
      document.documentElement.style.removeProperty('--boot-strip-h');
      return;
    }
    document.documentElement.style.setProperty('--boot-strip-h', `${stripEl.offsetHeight}px`);
  });
}

// -------- DEBUG BUTTON + POPUP --------

function ensureDebugButton(): void {
  if (!SHOW_DEBUG_BUTTON) return;
  if (debugBtnEl) return;
  if (!document.body) return;
  const btn = document.createElement('button');
  btn.id = 'mozai-debug-btn';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Open debug log');
  btn.textContent = '🐞';
  btn.style.cssText = [
    'position:fixed',
    'top:calc(8px + env(safe-area-inset-top,0px))',
    'right:8px',
    `z-index:${Z_DEBUG_BUTTON}`,
    'width:36px',
    'height:36px',
    'border-radius:18px',
    'border:1px solid rgba(255,255,255,0.3)',
    'background:rgba(20,30,45,0.85)',
    'color:#ffffff',
    'font:16px/1 system-ui, sans-serif',
    'cursor:pointer',
    'padding:0',
    'box-shadow:0 1px 4px rgba(0,0,0,0.3)',
    '-webkit-tap-highlight-color:transparent',
  ].join(';');
  btn.addEventListener('click', openDebugPopup);
  document.body.appendChild(btn);
  debugBtnEl = btn;
}

function openDebugPopup(): void {
  if (debugPopupEl) return;
  const overlay = document.createElement('div');
  overlay.id = 'mozai-debug-popup';
  // padding-bottom = 10px + --banner-h so the Copy/Close action bar
  // sits ABOVE the AdMob banner. The popup is position:fixed on the
  // WebView (which extends under the native banner overlay), so
  // env(safe-area-inset-bottom) alone is NOT enough — the banner is
  // above the safe area. --banner-h already includes the safe-area
  // inset (banner.ts adds it), so we don't double-count.
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    `z-index:${Z_DEBUG_POPUP}`,
    'background:rgba(0,0,0,0.85)',
    'color:#e8edf3',
    'font:12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    'display:flex',
    'flex-direction:column',
    'padding:calc(10px + env(safe-area-inset-top,0px)) 10px calc(10px + var(--banner-h, 60px))',
  ].join(';');

  const header = document.createElement('div');
  header.textContent = `Mozai diagnostics — ${diagBuffer.length} line(s)`;
  header.style.cssText =
    'font-weight:700;font-size:13px;color:#8fb1ff;margin:0 0 8px 0;letter-spacing:0.5px';
  overlay.appendChild(header);

  const pre = document.createElement('pre');
  pre.style.cssText = [
    'flex:1 1 auto',
    'min-height:0',
    'margin:0 0 10px 0',
    'padding:10px',
    'overflow:auto',
    '-webkit-overflow-scrolling:touch',
    'background:rgba(255,255,255,0.05)',
    'border:1px solid rgba(255,255,255,0.15)',
    'border-radius:4px',
    'color:#e8edf3',
    'font:inherit',
    'white-space:pre-wrap',
    'word-break:break-word',
    'user-select:text',
    '-webkit-user-select:text',
  ].join(';');
  pre.textContent = getDebugLog();
  overlay.appendChild(pre);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.textContent = 'Copy';
  copyBtn.style.cssText = debugActionBtnStyles('#3a6ea5');
  copyBtn.addEventListener('click', async () => {
    const ok = await copyToClipboard(pre.textContent ?? '');
    const original = 'Copy';
    copyBtn.textContent = ok ? 'Copied ✓' : 'Copy failed';
    copyBtn.disabled = true;
    setTimeout(() => {
      copyBtn.textContent = original;
      copyBtn.disabled = false;
    }, 1500);
  });
  actions.appendChild(copyBtn);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close';
  closeBtn.style.cssText = debugActionBtnStyles('#5a6b80');
  closeBtn.addEventListener('click', closeDebugPopup);
  actions.appendChild(closeBtn);

  overlay.appendChild(actions);
  document.body.appendChild(overlay);
  debugPopupEl = overlay;
}

function closeDebugPopup(): void {
  if (!debugPopupEl) return;
  debugPopupEl.remove();
  debugPopupEl = null;
}

function refreshDebugPopupIfOpen(): void {
  if (!debugPopupEl) return;
  const pre = debugPopupEl.querySelector('pre');
  if (pre) pre.textContent = getDebugLog();
  const header = debugPopupEl.querySelector('div');
  if (header) header.textContent = `Mozai diagnostics — ${diagBuffer.length} line(s)`;
}

function debugActionBtnStyles(bg: string): string {
  return [
    'padding:10px 16px',
    'border-radius:6px',
    'border:0',
    `background:${bg}`,
    'color:#fff',
    'font:inherit',
    'font-weight:700',
    'cursor:pointer',
    '-webkit-tap-highlight-color:transparent',
  ].join(';');
}

/**
 * Clipboard write with execCommand fallback. The Clipboard API
 * requires a secure context (HTTPS or localhost) and on Chrome 92
 * WebView is gated by user activation; the fallback works on any
 * browser that supports document.execCommand('copy').
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to legacy path below.
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

// -------- Public log API --------

/**
 * Push a single boot-step line. Always writes to the canonical
 * `diagBuffer` (visible via the 🐞 popup) + the console + the error
 * overlay's buffer (so a later reportError() surfaces the boot
 * sequence). Also paints to the boot strip when the strip is
 * enabled.
 */
export function bootLog(msg: string): void {
  if (!DIAGNOSTICS_ENABLED) return;
  const t = timestamp();
  const line = `${t}  ${msg}`;
  diagBuffer.push(line);
  errorBuffer.push(`[boot ${t}] ${msg}`);
  if (errorLogEl) errorLogEl.textContent = errorBuffer.join('\n\n');
  appendStrip();
  refreshDebugPopupIfOpen();
  // eslint-disable-next-line no-console
  console.info('[Mozai][boot]', msg);
}

/**
 * Push an entry into the diagnostic buffer WITHOUT marking it as a
 * boot step — used by long-running modules (e.g. the paint scene)
 * that want their diagnostics in the same popup. Goes to console
 * and the popup; does NOT touch the error overlay buffer.
 */
export function diagLog(msg: string): void {
  if (!DIAGNOSTICS_ENABLED) return;
  const t = timestamp();
  const line = `${t}  ${msg}`;
  diagBuffer.push(line);
  appendStrip();
  refreshDebugPopupIfOpen();
  // eslint-disable-next-line no-console
  console.info('[Mozai][diag]', msg);
}

/** The full diagnostic log as a single string. Used by the Copy button. */
export function getDebugLog(): string {
  return diagBuffer.join('\n');
}

/** Force the error overlay open even if nothing has thrown. */
export function showOverlay(): void {
  ensureErrorOverlay();
}

/**
 * Install global error / unhandled-rejection handlers + boot strip
 * + debug button. Idempotent — safe to call twice (the second call
 * no-ops). Called as the very first runtime side-effect from
 * main.ts so even an exception thrown from a top-level import is
 * captured.
 */
let installed = false;
export function installErrorOverlay(): void {
  if (installed) return;
  installed = true;
  stripEnabled = isBootDebugEnabled();
  ensureBootStrip();
  ensureDebugButton();
  window.addEventListener('error', (e) => {
    reportError(`window.error @ ${e.filename}:${e.lineno}:${e.colno}`, e.error ?? e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    reportError('unhandledrejection', e.reason);
  });
}
