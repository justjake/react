/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 * @jest-environment node
 */

/**
 * Reconciler-level tests for the external-runtime batch-id protocol
 * (ReactFiberBatchRegistry + ReactFiberExternalRuntime). These run against
 * React source with the noop renderer, so the protocol can be validated —
 * including mid-render, via time slicing — without any consumer library.
 * The consumer-side contract lives in cosignal's patch-contract tests.
 *
 * Batch ids come from a registered allocator when a test installs one
 * (installAllocator below — the stand-in for an external store, and the
 * only way a consumer observes each batch's deferred classification, told
 * to the allocator at creation) and from the registry's own fallback
 * counter otherwise (the driverless mode, pinned explicitly).
 */

'use strict';

let React;
let ReactNoop;
let Scheduler;
let useState;
let startTransition;
let act;
let assertLog;

describe('ReactFiberBatchRegistry', () => {
  beforeEach(() => {
    jest.resetModules();
    React = require('react');
    ReactNoop = require('react-noop-renderer');
    Scheduler = require('scheduler');
    useState = React.useState;
    startTransition = React.startTransition;

    const InternalTestUtils = require('internal-test-utils');
    act = InternalTestUtils.act;
    assertLog = InternalTestUtils.assertLog;
  });

  function Text({text}) {
    Scheduler.log(text);
    return text;
  }

  function subscribe() {
    const events = {passes: [], retired: []};
    const unsubscribe = React.unstable_subscribeToExternalRuntime({
      onRenderPassStart(container, includedBatches) {
        events.passes.push({container, included: includedBatches.slice()});
      },
      onBatchRetired(batchId, committed) {
        events.retired.push({batchId, committed});
      },
    });
    return {events, unsubscribe};
  }

  // Registers a batch-id allocator standing in for an external store: ids
  // from its own serial space (offset so a fallback-counter id can never be
  // mistaken for an allocated one), each id's deferred classification
  // recorded at creation — the allocator argument is the protocol's one
  // deferredness exposure.
  function installAllocator() {
    const allocated = new Map(); // batchId -> deferred
    let nextId = 101;
    const unregister = React.unstable_registerBatchIdAllocator(deferred => {
      const batchId = nextId++;
      allocated.set(batchId, deferred);
      return batchId;
    });
    return {
      allocated,
      deferredOf(batchId) {
        if (!allocated.has(batchId)) {
          throw new Error(
            `batch id ${batchId} was not allocated by this allocator`,
          );
        }
        return allocated.get(batchId);
      },
      unregister,
    };
  }

  it('creates one batch id per batch: stable within a transition scope, distinct across events', async () => {
    const {events, unsubscribe} = subscribe();
    const alloc = installAllocator();
    let t1a = null;
    let t1b = null;
    let t2 = null;
    await act(() => {
      startTransition(() => {
        t1a = React.unstable_getCurrentWriteBatch();
        t1b = React.unstable_getCurrentWriteBatch();
      });
    });
    await act(() => {
      startTransition(() => {
        t2 = React.unstable_getCurrentWriteBatch();
      });
    });
    expect(t1a).toBe(t1b);
    // Batch ids are the allocator's own positive integers; deferredness is
    // not encoded in the id — it was told to the allocator at creation.
    expect(Number.isInteger(t1a)).toBe(true);
    expect(t1a).toBeGreaterThan(0);
    expect(alloc.deferredOf(t1a)).toBe(true);
    expect(t2).not.toBe(t1a);
    // Exactly the two ids the allocator handed out, in creation order.
    expect(Array.from(alloc.allocated.keys())).toEqual([t1a, t2]);
    // Both store-only batches retired uncommitted at their event close.
    expect(events.retired.map(r => r.batchId)).toEqual([t1a, t2]);
    expect(events.retired.every(r => r.committed === false)).toBe(true);
    alloc.unregister();
    unsubscribe();
  });

  it('a transition that renders and commits retires exactly once, committed', async () => {
    const {events, unsubscribe} = subscribe();
    let setValue;
    function App() {
      const [value, _setValue] = useState(0);
      setValue = _setValue;
      return <Text text={`v=${value}`} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => {
      root.render(<App />);
    });
    assertLog(['v=0']);

    let batchId = null;
    await act(() => {
      startTransition(() => {
        batchId = React.unstable_getCurrentWriteBatch();
        setValue(1);
      });
    });
    assertLog(['v=1']);
    expect(events.retired.filter(r => r.batchId === batchId)).toEqual([
      {batchId, committed: true},
    ]);
    unsubscribe();
  });

  it('retires at commit when React work was scheduled before the batchId was minted', async () => {
    // Ordinary line order inside one transition: setState first, store write
    // second. The pending edge misses the setState (no batchId existed yet);
    // the root scheduler's back-fill repairs it before the close edge, so
    // the batch retires committed at its real commit, not early at event
    // close as "store-only".
    const {events, unsubscribe} = subscribe();
    let setValue;
    function App() {
      const [value, _setValue] = useState(0);
      setValue = _setValue;
      return <Text text={`v=${value}`} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => {
      root.render(<App />);
    });
    assertLog(['v=0']);

    let batchId = null;
    await act(() => {
      startTransition(() => {
        setValue(1); // React work FIRST
        batchId = React.unstable_getCurrentWriteBatch(); // minted after
      });
    });
    assertLog(['v=1']);
    expect(events.retired.filter(r => r.batchId === batchId)).toEqual([
      {batchId, committed: true},
    ]);
    unsubscribe();
  });

  it('render passes report included batches; interrupting urgent renders exclude pending transitions', async () => {
    const {events, unsubscribe} = subscribe();
    const alloc = installAllocator();
    let setUrgent;
    let setValue;
    function App() {
      const [urgent, _setUrgent] = useState(0);
      const [value, _setValue] = useState(0);
      setUrgent = _setUrgent;
      setValue = _setValue;
      return <Text text={`u=${urgent} v=${value}`} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => {
      root.render(<App />);
    });
    assertLog(['u=0 v=0']);

    let batchId = null;
    let urgentBatchId = null;
    await act(async () => {
      startTransition(() => {
        batchId = React.unstable_getCurrentWriteBatch();
        setValue(1);
      });
      // Interrupt with an urgent update before the transition commits.
      urgentBatchId = React.unstable_getCurrentWriteBatch();
      setUrgent(1);
    });
    assertLog(['u=1 v=0', 'u=1 v=1']);
    // Urgent batches were created non-deferred; transition batches deferred.
    expect(alloc.deferredOf(urgentBatchId)).toBe(false);
    expect(alloc.deferredOf(batchId)).toBe(true);
    // No pass includes both batches; the urgent pass excludes the pending
    // transition, and the transition's own pass includes it.
    const mixed = events.passes.filter(
      p => p.included.includes(batchId) && p.included.includes(urgentBatchId),
    );
    expect(mixed).toEqual([]);
    expect(
      events.passes.some(
        p =>
          p.included.includes(urgentBatchId) && !p.included.includes(batchId),
      ),
    ).toBe(true);
    expect(events.passes.some(p => p.included.includes(batchId))).toBe(true);
    unsubscribe();
  });

  // Spec test 1: writes inside a discrete event handler classify urgent —
  // a batch of their own, distinct from the same event's ambient default
  // batch, committing and retiring like any other.
  it('classifies discrete-event writes urgent, distinct from the ambient default batch', async () => {
    const {events, unsubscribe} = subscribe();
    const alloc = installAllocator();
    let setValue;
    function App() {
      const [value, _setValue] = useState(0);
      setValue = _setValue;
      return <Text text={`v=${value}`} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => {
      root.render(<App />);
    });
    assertLog(['v=0']);

    let discreteBatchId = null;
    let defaultBatchId = null;
    await act(() => {
      ReactNoop.discreteUpdates(() => {
        discreteBatchId = React.unstable_getCurrentWriteBatch();
        setValue(1);
      });
      // The same event, outside the discrete handler: the ambient default
      // batch — a different lane, a different batchId.
      defaultBatchId = React.unstable_getCurrentWriteBatch();
    });
    assertLog(['v=1']);
    expect(alloc.deferredOf(discreteBatchId)).toBe(false);
    expect(alloc.deferredOf(defaultBatchId)).toBe(false);
    expect(defaultBatchId).not.toBe(discreteBatchId);
    expect(events.retired.filter(r => r.batchId === discreteBatchId)).toEqual([
      {batchId: discreteBatchId, committed: true},
    ]);
    unsubscribe();
  });

  // Spec test 3: a write with no scope at all — a timer or network callback
  // — classifies as the ambient default batch: urgent (not deferred), its
  // own batch id, retiring uncommitted when it schedules nothing.
  it('classifies timer/network (ambient) writes as the default batch', async () => {
    const {events, unsubscribe} = subscribe();
    const alloc = installAllocator();
    let ambientBatchId = null;
    await act(() => {
      // act's callback runs like a timer callback: no event, no transition.
      ambientBatchId = React.unstable_getCurrentWriteBatch();
    });
    expect(alloc.deferredOf(ambientBatchId)).toBe(false);
    // Store-only ambient batch: retires uncommitted at its close edge.
    expect(events.retired).toEqual([
      {batchId: ambientBatchId, committed: false},
    ]);
    unsubscribe();
  });

  // Spec test 4: writes inside flushSync classify urgent into the sync
  // batch, which commits synchronously and retires committed.
  it('classifies flushSync writes urgent; the batch commits synchronously', async () => {
    const {events, unsubscribe} = subscribe();
    const alloc = installAllocator();
    let setValue;
    function App() {
      const [value, _setValue] = useState(0);
      setValue = _setValue;
      return <Text text={`v=${value}`} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => {
      root.render(<App />);
    });
    assertLog(['v=0']);

    let batchId = null;
    ReactNoop.flushSync(() => {
      batchId = React.unstable_getCurrentWriteBatch();
      setValue(1);
    });
    // Committed synchronously: the log is already there, no act needed.
    assertLog(['v=1']);
    expect(alloc.deferredOf(batchId)).toBe(false);
    expect(events.retired.filter(r => r.batchId === batchId)).toEqual([
      {batchId, committed: true},
    ]);
    unsubscribe();
  });

  // Spec test 5: nested scopes classify per-callstack. A transition inside
  // a discrete handler is deferred while the handler around it stays
  // urgent; a discrete scope inside a transition is urgent while the
  // transition around it stays deferred.
  it('classifies nested scopes per callstack: transition-in-event and event-in-transition', async () => {
    const {unsubscribe} = subscribe();
    const alloc = installAllocator();
    const probes = {};
    await act(() => {
      ReactNoop.discreteUpdates(() => {
        probes.handlerBefore = React.unstable_getCurrentWriteBatch();
        startTransition(() => {
          probes.transitionInHandler = React.unstable_getCurrentWriteBatch();
        });
        probes.handlerAfter = React.unstable_getCurrentWriteBatch();
      });
    });
    expect(alloc.deferredOf(probes.transitionInHandler)).toBe(true);
    expect(alloc.deferredOf(probes.handlerBefore)).toBe(false);
    // The handler's own classification is untouched by the nested scope.
    expect(probes.handlerAfter).toBe(probes.handlerBefore);
    expect(probes.transitionInHandler).not.toBe(probes.handlerBefore);

    await act(() => {
      startTransition(() => {
        probes.scopeBefore = React.unstable_getCurrentWriteBatch();
        ReactNoop.discreteUpdates(() => {
          probes.eventInScope = React.unstable_getCurrentWriteBatch();
        });
        probes.scopeAfter = React.unstable_getCurrentWriteBatch();
      });
    });
    expect(alloc.deferredOf(probes.eventInScope)).toBe(false);
    expect(alloc.deferredOf(probes.scopeBefore)).toBe(true);
    expect(probes.scopeAfter).toBe(probes.scopeBefore);
    expect(probes.eventInScope).not.toBe(probes.scopeBefore);
    unsubscribe();
  });

  // Spec test 6: the fork side of the library's engine-batch contract —
  // classification is PER WRITE, at write time. Writes interleaved across
  // scopes within one event each get their scope's batch id, stably: an
  // engine batch() that defers delivery can replay each write against the
  // context it was captured with.
  it('preserves per-write context across interleaved scopes in one event', async () => {
    const {unsubscribe} = subscribe();
    const alloc = installAllocator();
    let u1 = null;
    let u2 = null;
    let t1 = null;
    let t2 = null;
    await act(() => {
      u1 = React.unstable_getCurrentWriteBatch();
      startTransition(() => {
        t1 = React.unstable_getCurrentWriteBatch();
      });
      u2 = React.unstable_getCurrentWriteBatch();
      // A second transition scope in the same event joins the same
      // transition batch (same-event transitions share their lane).
      startTransition(() => {
        t2 = React.unstable_getCurrentWriteBatch();
      });
    });
    expect(u2).toBe(u1);
    expect(t2).toBe(t1);
    expect(t1).not.toBe(u1);
    expect(alloc.deferredOf(u1)).toBe(false);
    expect(alloc.deferredOf(t1)).toBe(true);
    unsubscribe();
  });

  it('parks a store-only async action until the action settles', async () => {
    const {events, unsubscribe} = subscribe();
    const alloc = installAllocator();
    let resolveGate;
    const gate = new Promise(resolve => {
      resolveGate = resolve;
    });
    let batchId = null;
    startTransition(async () => {
      batchId = React.unstable_getCurrentWriteBatch();
      await gate;
    });
    // Let the event's scheduling microtask (the close edge) run.
    await act(() => {});
    expect(alloc.deferredOf(batchId)).toBe(true);
    expect(events.retired.map(r => r.batchId)).not.toContain(batchId);

    resolveGate();
    await act(() => gate);
    expect(events.retired.filter(r => r.batchId === batchId)).toEqual([
      {batchId, committed: false},
    ]);
    unsubscribe();
  });

  // Appendix B flag 3, pinned: while an async action is pending, a
  // re-wrapped continuation (a startTransition after the await) claims the
  // action's lane — requestTransitionLane consults the entangled action
  // lane — so it lands in the same slot and gets the SAME batch id: the
  // parked action's id IS the re-wrap id (the registry's documented
  // explicit-merge rule). A bare (un-wrapped) continuation reports no
  // transition and classifies as the ambient default batch instead.
  it('a re-wrapped async-action continuation joins the parked batch; a bare one is ambient', async () => {
    const {events, unsubscribe} = subscribe();
    const alloc = installAllocator();
    let resolveGate;
    const gate = new Promise(resolve => {
      resolveGate = resolve;
    });
    let batchIdBefore = null;
    let bareBatchId = null;
    let rewrapBatchId = null;
    startTransition(async () => {
      batchIdBefore = React.unstable_getCurrentWriteBatch();
      await gate;
      // The bare continuation: no transition scope survives an await.
      bareBatchId = React.unstable_getCurrentWriteBatch();
      // The re-wrapped continuation: a fresh startTransition while the
      // action scope is still pending.
      startTransition(() => {
        rewrapBatchId = React.unstable_getCurrentWriteBatch();
      });
    });
    // The close edge parks the store-only action batch instead of retiring.
    await act(() => {});
    expect(alloc.deferredOf(batchIdBefore)).toBe(true);
    expect(events.retired.map(r => r.batchId)).not.toContain(batchIdBefore);

    resolveGate();
    await act(() => gate);
    // THE PIN: same lane ⇒ same slot ⇒ same batch id.
    expect(rewrapBatchId).toBe(batchIdBefore);
    // The bare continuation was ambient: urgent classification, a distinct
    // default-lane batch id.
    expect(alloc.deferredOf(bareBatchId)).toBe(false);
    expect(bareBatchId).not.toBe(batchIdBefore);
    // Still store-only when the action settled: retired exactly once,
    // uncommitted — the re-wrap did not double-retire or resurrect it.
    expect(events.retired.filter(r => r.batchId === batchIdBefore)).toEqual([
      {batchId: batchIdBefore, committed: false},
    ]);
    unsubscribe();
  });

  it('locks a committed batch into later renders on that root while other roots are pending', async () => {
    const {events, unsubscribe} = subscribe();
    let resolveGate;
    const gate = new Promise(resolve => {
      resolveGate = resolve;
    });
    let setA;
    let bumpA;
    let setB;
    function CompA() {
      const [on, _set] = useState(false);
      const [n, _setN] = useState(0);
      setA = _set;
      bumpA = _setN;
      return <Text text={`A on=${on} n=${n}`} />;
    }
    function CompB() {
      const [on, _set] = useState(false);
      setB = _set;
      if (on) {
        React.use(gate); // suspends the transition render on root B
      }
      return <Text text={`B on=${on}`} />;
    }
    const rootA = ReactNoop.createRoot();
    await act(() => {
      rootA.render(<CompA />);
    });
    assertLog(['A on=false n=0']);
    const containerA = events.passes[events.passes.length - 1].container;
    const rootB = ReactNoop.createRoot();
    await act(() => {
      rootB.render(<CompB />);
    });
    assertLog(['B on=false']);

    let batchId = null;
    await act(() => {
      startTransition(() => {
        batchId = React.unstable_getCurrentWriteBatch();
        setA(true);
        setB(true);
      });
    });
    // Root A committed the batch; root B is suspended on the gate, so the
    // batchId must not retire yet.
    assertLog(['A on=true n=0']);
    expect(events.retired.map(r => r.batchId)).not.toContain(batchId);

    // A later urgent render on root A includes the committed-but-unretired
    // batch (root A's committed tree already shows it).
    events.passes.length = 0;
    await act(() => {
      bumpA(1);
    });
    assertLog(['A on=true n=1']);
    const aPasses = events.passes.filter(p => p.container === containerA);
    expect(aPasses.length).toBeGreaterThan(0);
    expect(aPasses.every(p => p.included.includes(batchId))).toBe(true);

    // Root B settles: the batch commits everywhere and retires exactly once.
    resolveGate();
    await act(() => gate);
    assertLog(['B on=true']);
    expect(events.retired.filter(r => r.batchId === batchId)).toEqual([
      {batchId, committed: true},
    ]);
    unsubscribe();
  });

  // Protocol v2: with no registered allocator (stock usage), the registry
  // numbers batches from its own fallback counter — the protocol keeps
  // working driverless, with the same close-edge retirement.
  it('works driverless: without an allocator, ids come from the fallback counter', async () => {
    const {events, unsubscribe} = subscribe();
    let t = null;
    let u = null;
    await act(() => {
      startTransition(() => {
        t = React.unstable_getCurrentWriteBatch();
      });
      u = React.unstable_getCurrentWriteBatch();
    });
    expect(Number.isInteger(t)).toBe(true);
    expect(t).toBeGreaterThan(0);
    expect(Number.isInteger(u)).toBe(true);
    expect(u).toBeGreaterThan(0);
    expect(u).not.toBe(t);
    // Both store-only batches retired at the close edge, exactly as with a
    // registered allocator.
    expect(new Set(events.retired.map(r => r.batchId))).toEqual(
      new Set([t, u]),
    );
    expect(events.retired.every(r => r.committed === false)).toBe(true);
    unsubscribe();
  });

  // Protocol v2: batch ids are ONE number space owned by one allocator — a
  // second registration throws; unregistering frees the slot.
  it('a second allocator registration throws; unregistering frees the slot', () => {
    const unregister = React.unstable_registerBatchIdAllocator(() => 1);
    expect(() => React.unstable_registerBatchIdAllocator(() => 2)).toThrow(
      /already registered/,
    );
    unregister();
    const unregister2 = React.unstable_registerBatchIdAllocator(() => 3);
    unregister2();
  });

  // Protocol v2 test seam: the reset hook clears the FULL slot tenancy, so
  // the next same-lane write creates a FRESH batch identity instead of
  // merging with the scrubbed one — and the scrub emits no retirement (it
  // is a test-boundary scrub, not a batch outcome).
  it('resetBatchRegistryForTest clears tenancy: fresh id after reset, no retirement for the scrubbed batch', async () => {
    const {events, unsubscribe} = subscribe();
    const alloc = installAllocator();
    let before = null;
    let after = null;
    await act(() => {
      startTransition(() => {
        before = React.unstable_getCurrentWriteBatch();
        // Same scope, same lane: the ordinary merge rule returns the same id…
        expect(React.unstable_getCurrentWriteBatch()).toBe(before);
        React.unstable_resetBatchRegistryForTest();
        // …but after the scrub the slot is empty, so a fresh identity is
        // created (through the allocator again).
        after = React.unstable_getCurrentWriteBatch();
      });
    });
    expect(after).not.toBe(before);
    expect(alloc.deferredOf(after)).toBe(true);
    // Only the successor retires (ordinary close edge); the scrubbed batch
    // lost its retirement edge with its tenancy.
    expect(events.retired.map(r => r.batchId)).toEqual([after]);
    alloc.unregister();
    unsubscribe();
  });

  // Protocol v2 test seam: a parked settlement callback captures its batch
  // id and no-ops if the slot's tenancy changed by the time the action
  // settles. The dangerous shape: after a mid-action reset, a new
  // transition re-claims the action's entangled lane and re-parks on the
  // SAME action thenable — the stale callback sees the very thenable it
  // captured and only the id check stops it from retiring the successor.
  it('a parked settlement callback self-invalidates across a registry reset', async () => {
    const {events, unsubscribe} = subscribe();
    const alloc = installAllocator();
    let resolveGate;
    const gate = new Promise(resolve => {
      resolveGate = resolve;
    });
    let before = null;
    startTransition(async () => {
      before = React.unstable_getCurrentWriteBatch();
      await gate;
    });
    // Close edge: the store-only action batch parks instead of retiring.
    await act(() => {});
    expect(events.retired.map(r => r.batchId)).not.toContain(before);

    // Test-boundary scrub while the action is still pending.
    React.unstable_resetBatchRegistryForTest();

    // A transition while the action pends claims the action's entangled
    // lane (the documented re-wrap rule): same slot, FRESH id, and its own
    // close edge re-parks the slot on the same still-pending thenable.
    let after = null;
    await act(() => {
      startTransition(() => {
        after = React.unstable_getCurrentWriteBatch();
      });
    });
    expect(after).not.toBe(before);
    expect(events.retired.map(r => r.batchId)).not.toContain(after);

    resolveGate();
    await act(() => gate);
    // The stale callback (captured `before`) no-oped; the live one retired
    // `after` exactly once, uncommitted. The scrubbed batch never retires.
    expect(events.retired.filter(r => r.batchId === before)).toEqual([]);
    expect(events.retired.filter(r => r.batchId === after)).toEqual([
      {batchId: after, committed: false},
    ]);
    alloc.unregister();
    unsubscribe();
  });
});
