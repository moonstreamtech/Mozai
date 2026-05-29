/*
 * Content event bus — emitted by the SWR (stale-while-revalidate)
 * revalidate paths in loadContentIndex / loadRoomThumbs, consumed
 * by the scenes that render the affected content.
 *
 * The pattern in one paragraph: a loader returns the cached /
 * bundled value INSTANTLY (no UI wait), then kicks off a
 * background fetch of the live CDN copy. When the live copy
 * differs from what was returned, the loader updates its in-
 * memory cache AND emits an event here. Any scene currently
 * subscribed re-renders just the differences — no flicker, no
 * spinner, no loading state.
 *
 * Two event shapes:
 *
 *   • 'index-updated'   → ContentIndex
 *                          Fired when the live content/index.json
 *                          differs from what loadContentIndex
 *                          previously returned (e.g. a new room
 *                          unlocked, an existing room gained a
 *                          puzzle).
 *
 *   • 'thumbs-updated'  → { roomN, bundle }
 *                          Fired per room when the live
 *                          content/roomN/thumbs.json differs from
 *                          what loadRoomThumbs(N) previously
 *                          returned. The payload includes the
 *                          room number so a subscriber can ignore
 *                          rooms it doesn't render.
 *
 * Scenes own the lifecycle:
 *   const off = subscribeContentEvent('thumbs-updated', cb);
 *   // ... on teardown:
 *   off();
 *
 * No DOM event API (CustomEvent) — keeping it a plain TS object
 * bus avoids the bubbling / cancelable surface that's irrelevant
 * here and keeps the typed payloads.
 */

import type { ContentIndex } from './content.js';
import type { ThumbBundle } from './thumbs.js';

export type ContentEventMap = {
  'index-updated': ContentIndex;
  'thumbs-updated': { roomN: number; bundle: ThumbBundle };
};

type Listener<K extends keyof ContentEventMap> = (data: ContentEventMap[K]) => void;

/**
 * Per-event Set of listeners. Set (not Array) keeps unsubscribe
 * O(1) — relevant because every scene mount / teardown adds and
 * removes a listener, and scenes can churn fast on navigation.
 * Listener arrays per event are constructed lazily on first
 * subscribe.
 */
const listeners: { [K in keyof ContentEventMap]?: Set<Listener<K>> } = {};

/**
 * Subscribe to a content event. Returns the unsubscribe function;
 * call it on scene teardown to avoid leaks. A second subscribe
 * with the same listener function is idempotent (Set semantics).
 */
export function subscribeContentEvent<K extends keyof ContentEventMap>(
  event: K,
  listener: Listener<K>,
): () => void {
  let set = listeners[event] as Set<Listener<K>> | undefined;
  if (!set) {
    set = new Set<Listener<K>>();
    (listeners as Record<string, Set<Listener<K>>>)[event] = set;
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
  };
}

/**
 * Fire an event to every current subscriber. Listener exceptions
 * are caught and logged — one broken listener must not block the
 * others from receiving the update.
 */
export function emitContentEvent<K extends keyof ContentEventMap>(
  event: K,
  data: ContentEventMap[K],
): void {
  const set = listeners[event] as Set<Listener<K>> | undefined;
  if (!set || set.size === 0) return;
  // Iterate a snapshot — a listener that unsubscribes itself mid-
  // dispatch (rare but legal) shouldn't perturb the iteration.
  for (const listener of Array.from(set)) {
    try {
      listener(data);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[mozai] content event listener threw for '${event}':`, err);
    }
  }
}
