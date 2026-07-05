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

// ── Render lineage ids (cosignal spec §4.1 fact 5) ──────────────────────────
//
// A lineage id is stable per (root × batch-set): every pass on a root that
// renders the same set of batches — across restarts, replays, and Suspense
// retries — reports the same id, and the id dies when the set commits on
// that root or its work is abandoned (pruned). Consumers key Suspense
// thenable capsules on it (spec §5.8): a retry must find the capsule its
// suspended predecessor minted, and a pass over a DIFFERENT batch-set (a
// restart that picked up an extra batch, a pass after a spanning batch
// locked in) must not.
//
// The key is the pass's included token set (canonicalized) PLUS its
// render-time entangled lanes. Tokens alone under-determine the batch-set:
// a batch with no external writes never mints a token, and two unrelated
// token-free transitions must not share a lineage — their lanes tell them
// apart. Lanes alone under-determine it too: a root's later passes carry
// still-pending batches the root already committed (committedRoots lock-in)
// whose lanes are not render lanes on this root, and a pass before that
// lock-in is a different batch-set from a pass after it. Lane recycling
// cannot alias keys: reusing a live lane merges the batches (the registry's
// explicit merge rule — same set), and a retired lane's entries died with
// their set's commit or abandonment.
//
// Death: an entry dies at the first commit after which any of its lanes is
// no longer pending on the root — its set committed here (lanes finished),
// or its work was pruned (deletion resolved the lane), or a restart's
// superset pass committed it. A commit that leaves every lane pending (an
// unrelated batch's commit, or the mid-render re-pend split above) does not
// kill it: the set is still in flight and its retries still need their
// capsules. discardAllWip abandons passes, not batches — lanes stay
// pending, so lineages survive and the re-scheduled fresh passes report
// the same ids.
type LineageEntry = {id: number, lanes: Lanes};
const rootLineages: WeakMap<
  FiberRoot,
  Map<string, LineageEntry>,
> = new WeakMap();
let nextLineageId = 1;

/**
 * The lineage id for a pass on `root` rendering `lanes`, whose included
 * batches are `tokens` (as computed by batchTokensForRender). Mints on
 * first sight of the (root × batch-set); returns the existing id for every
 * later pass over the same set.
 */
export function lineageForRender(
  root: FiberRoot,
  lanes: Lanes,
  tokens: Array<BatchToken>,
): number {
  const entangledRenderLanes = getEntangledLanes(root, lanes);
  const key =
    tokens
      .slice()
      .sort((a, b) => a - b)
      .join(',') +
    '|' +
    entangledRenderLanes;
  let lineages = rootLineages.get(root);
  if (lineages === undefined) {
    lineages = new Map();
    rootLineages.set(root, lineages);
  }
  let entry = lineages.get(key);
  if (entry === undefined) {
    entry = {id: nextLineageId++, lanes: entangledRenderLanes};
    lineages.set(key, entry);
  }
  return entry.id;
}

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
 * The lane a LIVE token's batch occupies, or NoLane (0) when the token is
 * retired, unknown, or 0 ("no batch"). Used by runInBatch to resolve its
 * scheduling target: a token is live exactly while its slot still holds it,
 * including the window inside its retiring commit's onRootCommitted report
 * (retirement emits are deferred until after that report, so a write
 * delivered there lands on the outgoing token — the documented merge rule).
 */
export function lookupBatchTokenLane(token: BatchToken): Lane {
  if (token !== 0) {
    for (let index = 0; index < slots.length; index++) {
      const slot = slots[index];
      if (slot !== null && slot.token === token) {
        return (1 << index) as any;
      }
    }
  }
  return 0 as any; // NoLane
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
 * Finish edge. Called after markRootFinished with the lanes this commit's
 * pass rendered — the committed lanes expanded by their entanglements, the
 * same expansion the render consumed updates from — and the lanes still
 * pending on the root. A batch is done on a root when its lane is no longer
 * pending there. Its lane is in finishedLanes only when this commit rendered
 * its updates (directly or entangled); otherwise its updates died with
 * deleted fibers and were pruned from the surviving tree. A token retires
 * exactly once, when its last pending root is done with it.
 *
 * This edge is also the per-root commit report (spec §4.1 fact 3):
 * onRootCommitted fires on every commit with the root's new commit
 * generation and the batches this commit made visible on this root, BEFORE
 * any retirement the commit causes — a token retires because its last
 * pending root committed (or pruned) it, so the per-root report is the
 * cause and the retirement edge its consequence (spec case-11 step 6).
 * Listeners run between the bookkeeping mutation and the retirement emit;
 * a write issued inside an onRootCommitted listener for a lane retiring in
 * this very commit lands on the outgoing token (the registry's ordinary
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
 * Cost: iterates only slots holding live tokens (typically 0–2), plus one
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

  let committedTokens: Array<BatchToken> | null = null;
  let retirements: Array<{slot: Slot, committed: boolean}> | null = null;

  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index];
    if (slot === null) {
      continue;
    }
    const token = slot.token;
    if (token === null) {
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
        if (committedTokens === null) {
          committedTokens = [];
        }
        committedTokens.push(token);
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
      // the root's committed-batch delta, whether or not the token also
      // retires here.
      if (committedTokens === null) {
        committedTokens = [];
      }
      committedTokens.push(token);
    }
    roots.delete(root);
    if (roots.size === 0) {
      // Last pending root: the token retires at this commit — but emit the
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

  // Lineage death (see the lineage comment above): entries whose lanes are
  // no longer all pending on this root died with this commit — their set
  // committed here or was pruned. Runs unconditionally so death does not
  // depend on subscription timing; the map is empty until a pass was
  // observed.
  const lineages = rootLineages.get(root);
  if (lineages !== undefined && lineages.size > 0) {
    lineages.forEach((entry, key) => {
      if ((entry.lanes & remainingLanes) !== entry.lanes) {
        lineages.delete(key);
      }
    });
  }

  const runtime = getExternalRuntime();
  if (runtime !== null && runtime.hasListeners) {
    runtime.emitRootCommitted(
      root.containerInfo,
      committedTokens === null ? [] : committedTokens,
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
 * updates and must report both tokens, or a consumer resolving reads
 * against included-batches misses a write the tree visibly shows.
 */
export function batchTokensForRender(
  root: FiberRoot,
  lanes: Lanes,
): Array<BatchToken> {
  const tokens: Array<BatchToken> = [];
  const entangledRenderLanes = getEntangledLanes(root, lanes);
  let remaining = entangledRenderLanes;
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
      ((entangledRenderLanes >> i) & 1) === 0 // not already collected above
    ) {
      tokens.push(token);
    }
  }
  return tokens;
}
