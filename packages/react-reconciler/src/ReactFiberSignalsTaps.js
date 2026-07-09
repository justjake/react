/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {FiberRoot} from './ReactInternalTypes';
import type {Lane, Lanes} from './ReactFiberLane';
import type {Thenable} from 'shared/ReactTypes';

import ReactSharedInternals from 'shared/ReactSharedInternals';

type SignalsTapConsumer = {
  onRootUpdated: (FiberRoot, mixed, Lanes) => void,
  onScheduledRootPending: (FiberRoot, mixed, Lanes) => void,
  onEventClosed: (Lane, Thenable<void> | null) => void,
  onRenderPassStart: (FiberRoot, mixed, Lanes) => void,
  onRenderPassYield: (FiberRoot, mixed) => void,
  onRenderPassResume: (FiberRoot, mixed) => void,
  onRootCommitted: (FiberRoot, mixed, Lanes, Lanes, Lanes) => void,
  onBeforeMutation: mixed => void,
  onAfterMutation: mixed => void,
};

export type SignalsTaps = {
  forkProtocolVersion: 1,
  consumer: SignalsTapConsumer | null,
  watchedLanes: Lanes,
  getCurrentWriteLane: () => number,
  getRenderContext: () => null | {root: FiberRoot, container: mixed},
  runInBatch: <R>(packedLane: number, fn: () => R) => R,
};

export const signalsTaps: SignalsTaps = {
  forkProtocolVersion: 1,
  consumer: null,
  watchedLanes: 0,
  getCurrentWriteLane: () => 0,
  getRenderContext: () => null,
  runInBatch: <R>(packedLane: number, fn: () => R): R => fn(),
};

ReactSharedInternals.E = signalsTaps;
