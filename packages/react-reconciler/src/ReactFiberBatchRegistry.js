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

import {getExternalRuntime} from './ReactFiberExternalRuntime';
import {
  peekEntangledActionLane,
  peekEntangledActionThenable,
} from './ReactFiberAsyncAction';

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

/**
 * A batch token is a non-zero integer: `serial << 1 | deferredBit`, written
 * as `serial * 2 + deferredBit` so the serial is never truncated to 31 bits.
 * 0 is reserved for "no batch" (see getExternalRuntimeCurrentWriteBatch).
 *
 *   token & 1              — 1 for transition-like (deferred) batches:
 *                            renders don't block paint and the batch commits
 *                            later. External stores fork pending state on
 *                            these.
 *   (token - (token & 1))/2 — the mint serial (debug only; stable for the
 *                            token's life, never reused while live).
 */
export type BatchToken = number;

type Slot = {
  token: BatchToken | null,
  /** Roots this batch has scheduled work on and not yet finished. */
  roots: Set<FiberRoot> | null,
  /** Roots that already committed this batch while it stays pending on
   * others: renders on these roots must keep including the batch (their
   * committed tree already shows it) even though the token has not retired. */
  committedRoots: Set<FiberRoot> | null,
  /** Open async-action thenable this store-only batch is parked on: the
   * close edge must not retire it until the action settles. */
  parked: Thenable<void> | null,
};

// One slot per lane index (31 lanes).
const slots: Array<Slot | null> = new Array<Slot | null>(31).fill(null);
let nextTokenSerial = 1;

function slotFor(lane: Lane): Slot {
  const index = 31 - Math.clz32(lane);
  let slot = slots[index];
  if (slot === null) {
    slot = {token: null, roots: null, committedRoots: null, parked: null};
    slots[index] = slot;
  }
  return slot;
}

/**
 * Returns the token for the batch an external write issued right now belongs
 * to, minting it on first use. `lane` is what requestUpdateLane would assign;
 * `isDeferred` classifies it (transition-like or not).
 */
export function getOrMintBatchToken(
  lane: Lane,
  isDeferred: boolean,
): BatchToken {
  const slot = slotFor(lane);
  if (slot.token === null) {
    slot.token = nextTokenSerial++ * 2 + (isDeferred ? 1 : 0);
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
 * Pending-edge repair. The pending edge only records a root when the token
 * already exists, so an update scheduled BEFORE its batch's first store write
 * (`startTransition(() => { setState(x); store.write(y); })` — ordinary line
 * order) is invisible to the registry. Called from the root scheduler's
 * microtask for every root still holding work, before the close edge decides
 * a batch is store-only: any live token whose lane is pending on the root
 * records it, so the finish edge retires the batch at its real commit
 * instead of the close edge retiring it early.
 *
 * Cost per scheduled root: iterates only slots holding live tokens
 * (typically 0–2); Set.add is idempotent for roots already recorded.
 */
export function batchRegistryBackfillRoot(root: FiberRoot): void {
  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index];
    if (slot === null || slot.token === null) {
      continue;
    }
    if ((root.pendingLanes & (1 << index)) !== 0) {
      if (slot.roots === null) {
        slot.roots = new Set();
      }
      slot.roots.add(root);
    }
  }
}

/**
 * Finish edge. Called after markRootFinished with both the lanes in this
 * commit and the lanes still pending on the root. A batch is done on a root
 * when its lane is no longer pending there. Its lane is in finishedLanes only
 * when this commit rendered it; otherwise its updates died with deleted
 * fibers and were pruned from the surviving tree. A token retires exactly
 * once, when its last pending root is done with it.
 *
 * Cost: iterates only slots holding live tokens (typically 0–2).
 */
export function batchRegistryOnRootFinished(
  root: FiberRoot,
  finishedLanes: Lanes,
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
    const committed = (finishedLanes & lane) !== 0;
    roots.delete(root);
    if (roots.size === 0) {
      retireSlot(
        slot,
        committed ||
          (slot.committedRoots !== null && slot.committedRoots.size > 0),
      );
    } else if (committed) {
      // Committed here, still pending elsewhere: renders on this root must
      // keep including the batch until it fully retires (per-root lock-in).
      if (slot.committedRoots === null) {
        slot.committedRoots = new Set();
      }
      slot.committedRoots.add(root);
    }
  }
}

/**
 * Close edge: the scheduling microtask for the current event is done
 * (currentEventTransitionLane resets). A token whose batch never scheduled
 * React work on any root will never see a finish edge — retire it now.
 *
 * Exception: a store-only batch whose transition turned out to be an async
 * action (the scope returned a promise) must stay pending for the action's
 * whole life — the action's post-await updates commit later, and retiring at
 * event close would leak the batch's store writes into committed state
 * mid-action. Entanglement is only knowable after the scope returns, which
 * is before this microtask runs, so the check belongs exactly here: park the
 * slot on the action thenable and re-run the close decision when it settles.
 */
export function batchRegistryOnEventClosed(): void {
  const actionLane = peekEntangledActionLane();
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (
      slot === null ||
      slot.token === null ||
      slot.parked !== null ||
      (slot.roots !== null && slot.roots.size > 0)
    ) {
      continue;
    }
    if ((slot.token & 1) === 1 && 1 << i === actionLane) {
      const actionThenable = peekEntangledActionThenable();
      if (actionThenable !== null) {
        parkUntilActionSettles(slot, actionThenable);
        continue;
      }
    }
    retireSlot(slot, false);
  }
}

function parkUntilActionSettles(
  slot: Slot,
  actionThenable: Thenable<void>,
): void {
  slot.parked = actionThenable;
  const onSettle = () => {
    if (slot.parked !== actionThenable) {
      return;
    }
    slot.parked = null;
    // The action settled. If its updates scheduled React work under this
    // batch the finish edge owns retirement; a still store-only batch
    // retires now, converging with the action's outcome.
    if (slot.token !== null && (slot.roots === null || slot.roots.size === 0)) {
      retireSlot(slot, false);
    }
  };
  actionThenable.then(onSettle, onSettle);
}

function retireSlot(slot: Slot, committed: boolean): void {
  const token = slot.token;
  slot.token = null;
  slot.roots = null;
  slot.committedRoots = null;
  slot.parked = null;
  if (token !== null) {
    const runtime = getExternalRuntime();
    if (runtime !== null && runtime.hasListeners) {
      runtime.emitBatchRetired(token, committed);
    }
  }
}

/**
 * The batches a render pass on `root` includes: the live tokens for its
 * render lanes, plus every still-pending batch this root has ALREADY
 * committed — the root's committed tree shows those writes, so hiding them
 * from its later renders (urgent ones especially) would tear against its own
 * DOM while other roots finish the batch.
 */
export function batchTokensForRender(
  root: FiberRoot,
  lanes: Lanes,
): Array<BatchToken> {
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
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (slot === null) {
      continue;
    }
    const token = slot.token;
    if (
      token !== null &&
      slot.committedRoots !== null &&
      slot.committedRoots.has(root) &&
      ((lanes >> i) & 1) === 0 // not already collected via render lanes
    ) {
      tokens.push(token);
    }
  }
  return tokens;
}
