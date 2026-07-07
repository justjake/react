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
 * Lane-scoped scheduling: unstable_runInBatch(token, fn) (cosignal spec §4.1
 * fact 4, §4.4 tests 18–19, plus the test-24 insertion interplay).
 *
 * Contract pinned here:
 * - LIVE deferred token: fn's updates join the token's OWN lane — the
 *   delivered correction rides inside the pending batch and commits WITH it,
 *   atomically, exactly once. Inside fn, writes classify into the same
 *   batch (getCurrentWriteBatch() === token), and a nested startTransition
 *   joins it too.
 * - LIVE urgent token: fn runs at the batch's own event priority; writes
 *   inside classify into the same batch.
 * - RETIRED (or unknown, or 0) token: the documented fallback — fn runs
 *   URGENT (discrete), outside any transition. Discrete means it preempts
 *   even a yielded same-root transition pass (default priority does not:
 *   see the wall-clock test in the Pass file) and flushes pre-paint.
 * - A token stays addressable through its own retiring commit's
 *   onRootCommitted report (retirement emits follow the report): a delivery
 *   issued inside that listener lands on the outgoing token's lane. After
 *   the retirement emit, calls take the urgent fallback.
 * - Calls are legal from event handlers, timers, layout effects, channel
 *   listeners, and yield gaps; calling during RENDER throws.
 * - Nested calls compose: the innermost pin wins for its extent and the
 *   outer pin is restored when it returns.
 */

'use strict';

let React;
let ReactNoop;
let Scheduler;
let useState;
let useLayoutEffect;
let startTransition;
let ViewTransition;
let act;
let assertLog;
let waitFor;
let waitForAll;

describe('ReactFiberRunInBatch', () => {
  beforeEach(() => {
    jest.resetModules();
    React = require('react');
    ReactNoop = require('react-noop-renderer');
    Scheduler = require('scheduler');
    useState = React.useState;
    useLayoutEffect = React.useLayoutEffect;
    startTransition = React.startTransition;
    ViewTransition = React.ViewTransition;

    const InternalTestUtils = require('internal-test-utils');
    act = InternalTestUtils.act;
    assertLog = InternalTestUtils.assertLog;
    waitFor = InternalTestUtils.waitFor;
    waitForAll = InternalTestUtils.waitForAll;
  });

  function Text({text}) {
    Scheduler.log(text);
    return text;
  }

  function subscribe(extra) {
    const events = {
      log: [],
      passes: [],
      commits: [],
      retired: [],
    };
    const unsubscribe = React.unstable_subscribeToExternalRuntime({
      onRenderPassStart(container, includedBatches) {
        const entry = {
          type: 'passStart',
          container,
          included: includedBatches.slice(),
        };
        events.log.push(entry);
        events.passes.push(entry);
      },
      onRenderPassYield(container) {
        events.log.push({type: 'passYield', container});
      },
      onRenderPassResume(container) {
        events.log.push({type: 'passResume', container});
      },
      onRenderPassEnd(container, committed) {
        events.log.push({type: 'passEnd', container, committed});
      },
      onRootCommitted(container, committedBatches, rootCommitGeneration) {
        const entry = {
          type: 'rootCommitted',
          container,
          tokens: committedBatches.slice(),
          generation: rootCommitGeneration,
        };
        events.log.push(entry);
        events.commits.push(entry);
        if (extra && extra.onRootCommitted) {
          extra.onRootCommitted(entry);
        }
      },
      onBatchRetired(token, committed) {
        const entry = {type: 'retired', token, committed};
        events.log.push(entry);
        events.retired.push(entry);
      },
    });
    return {events, unsubscribe};
  }

  // Events for one container, in order, as compact strings.
  function frameEventsFor(events, container, fromIndex = 0) {
    const out = [];
    for (let i = fromIndex; i < events.log.length; i++) {
      const e = events.log[i];
      if (e.container !== container) {
        continue;
      }
      if (e.type === 'passEnd') {
        out.push(e.committed ? 'end(commit)' : 'end(discard)');
      } else if (e.type === 'passStart') {
        out.push('start');
      } else if (e.type === 'passYield') {
        out.push('yield');
      } else if (e.type === 'passResume') {
        out.push('resume');
      } else if (e.type === 'rootCommitted') {
        out.push('rootCommitted');
      }
    }
    return out;
  }

  // The pass-frame state machine the protocol guarantees (same checker as
  // the Pass test file): start (yield resume)* end, per container, with
  // every rootCommitted consuming the end(commit) that closed its frame.
  function checkFrameInvariants(log) {
    const state = new Map();
    const pendingCommitClose = new Set();
    const violations = [];
    for (let i = 0; i < log.length; i++) {
      const e = log[i];
      const s = state.get(e.container);
      switch (e.type) {
        case 'passStart':
          if (s !== undefined) {
            violations.push(`#${i} passStart over an ${s} frame`);
          }
          state.set(e.container, 'open');
          pendingCommitClose.delete(e.container);
          break;
        case 'passYield':
          if (s !== 'open') {
            violations.push(`#${i} passYield in state ${s || 'closed'}`);
          }
          state.set(e.container, 'yielded');
          break;
        case 'passResume':
          if (s !== 'yielded') {
            violations.push(`#${i} passResume in state ${s || 'closed'}`);
          }
          state.set(e.container, 'open');
          break;
        case 'passEnd':
          if (s === undefined) {
            violations.push(`#${i} passEnd with no open frame`);
          }
          state.delete(e.container);
          if (e.committed) {
            pendingCommitClose.add(e.container);
          }
          break;
        case 'rootCommitted':
          if (s !== undefined) {
            violations.push(`#${i} rootCommitted while frame ${s}`);
          }
          if (!pendingCommitClose.has(e.container)) {
            violations.push(`#${i} rootCommitted without an end(commit)`);
          }
          pendingCommitClose.delete(e.container);
          break;
        default:
          break;
      }
    }
    return violations;
  }

  // Spec test 18, the delivery schedule that motivates the API: the binding
  // learns mid-batch (here: in a yield gap of the batch's own pass) that a
  // late subscriber needs a value-blind entanglement setState. Delivered
  // through runInBatch, the update joins the token's own lane.
  //
  // Pinned flush shape for a MID-RENDER delivery: React's interleaved-update
  // semantics let the in-flight pass finish and commit WITHOUT the delivered
  // update (updates never join a render already past them), and the delivery
  // commits at the lane's immediately following pass. The protocol stays
  // truthful across the split: the first commit reports the batch on this
  // root (its rendered writes became visible) and LOCKS IT IN while the lane
  // stays pending; the follow-up commit reports the batch again with the
  // delivered update; the token retires exactly once, at the end. The
  // delivery never mints a foreign batch and never leaks into any other
  // batch's commit.
  it("a yield-gap delivery joins the token's own lanes and commits with the batch", async () => {
    const {events, unsubscribe} = subscribe();
    let setValue;
    let setEntangled;
    function App() {
      const [value, _setValue] = useState(0);
      const [entangled, _setEntangled] = useState(0);
      setValue = _setValue;
      setEntangled = _setEntangled;
      return (
        <>
          <Text text={`A${value}`} />
          <Text text={`B${value}`} />
          <Text text={`E${entangled}`} />
        </>
      );
    }
    const root = ReactNoop.createRoot();
    await act(() => {
      root.render(<App />);
    });
    assertLog(['A0', 'B0', 'E0']);
    const commitsBefore = events.commits.length;

    let t = null;
    let insideDeferred = null;
    let insideToken = null;
    await act(async () => {
      startTransition(() => {
        t = React.unstable_getCurrentWriteBatch();
        setValue(1);
      });
      // Partially render the transition, then yield: the frame is open,
      // parked in its gap.
      await waitFor(['A1']);

      // The delivery. Classification inside the callback resolves to the
      // batch itself.
      React.unstable_runInBatch(t, () => {
        insideDeferred = (React.unstable_getCurrentWriteBatch() & 1) === 1;
        insideToken = React.unstable_getCurrentWriteBatch();
        setEntangled(1);
      });

      await waitForAll(['B1', 'E0', 'A1', 'B1', 'E1']);
    });
    expect(insideDeferred).toBe(true);
    expect(insideToken).toBe(t);

    // Every commit that advanced this root carried the batch — first the
    // pass the delivery interrupted (its rendered writes became visible and
    // the still-pending batch locked in), then the follow-up pass carrying
    // the delivered update. No batchless advance, no foreign batch.
    const commitsWithT = events.commits.filter(c => c.tokens.includes(t));
    expect(commitsWithT.length).toBe(2);
    expect(commitsWithT[0].tokens).toEqual([t]);
    expect(commitsWithT[1].tokens).toEqual([t]);
    expect(commitsWithT[1].generation).toBe(commitsWithT[0].generation + 1);
    expect(events.commits.length).toBe(commitsBefore + 2);
    expect(root).toMatchRenderedOutput('A1B1E1');
    // The token retired exactly once, committed, at the flush that landed
    // the delivered update — after BOTH reports.
    expect(events.retired.filter(r => r.token === t)).toEqual([
      {type: 'retired', token: t, committed: true},
    ]);
    expect(events.log.indexOf(commitsWithT[1])).toBeLessThan(
      events.log.findIndex(e => e.type === 'retired' && e.token === t),
    );
    expect(checkFrameInvariants(events.log)).toEqual([]);
    unsubscribe();
  });

  // The binding's queued-delivery site: deliveries discovered inside a
  // render slice are queued to the pass's yield/end edge — and the yield
  // edge LISTENER itself is a legal runInBatch context (the work loop emits
  // it after leaving the render context; per-callstack truth says
  // not-in-render there).
  it('a delivery inside the onRenderPassYield listener itself is legal and joins the batch', async () => {
    let t = null;
    const probes = {};
    let setEntangled;
    const {events, unsubscribe} = subscribe();
    const unsubscribeYield = React.unstable_subscribeToExternalRuntime({
      onRenderPassYield() {
        if (t !== null && !probes.delivered) {
          probes.delivered = true;
          probes.renderContext = React.unstable_getRenderContext();
          React.unstable_runInBatch(t, () => {
            probes.insideToken = React.unstable_getCurrentWriteBatch();
            setEntangled(1);
          });
        }
      },
    });
    let setValue;
    function App() {
      const [value, _setValue] = useState(0);
      const [entangled, _setEntangled] = useState(0);
      setValue = _setValue;
      setEntangled = _setEntangled;
      return (
        <>
          <Text text={`A${value}`} />
          <Text text={`B${value}`} />
          <Text text={`E${entangled}`} />
        </>
      );
    }
    const root = ReactNoop.createRoot();
    await act(() => {
      root.render(<App />);
    });
    assertLog(['A0', 'B0', 'E0']);

    await act(async () => {
      startTransition(() => {
        t = React.unstable_getCurrentWriteBatch();
        setValue(1);
      });
      // The waitFor boundary parks the pass in a gap: the yield edge fires
      // and the listener above delivers into the batch right there.
      await waitFor(['A1']);
      await waitForAll(['B1', 'E0', 'A1', 'B1', 'E1']);
    });
    expect(probes.delivered).toBe(true);
    expect(probes.renderContext).toBe(null); // per-callstack truth at the edge
    expect(probes.insideToken).toBe(t);
    // Same truthful split as the gap delivery: every advance on this root
    // carried the batch, and it retired exactly once at the end.
    const commitsWithT = events.commits.filter(c => c.tokens.includes(t));
    expect(commitsWithT.length).toBeGreaterThanOrEqual(1);
    events.commits.slice(1).forEach(c => {
      expect(c.tokens).toEqual([t]);
    });
    expect(root).toMatchRenderedOutput('A1B1E1');
    expect(events.retired.filter(r => r.token === t)).toEqual([
      {type: 'retired', token: t, committed: true},
    ]);
    expect(checkFrameInvariants(events.log)).toEqual([]);
    unsubscribeYield();
    unsubscribe();
  });

  // The control for the test above: the SAME schedule delivered through a
  // fresh startTransition (instead of runInBatch) mints a second batch that
  // React never entangles with the first — the two commit separately, the
  // first commit exposes the original batch's write WITHOUT the correction,
  // and nothing ties the second batch to the first (its commit reports only
  // itself). This torn schedule is exactly why the lane-scoped fact exists.
  it('control: a fresh transition in the gap is a separate batch that commits separately (torn)', async () => {
    const {events, unsubscribe} = subscribe();
    let setValue;
    let setEntangled;
    function App() {
      const [value, _setValue] = useState(0);
      const [entangled, _setEntangled] = useState(0);
      setValue = _setValue;
      setEntangled = _setEntangled;
      return (
        <>
          <Text text={`A${value}`} />
          <Text text={`B${value}`} />
          <Text text={`E${entangled}`} />
        </>
      );
    }
    const root = ReactNoop.createRoot();
    await act(() => {
      root.render(<App />);
    });
    assertLog(['A0', 'B0', 'E0']);

    let t = null;
    let t2 = null;
    await act(async () => {
      startTransition(() => {
        t = React.unstable_getCurrentWriteBatch();
        setValue(1);
      });
      await waitFor(['A1']);

      // The would-be correction, as its own transition: a distinct batch.
      startTransition(() => {
        t2 = React.unstable_getCurrentWriteBatch();
        setEntangled(1);
      });

      await waitForAll(['B1', 'E0', 'A1', 'B1', 'E1']);
    });
    expect(t2).not.toBe(t);

    // Two separate commits; the first exposes the batch without the
    // correction (the tear runInBatch prevents).
    const tCommit = events.commits.find(c => c.tokens.includes(t));
    const t2Commit = events.commits.find(c => c.tokens.includes(t2));
    expect(tCommit).not.toBe(undefined);
    expect(t2Commit).not.toBe(undefined);
    expect(tCommit).not.toBe(t2Commit);
    expect(tCommit.tokens).toEqual([t]);
    expect(events.log.indexOf(tCommit)).toBeLessThan(
      events.log.indexOf(t2Commit),
    );
    expect(checkFrameInvariants(events.log)).toEqual([]);
    unsubscribe();
  });

  // A live URGENT token: fn runs at the batch's own event priority, and
  // writes inside classify into the same batch. Nested calls compose — the
  // innermost pin wins for its extent, and the outer pin is restored when
  // it returns.
  it('targets live urgent tokens at their own priority, and nested calls restore the outer pin', async () => {
    const {events, unsubscribe} = subscribe();
    let setValue;
    let setUrgent;
    function App() {
      const [value, _setValue] = useState(0);
      const [urgent, _setUrgent] = useState(0);
      setValue = _setValue;
      setUrgent = _setUrgent;
      return <Text text={`v${value} u${urgent}`} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => {
      root.render(<App />);
    });
    assertLog(['v0 u0']);

    let t = null;
    let u = null;
    const probes = {};
    await act(() => {
      startTransition(() => {
        t = React.unstable_getCurrentWriteBatch();
        setValue(1);
      });
      // The ambient (default-priority) batch of this same event.
      u = React.unstable_getCurrentWriteBatch();
      expect(u & 1).toBe(0);

      React.unstable_runInBatch(t, () => {
        probes.outerToken = React.unstable_getCurrentWriteBatch();
        probes.outerDeferred = (React.unstable_getCurrentWriteBatch() & 1) === 1;
        React.unstable_runInBatch(u, () => {
          probes.innerToken = React.unstable_getCurrentWriteBatch();
          probes.innerDeferred = (React.unstable_getCurrentWriteBatch() & 1) === 1;
          setUrgent(1);
        });
        // The outer deferred pin is restored after the inner call returns.
        probes.restoredToken = React.unstable_getCurrentWriteBatch();
        probes.restoredDeferred = (React.unstable_getCurrentWriteBatch() & 1) === 1;
      });
    });
    // The urgent (default-priority) write commits in its own earlier flush;
    // the transition follows.
    assertLog(['v0 u1', 'v1 u1']);

    expect(probes.outerToken).toBe(t);
    expect(probes.outerDeferred).toBe(true);
    expect(probes.innerToken).toBe(u);
    expect(probes.innerDeferred).toBe(false);
    expect(probes.restoredToken).toBe(t);
    expect(probes.restoredDeferred).toBe(true);

    // The urgent batch committed first (default preempts nothing, but
    // renders before a pending transition), without the transition batch;
    // the transition committed separately with its own write set.
    const uCommit = events.commits.find(c => c.tokens.includes(u));
    const tCommit = events.commits.find(c => c.tokens.includes(t));
    expect(uCommit).not.toBe(undefined);
    expect(tCommit).not.toBe(undefined);
    expect(uCommit.tokens).toEqual([u]);
    expect(tCommit.tokens).toEqual([t]);
    expect(events.log.indexOf(uCommit)).toBeLessThan(
      events.log.indexOf(tCommit),
    );
    expect(root).toMatchRenderedOutput('v1 u1');
    expect(checkFrameInvariants(events.log)).toEqual([]);
    unsubscribe();
  });

  // Spec test 19: a retired token makes fn run URGENT — the documented
  // fallback. Classification inside is not-deferred and mints the ambient
  // urgent batch, and the update commits without resurrecting the retired
  // token.
  it('retired token: fn runs urgent, classification falls back to the ambient batch', async () => {
    const {events, unsubscribe} = subscribe();
    let setValue;
    function App() {
      const [value, _setValue] = useState(0);
      setValue = _setValue;
      return <Text text={`v${value}`} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => {
      root.render(<App />);
    });
    assertLog(['v0']);

    // A store-only transition batch: mints a token, schedules no React
    // work, retires (uncommitted) at its event's close edge.
    let t = null;
    await act(() => {
      startTransition(() => {
        t = React.unstable_getCurrentWriteBatch();
      });
    });
    expect(events.retired.filter(r => r.token === t)).toEqual([
      {type: 'retired', token: t, committed: false},
    ]);

    let fallbackToken = null;
    let fallbackDeferred = null;
    await act(() => {
      React.unstable_runInBatch(t, () => {
        fallbackDeferred = (React.unstable_getCurrentWriteBatch() & 1) === 1;
        fallbackToken = React.unstable_getCurrentWriteBatch();
        setValue(1);
      });
    });
    assertLog(['v1']);
    expect(fallbackDeferred).toBe(false);
    expect(fallbackToken).not.toBe(t);
    expect(fallbackToken & 1).toBe(0); // urgent classification
    // The retired token retired exactly once, long before the fallback
    // commit; the fallback commit carries only the ambient urgent batch.
    expect(events.retired.filter(r => r.token === t).length).toBe(1);
    const fallbackCommit = events.commits.find(c =>
      c.tokens.includes(fallbackToken),
    );
    expect(fallbackCommit).not.toBe(undefined);
    expect(fallbackCommit.tokens).toEqual([fallbackToken]);
    expect(root).toMatchRenderedOutput('v1');
    expect(checkFrameInvariants(events.log)).toEqual([]);
    unsubscribe();
  });

  // The urgency of the fallback, pinned against the pass-lifecycle events:
  // DEFAULT priority does not preempt a yielded transition (Pass test 10),
  // but the retired-token fallback is DISCRETE — it discards the yielded
  // pass, commits pre-paint, and the transition restarts after. This is
  // what "urgent pre-paint correction" means through this channel.
  it('the retired-token fallback preempts a yielded transition pass (discrete, not default)', async () => {
    const {events, unsubscribe} = subscribe();
    let setValue;
    let setUrgent;
    function App() {
      const [value, _setValue] = useState(0);
      const [urgent, _setUrgent] = useState(0);
      setValue = _setValue;
      setUrgent = _setUrgent;
      return (
        <>
          <Text text={`U${urgent}`} />
          <Text text={`A${value}`} />
          <Text text={`B${value}`} />
        </>
      );
    }
    const root = ReactNoop.createRoot();
    await act(() => {
      root.render(<App />);
    });
    assertLog(['U0', 'A0', 'B0']);
    const container = events.passes[0].container;

    // Retire a store-only token in its own event.
    let retired = null;
    await act(() => {
      startTransition(() => {
        retired = React.unstable_getCurrentWriteBatch();
      });
    });
    expect(events.retired.map(r => r.token)).toContain(retired);

    let t = null;
    await act(async () => {
      startTransition(() => {
        t = React.unstable_getCurrentWriteBatch();
        setValue(1);
      });
      // Yield mid-pass.
      await waitFor(['U0', 'A1']);
      const yieldedIndex = events.log.indexOf(
        events.passes[events.passes.length - 1],
      );

      // The fallback correction, delivered while the transition pass is
      // parked in its gap.
      React.unstable_runInBatch(retired, () => {
        setUrgent(1);
      });

      // The discrete update discards the yielded pass and commits first;
      // the transition then restarts from scratch and commits separately.
      await waitForAll(['U1', 'A0', 'B0', 'U1', 'A1', 'B1']);

      expect(frameEventsFor(events, container, yieldedIndex + 1)).toEqual([
        'yield', // the transition pass parked in its gap
        'end(discard)', // …discarded by the urgent correction…
        'start',
        'end(commit)', // …which commits before the transition,
        'rootCommitted',
        'start', // …and the transition restarts after it.
        'end(commit)',
        'rootCommitted',
      ]);
    });

    // The urgent commit carried no transition batch; the transition batch
    // committed exactly once, after it.
    const commitsWithT = events.commits.filter(c => c.tokens.includes(t));
    expect(commitsWithT.length).toBe(1);
    expect(root).toMatchRenderedOutput('U1A1B1');
    expect(checkFrameInvariants(events.log)).toEqual([]);
    unsubscribe();
  });

  // runInBatch during the render phase throws: update attribution during a
  // pass belongs to the pass itself. (Deliveries discovered mid-render are
  // queued to the pass's yield or end edge — binding-side policy.)
  it('throws when called during render', async () => {
    let renderError = null;
    function Bad() {
      try {
        React.unstable_runInBatch(0, () => {});
      } catch (error) {
        renderError = error;
      }
      return <Text text="rendered" />;
    }
    const root = ReactNoop.createRoot();
    await act(() => {
      root.render(<Bad />);
    });
    assertLog(['rendered']);
    expect(renderError).not.toBe(null);
    expect(renderError.message).toMatch(
      /runInBatch must not be called while React is rendering/,
    );
  });

  // Delivery from a layout effect while the token is STILL LIVE (pending on
  // another root): the correction rides the token's own lane on this root,
  // producing a second reported commit of the same batch here — the
  // merge-rule consequence: a batch that gains new visible updates on a
  // root it already committed on is reported on that root again — while
  // the token retires exactly once, at its true last-root finish.
  it('a layout-effect delivery on a committed-here-pending-elsewhere batch rides its lane and re-reports', async () => {
    const {events, unsubscribe} = subscribe();
    let resolveGate;
    const gate = new Promise(resolve => {
      resolveGate = resolve;
    });
    const probes = {};
    let tokenForEffect = null;
    let setA;
    let setN;
    let setB;
    function CompA() {
      const [on, _set] = useState(false);
      const [n, _setN] = useState(0);
      setA = _set;
      setN = _setN;
      useLayoutEffect(() => {
        if (on && n === 0) {
          // The mount-fixup shape: deliver into the (still live) batch from
          // the layout effect of the commit that landed it on this root.
          React.unstable_runInBatch(tokenForEffect, () => {
            probes.insideToken = React.unstable_getCurrentWriteBatch();
            setN(1);
          });
        }
      }, [on, n]);
      return <Text text={`A on=${on} n=${n}`} />;
    }
    function CompB() {
      const [on, _set] = useState(false);
      setB = _set;
      if (on) {
        React.use(gate); // keeps the spanning batch pending on root B
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

    let t = null;
    await act(() => {
      startTransition(() => {
        t = React.unstable_getCurrentWriteBatch();
        tokenForEffect = t;
        setA(true);
        setB(true);
      });
    });
    // Root A committed the batch, its layout effect delivered the
    // correction into the still-live token, and the correction committed
    // on root A through the batch's own lane.
    assertLog(['A on=true n=0', 'A on=true n=1']);
    expect(probes.insideToken).toBe(t);
    expect(events.retired.map(r => r.token)).not.toContain(t);

    const aCommitsWithT = events.commits.filter(
      c => c.container === containerA && c.tokens.includes(t),
    );
    expect(aCommitsWithT.length).toBe(2); // the landing + the delivery
    expect(aCommitsWithT[1].generation).toBe(aCommitsWithT[0].generation + 1);

    // Root B settles: the batch commits there and the token retires
    // exactly once, committed.
    resolveGate();
    await act(() => gate);
    assertLog(['B on=true']);
    expect(events.retired.filter(r => r.token === t)).toEqual([
      {type: 'retired', token: t, committed: true},
    ]);
    expect(checkFrameInvariants(events.log)).toEqual([]);
    unsubscribe();
  });

  // The retiring-commit listener window: inside the onRootCommitted report
  // of the commit that retires the token, the token is still addressable —
  // a delivery there lands on the OUTGOING token's lane (the documented
  // merge rule). The token still retires exactly once, and the late update
  // reaches the committed view through a later, batchless commit.
  it('a delivery inside the retiring commit report lands on the outgoing token', async () => {
    let t = null;
    const probes = {};
    let setLate;
    const {events, unsubscribe} = subscribe({
      onRootCommitted(entry) {
        if (t !== null && entry.tokens.includes(t) && !probes.delivered) {
          probes.delivered = true;
          React.unstable_runInBatch(t, () => {
            probes.insideToken = React.unstable_getCurrentWriteBatch();
            probes.insideDeferred = (React.unstable_getCurrentWriteBatch() & 1) === 1;
            setLate(1);
          });
        }
      },
    });
    let setValue;
    function App() {
      const [value, _setValue] = useState(0);
      const [late, _setLate] = useState(0);
      setValue = _setValue;
      setLate = _setLate;
      return <Text text={`v${value} late${late}`} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => {
      root.render(<App />);
    });
    assertLog(['v0 late0']);

    await act(() => {
      startTransition(() => {
        t = React.unstable_getCurrentWriteBatch();
        setValue(1);
      });
    });
    assertLog(['v1 late0', 'v1 late1']);
    expect(probes.delivered).toBe(true);
    // Inside the report window the token was still the write's identity.
    expect(probes.insideToken).toBe(t);
    expect(probes.insideDeferred).toBe(true);
    // …and it still retired exactly once, committed, at that commit.
    expect(events.retired.filter(r => r.token === t)).toEqual([
      {type: 'retired', token: t, committed: true},
    ]);
    // The late update committed AFTER the retirement, through a commit
    // whose delta is empty (the token was already gone; lane bookkeeping
    // only). The committed view still shows the write.
    const tCommitIndex = events.log.findIndex(
      e => e.type === 'rootCommitted' && e.tokens.includes(t),
    );
    const retireIndex = events.log.findIndex(
      e => e.type === 'retired' && e.token === t,
    );
    const lateCommit = events.commits[events.commits.length - 1];
    expect(tCommitIndex).toBeLessThan(retireIndex);
    expect(retireIndex).toBeLessThan(events.log.indexOf(lateCommit));
    expect(lateCommit.tokens).toEqual([]);
    expect(root).toMatchRenderedOutput('v1 late1');
    expect(checkFrameInvariants(events.log)).toEqual([]);
    unsubscribe();
  });

  // The test-24 interplay: a delivery into a batch whose pass COMPLETED but
  // has not committed (suspensey commit window) forces React's pre-commit
  // restart — the batch still commits atomically, once, with the delivered
  // update included. Never a commit of the stale completed tree.
  // @gate enableViewTransition
  it('a delivery into a completed-but-uncommitted pass forces a pre-commit restart, one atomic commit', async () => {
    const {events, unsubscribe} = subscribe();
    let setSrc;
    let setStep;
    function App() {
      const [src, _setSrc] = useState(null);
      const [step, _setStep] = useState(0);
      setSrc = _setSrc;
      setStep = _setStep;
      return (
        <ViewTransition>
          <Text text={`step ${step}${src !== null ? ' +img' : ''}`} />
          {src !== null ? (
            <suspensey-thing
              src={src}
              onLoadStart={() => Scheduler.log(`Image requested [${src}]`)}
            />
          ) : null}
        </ViewTransition>
      );
    }
    const root = ReactNoop.createRoot();
    await act(() => {
      root.render(<App />);
    });
    assertLog(['step 0']);
    const container = events.passes[0].container;
    expect(events.commits.length).toBe(1);

    // The batch's pass completes; its commit suspends on the image.
    let t = null;
    await act(() => {
      startTransition(() => {
        t = React.unstable_getCurrentWriteBatch();
        setSrc('A');
      });
    });
    assertLog(['step 0 +img', 'Image requested [A]']);
    expect(ReactNoop.getSuspenseyThingStatus('A')).toBe('pending');
    expect(events.commits.length).toBe(1);
    const completedIndex = events.log.indexOf(
      events.passes[events.passes.length - 1],
    );

    // The delivery, into the completed-but-uncommitted batch.
    await act(() => {
      React.unstable_runInBatch(t, () => {
        setStep(1);
      });
    });
    // The pending commit was canceled (discard edge), the pass restarted
    // over the same batch with the delivered update, completed again, and
    // suspended its commit again. Still nothing committed.
    assertLog(['step 1 +img']);
    expect(events.commits.length).toBe(1);
    expect(root).toMatchRenderedOutput('step 0');
    const restarted = events.passes[events.passes.length - 1];
    expect(restarted.included).toEqual([t]);
    expect(
      frameEventsFor(events, container, completedIndex + 1).slice(0, 2),
    ).toEqual(['end(discard)', 'start']);

    // The image resolves: ONE commit, carrying the batch, exposing both
    // writes at once; the token retires committed.
    await act(() => {
      ReactNoop.resolveSuspenseyThing('A');
    });
    assertLog([]);
    expect(events.commits.length).toBe(2);
    expect(events.commits[1].tokens).toEqual([t]);
    expect(root).toMatchRenderedOutput(
      <>
        step 1 +img
        <suspensey-thing src="A" />
      </>,
    );
    expect(events.retired.filter(r => r.token === t)).toEqual([
      {type: 'retired', token: t, committed: true},
    ]);
    expect(checkFrameInvariants(events.log)).toEqual([]);
    unsubscribe();
  });
});
