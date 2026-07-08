/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {
  SignalRenderContext,
  SignalRuntimeListener,
} from './ReactSharedInternalsClient';

import ReactSharedInternals from 'shared/ReactSharedInternals';

export function subscribeToSignalRuntime(
  listener: SignalRuntimeListener,
): () => void {
  const runtime = ReactSharedInternals.signalRuntime;
  if (runtime.listener !== null) {
    throw new Error('Only one signal runtime can be registered at a time.');
  }
  runtime.listener = listener;
  return () => {
    if (runtime.listener === listener) runtime.listener = null;
  };
}

export function getCurrentSignalWriteLane(): number {
  const getWriteLane = ReactSharedInternals.signalRuntime.getWriteLane;
  if (getWriteLane === null) {
    throw new Error('The active renderer does not support the signal runtime.');
  }
  return getWriteLane();
}

export function isCurrentSignalWriteDeferred(): boolean {
  return ReactSharedInternals.T !== null;
}

export function getSignalRenderContext(): SignalRenderContext | null {
  const getRenderContext = ReactSharedInternals.signalRuntime.getRenderContext;
  return getRenderContext === null ? null : getRenderContext();
}

export function runWithSignalLane<T>(lane: number, fn: () => T): T {
  const runtime = ReactSharedInternals.signalRuntime;
  const previousLane = runtime.pinnedLane;
  const previousTransition = ReactSharedInternals.T;
  runtime.pinnedLane = lane;
  if (lane === 0) ReactSharedInternals.T = null;
  try {
    return fn();
  } finally {
    ReactSharedInternals.T = previousTransition;
    runtime.pinnedLane = previousLane;
  }
}
