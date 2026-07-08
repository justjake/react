/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

export {createRoot, hydrateRoot, version} from './src/client/ReactDOMClient';
export {
  registerSignalSeamRuntime as unstable_registerSignalSeamRuntime,
  signalSeamCurrentUpdateLane as unstable_currentUpdateLane,
  signalSeamCurrentRenderInfo as unstable_currentRenderInfo,
  runWithPinnedLane as unstable_runWithPinnedLane,
} from 'shared/ReactSignalSeam';
