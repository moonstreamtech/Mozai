/*
 * Mozai entry.
 *
 * Boot order matters:
 *
 *   0. Install the error overlay BEFORE anything else so a thrown
 *      exception during import resolution becomes a visible message
 *      instead of a silent white screen on device.
 *   1. Resolve required DOM elements; bail with a clear error if the
 *      HTML and TS are out of sync.
 *   2. Mount the resize controller against #game (so the play area is
 *      sized correctly from the first frame even before AdMob loads).
 *   3. Kick off the AdMob banner (fire-and-forget — it writes its
 *      measured height into --banner-h and the resize controller
 *      picks that up via the mozai:banner-height-changed event).
 *   4. In parallel: load the content index and the saved progress,
 *      then mount the room-select scene inside #game.
 *   5. Wire the hardware back button through the Capacitor App
 *      plugin so Android's gesture-back drives our scene stack.
 *
 * No game logic lives here — main.ts is glue.
 */

import { attachResize } from './resize.js';
import { makePlaceholderGrid } from './placeholder-grid.js';
import { initBanner } from './banner.js';
import { isDebugReadoutEnabled, maskAdId, readAdMobConfig } from './env.js';
import { mountDebugReadout } from './debug-readout.js';
import { loadContentIndex, type ContentIndex } from './content.js';
import { load as loadProgress, debugMarkCompleted, debugReset } from './progress.js';
import { SceneManager } from './scenes.js';
import { roomsSceneMount } from './scene-rooms.js';
import { makeRoomSceneMount } from './scene-room.js';
import { makePreviewSceneMount } from './scene-preview.js';
import { makePaintSceneMount } from './scene-paint.js';
import { setRewardedConfig } from './rewarded.js';
import { installErrorOverlay, reportError } from './error-overlay.js';

// Install global error capture as the very first runtime side-effect.
// Any synchronous throw between here and boot()'s catch will land on
// the on-screen overlay.
installErrorOverlay();

function requireEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} — index.html out of sync with main.ts`);
  return el as T;
}

async function boot(): Promise<void> {
  const gameEl = requireEl<HTMLDivElement>('game');
  const canvasEl = requireEl<HTMLCanvasElement>('play-canvas');
  const bannerEl = requireEl<HTMLDivElement>('banner');
  const debugEl = requireEl<HTMLDivElement>('debug');

  const debug = isDebugReadoutEnabled() ? mountDebugReadout(debugEl) : null;

  canvasEl.style.visibility = 'hidden';
  const controller = attachResize({
    game: gameEl,
    canvas: canvasEl,
    render: makePlaceholderGrid(),
    onFit: (info) => debug?.update(info),
  });

  if (debug) {
    window.addEventListener('mozai:banner-height-changed', (e: Event) => {
      const detail = (e as CustomEvent<{ totalPx: number }>).detail;
      debug.bannerHeightChanged(detail.totalPx);
      const current = controller.current();
      if (current) debug.update(current);
    });
  }

  const adConfig = readAdMobConfig();
  // Surface real-vs-test placement at a glance during dev. maskAdId
  // keeps the unit suffix masked.
  // eslint-disable-next-line no-console
  console.info(
    `[Mozai] admob mode=${adConfig.mode} testing=${adConfig.isTesting} ` +
      `banner=${maskAdId(adConfig.bannerUnitId)} ` +
      `rewarded=${maskAdId(adConfig.rewardedUnitId)}`,
  );

  initBanner({ config: adConfig, bannerEl }).catch((err) => {
    reportError('initBanner threw', err);
  });

  setRewardedConfig(adConfig);

  // Content index + progress are independent and both small — load in
  // parallel so the first scene paint happens as soon as both settle.
  // Either failure mode (network, malformed JSON, missing key) is
  // surfaced via reportError + an inline panel below.
  const indexUrlAbsolute = new URL('content/index.json', location.href).href;
  let index: ContentIndex;
  try {
    const [loadedIndex] = await Promise.all([loadContentIndex(), loadProgress()]);
    index = loadedIndex;
  } catch (err) {
    reportError('Failed to load content/index.json or progress', err);
    renderFatalPanel(gameEl, indexUrlAbsolute, err);
    return;
  }

  let scenes: SceneManager;
  try {
    scenes = new SceneManager({
      host: gameEl,
      index,
      registry: {
        rooms: roomsSceneMount,
        room: makeRoomSceneMount,
        preview: makePreviewSceneMount,
        paint: makePaintSceneMount,
      },
    });
    scenes.start();
  } catch (err) {
    reportError('Scene manager / rooms-scene mount failed', err);
    renderFatalPanel(gameEl, 'rooms-scene mount', err);
    return;
  }

  // Hardware back button (Android gesture / button). Wired through the
  // Capacitor App plugin; falls back to no-op on web where there is
  // no native back button to intercept.
  await wireHardwareBack(scenes);

  // Debug helpers — only mounted when MOZAI_DEBUG is on.
  if (isDebugReadoutEnabled()) {
    interface MozaiDebug {
      markCompleted: (id: string) => Promise<void>;
      resetProgress: () => Promise<void>;
      reload: () => void;
      openRoom: (roomN: number) => void;
      openPicture: (id: string) => void;
    }
    (window as unknown as { __mozaiDebug: MozaiDebug }).__mozaiDebug = {
      markCompleted: debugMarkCompleted,
      resetProgress: debugReset,
      reload: () => window.location.reload(),
      openRoom: (roomN: number) => scenes.push({ scene: 'room', roomN }),
      openPicture: (id: string) => {
        for (const list of Object.values(index.rooms)) {
          const meta = list.find((m) => m.id === id);
          if (meta) {
            scenes.push({ scene: 'paint', meta });
            return;
          }
        }
        // eslint-disable-next-line no-console
        console.warn(`[Mozai] openPicture: id '${id}' not found in any room`);
      },
    };
    // eslint-disable-next-line no-console
    console.info(
      '[Mozai] Debug helpers on window.__mozaiDebug — markCompleted, resetProgress, reload, openRoom(N), openPicture(id).',
    );
  }
}

/**
 * In-place fatal-error panel rendered into #game. Visible regardless
 * of whether the error overlay's <body>-level pile is being read — a
 * device user gets a clear "what failed and what URL was attempted"
 * panel instead of a blank screen.
 */
function renderFatalPanel(host: HTMLElement, attempted: string, err: unknown): void {
  const message = (err as Error)?.message ?? String(err);
  const stack = (err as Error)?.stack ?? '';
  host.replaceChildren();
  const panel = document.createElement('div');
  panel.style.cssText = [
    'position:absolute',
    'inset:0',
    'padding:calc(12px + env(safe-area-inset-top,0px)) 14px calc(12px + env(safe-area-inset-bottom,0px))',
    'overflow:auto',
    'background:#1f0a0a',
    'color:#ffd1d1',
    'font:13px/1.4 system-ui, sans-serif',
  ].join(';');
  panel.innerHTML = `
    <h2 style="margin:0 0 8px;font-size:16px;color:#ff8a8a;">Mozai failed to boot</h2>
    <p style="margin:0 0 6px;color:#cf9090;">Attempted: <code>${escapeHtml(attempted)}</code></p>
    <p style="margin:0 0 8px;font-weight:700">${escapeHtml(message)}</p>
    <pre style="margin:0;white-space:pre-wrap;word-break:break-word;font:11px/1.35 ui-monospace,Menlo,monospace;color:#ffb4b4">${escapeHtml(stack)}</pre>
  `;
  host.appendChild(panel);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function wireHardwareBack(scenes: SceneManager): Promise<void> {
  try {
    const { App } = await import(/* @vite-ignore */ '@capacitor/app');
    App.addListener('backButton', () => {
      if (scenes.canBack()) {
        scenes.back();
      } else {
        App.exitApp();
      }
    });
  } catch (err) {
    // Expected on web (the plugin is a no-op there). Quietly skip.
    // eslint-disable-next-line no-console
    console.debug('[Mozai] Capacitor App plugin not available (web?). Skipping back-button wiring.', err);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener(
    'DOMContentLoaded',
    () => {
      boot().catch((err) => reportError('boot() rejected', err));
    },
    { once: true },
  );
} else {
  boot().catch((err) => reportError('boot() rejected', err));
}
