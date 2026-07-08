/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * Experimental introspection channel for external state libraries.
 *
 * Concurrent React renders the same app state at different priorities
 * ("lanes"): a transition render and an urgent render may be in flight around
 * one another, and a render pass may be discarded and restarted. State that
 * lives outside React cannot participate correctly without knowing three
 * things userspace cannot otherwise observe:
 *
 *   1. the lane an update scheduled *right now* would be assigned
 *      (getCurrentUpdateLane), so an external write can be attributed to the
 *      same "version of the world" as the setState calls it batches with;
 *   2. which root/lanes are currently rendering (getRenderContext and the
 *      render-pass listener events), so reads during render can resolve
 *      against the matching version;
 *   3. when a commit lands and with which lanes (onCommit), so pending
 *      versions can be promoted to committed state.
 *
 * Separately, onBeforeMutation/onAfterMutation bracket exactly the window in
 * which React mutates the DOM during a commit, so a MutationObserver can
 * ignore React's own mutations while observing everything else. The bracket
 * covers React's reconciliation mutations; it intentionally does not cover
 * user code in effects, imperative preload()-style inserts, or the
 * suspensey-CSS/img-decode paths (see the react-signals DESIGN.md notes).
 *
 * Design notes:
 * - This module is isomorphic; renderers register a provider (and call the
 *   emit* methods) through ReactSharedInternals.E, following the same pattern
 *   as ReactSharedInternals.S (onStartTransitionFinish).
 * - Lane values cross this boundary as opaque numbers: stable to compare with
 *   the helpers here, meaningless to inspect. Roots are identified by their
 *   container (for react-dom, the DOM container element) — an identity token
 *   that is also what a MutationObserver caller needs.
 * - Everything here is inert until the first listener subscribes; the
 *   per-commit cost with no listeners is one property read and branch.
 */

import ReactSharedInternals from './ReactSharedInternalsClient';
import reportGlobalError from 'shared/reportGlobalError';

export type ExternalRuntimeListener = {
  /** A render pass began on `container` for `renderLanes`. Passes can yield
   * to the browser and resume; a pass ends by completing or restarting. */
  onRenderPassStart?: (container: mixed, renderLanes: number) => void,
  /** The render pass on `container` completed or was discarded. */
  onRenderPassEnd?: (container: mixed) => void,
  /** A commit's host-tree mutations finished; the committed tree is current.
   * `committedLanes` were rendered; `remainingLanes` are still pending. */
  onCommit?: (
    container: mixed,
    committedLanes: number,
    remainingLanes: number,
  ) => void,
  /** React is about to mutate the host tree under `container`. Fires only
   * when there are mutations to apply. */
  onBeforeMutation?: (container: mixed) => void,
  /** React finished mutating the host tree under `container`. */
  onAfterMutation?: (container: mixed) => void,
};

export type ExternalRuntimeProvider = {
  /** Non-null while a render pass is executing on the current thread. */
  getRenderContext: () => null | {container: mixed, renderLanes: number},
  /** The lane an update scheduled right now would get. */
  getCurrentUpdateLane: () => number,
  isTransitionLane: (lane: number) => boolean,
  lanesInclude: (lanes: number, lane: number) => boolean,
  runInLane: <T>(lane: number, fn: () => T) => T,
};

const listeners: Set<ExternalRuntimeListener> = new Set();

function emit(event: string, a: mixed, b?: mixed, c?: mixed): void {
  // Deliver to every listener even if one throws; a listener error must not
  // corrupt React's commit, so it is reported like an uncaught error.
  for (const listener of listeners) {
    const handler = (listener as any)[event];
    if (handler != null) {
      try {
        handler(a, b, c);
      } catch (error) {
        reportGlobalError(error);
      }
    }
  }
}

export type ExternalRuntime = {
  providers: Array<ExternalRuntimeProvider>,
  hasListeners: boolean,
  emitRenderPassStart: (container: mixed, renderLanes: number) => void,
  emitRenderPassEnd: (container: mixed) => void,
  emitCommit: (
    container: mixed,
    committedLanes: number,
    remainingLanes: number,
  ) => void,
  emitBeforeMutation: (container: mixed) => void,
  emitAfterMutation: (container: mixed) => void,
};

const runtime: ExternalRuntime = {
  providers: [],
  hasListeners: false,
  emitRenderPassStart(container, renderLanes) {
    emit('onRenderPassStart', container, renderLanes);
  },
  emitRenderPassEnd(container) {
    emit('onRenderPassEnd', container);
  },
  emitCommit(container, committedLanes, remainingLanes) {
    emit('onCommit', container, committedLanes, remainingLanes);
  },
  emitBeforeMutation(container) {
    emit('onBeforeMutation', container);
  },
  emitAfterMutation(container) {
    emit('onAfterMutation', container);
  },
};

ReactSharedInternals.E = runtime;

export function subscribeToExternalRuntime(
  listener: ExternalRuntimeListener,
): () => void {
  listeners.add(listener);
  runtime.hasListeners = true;
  return function unsubscribe() {
    listeners.delete(listener);
    runtime.hasListeners = listeners.size > 0;
  };
}

export function getExternalRuntimeRenderContext(): null | {
  container: mixed,
  renderLanes: number,
} {
  const providers = runtime.providers;
  for (let i = 0; i < providers.length; i++) {
    const context = providers[i].getRenderContext();
    if (context !== null) {
      return context;
    }
  }
  return null;
}

export function getExternalRuntimeCurrentUpdateLane(): number {
  const providers = runtime.providers;
  // Only one renderer can be processing an event / rendering at a time on a
  // thread; the first registered provider answers. With multiple renderers
  // loaded, lane attribution is best-effort (documented limitation).
  return providers.length > 0 ? providers[0].getCurrentUpdateLane() : 0;
}

export function externalRuntimeIsTransitionLane(lane: number): boolean {
  const providers = runtime.providers;
  return providers.length > 0 ? providers[0].isTransitionLane(lane) : false;
}

export function externalRuntimeLanesInclude(
  lanes: number,
  lane: number,
): boolean {
  const providers = runtime.providers;
  return providers.length > 0 ? providers[0].lanesInclude(lanes, lane) : false;
}

export function externalRuntimeRunInLane<T>(lane: number, fn: () => T): T {
  const providers = runtime.providers;
  return providers.length > 0 ? providers[0].runInLane(lane, fn) : fn();
}
