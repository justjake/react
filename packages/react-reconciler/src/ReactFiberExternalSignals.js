/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

// External-signals seam: render identity for external state libraries.
//
// A concurrent-safe external store needs to know four things React never
// tells it: when a render pass starts (and for which root and lanes), when
// a pass's work reaches the screen (per-root commit, bracketing the DOM
// mutation phase exactly), which lane a transition-classified write will
// schedule on, and how to schedule follow-up work onto a specific lane so
// corrective re-renders land inside the owning batch's commit instead of
// beside it. This module is that seam and nothing more: one injectable
// runtime for the outbound events, and three inbound helpers. Subscription
// bookkeeping, speculative state, and delivery policy all stay in userland.

import type {FiberRoot} from './ReactInternalTypes';
import type {Lane, Lanes} from './ReactFiberLane';

import {NoLane, markRootUpdated} from './ReactFiberLane';
import {
  ensureRootIsScheduled,
  requestTransitionLane,
} from './ReactFiberRootScheduler';
import ReactSharedInternals from 'shared/ReactSharedInternals';

export type ExternalSignalsCommitPhase =
  | 'mutation-start' // immediately before React mutates the host tree
  | 'mutation-stop' // immediately after; layout and passive effects follow
  | 'committed'; // the pass's work is current; lanes name what committed

export type ExternalSignalsRuntime = {
  onPassStarted: (root: FiberRoot, lanes: Lanes) => void,
  onPassDiscarded: (root: FiberRoot, lanes: Lanes) => void,
  onCommitPhase: (
    root: FiberRoot,
    phase: ExternalSignalsCommitPhase,
    lanes: Lanes,
  ) => void,
};

let runtime: ExternalSignalsRuntime | null = null;

/**
 * Installs the external runtime. One slot: installing replaces the previous
 * runtime and returns an uninstaller. The seam's existence is the protocol
 * handshake — stock React has no such export, so a library that requires it
 * can fail loudly at registration.
 */
export function injectExternalSignalsRuntime(
  next: ExternalSignalsRuntime,
): () => void {
  runtime = next;
  return () => {
    if (runtime === next) {
      runtime = null;
    }
  };
}

export function externalSignalsPassStarted(
  root: FiberRoot,
  lanes: Lanes,
): void {
  if (runtime !== null) {
    runtime.onPassStarted(root, lanes);
  }
}

export function externalSignalsPassDiscarded(
  root: FiberRoot,
  lanes: Lanes,
): void {
  if (runtime !== null) {
    runtime.onPassDiscarded(root, lanes);
  }
}

export function externalSignalsCommitPhase(
  root: FiberRoot,
  phase: ExternalSignalsCommitPhase,
  lanes: Lanes,
): void {
  if (runtime !== null) {
    runtime.onCommitPhase(root, phase, lanes);
  }
}

// A forced update lane, consulted by requestUpdateLane ahead of every other
// classification rule. This is how a corrective re-render joins a live
// batch: the store schedules the subscriber's own update while the batch's
// lane is forced, so React folds the correction into that batch's render
// and commit rather than creating a fresh one.
let forcedLane: Lane = NoLane;

export function getForcedExternalLane(): Lane {
  return forcedLane;
}

export function runWithForcedLane<T>(lane: Lane, fn: () => T): T {
  const prev = forcedLane;
  forcedLane = lane;
  try {
    return fn();
  } finally {
    forcedLane = prev;
  }
}

/**
 * The lane an update scheduled by the current transition scope would get
 * (NoLane outside a transition). Lets the store key its draft batch by the
 * same lane React will render, without scheduling anything yet.
 */
export function requestCurrentTransitionLane(): Lane {
  const transition = ReactSharedInternals.T;
  if (transition === null) {
    return NoLane;
  }
  return requestTransitionLane(transition);
}

/**
 * Guarantees a close edge for a batch: marks the lane pending on a root and
 * schedules it, so the lane renders and commits (retiring the batch) even
 * when no subscribed component exists. A bailed-out root render is cheap.
 */
export function scheduleExternalRootLane(root: FiberRoot, lane: Lane): void {
  markRootUpdated(root, lane);
  ensureRootIsScheduled(root);
}
