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
 * Concurrent React renders the same app state as different update batches: a
 * transition render and an urgent render may be in flight around one another,
 * and a render pass may be discarded and restarted. State that lives outside
 * React cannot participate correctly without knowing three things userspace
 * cannot otherwise observe:
 *
 *   1. the identity of the batch a write issued *right now* belongs to
 *      (getCurrentWriteBatch, with isCurrentWriteDeferred as its
 *      allocation-free classification), so an external write can be
 *      attributed to the same "version of the world" as the setState calls
 *      it batches with;
 *   2. which root is currently rendering and which batches that pass
 *      includes (getRenderContext and the render-pass listener events), so
 *      reads during render can resolve against the matching version;
 *   3. when each batch retires (onBatchRetired, exactly once per token), so
 *      pending versions can be promoted to committed state.
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
 * - Batches cross this boundary as integer tokens (see
 *   ReactFiberBatchRegistry): non-zero integers, stable for the batch's
 *   life, never reused while live. 0 is reserved for "no batch". The low
 *   bit is the only documented payload: `token & 1` is 1 for deferred
 *   (transition-like) batches. Everything else about a token is opaque.
 *   Roots are identified by their container (for react-dom, the DOM
 *   container element) — an identity token that is also what a
 *   MutationObserver caller needs.
 * - Everything here is inert until the first listener subscribes; the
 *   per-commit cost with no listeners is one property read and branch.
 */

import ReactSharedInternals from './ReactSharedInternalsClient';
import reportGlobalError from 'shared/reportGlobalError';

// ── Protocol handshake (cosignal spec §4.1 fact 7) ──────────────────────────
//
// The protocol is versioned, with capability bits, on BOTH sides of the
// channel: this isomorphic module carries the version the `react` package was
// built with, and every renderer echoes the version its reconciler was built
// with when it registers a provider (see ReactFiberExternalRuntime.js, which
// keeps a deliberately duplicated copy of these constants). Consumers assert
// both sides through `unstable_externalRuntimeProtocol` and refuse to run
// otherwise. Version skew fails loudly — at provider registration for a
// mismatched renderer, at the consumer handshake for everything else. There
// is intentionally no silently-degraded mode: with a mismatched pair, writes
// would classify as "no batch" and external stores would tear.
//
// Capability bits (grow-only; renumbering is a version bump):
//   1 << 0  batch tokens        — integer write-classification tokens,
//                                 mint/classify/retire (fact 1)
//   1 << 1  pass lifecycle      — render-pass start/end events (fact 2, the
//                                 start/end half)
//   1 << 2  retirement          — exactly-once retirement with committed
//                                 flag and async-action parking (fact 3)
//   1 << 3  mutation window     — before/after host-mutation bracket
//                                 (fact 6)
// Reserved for capabilities this fork plans to add; a stale build lacking
// one fails the consumer handshake instead of silently missing events:
//   1 << 4  pass yield/resume edges + end disposition
//   1 << 5  per-root commit reporting + baseline-capture ordering
//   1 << 6  runInBatch (lane-scoped scheduling)
//   1 << 7  render lineage ids
//   1 << 8  discardAllWip
export const EXTERNAL_RUNTIME_PROTOCOL_VERSION = 1;
export const EXTERNAL_RUNTIME_CAPABILITIES =
  (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3);

export type ExternalRuntimeProtocol = {
  version: number,
  capabilities: number,
};

export type ExternalRuntimeListener = {
  /** A render pass began on `container`. `includedBatches` are the tokens of
   * every live batch this pass renders (see getCurrentWriteBatch). Passes can
   * yield to the browser and resume; a pass ends by completing or
   * restarting. */
  onRenderPassStart?: (
    container: mixed,
    includedBatches: $ReadOnlyArray<number>,
  ) => void,
  /** The render pass on `container` completed or was discarded. */
  onRenderPassEnd?: (container: mixed) => void,
  /** React is about to mutate the host tree under `container`. Fires only
   * when there are mutations to apply. */
  onBeforeMutation?: (container: mixed) => void,
  /** React finished mutating the host tree under `container`. */
  onAfterMutation?: (container: mixed) => void,
  /** A batch retired — exactly once per token. `committed` is false only for
   * batches that never produced React work (their writes were external-only);
   * batches whose React updates were discarded by unmounts still retire
   * through an ordinary (empty) commit with committed = true. */
  onBatchRetired?: (token: number, committed: boolean) => void,
};

export type ExternalRuntimeProviderMethods = {
  /** Non-null while a render pass is executing on the current thread. */
  getRenderContext: () => null | {container: mixed},
  /** Would a write issued right now belong to a deferred (transition-like)
   * batch? Pure classification: no token minting, no side effects. */
  isCurrentWriteDeferred: () => boolean,
  /** Identity of the batch an external write issued right now belongs to:
   * a non-zero integer, stable for the batch's life, with the deferred
   * classification in its low bit (`token & 1`). Never allocates. */
  getCurrentWriteBatch: () => number,
};

export type ExternalRuntimeProvider = {
  /** The protocol version + capability bits the registering renderer was
   * built with (its side of the handshake). */
  protocol: ExternalRuntimeProtocol,
  ...ExternalRuntimeProviderMethods,
};

const listeners: Set<ExternalRuntimeListener> = new Set();

function emit(event: string, a: mixed, b?: mixed): void {
  // Deliver to every listener even if one throws; a listener error must not
  // corrupt React's commit, so it is reported like an uncaught error.
  // (Set#forEach rather than for..of: repo lint bans for..of loops.)
  listeners.forEach(listener => {
    const handler = (listener as any)[event];
    if (handler != null) {
      try {
        handler(a, b);
      } catch (error) {
        reportGlobalError(error);
      }
    }
  });
}

export type ExternalRuntime = {
  /** This (isomorphic) side of the versioned handshake. Renderers check it
   * before registering a provider and refuse to register across a version
   * mismatch. */
  protocol: ExternalRuntimeProtocol,
  providers: Array<ExternalRuntimeProvider>,
  hasListeners: boolean,
  emitRenderPassStart: (
    container: mixed,
    includedBatches: $ReadOnlyArray<number>,
  ) => void,
  emitRenderPassEnd: (container: mixed) => void,
  emitBeforeMutation: (container: mixed) => void,
  emitAfterMutation: (container: mixed) => void,
  emitBatchRetired: (token: number, committed: boolean) => void,
};

const runtime: ExternalRuntime = {
  protocol: {
    version: EXTERNAL_RUNTIME_PROTOCOL_VERSION,
    capabilities: EXTERNAL_RUNTIME_CAPABILITIES,
  },
  providers: [],
  hasListeners: false,
  emitRenderPassStart(container, includedBatches) {
    emit('onRenderPassStart', container, includedBatches);
  },
  emitRenderPassEnd(container) {
    emit('onRenderPassEnd', container);
  },
  emitBeforeMutation(container) {
    emit('onBeforeMutation', container);
  },
  emitAfterMutation(container) {
    emit('onAfterMutation', container);
  },
  emitBatchRetired(token, committed) {
    emit('onBatchRetired', token, committed);
  },
};

ReactSharedInternals.E = runtime;

/**
 * The consumer side of the handshake: everything a binding needs to refuse a
 * degraded configuration before doing any work.
 *
 * A binding must assert, in order, and throw its own error if any fails:
 *   1. this export exists (stock React has none),
 *   2. `version` is the version it was written against,
 *   3. `capabilities` contains every bit it requires,
 *   4. after loading its renderer: `providerProtocols` contains an entry
 *      whose version/capabilities pass the same checks (a renderer that is
 *      missing entirely means a stock or mismatched renderer package —
 *      registration of a MISMATCHED renderer already failed loudly at
 *      renderer load, so an empty list here means no renderer loaded at all).
 */
export const externalRuntimeProtocol: {
  version: number,
  capabilities: number,
  providerProtocols: Array<ExternalRuntimeProtocol>,
} = {
  version: EXTERNAL_RUNTIME_PROTOCOL_VERSION,
  capabilities: EXTERNAL_RUNTIME_CAPABILITIES,
  // $FlowFixMe[unsafe-getters-setters] live view of registered renderers
  get providerProtocols(): Array<ExternalRuntimeProtocol> {
    return runtime.providers.map(provider => provider.protocol);
  },
};

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

export function getExternalRuntimeRenderContext(): null | {container: mixed} {
  const providers = runtime.providers;
  for (let i = 0; i < providers.length; i++) {
    const context = providers[i].getRenderContext();
    if (context !== null) {
      return context;
    }
  }
  return null;
}

// Only one renderer can be processing an event / rendering at a time on a
// thread; the first registered provider answers. With multiple renderers
// loaded, batch attribution is best-effort (documented limitation).

export function externalRuntimeIsCurrentWriteDeferred(): boolean {
  const providers = runtime.providers;
  return providers.length > 0 ? providers[0].isCurrentWriteDeferred() : false;
}

export function getExternalRuntimeCurrentWriteBatch(): number {
  const providers = runtime.providers;
  // 0 = "no batch": no renderer has registered a provider (e.g. no renderer
  // module has loaded yet), so a write issued now precedes any React batch.
  return providers.length > 0 ? providers[0].getCurrentWriteBatch() : 0;
}
