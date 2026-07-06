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
 *      pending versions can be promoted to committed state — and, because a
 *      batch spanning several roots commits on each root at its own time,
 *      when each root commits (onRootCommitted, with the batches that commit
 *      made visible on that root), so per-root committed views stay
 *      self-consistent while the batch is still pending elsewhere.
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

export type ExternalRuntimeListener = {
  /** A render pass began on `container`, opening its pass FRAME.
   * `includedBatches` are the tokens of every live batch this pass renders
   * (see getCurrentWriteBatch). The frame stays open across yields
   * (onRenderPassYield/onRenderPassResume) and across the
   * completed-but-uncommitted period (e.g. a commit suspended on resources),
   * and closes exactly once, at onRenderPassEnd. "In render" is per
   * callstack, NOT per frame: code running in a yield gap or while a
   * completed tree waits to commit observes getRenderContext() === null even
   * though the frame is open — keying any decision to the wall-clock
   * [start, end) interval is wrong.
   *
   * `lineageId` is the render-lineage identity: a positive integer stable
   * per (root × batch-set). Every pass on this root rendering the same set
   * of batches — restarts after an interruption, replays, Suspense retries,
   * fresh passes after discardAllWip — reports the SAME id, and the id is
   * dead (never reported again) once the set commits on this root or its
   * work is abandoned. A pass over a different set (a restart that picked
   * up an extra batch, a pass after a spanning batch locked in) reports a
   * new id, and the same batch-set spanning two roots has a different id
   * per root. Single tokens, mask unions, and pass serial numbers are all
   * wrong keys for cross-pass state (they drift, churn, or refetch
   * forever); this id is the intended key, e.g. for Suspense thenable
   * capsules. */
  onRenderPassStart?: (
    container: mixed,
    includedBatches: $ReadOnlyArray<number>,
    lineageId: number,
  ) => void,
  /** The pass on `container` yielded to the event loop with its tree
   * unfinished; the frame stays open. Fires at most once per gap:
   * yield/resume strictly alternate within a frame. */
  onRenderPassYield?: (container: mixed) => void,
  /** The yielded pass on `container` re-entered the work loop. Always
   * paired with a preceding onRenderPassYield; a discarded yielded pass
   * ends (committed = false) without a resume. */
  onRenderPassResume?: (container: mixed) => void,
  /** The pass frame on `container` closed — exactly once per frame.
   * `committed` is true when the frame closes because its tree is being
   * committed: it fires inside that commit, BEFORE the commit's
   * onRootCommitted report (no committed-view advance happens on a root
   * while a pass frame on that root is open). `committed` is false when the
   * pass was discarded — a restart (a fresh onRenderPassStart on the same
   * root follows), an interrupted suspended render, a canceled pending
   * commit, or discardAllWip — and the pass's tree can never later commit. */
  onRenderPassEnd?: (container: mixed, committed: boolean) => void,
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
  /** `container` committed. Fires on every commit of a root, in commit order.
   * `committedBatches` is the delta this commit adds to the root's
   * committed-batch table: the tokens of live batches whose updates this
   * commit made visible on this root, exactly once per (root, batch). A batch
   * still pending on a root (not rendered by the committing pass) never
   * appears, and neither does a batch whose updates on this root died with
   * deleted fibers (pruned): the table reflects what the root's committed
   * tree actually shows. `rootCommitGeneration` counts this root's commits
   * (monotonic, per root, starting at 1). Within one commit, this event
   * precedes the onBatchRetired edges the commit causes: a token retires
   * BECAUSE its last pending root committed (or pruned) it. */
  onRootCommitted?: (
    container: mixed,
    committedBatches: $ReadOnlyArray<number>,
    rootCommitGeneration: number,
  ) => void,
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
  /** Synchronously abandon every work-in-progress pass on every root this
   * renderer manages: every open pass frame closes with the discard
   * disposition before this returns, and the abandoned lanes are
   * re-scheduled as fresh passes. Throws if called while the renderer is
   * rendering or committing. */
  discardAllWip: () => void,
  /** Run `fn` so the React updates it schedules join `token`'s batch (its
   * own lane while the token is live; the urgent fallback once it has
   * retired). Returns fn's result. Throws if called while the renderer is
   * rendering. */
  runInBatch: <R>(token: number, fn: () => R) => R,
};

const listeners: Set<ExternalRuntimeListener> = new Set();

function emit(event: string, a: mixed, b?: mixed, c?: mixed): void {
  // Deliver to every listener even if one throws; a listener error must not
  // corrupt React's commit, so it is reported like an uncaught error.
  // (Set#forEach rather than for..of: repo lint bans for..of loops.)
  listeners.forEach(listener => {
    const handler = (listener as any)[event];
    if (handler != null) {
      try {
        handler(a, b, c);
      } catch (error) {
        reportGlobalError(error);
      }
    }
  });
}

export type ExternalRuntime = {
  providers: Array<ExternalRuntimeProviderMethods>,
  hasListeners: boolean,
  emitRenderPassStart: (
    container: mixed,
    includedBatches: $ReadOnlyArray<number>,
    lineageId: number,
  ) => void,
  emitRenderPassYield: (container: mixed) => void,
  emitRenderPassResume: (container: mixed) => void,
  emitRenderPassEnd: (container: mixed, committed: boolean) => void,
  emitBeforeMutation: (container: mixed) => void,
  emitAfterMutation: (container: mixed) => void,
  emitBatchRetired: (token: number, committed: boolean) => void,
  emitRootCommitted: (
    container: mixed,
    committedBatches: $ReadOnlyArray<number>,
    rootCommitGeneration: number,
  ) => void,
};

const runtime: ExternalRuntime = {
  providers: [],
  hasListeners: false,
  emitRenderPassStart(container, includedBatches, lineageId) {
    emit('onRenderPassStart', container, includedBatches, lineageId);
  },
  emitRenderPassYield(container) {
    emit('onRenderPassYield', container);
  },
  emitRenderPassResume(container) {
    emit('onRenderPassResume', container);
  },
  emitRenderPassEnd(container, committed) {
    emit('onRenderPassEnd', container, committed);
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
  emitRootCommitted(container, committedBatches, rootCommitGeneration) {
    emit('onRootCommitted', container, committedBatches, rootCommitGeneration);
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

export function externalRuntimeDiscardAllWip(): void {
  // Unlike the write-classification reads above, this addresses every
  // renderer: each one abandons its own work in progress.
  const providers = runtime.providers;
  for (let i = 0; i < providers.length; i++) {
    providers[i].discardAllWip();
  }
}

export function externalRuntimeRunInBatch<R>(token: number, fn: () => R): R {
  const providers = runtime.providers;
  if (providers.length === 0) {
    // No renderer has registered a provider, so no batch can be live and
    // there is no renderer scheduling state to pin: this is the retired-
    // token fallback with nothing to make urgent. Run fn plainly.
    return fn();
  }
  // Tokens are minted by a renderer's reconciler; with several renderers
  // loaded, attribution is best-effort through the first (the documented
  // multi-renderer limitation above). A token the first renderer does not
  // recognize takes its retired-token urgent fallback.
  return providers[0].runInBatch(token, fn);
}
