/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import ReactSharedInternals from './ReactSharedInternalsClient';

export function registerSignalRuntime(runtime: mixed): () => void {
  const current = ReactSharedInternals.R;
  if (current !== null && current !== runtime) {
    throw new Error('A different signal runtime is already registered.');
  }
  ReactSharedInternals.R = runtime;
  return () => {
    if (ReactSharedInternals.R === runtime) ReactSharedInternals.R = null;
  };
}

export function runWithSignalBatch<T>(batch: number, scope: () => T): T {
  const previous = ReactSharedInternals.B;
  ReactSharedInternals.B = batch;
  try {
    return scope();
  } finally {
    ReactSharedInternals.B = previous;
  }
}
