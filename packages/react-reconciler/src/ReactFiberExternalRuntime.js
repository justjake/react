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
  ExternalRuntimeProvider,
} from 'react/src/ReactExternalRuntime';

import ReactSharedInternals from 'shared/ReactSharedInternals';
import {batchTokensForRender} from './ReactFiberBatchRegistry';

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

export function getExternalRuntime(): ExternalRuntime | null {
  // The runtime exists once the isomorphic `react` module has evaluated.
  // It is null with mismatched react/renderer versions; every entry point
  // here tolerates that by doing nothing.
  return (ReactSharedInternals as any).E || null;
}

export function registerExternalRuntimeProvider(
  provider: ExternalRuntimeProvider,
): void {
  const runtime = getExternalRuntime();
  if (runtime !== null) {
    runtime.providers.push(provider);
  }
}

// Roots with a render pass currently in progress (spanning yields). Used to
// pair start/end events exactly even when a pass is discarded by a restart.
const rootsWithActivePass: WeakSet<FiberRoot> = new WeakSet();

/**
 * Called from prepareFreshStack: a fresh work-in-progress stack is being
 * prepared for `root`. Any pass previously active on this root is implicitly
 * over (its partial tree was discarded). `lanes` is NoLanes when the stack is
 * reset without starting new work (e.g. interrupting a suspended render).
 */
export function notifyRenderPassStart(root: FiberRoot, lanes: Lanes): void {
  const runtime = getExternalRuntime();
  if (runtime === null) {
    return;
  }
  if (rootsWithActivePass.has(root)) {
    rootsWithActivePass.delete(root);
    if (runtime.hasListeners) {
      runtime.emitRenderPassEnd(root.containerInfo);
    }
  }
  if (lanes !== 0) {
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
 * Called when the render phase for `root` completed (the work loop finished
 * the whole tree — committed or not). Idempotent: yielded passes that resume
 * end exactly once.
 */
export function notifyRenderPassEnd(root: FiberRoot): void {
  const runtime = getExternalRuntime();
  if (runtime === null) {
    return;
  }
  if (rootsWithActivePass.has(root)) {
    rootsWithActivePass.delete(root);
    if (runtime.hasListeners) {
      runtime.emitRenderPassEnd(root.containerInfo);
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
