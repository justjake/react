/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * The signal seam: a minimal introspection channel that lets an external
 * signal runtime participate in concurrent rendering without tearing.
 *
 * Design: React exposes raw facts (lanes, roots, phase edges) and one control
 * (a pinned transition lane); every batch/world/store concept lives in the
 * runtime. The seam object is published on ReactSharedInternals so a runtime
 * loaded from the `react` package can reach it; its absence on stock React is
 * the runtime's feature-detection signal.
 *
 * Facts, from the reconciler to the runtime:
 * - onPassStart(container, lanes): a fresh render stack was prepared for a
 *   root; `lanes` is the entangled set the pass will consume (NoLanes when
 *   the stack was reset without new work).
 * - onRootUpdated(container, lanes): updates were scheduled on a root.
 * - onCommit(container, committedLanes, remainingLanes): a commit finished
 *   `committedLanes` (entanglement-expanded) on a root; `remainingLanes` is
 *   what is still pending there.
 * - onMutation(container, active): brackets exactly the phase in which React
 *   mutates the host tree for a commit.
 *
 * Queries, installed by the work loop for the runtime to call:
 * - getWriteLane(): the transition lane a store write issued right now
 *   belongs to, or 0 for urgent writes.
 * - getRenderContainer(): the container whose render pass is executing on
 *   this stack, or null (write-during-render detection and world routing).
 *
 * Control:
 * - pinnedTransitionLane: while nonzero, transitions claim exactly this lane.
 *   The runtime pins it around a corrective update so the update rides
 *   INSIDE the pending batch's own lane and commits with it, never beside it.
 */

import type {FiberRoot} from './ReactInternalTypes';
import type {Lane, Lanes} from './ReactFiberLane';

import ReactSharedInternals from 'shared/ReactSharedInternals';

export type SignalRuntime = {
  onPassStart: (container: mixed, lanes: Lanes) => void,
  onRootUpdated: (container: mixed, lanes: Lanes) => void,
  onCommit: (
    container: mixed,
    committedLanes: Lanes,
    remainingLanes: Lanes,
  ) => void,
  onMutation: (container: mixed, active: boolean) => void,
};

export type SignalSeam = {
  runtime: SignalRuntime | null,
  getWriteLane: null | (() => Lane),
  getRenderContainer: null | (() => mixed),
  pinnedTransitionLane: Lane,
};

const seam: SignalSeam = {
  runtime: null,
  getWriteLane: null,
  getRenderContainer: null,
  pinnedTransitionLane: (0: any),
};

(ReactSharedInternals: any).signalSeam = seam;

export default seam;

export function onSignalPassStart(root: FiberRoot, lanes: Lanes): void {
  const runtime = seam.runtime;
  if (runtime !== null) {
    runtime.onPassStart(root.containerInfo, lanes);
  }
}

export function onSignalRootUpdated(root: FiberRoot, lanes: Lanes): void {
  const runtime = seam.runtime;
  if (runtime !== null) {
    runtime.onRootUpdated(root.containerInfo, lanes);
  }
}

export function onSignalCommit(
  root: FiberRoot,
  committedLanes: Lanes,
  remainingLanes: Lanes,
): void {
  const runtime = seam.runtime;
  if (runtime !== null) {
    runtime.onCommit(root.containerInfo, committedLanes, remainingLanes);
  }
}

export function onSignalMutation(root: FiberRoot, active: boolean): void {
  const runtime = seam.runtime;
  if (runtime !== null) {
    runtime.onMutation(root.containerInfo, active);
  }
}
