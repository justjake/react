/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import ReactSharedInternals from './ReactSharedInternalsClient';
import reportGlobalError from 'shared/reportGlobalError';

export type SignalRuntimeListener = {
  onRenderStart?: (container: mixed, lanes: number) => void,
  onRenderEnd?: (container: mixed, committed: boolean) => void,
  onRootPending?: (container: mixed, lanes: number) => void,
  onRootCommit?: (
    container: mixed,
    finishedLanes: number,
    remainingLanes: number,
  ) => void,
  onEventEnd?: () => void,
  onBeforeMutation?: (container: mixed) => void,
  onAfterMutation?: (container: mixed) => void,
};

export type SignalRuntimeProvider = {
  getWriteLane: () => number,
  getRenderRoot: () => mixed,
  getRenderLanes: () => number,
  runInLane: <T>(lane: number, fn: () => T) => T,
};

export type SignalRuntime = {
  provider: SignalRuntimeProvider | null,
  hasListeners: boolean,
  emit: (event: string, a?: mixed, b?: mixed, c?: mixed) => void,
};

const listeners: Set<SignalRuntimeListener> = new Set();

const runtime: SignalRuntime = {
  provider: null,
  hasListeners: false,
  emit(event, a, b, c) {
    listeners.forEach(listener => {
      const handler = (listener as any)[event];
      if (handler !== undefined) {
        try {
          handler(a, b, c);
        } catch (error) {
          reportGlobalError(error);
        }
      }
    });
  },
};

ReactSharedInternals.E = runtime;

export function subscribeToSignalRuntime(
  listener: SignalRuntimeListener,
): () => void {
  listeners.add(listener);
  runtime.hasListeners = true;
  return function unsubscribe() {
    listeners.delete(listener);
    runtime.hasListeners = listeners.size !== 0;
  };
}

export function getSignalWriteLane(): number {
  const provider = runtime.provider;
  return provider === null ? 0 : provider.getWriteLane();
}

export function getSignalRenderRoot(): mixed {
  const provider = runtime.provider;
  return provider === null ? null : provider.getRenderRoot();
}

export function getSignalRenderLanes(): number {
  const provider = runtime.provider;
  return provider === null ? 0 : provider.getRenderLanes();
}

export function runInSignalLane<T>(lane: number, fn: () => T): T {
  const provider = runtime.provider;
  return provider === null ? fn() : provider.runInLane(lane, fn);
}
