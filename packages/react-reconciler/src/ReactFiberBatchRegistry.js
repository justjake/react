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

import {getExternalRuntime} from './ReactFiberExternalRuntime';

/**
 * Batch tokens: stable identities for "a batch of updates React renders and
 * retires as a unit", exposed to external state libraries in place of raw
 * lane bits (see ReactExternalRuntime.js).
 *
 * Why identities instead of bits: lane bits are recycled (the transition
 * cursor wraps after 10 claims), so a bit cannot name a batch across time.
 * The registry is EDGE-TRIGGERED from the places the reconciler already
 * mutates its own bookkeeping — never sampled — so a reused bit can never be
 * observed under a stale token:
 *
 *   claim   (requestTransitionLane's once-per-event claim)
 *   pending (markRootUpdated: first time this batch gets work on a root)
 *   finish  (commitRoot: lanes leave root.pendingLanes)
 *   close   (end of the scheduling microtask: a batch that never produced
 *            React work retires immediately)
 *
 * Abandonment needs no special detection: updates orphaned by unmounts keep
 * their lane bit pending, React eventually renders that lane to nothing and
 * commits, and the finish edge fires like any other commit.
 *
 * If a lane bit is claimed again while its previous batch is still pending,
 * React itself cannot distinguish the two batches — they render and retire
 * together. The registry mirrors reality: the existing token is REUSED
 * (explicit merge), rather than pretending two identities exist.
 *
 * Allocation discipline: a token is minted lazily, only when an external
 * write actually asks for the current batch. Claims, pending edges, and
 * finish edges on slots without tokens are integer/null checks.
 */

export type BatchToken = {
  /** True for transition-like batches: renders don't block paint and the
   * batch commits later. External stores fork pending state on these. */
  deferred: boolean,
  /** Debug only; stable across the token's life. */
  id: number,
};

type Slot = {
  token: BatchToken | null,
  /** Roots this batch has scheduled work on and not yet finished. */
  roots: Set<FiberRoot> | null,
};

// One slot per lane index (31 lanes).
const slots: Array<Slot | null> = new Array<Slot | null>(31).fill(null);
let nextTokenId = 1;

function slotFor(lane: Lane): Slot {
  const index = 31 - Math.clz32(lane);
  let slot = slots[index];
  if (slot === null) {
    slot = {token: null, roots: null};
    slots[index] = slot;
  }
  return slot;
}

/**
 * Returns the token for the batch an external write issued right now belongs
 * to, minting it on first use. `lane` is what requestUpdateLane would assign;
 * `isDeferred` classifies it (transition-like or not).
 */
export function getOrMintBatchToken(lane: Lane, isDeferred: boolean): BatchToken {
  const slot = slotFor(lane);
  if (slot.token === null) {
    slot.token = {deferred: isDeferred, id: nextTokenId++};
  }
  return slot.token;
}

/**
 * Pending edge. Called from the markRootUpdated wrapper on every scheduled
 * update; must be near-free when no token exists for the lane.
 */
export function batchRegistryOnRootUpdated(root: FiberRoot, lane: Lane): void {
  const slot = slots[31 - Math.clz32(lane)];
  if (slot === null || slot.token === null) {
    return;
  }
  if (slot.roots === null) {
    slot.roots = new Set();
  }
  slot.roots.add(root);
}

/**
 * Finish edge. Called after markRootFinished with the lanes still pending on
 * the root. A batch is done on a root when its lane is no longer pending
 * there — whether it committed normally or its updates died with deleted
 * fibers (React recomputes remaining lanes from the surviving tree, so
 * discarded work is *pruned*, never rendered). A token retires exactly once,
 * when its last pending root is done with it.
 *
 * Cost: iterates only slots holding live tokens (typically 0–2).
 */
export function batchRegistryOnRootFinished(
  root: FiberRoot,
  remainingLanes: Lanes,
): void {
  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index];
    if (slot === null || slot.token === null) {
      continue;
    }
    const lane = 1 << index;
    if ((remainingLanes & lane) !== 0) {
      continue; // still pending on this root
    }
    const roots = slot.roots;
    if (roots === null || !roots.has(root)) {
      continue; // this batch never had work on this root
    }
    roots.delete(root);
    if (roots.size === 0) {
      retireSlot(slot, true);
    }
  }
}

/**
 * Close edge: the scheduling microtask for the current event is done
 * (currentEventTransitionLane resets). A token whose batch never scheduled
 * React work on any root will never see a finish edge — retire it now.
 */
export function batchRegistryOnEventClosed(): void {
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (
      slot !== null &&
      slot.token !== null &&
      (slot.roots === null || slot.roots.size === 0)
    ) {
      retireSlot(slot, false);
    }
  }
}

function retireSlot(slot: Slot, committed: boolean): void {
  const token = slot.token;
  slot.token = null;
  slot.roots = null;
  if (token !== null) {
    const runtime = getExternalRuntime();
    if (runtime !== null && runtime.hasListeners) {
      runtime.emitBatchRetired(token, committed);
    }
  }
}

/** The live tokens for a render's lanes (identity of every included batch). */
export function batchTokensForLanes(lanes: Lanes): Array<BatchToken> {
  const tokens: Array<BatchToken> = [];
  let remaining = lanes;
  while (remaining !== 0) {
    const index = 31 - Math.clz32(remaining);
    remaining &= ~(1 << index);
    const slot = slots[index];
    if (slot !== null && slot.token !== null) {
      tokens.push(slot.token);
    }
  }
  return tokens;
}
