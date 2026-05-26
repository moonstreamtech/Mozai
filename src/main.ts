/*
 * Mozai entry.
 *
 * Boot order matters:
 *
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
import { isDebugReadoutEnabled, readAdMobConfig } from './env.js';
import { mountDebugReadout } from './debug-readout.js';
import { loadContentIndex } from './content.js';
import { load as loadProgress, debugMarkCompleted, debugReset } from './progress.js';
import { SceneManager } from './scenes.js';
import { roomsSceneMount } from './scene-rooms.js';
import { makeRoomSceneMount } from './scene-room.js';
import { makePaintSceneMount } from './scene-paint.js';
import { setRewardedConfig } from './rewarded.js';

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

  // The play-canvas is the future home of the colour-by-number
  // renderer. Until the paint engine lands the canvas sits hidden
  // beneath the scene DOM — but we still keep the resize controller
  // attached so:
  //   a) the canvas backing store is kept in sync for the paint scene
  //   b) the debug readout has a continuous stream of FitInfo
  //   c) the foundation contract (resize gates) stays exercised
  // We hide the canvas to avoid the placeholder grid leaking through
  // when no scene paints over it (mount order is async).
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
  // eslint-disable-next-line no-console
  console.info(
    `[Mozai] Boot. AdMob mode: ${adConfig.mode} (test ids ${adConfig.mode === 'TEST' ? 'IN USE' : 'NOT USED'})`,
  );

  initBanner({ config: adConfig, bannerEl }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[Mozai] initBanner threw', err);
  });

  // The rewarded module is stateless across the app lifetime — caching
  // the config once at boot keeps every paint scene's hint button from
  // re-reading env. Cleared in nothing for now; tests can re-call with
  // a null to wipe.
  setRewardedConfig(adConfig);

  // Content index + progress are independent and both small — load in
  // parallel so the first scene paint happens as soon as both settle.
  const [index] = await Promise.all([loadContentIndex(), loadProgress()]);
  // eslint-disable-next-line no-console
  console.info(`[Mozai] Content index: ${index.maxRoom} room(s).`);

  // Scene manager owns the #game subtree from here on.
  const scenes = new SceneManager({
    host: gameEl,
    index,
    registry: {
      rooms: roomsSceneMount,
      room: makeRoomSceneMount,
      paint: makePaintSceneMount,
    },
  });
  scenes.start();

  // Hardware back button (Android gesture / button). Wired through the
  // Capacitor App plugin; falls back to no-op on web where there is
  // no native back button to intercept. We CANNOT cleanly preventDefault
  // a hardware back at the WebView level on web, so this only matters
  // on native.
  await wireHardwareBack(scenes);

  // Debug helpers — only mounted when MOZAI_DEBUG is on. Lets a
  // developer mark pictures complete from the JS console to verify
  // the % fill + lock progression without playing through the stub,
  // and to jump straight into a high-room puzzle (e.g. the 1000x1000
  // performance test) without satisfying every lock between here and
  // there.
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

async function wireHardwareBack(scenes: SceneManager): Promise<void> {
  try {
    const { App } = await import(/* @vite-ignore */ '@capacitor/app');
    // Plugin emits 'backButton' with `canGoBack` reflecting the
    // WebView history. We ignore canGoBack and consult OUR scene
    // stack: scenes drive the entire UX, the WebView never navigates.
    App.addListener('backButton', () => {
      if (scenes.canBack()) {
        scenes.back();
      } else {
        // At the root scene — let the OS dismiss the app (mirrors
        // Android conventions where back at the root closes the app).
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
  document.addEventListener('DOMContentLoaded', () => {
    boot().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[Mozai] Boot failed', err);
    });
  }, { once: true });
} else {
  boot().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[Mozai] Boot failed', err);
  });
}
