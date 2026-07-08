/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {FiberRoot} from './ReactInternalTypes';
import type {Lanes, Lane} from './ReactFiberLane';
import type {Transition} from 'react/src/ReactStartTransition';

import ReactSharedInternals from 'shared/ReactSharedInternals';

const batchesByLane: Int32Array = new Int32Array(31);
const renderedBatches: Map<FiberRoot, Array<number>> = new Map();

export function laneForSignalBatch(batch: number): Lane {
  for (let index = 0, lane = 1; index < 31; index++, lane *= 2) {
    if (batchesByLane[index] === batch) return lane;
  }
  return 0;
}

ReactSharedInternals.P = function <T>(batch: number, scope: () => T): T {
  if (laneForSignalBatch(batch) === 0) return scope();
  const previous = ReactSharedInternals.T;
  ReactSharedInternals.T = ({_signalBatch: batch}: any);
  try {
    return scope();
  } finally {
    ReactSharedInternals.T = previous;
  }
};

function batchesFor(lanes: Lanes): Array<number> {
  const result = [];
  let lane = 1;
  for (let index = 0; index < 31; index++, lane *= 2) {
    const batch = batchesByLane[index];
    if ((lanes & lane) !== 0 && batch !== 0 && result.indexOf(batch) < 0) {
      result.push(batch);
    }
  }
  return result;
}

export function claimSignalBatch(lane: Lane, transition: Transition): void {
  const batch = transition._signalBatch;
  if (batch === undefined) return;
  const index = 31 - Math.clz32(lane);
  batchesByLane[index] = batch;
  const runtime = ReactSharedInternals.R;
  if (runtime !== null) runtime.batchScheduled(batch);
}

export function signalRenderStart(root: FiberRoot, lanes: Lanes): void {
  const runtime = ReactSharedInternals.R;
  const previous = renderedBatches.get(root);
  if (runtime !== null && previous !== undefined) runtime.renderEnd(false);
  if (lanes === 0) {
    renderedBatches.delete(root);
    return;
  }
  const batches = batchesFor(lanes);
  renderedBatches.set(root, batches);
  if (runtime !== null) runtime.renderStart(root.containerInfo, batches);
}

export function signalRenderResume(root: FiberRoot): void {
  const runtime = ReactSharedInternals.R;
  if (runtime !== null) {
    runtime.renderStart(root.containerInfo, renderedBatches.get(root) || []);
  }
}

export function signalRenderEnd(completed: boolean): void {
  const runtime = ReactSharedInternals.R;
  if (runtime !== null) runtime.renderEnd(completed);
}

export function signalCommit(root: FiberRoot, lanes: Lanes): void {
  const runtime = ReactSharedInternals.R;
  const batches = renderedBatches.get(root) || batchesFor(lanes);
  renderedBatches.delete(root);
  if (runtime !== null) runtime.commit(root.containerInfo, batches);
}

export function signalMutation(root: FiberRoot, start: boolean): void {
  const runtime = ReactSharedInternals.R;
  if (runtime !== null) runtime.mutation(start, root.containerInfo);
}
