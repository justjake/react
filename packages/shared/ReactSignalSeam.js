/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

// A minimal seam between the reconciler and an external signal runtime.
//
// The runtime (a userland state library) registers a handler object here to
// hear about render-pass boundaries, per-root commits, and the DOM mutation
// window. The reconciler installs a provider here so the runtime can ask
// which lane an update issued right now would take, which root and lanes are
// rendering on the current stack, and schedule updates pinned to a specific
// lane. Everything else — batch identity, write classification, world
// snapshots — lives in the runtime; React only reports lanes as opaque
// numbers.

export type SignalSeamRuntime = {
  // A render pass began on `container` covering `lanes` (a fresh stack; a
  // restart replaces the previous pass on the same container).
  onPassStart: (container: mixed, lanes: number) => void,
  // A pass on `container` committed `lanes`; `remainingLanes` still hold
  // pending work afterwards.
  onPassCommit: (container: mixed, lanes: number, remainingLanes: number) => void,
  // Brackets exactly React's DOM mutation phase for a commit on `container`.
  onMutationPhase: (phase: 'start' | 'stop', container: mixed) => void,
};

export type SignalSeamProvider = {
  // The lane an external write issued right now would be scheduled on,
  // mirroring requestUpdateLane's cascade for updates with no fiber.
  currentUpdateLane: () => number,
  // Non-null while React renders on the current stack.
  currentRenderInfo: () => null | {container: mixed, lanes: number},
};

let runtime: SignalSeamRuntime | null = null;
let provider: SignalSeamProvider | null = null;
// While non-zero, requestUpdateLane returns this lane unconditionally: the
// runtime uses it to schedule a corrective update INTO a live batch's lane so
// the correction commits with the batch instead of beside it.
let pinnedLane: number = 0;

export function registerSignalSeamRuntime(r: SignalSeamRuntime | null): void {
  runtime = r;
}

export function installSignalSeamProvider(p: SignalSeamProvider): void {
  provider = p;
}

export function signalSeamCurrentUpdateLane(): number {
  if (provider === null) {
    throw new Error('The signal seam provider is not installed.');
  }
  return provider.currentUpdateLane();
}

export function signalSeamCurrentRenderInfo(): null | {
  container: mixed,
  lanes: number,
} {
  if (provider === null) {
    return null;
  }
  return provider.currentRenderInfo();
}

export function runWithPinnedLane<R>(lane: number, fn: () => R): R {
  const prev = pinnedLane;
  pinnedLane = lane;
  try {
    return fn();
  } finally {
    pinnedLane = prev;
  }
}

export function getPinnedLane(): number {
  return pinnedLane;
}

export function emitPassStart(container: mixed, lanes: number): void {
  if (runtime !== null) {
    runtime.onPassStart(container, lanes);
  }
}

export function emitPassCommit(
  container: mixed,
  lanes: number,
  remainingLanes: number,
): void {
  if (runtime !== null) {
    runtime.onPassCommit(container, lanes, remainingLanes);
  }
}

export function emitMutationPhase(phase: 'start' | 'stop', container: mixed): void {
  if (runtime !== null) {
    runtime.onMutationPhase(phase, container);
  }
}
