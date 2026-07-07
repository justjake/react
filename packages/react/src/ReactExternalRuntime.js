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
 *      (getCurrentWriteBatch), so an external write can be attributed to
 *      the same "version of the world" as the setState calls it batches
 *      with;
 *   2. which root is currently rendering and which batches that pass
 *      includes (getRenderContext and the render-pass listener events), so
 *      reads during render can resolve against the matching version;
 *   3. when each batch retires (onBatchRetired, exactly once per batch), so
 *      pending versions can be promoted to committed state — and, because a
 *      batch spanning several roots commits on each root at its own time,
 *      when each root commits (onRootCommitted, with the batches that commit
 *      made visible on that root), so per-root committed views stay
 *      self-consistent while the batch is still pending elsewhere.
 *
 * Batch ids are allocated by the external store itself when it registers a
 * BATCH-ID ALLOCATOR (registerBatchIdAllocator below): at each batch's
 * creation the reconciler calls the allocator with the batch's deferred
 * classification and stores whatever id it returns, so React's batch ids
 * and the store's batch ids are ONE number space — no translation tables on
 * either side, and allocation is also where the store learns each batch's
 * deferredness. Without a registered allocator the reconciler numbers
 * batches from its own internal counter; the protocol is identical either
 * way.
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
 * - Batches cross this boundary as integer batch ids (see
 *   ReactFiberBatchRegistry): positive integers, stable for the batch's
 *   life, never reused while live. BATCH_NONE (0) is reserved for "no
 *   batch". The integer carries no payload — deferredness is told to the
 *   registered allocator at creation, not encoded in the id — and is
 *   otherwise opaque. Roots are identified by their container (for
 *   react-dom, the DOM container element) — an identity token that is also
 *   what a MutationObserver caller needs.
 * - Everything here is inert until the first listener subscribes; the
 *   per-commit cost with no listeners is one property read and branch.
 */

import ReactSharedInternals from './ReactSharedInternalsClient';
import reportGlobalError from 'shared/reportGlobalError';

/** The reserved "no batch" id (mirrored by ReactFiberBatchRegistry's
 * BATCH_NONE — the two modules cannot share a constant across the
 * isomorphic/reconciler boundary). */
const BATCH_NONE = 0;

/**
 * An external store's batch-id allocator. Called by the reconciler exactly
 * once per batch, at the batch's creation — the first time an external
 * write asks for the current batch on a lane with no live batch — with the
 * batch's deferred classification (true for transition-like batches whose
 * renders don't block paint). Must return a positive integer that no live
 * batch currently carries; the reconciler stores it as the batch's identity
 * for its whole life (every event and provider method speaks it). Creation
 * can happen mid-render, mid-commit, or inside protocol listeners, so the
 * allocator must be allocation-only on its own side: hand out the id,
 * record what it needs, run nothing else.
 */
export type BatchIdAllocator = (deferred: boolean) => number;

export type ExternalRuntimeListener = {
  /** A render pass began on `container`, opening its pass FRAME.
   * `includedBatches` are the ids of every live batch this pass renders
   * (see getCurrentWriteBatch). The frame stays open across yields
   * (onRenderPassYield/onRenderPassResume) and across the
   * completed-but-uncommitted period (e.g. a commit suspended on resources),
   * and closes exactly once, at onRenderPassEnd. "In render" is per
   * callstack, NOT per frame: code running in a yield gap or while a
   * completed tree waits to commit observes getRenderContext() === null even
   * though the frame is open — keying any decision to the wall-clock
   * [start, end) interval is wrong. */
  onRenderPassStart?: (
    container: mixed,
    includedBatches: $ReadOnlyArray<number>,
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
  /** A batch retired — exactly once per batch id. `committed` is false only
   * for batches that never produced React work (their writes were
   * external-only); batches whose React updates were discarded by unmounts
   * still retire through an ordinary (empty) commit with committed = true. */
  onBatchRetired?: (batchId: number, committed: boolean) => void,
  /** `container` committed. Fires on every commit of a root, in commit order.
   * `committedBatches` is the delta this commit adds to the root's
   * committed-batch table: the ids of live batches whose updates this
   * commit made visible on this root, exactly once per (root, batch). A batch
   * still pending on a root (not rendered by the committing pass) never
   * appears, and neither does a batch whose updates on this root died with
   * deleted fibers (pruned): the table reflects what the root's committed
   * tree actually shows. `rootCommitGeneration` counts this root's commits
   * (monotonic, per root, starting at 1). Within one commit, this event
   * precedes the onBatchRetired edges the commit causes: a batch retires
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
  /** Identity of the batch an external write issued right now belongs to:
   * a positive integer, stable for the batch's life. Creates the batch
   * identity on first use for a batch (via the registered allocator, or the
   * reconciler's fallback counter); allocation-free per write after that. */
  getCurrentWriteBatch: () => number,
  /** Synchronously abandon every work-in-progress pass on every root this
   * renderer manages: every open pass frame closes with the discard
   * disposition before this returns, and the abandoned lanes are
   * re-scheduled as fresh passes. Throws if called while the renderer is
   * rendering or committing. */
  discardAllWip: () => void,
  /** Run `fn` so the React updates it schedules join `batchId`'s batch (its
   * own lane while the batch is live; the urgent fallback once it has
   * retired). Returns fn's result. Throws if called while the renderer is
   * rendering. */
  runInBatch: <R>(batchId: number, fn: () => R) => R,
  /** TEST-ONLY: clear the batch registry's full slot tenancy (batch ids,
   * root sets, committed-root sets, parked state) without emitting
   * retirement events. See resetBatchRegistryForTest in
   * ReactFiberBatchRegistry. */
  resetBatchRegistryForTest: () => void,
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
  /** The one registered renderer provider. One renderer per runtime: only
   * one renderer can be processing an event / rendering at a time on a
   * thread, and the workspace never loads two. A second renderer's
   * registration is ignored (first wins). */
  provider: ExternalRuntimeProviderMethods | null,
  /** The one registered batch-id allocator (see BatchIdAllocator), or null
   * when no external store has registered one (the reconciler then numbers
   * batches from its own counter). One allocator per runtime: batch ids are
   * one number space, and two stores minting into it cannot compose. */
  allocateBatchId: BatchIdAllocator | null,
  hasListeners: boolean,
  emitRenderPassStart: (
    container: mixed,
    includedBatches: $ReadOnlyArray<number>,
  ) => void,
  emitRenderPassYield: (container: mixed) => void,
  emitRenderPassResume: (container: mixed) => void,
  emitRenderPassEnd: (container: mixed, committed: boolean) => void,
  emitBeforeMutation: (container: mixed) => void,
  emitAfterMutation: (container: mixed) => void,
  emitBatchRetired: (batchId: number, committed: boolean) => void,
  emitRootCommitted: (
    container: mixed,
    committedBatches: $ReadOnlyArray<number>,
    rootCommitGeneration: number,
  ) => void,
};

const runtime: ExternalRuntime = {
  provider: null,
  allocateBatchId: null,
  hasListeners: false,
  emitRenderPassStart(container, includedBatches) {
    emit('onRenderPassStart', container, includedBatches);
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
  emitBatchRetired(batchId, committed) {
    emit('onBatchRetired', batchId, committed);
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

/**
 * Registers the external store's batch-id allocator (see BatchIdAllocator);
 * returns the unregister function. From registration on, every batch React
 * creates carries an id the allocator handed out. Throws if an allocator is
 * already registered: ids form one number space, so exactly one store can
 * own allocation — a store replacing itself must unregister first (and only
 * do so when no batch it allocated is still live, or between tests after
 * resetting the registry).
 */
export function registerExternalRuntimeBatchIdAllocator(
  allocateBatchId: BatchIdAllocator,
): () => void {
  if (runtime.allocateBatchId !== null) {
    throw new Error(
      'A batch-id allocator is already registered. Batch ids are one ' +
        'number space, so only one external store can allocate them; ' +
        'unregister the previous allocator first.',
    );
  }
  runtime.allocateBatchId = allocateBatchId;
  return function unregister() {
    if (runtime.allocateBatchId === allocateBatchId) {
      runtime.allocateBatchId = null;
    }
  };
}

/**
 * TEST-ONLY. Clears the renderer's batch registry — the full tenancy of
 * every batch slot (batch id, deferred flag, root sets, committed-root
 * sets, parked state) — without emitting retirement events. Test harnesses
 * call it between tests so stale slots never leak batch identity across a
 * test boundary. No-op when no renderer has registered a provider.
 */
export function externalRuntimeResetBatchRegistryForTest(): void {
  const provider = runtime.provider;
  if (provider !== null) {
    provider.resetBatchRegistryForTest();
  }
}

export function getExternalRuntimeRenderContext(): null | {container: mixed} {
  const provider = runtime.provider;
  return provider !== null ? provider.getRenderContext() : null;
}

export function getExternalRuntimeCurrentWriteBatch(): number {
  const provider = runtime.provider;
  // BATCH_NONE = "no batch": no renderer has registered a provider (e.g. no
  // renderer module has loaded yet), so a write issued now precedes any
  // React batch.
  return provider !== null ? provider.getCurrentWriteBatch() : BATCH_NONE;
}

export function externalRuntimeDiscardAllWip(): void {
  const provider = runtime.provider;
  if (provider !== null) {
    provider.discardAllWip();
  }
}

export function externalRuntimeRunInBatch<R>(batchId: number, fn: () => R): R {
  const provider = runtime.provider;
  if (provider === null) {
    // No renderer has registered a provider, so no batch can be live and
    // there is no renderer scheduling state to pin: this is the retired-
    // batch fallback with nothing to make urgent. Run fn plainly.
    return fn();
  }
  return provider.runInBatch(batchId, fn);
}
