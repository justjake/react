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
  SignalRuntime,
  SignalRuntimeProvider,
} from 'react/src/ReactSignalRuntime';

import ReactSharedInternals from 'shared/ReactSharedInternals';

const activePassRoots: Set<FiberRoot> = new Set();

function getRuntime(): SignalRuntime | null {
  return (ReactSharedInternals as any).E || null;
}

export function registerSignalRuntimeProvider(
  provider: SignalRuntimeProvider,
): void {
  const runtime = getRuntime();
  if (runtime !== null && runtime.provider === null)
    runtime.provider = provider;
}

export function notifySignalRenderStart(root: FiberRoot, lanes: Lanes): void {
  const runtime = getRuntime();
  if (runtime === null) return;
  if (activePassRoots.delete(root) && runtime.hasListeners) {
    runtime.emit('onRenderEnd', root.containerInfo, false);
  }
  if (lanes !== 0) {
    activePassRoots.add(root);
    if (runtime.hasListeners) {
      runtime.emit('onRenderStart', root.containerInfo, lanes);
    }
  }
}

export function notifySignalRenderCommitted(root: FiberRoot): void {
  const runtime = getRuntime();
  if (
    runtime !== null &&
    activePassRoots.delete(root) &&
    runtime.hasListeners
  ) {
    runtime.emit('onRenderEnd', root.containerInfo, true);
  }
}

export function notifySignalRootPending(root: FiberRoot): void {
  const runtime = getRuntime();
  if (runtime !== null && runtime.hasListeners) {
    runtime.emit('onRootPending', root.containerInfo, root.pendingLanes);
  }
}

export function notifySignalRootCommit(
  root: FiberRoot,
  finishedLanes: Lanes,
): void {
  const runtime = getRuntime();
  if (runtime !== null && runtime.hasListeners) {
    runtime.emit(
      'onRootCommit',
      root.containerInfo,
      finishedLanes,
      root.pendingLanes,
    );
  }
}

export function notifySignalEventEnd(): void {
  const runtime = getRuntime();
  if (runtime !== null && runtime.hasListeners) runtime.emit('onEventEnd');
}

export function notifySignalBeforeMutation(root: FiberRoot): void {
  const runtime = getRuntime();
  if (runtime !== null && runtime.hasListeners) {
    runtime.emit('onBeforeMutation', root.containerInfo);
  }
}

export function notifySignalAfterMutation(root: FiberRoot): void {
  const runtime = getRuntime();
  if (runtime !== null && runtime.hasListeners) {
    runtime.emit('onAfterMutation', root.containerInfo);
  }
}
