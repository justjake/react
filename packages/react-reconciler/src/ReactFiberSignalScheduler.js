/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

// Bridge for an external signal store that owns update scheduling. The store
// claims a transition lane per store batch and pins it on the transition
// objects it dispatches under (`transition._signalLane`), so every update for
// that batch — including corrective re-renders issued much later — lands in
// the same commit. In return React reports, through the callbacks below, when
// a render pass starts, when a root commits, and the exact DOM mutation
// window. The store discovers the bridge via a well-known global; a build
// without it fails the store's registration loudly.

import type {FiberRoot} from './ReactInternalTypes';
import type {Lane, Lanes} from './ReactFiberLane';

type SignalSchedulerBridge = {
  // Filled by React at module load:
  claimTransitionLane: null | (() => Lane),
  getWorkInProgress: null | (() => {root: FiberRoot, lanes: Lanes} | null),
  isRendering: null | (() => boolean),
  // Filled by the store at registration:
  onPassStart: null | ((root: FiberRoot, lanes: Lanes) => void),
  onCommit: null | ((root: FiberRoot, lanes: Lanes) => void),
  onMutation: null | ((root: FiberRoot, start: boolean) => void),
};

export const signalScheduler: SignalSchedulerBridge = {
  claimTransitionLane: null,
  getWorkInProgress: null,
  isRendering: null,
  onPassStart: null,
  onCommit: null,
  onMutation: null,
};

if (typeof globalThis !== 'undefined') {
  (globalThis as any).__SIGNALS_ROYALE_FX1__ = signalScheduler;
}
