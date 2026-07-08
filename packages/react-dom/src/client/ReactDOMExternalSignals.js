/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

// Userland surface of the external-signals seam. Its existence is the
// protocol handshake: stock React has no `unstable_externalSignals` export,
// so a signals library that requires the seam fails loudly at registration
// on an unpatched build.

import {
  injectExternalSignalsRuntime,
  runWithForcedLane,
  requestCurrentTransitionLane,
  scheduleExternalRootLane,
} from 'react-reconciler/src/ReactFiberExternalSignals';
import {isInvalidExecutionContextForEventFunction} from 'react-reconciler/src/ReactFiberWorkLoop';

export const unstable_externalSignals = {
  inject: injectExternalSignalsRuntime,
  runWithLane: runWithForcedLane,
  currentTransitionLane: requestCurrentTransitionLane,
  scheduleRootLane: scheduleExternalRootLane,
  // True during the render phase: the window in which store writes must be
  // rejected (commit-phase and event writes stay legal).
  isRenderPhase: isInvalidExecutionContextForEventFunction,
};
