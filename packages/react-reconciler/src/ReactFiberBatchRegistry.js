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
import {getEntangledLanes} from './ReactFiberLane';
import {
  peekEntangledActionLane,
  peekEntangledActionThenable,
} from './ReactFiberAsyncAction';

/**
 * Batch ids: stable identities for "a batch of updates React renders and
 * retires as a unit", exposed to external state libraries in place of raw
 * lane bits (see ReactExternalRuntime.js).
 *
 * Why identities instead of bits: lane bits are recycled (the transition
 * cursor wraps after 10 claims), so a bit cannot name a batch across time.
 * The registry is EDGE-TRIGGERED from the places the reconciler already
 * mutates its own bookkeeping — never sampled — so a reused bit can never be
 * observed under a stale batch id:
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
 * together. The registry mirrors reality: the existing batch id is REUSED
 * (explicit merge), rather than pretending two identities exist.
 *
 * Allocation discipline: a batch id is created lazily, only when an external
 * write actually asks for the current batch. Claims, pending edges, and
 * finish edges on slots without ids are integer/null checks.
 *
 * WHO allocates the id (protocol v2): a registered BATCH-ID ALLOCATOR when
 * an external runtime has one (see registerExternalRuntimeBatchIdAllocator
 * in ReactExternalRuntime.js) — the external store hands out the id from its
 * own id space, so both sides speak ONE number space with no translation
 * maps — and this module's own fallback counter otherwise (stock usage and
 * driverless tests; the protocol keeps working without an allocator). The
 * id is opaque to React either way: a positive integer, stable for the
 * batch's life, never reused while live. Deferredness is NOT encoded in the
 * id (there is no low-bit payload); it is a stored field on the slot, told
 * to the allocator at creation.
 */

/**
 * A batch id is a positive integer naming one batch for its whole life.
 * BATCH_NONE (0) is reserved for "no batch" (see
 * getExternalRuntimeCurrentWriteBatch). The integer carries NO payload —
 * ids from a registered allocator are that allocator's serials, fallback
 * ids are this module's serials; consumers treat both as opaque.
 */
export type BatchId = number;

/** The reserved "no batch" id — never allocated, never stored in a slot. */
export const BATCH_NONE: BatchId = 0;

type Slot = {
  /** The live batch occupying this lane's slot, or null between batches
   * (retirement clears this field and keeps the Slot). */
  batchId: BatchId | null,
  /** True for transition-like batches: renders don't block paint and the
   * batch commits later. External stores fork pending state on these. Set
   * at batch-identity creation from the lane kind; meaningless (false)
   * while batchId is null. */
  deferred: boolean,
  /** The lane this slot serves — fixed at Slot creation (one persistent
   * Slot per lane). */
  lane: Lane,
  /** Roots this batch has scheduled work on and not yet finished. */
  roots: Set<FiberRoot> | null,
  /** Roots that already committed this batch while it stays pending on
   * others: renders on these roots must keep including the batch (their
   * committed tree already shows it) even though the batch has not retired. */
  committedRoots: Set<FiberRoot> | null,
  /** Open async-action thenable this store-only batch is parked on: the
   * close edge must not retire it until the action settles. */
  parked: Thenable<void> | null,
};

// One slot per lane index (31 lanes).
const slots: Array<Slot | null> = new Array<Slot | null>(31).fill(null);
// Fallback id source when no allocator is registered. Monotonic for the
// module's life — never reset, even by resetBatchRegistryForTest — so a
// stale id can never collide with a later batch.
let nextFallbackBatchId = 1;

// Per-root commit generation: how many times each root has committed.
// Maintained unconditionally (like the rest of the registry's bookkeeping)
// so the sequence does not depend on when a listener subscribed; delivered
// with every onRootCommitted event. Consumers use it to key per-root
// committed state (cosignal spec §4.2 baseline capture, §5.3 per-root
// committed-batch tables).
const rootCommitGenerations: WeakMap<FiberRoot, number> = new WeakMap();

// The RENDER-TIME entangled expansion of the pass most recently started on
// each root — exactly the lanes whose then-queued updates that pass
// consumed. Captured at the pass's fresh stack (see notifyRenderPassStart)
// and consumed by the finish edge, where it distinguishes a lane the
// committing pass really rendered (updates visible in the committed tree)
// from a lane the COMMIT-TIME expansion merely grew to include — e.g. a
// lane first entangled by an update that arrived while the pass was already
// rendering, whose updates are NOT in the committed tree.
const renderedLanesByRoot: WeakMap<FiberRoot, Lanes> = new WeakMap();

/**
 * Called (unconditionally — bookkeeping must not depend on listeners) when
 * a render pass starts on `root` with a fresh stack. `lanes` are the lanes
 * that named the render; the stash records their render-time entangled
 * expansion.
 */
export function batchRegistryOnRenderStart(
  root: FiberRoot,
  lanes: Lanes,
): void {
  renderedLanesByRoot.set(root, getEntangledLanes(root, lanes));
}

function slotFor(lane: Lane): Slot {
  const index = 31 - Math.clz32(lane);
  let slot = slots[index];
  if (slot === null) {
    slot = {
      batchId: null,
      deferred: false,
      lane,
      roots: null,
      committedRoots: null,
      parked: null,
    };
    slots[index] = slot;
  }
  return slot;
}

/**
 * Returns the id of the batch an external write issued right now belongs
 * to, creating the batch identity on first use — THE one creation site
 * (every classification arm of getCurrentWriteBatch funnels here). `lane`
 * is what requestUpdateLane would assign; `deferred` classifies it
 * (transition-like or not).
 *
 * Creation asks the registered batch-id allocator when one exists —
 * passing `deferred`, which is also how the allocator's owner learns each
 * batch's classification — and falls back to this module's own counter
 * otherwise. The allocator must return a positive integer never equal to a
 * currently live id; it is called at whatever position the write happens
 * (mid-render, mid-commit, inside listeners), so it must be re-entrant-safe
 * and allocation-only on its own side.
 */
export function getOrCreateBatchId(lane: Lane, deferred: boolean): BatchId {
  const slot = slotFor(lane);
  const existing = slot.batchId;
  if (existing !== null) {
    return existing;
  }
  const runtime = getExternalRuntime();
  const allocate = runtime !== null ? runtime.allocateBatchId : null;
  const batchId =
    allocate !== null ? allocate(deferred) : nextFallbackBatchId++;
  if (__DEV__) {
    if (!Number.isInteger(batchId) || batchId <= 0) {
      console.error(
        'The registered batch-id allocator returned %s. Batch ids must be ' +
          'positive integers (0 is reserved for "no batch").',
        batchId,
      );
    }
  }
  slot.batchId = batchId;
  slot.deferred = deferred;
  return batchId;
}

/**
 * The slot a LIVE batch occupies (its lane and deferred flag), or null when
 * the id is retired, unknown, or BATCH_NONE. Used by runInBatch to resolve
 * its scheduling target: a batch is live exactly while its slot still holds
 * its id, including the window inside its retiring commit's onRootCommitted
 * report (retirement emits are deferred until after that report, so a write
 * delivered there lands on the outgoing batch — the documented merge rule).
 */
export function lookupLiveBatchSlot(
  batchId: BatchId,
): null | {+lane: Lane, +deferred: boolean, ...} {
  if (batchId !== BATCH_NONE) {
    for (let index = 0; index < slots.length; index++) {
      const slot = slots[index];
      if (slot !== null && slot.batchId === batchId) {
        return slot;
      }
    }
  }
  return null;
}

/**
 * Pending edge. Called from the markRootUpdated wrapper on every scheduled
 * update; must be near-free when no batch id exists for the lane.
 */
export function batchRegistryOnRootUpdated(root: FiberRoot, lane: Lane): void {
  const slot = slots[31 - Math.clz32(lane)];
  if (slot === null || slot.batchId === null) {
    return;
  }
  if (slot.roots === null) {
    slot.roots = new Set();
  }
  slot.roots.add(root);
}

/**
 * Pending-edge repair. The pending edge only records a root when the batch
 * id already exists, so an update scheduled BEFORE its batch's first store
 * write (`startTransition(() => { setState(x); store.write(y); })` —
 * ordinary line order) is invisible to the registry. Called from the root
 * scheduler's microtask for every root still holding work, before the close
 * edge decides a batch is store-only: any live batch whose lane is pending
 * on the root records it, so the finish edge retires the batch at its real
 * commit instead of the close edge retiring it early.
 *
 * Cost per scheduled root: iterates only slots holding live batches
 * (typically 0–2); Set.add is idempotent for roots already recorded.
 */
export function batchRegistryBackfillRoot(root: FiberRoot): void {
  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index];
    if (slot === null || slot.batchId === null) {
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
 * Finish edge. Called after markRootFinished with the lanes this commit's
 * pass rendered — the committed lanes expanded by their entanglements, the
 * same expansion the render consumed updates from — and the lanes still
 * pending on the root. A batch is done on a root when its lane is no longer
 * pending there. Its lane is in finishedLanes only when this commit rendered
 * its updates (directly or entangled); otherwise its updates died with
 * deleted fibers and were pruned from the surviving tree. A batch retires
 * exactly once, when its last pending root is done with it.
 *
 * This edge is also the per-root commit report (spec §4.1 fact 3):
 * onRootCommitted fires on every commit with the root's new commit
 * generation and the batches this commit made visible on this root, BEFORE
 * any retirement the commit causes — a batch retires because its last
 * pending root committed (or pruned) it, so the per-root report is the
 * cause and the retirement edge its consequence (spec case-11 step 6).
 * Listeners run between the bookkeeping mutation and the retirement emit;
 * a write issued inside an onRootCommitted listener for a lane retiring in
 * this very commit lands on the outgoing batch (the registry's ordinary
 * merge-on-lane-reuse rule already covers reused lanes, and the retirement
 * edge still fires exactly once, after).
 *
 * `rependedLanes` are lanes holding NEW updates that arrived while the
 * committing pass was rendering (or waiting to commit): a lane can be in
 * `remainingLanes` either because this commit did not touch its batch, or
 * because the pass rendered the batch's updates and fresh ones re-pended
 * the lane (a mid-render runInBatch delivery, or the merge rule reusing a
 * live lane). The second case is a real committed-view advance on this
 * root — the committed tree shows the writes the pass rendered — so it is
 * reported and locked in (committedRoots) while the batch stays pending;
 * the follow-up commit that lands the newer updates reports the batch on
 * this root again. Requiring the lane in the RENDER-TIME expansion keeps
 * lanes that merely got entangled mid-flight (updates not in this tree)
 * out of the report.
 *
 * Cost: iterates only slots holding live batches (typically 0–2), plus one
 * WeakMap bump per commit.
 */
export function batchRegistryOnRootFinished(
  root: FiberRoot,
  finishedLanes: Lanes,
  remainingLanes: Lanes,
  rependedLanes: Lanes,
): void {
  const previousGeneration = rootCommitGenerations.get(root);
  const generation =
    previousGeneration === undefined ? 1 : previousGeneration + 1;
  rootCommitGenerations.set(root, generation);

  const renderedLanesStash = renderedLanesByRoot.get(root);
  const renderedLanes =
    renderedLanesStash === undefined
      ? // No recorded pass start for this commit (exotic path): fall back
        // to the commit-time expansion, which can only over-approximate.
        finishedLanes
      : renderedLanesStash;

  let committedBatchIds: Array<BatchId> | null = null;
  let retirements: Array<{slot: Slot, committed: boolean}> | null = null;

  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index];
    if (slot === null) {
      continue;
    }
    const batchId = slot.batchId;
    if (batchId === null) {
      continue;
    }
    const lane = 1 << index;
    const roots = slot.roots;
    if ((remainingLanes & lane) !== 0) {
      // Still pending on this root — untouched by this commit, UNLESS the
      // committing pass rendered the batch's updates and only newer,
      // re-pending updates keep the lane alive: then this commit advanced
      // the root's committed view by those rendered writes. Report it and
      // lock the batch into this root's later passes; it does not finish
      // here.
      if (
        (rependedLanes & lane) !== 0 &&
        (finishedLanes & lane) !== 0 &&
        (renderedLanes & lane) !== 0 &&
        roots !== null &&
        roots.has(root)
      ) {
        if (committedBatchIds === null) {
          committedBatchIds = [];
        }
        committedBatchIds.push(batchId);
        if (slot.committedRoots === null) {
          slot.committedRoots = new Set();
        }
        slot.committedRoots.add(root);
      }
      continue;
    }
    if (roots === null || !roots.has(root)) {
      continue; // this batch never had work on this root
    }
    const committed = (finishedLanes & lane) !== 0;
    if (committed) {
      // This commit made the batch's updates visible on this root: part of
      // the root's committed-batch delta, whether or not the batch also
      // retires here.
      if (committedBatchIds === null) {
        committedBatchIds = [];
      }
      committedBatchIds.push(batchId);
    }
    roots.delete(root);
    if (roots.size === 0) {
      // Last pending root: the batch retires at this commit — but emit the
      // per-root commit report first (see the function comment).
      if (retirements === null) {
        retirements = [];
      }
      retirements.push({
        slot,
        committed:
          committed ||
          (slot.committedRoots !== null && slot.committedRoots.size > 0),
      });
    } else if (committed) {
      // Committed here, still pending elsewhere: renders on this root must
      // keep including the batch until it fully retires (per-root lock-in).
      if (slot.committedRoots === null) {
        slot.committedRoots = new Set();
      }
      slot.committedRoots.add(root);
    }
  }

  // The stash described the pass this commit landed; it is consumed.
  renderedLanesByRoot.delete(root);

  const runtime = getExternalRuntime();
  if (runtime !== null && runtime.hasListeners) {
    runtime.emitRootCommitted(
      root.containerInfo,
      committedBatchIds === null ? [] : committedBatchIds,
      generation,
    );
  }

  if (retirements !== null) {
    for (let i = 0; i < retirements.length; i++) {
      retireSlot(retirements[i].slot, retirements[i].committed);
    }
  }
}

/**
 * Close edge: the scheduling microtask for the current event is done
 * (currentEventTransitionLane resets). A batch that never scheduled React
 * work on any root will never see a finish edge — retire it now.
 *
 * Exception: a store-only DEFERRED batch whose transition turned out to be
 * an async action (the scope returned a promise) must stay pending for the
 * action's whole life — the action's post-await updates commit later, and
 * retiring at event close would leak the batch's store writes into
 * committed state mid-action. Entanglement is only knowable after the scope
 * returns, which is before this microtask runs, so the check belongs
 * exactly here: park the slot on the action thenable and re-run the close
 * decision when it settles.
 */
export function batchRegistryOnEventClosed(): void {
  const actionLane = peekEntangledActionLane();
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (
      slot === null ||
      slot.batchId === null ||
      slot.parked !== null ||
      (slot.roots !== null && slot.roots.size > 0)
    ) {
      continue;
    }
    if (slot.deferred && 1 << i === actionLane) {
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
  // Self-invalidation: the callback captures the batch id it parked for and
  // no-ops if the slot's tenancy changed by the time the action settles —
  // whether because a test reset scrubbed the slot (resetBatchRegistryForTest)
  // or because retirement and a fresh claim recycled the lane. Without the
  // id check, a stale settlement could retire an unrelated successor batch.
  const parkedBatchId = slot.batchId;
  const onSettle = () => {
    if (slot.parked !== actionThenable || slot.batchId !== parkedBatchId) {
      return;
    }
    slot.parked = null;
    // The action settled. If its updates scheduled React work under this
    // batch the finish edge owns retirement; a still store-only batch
    // retires now, converging with the action's outcome.
    if (
      slot.batchId !== null &&
      (slot.roots === null || slot.roots.size === 0)
    ) {
      retireSlot(slot, false);
    }
  };
  actionThenable.then(onSettle, onSettle);
}

function retireSlot(slot: Slot, committed: boolean): void {
  const batchId = slot.batchId;
  slot.batchId = null;
  slot.deferred = false;
  slot.roots = null;
  slot.committedRoots = null;
  slot.parked = null;
  if (batchId !== null) {
    const runtime = getExternalRuntime();
    if (runtime !== null && runtime.hasListeners) {
      runtime.emitBatchRetired(batchId, committed);
    }
  }
}

/**
 * TEST-ONLY. Clears the FULL tenancy of every slot — batch id, deferred
 * flag, root sets, committed-root sets, parked state — without emitting
 * retirement events (this is a scrub, not a batch outcome). Test harnesses
 * call it between tests so a stale slot from one test can never claim,
 * merge with, or settle over a batch of the next (external allocators may
 * restart their id space per test; a parked settlement that fires late
 * additionally no-ops via its captured batch id). Never call this in
 * production: live batches lose their retirement edge.
 *
 * The fallback id counter is NOT reset: fallback ids stay monotonic for the
 * module's life, mirroring the allocator-side rule that batch ids are
 * monotonic across engine resets.
 */
export function resetBatchRegistryForTest(): void {
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (slot === null) {
      continue;
    }
    slot.batchId = null;
    slot.deferred = false;
    slot.roots = null;
    slot.committedRoots = null;
    slot.parked = null;
  }
}

/**
 * The batches a render pass on `root` includes: the live batch ids for its
 * ENTANGLED render lanes, plus every still-pending batch this root has
 * ALREADY committed — the root's committed tree shows those writes, so
 * hiding them from its later renders (urgent ones especially) would tear
 * against its own DOM while other roots finish the batch.
 *
 * Entangled expansion: the pass consumes updates from
 * getEntangledLanes(root, lanes) — the same expansion prepareFreshStack
 * assigns to entangledRenderLanes — not just from the lanes that named the
 * render. E.g. under enableParallelTransitions (www) a sibling transition
 * renders on its own lane, but a second transition writing through a shared
 * hook queue entangles with the first: the pass renders BOTH batches'
 * updates and must report both ids, or a consumer resolving reads against
 * included-batches misses a write the tree visibly shows.
 */
export function batchIdsForRender(
  root: FiberRoot,
  lanes: Lanes,
): Array<BatchId> {
  const batchIds: Array<BatchId> = [];
  const entangledRenderLanes = getEntangledLanes(root, lanes);
  let remaining = entangledRenderLanes;
  while (remaining !== 0) {
    const index = 31 - Math.clz32(remaining);
    remaining &= ~(1 << index);
    const slot = slots[index];
    if (slot !== null && slot.batchId !== null) {
      batchIds.push(slot.batchId);
    }
  }
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (slot === null) {
      continue;
    }
    const batchId = slot.batchId;
    if (
      batchId !== null &&
      slot.committedRoots !== null &&
      slot.committedRoots.has(root) &&
      ((entangledRenderLanes >> i) & 1) === 0 // not already collected above
    ) {
      batchIds.push(batchId);
    }
  }
  return batchIds;
}
