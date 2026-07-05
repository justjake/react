/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {FiberRoot} from './ReactInternalTypes';
import type {Lanes} from './ReactFiberLane';
import type {
  ExternalRuntime,
  ExternalRuntimeProviderMethods,
} from 'react/src/ReactExternalRuntime';

import ReactSharedInternals from 'shared/ReactSharedInternals';
import {
  batchTokensForRender,
  batchRegistryOnRenderStart,
} from './ReactFiberBatchRegistry';

/**
 * Reconciler side of the external-runtime introspection channel (see
 * packages/react/src/ReactExternalRuntime.js for what it is for). The work
 * loop calls the notify* functions at documented lifecycle points; they no-op
 * unless a listener has subscribed on the isomorphic side.
 *
 * Roots are reported to userspace as their container (root.containerInfo):
 * an identity token that is also the object a MutationObserver caller needs.
 * No Fiber or FiberRoot shapes cross this boundary.
 */

// The protocol version + capability bits THIS reconciler build implements.
// Deliberately a duplicated copy of the constants in
// packages/react/src/ReactExternalRuntime.js (which also documents the bit
// assignments), NOT a value import: a value import would be inlined into the
// renderer bundle at build time either way, and keeping the copy explicit
// makes it obvious that each artifact bakes its own numbers — which is
// exactly what lets registerExternalRuntimeProvider detect version skew
// between separately built react and renderer packages.
const EXTERNAL_RUNTIME_PROTOCOL_VERSION = 1;
const EXTERNAL_RUNTIME_CAPABILITIES =
  (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 6) | (1 << 8);

export function getExternalRuntime(): ExternalRuntime | null {
  // The runtime exists once the isomorphic `react` module has evaluated.
  // Registration below refuses mismatched react/renderer pairs loudly, so
  // the emit paths can only observe null before registration has run; they
  // tolerate that by doing nothing.
  return (ReactSharedInternals as any).E || null;
}

export function registerExternalRuntimeProvider(
  methods: ExternalRuntimeProviderMethods,
): void {
  // The versioned handshake, renderer side (cosignal spec §4.1 fact 7).
  // Failing loudly here is the point: pairing this renderer with a react
  // package that lacks the registry (stock React) or speaks a different
  // protocol version must not silently degrade into a mode where every
  // external write classifies as "no batch".
  const runtime = getExternalRuntime();
  if (runtime === null || runtime.protocol == null) {
    throw new Error(
      'This renderer was built with external-runtime protocol v' +
        EXTERNAL_RUNTIME_PROTOCOL_VERSION +
        ', but the react package it loaded does not provide the ' +
        'external-runtime registry. The react package and the renderer ' +
        'must come from the same cosignal fork build.',
    );
  }
  if (runtime.protocol.version !== EXTERNAL_RUNTIME_PROTOCOL_VERSION) {
    throw new Error(
      'External-runtime protocol version skew: the react package speaks v' +
        runtime.protocol.version +
        ' but this renderer was built for v' +
        EXTERNAL_RUNTIME_PROTOCOL_VERSION +
        '. The react package and the renderer must come from the same ' +
        'cosignal fork build.',
    );
  }
  runtime.providers.push({
    protocol: {
      version: EXTERNAL_RUNTIME_PROTOCOL_VERSION,
      capabilities: EXTERNAL_RUNTIME_CAPABILITIES,
    },
    getRenderContext: methods.getRenderContext,
    isCurrentWriteDeferred: methods.isCurrentWriteDeferred,
    getCurrentWriteBatch: methods.getCurrentWriteBatch,
    discardAllWip: methods.discardAllWip,
    runInBatch: methods.runInBatch,
  });
}

// Roots with an open pass FRAME. A frame opens at prepareFreshStack and
// closes exactly once — at the commit that lands the pass's tree
// (notifyRenderPassCommitted) or at the discard that abandons it (the
// implicit end inside notifyRenderPassStart when a restart/reset throws the
// work-in-progress away, or discardAllWorkInProgress). It does NOT close at
// render completion: the frame spans yields, suspensions, and the
// completed-but-uncommitted period (e.g. a commit suspended on resources),
// so several roots can hold open frames at once even though only one render
// is ever in progress.
//
// A strong Set, not a WeakSet: discardAllWorkInProgress must ENUMERATE the
// open frames, and the scheduler's own root list drops roots whose only
// remaining work is a suspended pending commit. The strong reference adds no
// practical leak: a root with an open frame is one React itself still holds
// — through the root schedule (pending renderable lanes), a pending-commit
// subscription, a throttle timeout, or a ping listener — and membership ends
// at the frame's commit/discard edge.
const rootsWithActivePass: Set<FiberRoot> = new Set();
// The subset of open frames currently in a yield gap: the work loop
// returned to the event loop with the tree unfinished. Membership pairs
// yield/resume exactly — they strictly alternate within a frame, and a
// frame that closes mid-gap (discarded) simply never resumes.
const rootsWithYieldedPass: WeakSet<FiberRoot> = new WeakSet();

/**
 * Every root with an open pass frame, for discardAllWorkInProgress
 * (reconciler-internal — FiberRoots never cross the userspace boundary).
 * A fresh array: the caller mutates frame state while iterating.
 */
export function getRootsWithOpenPassFrames(): Array<FiberRoot> {
  const roots: Array<FiberRoot> = [];
  rootsWithActivePass.forEach(root => {
    roots.push(root);
  });
  return roots;
}

/**
 * Called from prepareFreshStack: a fresh work-in-progress stack is being
 * prepared for `root`. Any frame previously open on this root is implicitly
 * over (its tree — partial, or completed but never committed — was
 * discarded and can never commit). `lanes` is NoLanes when the stack is
 * reset without starting new work (e.g. interrupting a suspended render).
 */
export function notifyRenderPassStart(root: FiberRoot, lanes: Lanes): void {
  const runtime = getExternalRuntime();
  if (runtime === null) {
    return;
  }
  if (rootsWithActivePass.has(root)) {
    rootsWithActivePass.delete(root);
    rootsWithYieldedPass.delete(root);
    if (runtime.hasListeners) {
      runtime.emitRenderPassEnd(root.containerInfo, false);
    }
  }
  if (lanes !== 0) {
    // Registry bookkeeping (unconditional, like the frame sets): record the
    // render-time entangled expansion this pass consumes, for the finish
    // edge's visibility decisions.
    batchRegistryOnRenderStart(root, lanes);
    rootsWithActivePass.add(root);
    if (runtime.hasListeners) {
      runtime.emitRenderPassStart(
        root.containerInfo,
        batchTokensForRender(root, lanes),
      );
    }
  }
}

/**
 * Called when the work loop returns control to the event loop with `root`'s
 * tree unfinished (time-slicing, or a suspension the loop is waiting out).
 * The frame stays open; code that runs in the gap observes "not in render"
 * (getRenderContext() === null) — truth is per callstack, not per frame.
 * The membership guard makes a double yield (two yields with no resume,
 * restart, or commit between) structurally unemittable.
 */
export function notifyRenderPassYield(root: FiberRoot): void {
  const runtime = getExternalRuntime();
  if (runtime === null) {
    return;
  }
  if (rootsWithActivePass.has(root) && !rootsWithYieldedPass.has(root)) {
    rootsWithYieldedPass.add(root);
    if (runtime.hasListeners) {
      runtime.emitRenderPassYield(root.containerInfo);
    }
  }
}

/**
 * Called when the work loop re-enters an in-progress pass on `root` without
 * preparing a fresh stack (the same-root-same-lanes continuation path, sync
 * or concurrent). Emits only if the frame actually yielded: a stack the
 * caller prepared explicitly right before rendering takes the same entry
 * path but never yielded, and pairing is exact.
 */
export function notifyRenderPassResume(root: FiberRoot): void {
  const runtime = getExternalRuntime();
  if (runtime === null) {
    return;
  }
  if (rootsWithYieldedPass.has(root)) {
    rootsWithYieldedPass.delete(root);
    if (runtime.hasListeners) {
      runtime.emitRenderPassResume(root.containerInfo);
    }
  }
}

/**
 * Called from commitRoot, after React's own bookkeeping marks the committed
 * lanes finished and BEFORE the batch registry reports the committed-view
 * advance (onRootCommitted) that commit causes: the committing pass's frame
 * closes, disposition commit, so no listener ever observes a same-root
 * committed-view advance while a same-root frame is open. The membership
 * guard keeps the close exactly-once even if a commit path runs for a root
 * whose frame a restart already discarded.
 */
export function notifyRenderPassCommitted(root: FiberRoot): void {
  const runtime = getExternalRuntime();
  if (runtime === null) {
    return;
  }
  if (rootsWithActivePass.has(root)) {
    rootsWithActivePass.delete(root);
    rootsWithYieldedPass.delete(root);
    if (runtime.hasListeners) {
      runtime.emitRenderPassEnd(root.containerInfo, true);
    }
  }
}

/**
 * Bracket exactly the window in which React mutates the host tree during a
 * commit. Fired only when there are mutation effects to apply. These live in
 * flushMutationEffects (not commitRoot) so View Transition commits — whose
 * mutation phase runs later, inside the browser's startViewTransition update
 * callback — are bracketed correctly too.
 */
export function notifyBeforeMutation(root: FiberRoot): void {
  const runtime = getExternalRuntime();
  if (runtime !== null && runtime.hasListeners) {
    runtime.emitBeforeMutation(root.containerInfo);
  }
}

export function notifyAfterMutation(root: FiberRoot): void {
  const runtime = getExternalRuntime();
  if (runtime !== null && runtime.hasListeners) {
    runtime.emitAfterMutation(root.containerInfo);
  }
}
