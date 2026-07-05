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
 * Existence proofs for the per-root commit facts of the external-runtime
 * protocol (cosignal spec §4.1 fact 3, §4.4 tests 15–17 and 25): a batch
 * spanning several roots commits on each root at its own time, and each of
 * those commits is REPORTED per root — with a per-root commit generation —
 * while the token stays live until its last pending root finishes.
 *
 * These tests pin current React behavior through the channel; the multi-root
 * schedules here are the ones the spec calls out as never having had a
 * current-generation existence proof. See ReactFiberBatchRegistry-test.js for
 * the single-root token protocol and ReactFiberExternalRuntimePass-test.js
 * for the pass/commit serialization facts.
 */

'use strict';

let React;
let ReactNoop;
let Scheduler;
let useState;
let startTransition;
let act;
let assertLog;

describe('ReactFiberExternalRuntimeCommit', () => {
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

  // Records every channel event into one ordered log (for cross-event
  // ordering assertions) plus per-kind views.
  function subscribe() {
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
      onRenderPassEnd(container) {
        events.log.push({type: 'passEnd', container});
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
      },
      onBatchRetired(token, committed) {
        const entry = {type: 'retired', token, committed};
        events.log.push(entry);
        events.retired.push(entry);
      },
    });
    return {events, unsubscribe};
  }

  function commitsOn(events, container) {
    return events.commits.filter(commit => commit.container === container);
  }

  function lastContainer(events) {
    return events.passes[events.passes.length - 1].container;
  }

  // Spec test 15: two createRoots, one transition spanning both; the batch's
  // commit on each root is reported per root, with that root's commit
  // generation, while the token stays live until the last root finishes.
  it('reports a spanning batch per root, with generations, while the token stays live', async () => {
    const {events, unsubscribe} = subscribe();
    let resolveGate;
    const gate = new Promise(resolve => {
      resolveGate = resolve;
    });
    let setA;
    let setB;
    function CompA() {
      const [on, _set] = useState(false);
      setA = _set;
      return <Text text={`A on=${on}`} />;
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
    assertLog(['A on=false']);
    const containerA = lastContainer(events);

    const rootB = ReactNoop.createRoot();
    await act(() => {
      rootB.render(<CompB />);
    });
    assertLog(['B on=false']);
    const containerB = lastContainer(events);
    expect(containerA).not.toBe(containerB);

    // Every commit is reported, including batchless mounts: generation 1,
    // empty delta, one per root.
    expect(commitsOn(events, containerA)).toEqual([
      {type: 'rootCommitted', container: containerA, tokens: [], generation: 1},
    ]);
    expect(commitsOn(events, containerB)).toEqual([
      {type: 'rootCommitted', container: containerB, tokens: [], generation: 1},
    ]);

    let token = null;
    await act(() => {
      startTransition(() => {
        token = React.unstable_getCurrentWriteBatch();
        setA(true);
        setB(true);
      });
    });
    // Root A committed the spanning batch; root B is suspended on the gate.
    assertLog(['A on=true']);

    // The commit is reported on root A — and only root A — with the token in
    // the delta and A's bumped generation…
    expect(commitsOn(events, containerA)).toEqual([
      {type: 'rootCommitted', container: containerA, tokens: [], generation: 1},
      {
        type: 'rootCommitted',
        container: containerA,
        tokens: [token],
        generation: 2,
      },
    ]);
    expect(commitsOn(events, containerB).length).toBe(1);
    // …while the token stays live: no retirement until root B commits.
    expect(events.retired.map(r => r.token)).not.toContain(token);

    // Root B settles and commits: reported on B with B's own generation.
    resolveGate();
    await act(() => gate);
    assertLog(['B on=true']);
    const bCommit = commitsOn(events, containerB)[1];
    expect(bCommit).toEqual({
      type: 'rootCommitted',
      container: containerB,
      tokens: [token],
      generation: 2,
    });

    // Retirement fires exactly once, committed — and AFTER the last root's
    // commit report: the report is the cause, retirement its consequence.
    expect(events.retired.filter(r => r.token === token)).toEqual([
      {type: 'retired', token, committed: true},
    ]);
    const retireIndex = events.log.findIndex(
      e => e.type === 'retired' && e.token === token,
    );
    expect(retireIndex).toBeGreaterThan(events.log.indexOf(bCommit));
    unsubscribe();
  });

  // Spec test 16: both roots commit the spanning batch in the same flush.
  // Each root's commit is reported separately (correct container, exactly
  // once per root); retirement follows the LAST report; and the generation
  // counters advance per root, independently.
  it('reports each root separately when a spanning batch commits on both in one flush', async () => {
    const {events, unsubscribe} = subscribe();
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
      return <Text text={`B on=${on}`} />;
    }

    const rootA = ReactNoop.createRoot();
    await act(() => {
      rootA.render(<CompA />);
    });
    assertLog(['A on=false n=0']);
    const containerA = lastContainer(events);

    const rootB = ReactNoop.createRoot();
    await act(() => {
      rootB.render(<CompB />);
    });
    assertLog(['B on=false']);
    const containerB = lastContainer(events);

    // An extra urgent commit on root A only, so the two roots' generation
    // counters diverge before the spanning batch lands.
    await act(() => {
      bumpA(1);
    });
    assertLog(['A on=false n=1']);

    let token = null;
    await act(() => {
      startTransition(() => {
        token = React.unstable_getCurrentWriteBatch();
        setA(true);
        setB(true);
      });
    });
    assertLog(['A on=true n=1', 'B on=true']);

    // One report per root, each with its own container and generation:
    // A has committed three times (mount, bump, batch), B twice (mount,
    // batch) — per-root counters, not a global one.
    const aCommits = commitsOn(events, containerA);
    const bCommits = commitsOn(events, containerB);
    expect(aCommits.map(c => c.generation)).toEqual([1, 2, 3]);
    expect(bCommits.map(c => c.generation)).toEqual([1, 2]);
    const aBatchCommits = aCommits.filter(c => c.tokens.includes(token));
    const bBatchCommits = bCommits.filter(c => c.tokens.includes(token));
    expect(aBatchCommits).toEqual([
      {
        type: 'rootCommitted',
        container: containerA,
        tokens: [token],
        generation: 3,
      },
    ]);
    expect(bBatchCommits).toEqual([
      {
        type: 'rootCommitted',
        container: containerB,
        tokens: [token],
        generation: 2,
      },
    ]);

    // Exactly one retirement, positioned after BOTH per-root reports.
    expect(events.retired.filter(r => r.token === token)).toEqual([
      {type: 'retired', token, committed: true},
    ]);
    const retireIndex = events.log.findIndex(
      e => e.type === 'retired' && e.token === token,
    );
    expect(retireIndex).toBeGreaterThan(events.log.indexOf(aBatchCommits[0]));
    expect(retireIndex).toBeGreaterThan(events.log.indexOf(bBatchCommits[0]));
    unsubscribe();
  });

  // Spec test 17: a root whose share of the batch is pruned (its pending
  // update dies with a deleted subtree) never reports the batch as
  // committed — its committed view never showed the batch's writes — while
  // the token still retires exactly once, committed=true, because the other
  // root did commit it.
  it('never reports a batch on a root where its work was pruned by deletion', async () => {
    const {events, unsubscribe} = subscribe();
    let resolveGate;
    const gate = new Promise(resolve => {
      resolveGate = resolve;
    });
    let setA;
    let setB;
    function CompA() {
      const [on, _set] = useState(false);
      setA = _set;
      return <Text text={`A on=${on}`} />;
    }
    function CompB() {
      const [on, _set] = useState(false);
      setB = _set;
      if (on) {
        React.use(gate); // keeps the batch pending on root B
      }
      return <Text text={`B on=${on}`} />;
    }

    const rootA = ReactNoop.createRoot();
    await act(() => {
      rootA.render(<CompA />);
    });
    assertLog(['A on=false']);
    const containerA = lastContainer(events);

    const rootB = ReactNoop.createRoot();
    await act(() => {
      rootB.render(<CompB />);
    });
    assertLog(['B on=false']);
    const containerB = lastContainer(events);

    let token = null;
    await act(() => {
      startTransition(() => {
        token = React.unstable_getCurrentWriteBatch();
        setA(true);
        setB(true);
      });
    });
    // A committed the batch; B is suspended, batch pending there.
    assertLog(['A on=true']);
    expect(
      commitsOn(events, containerA).filter(c => c.tokens.includes(token))
        .length,
    ).toBe(1);
    expect(events.retired.map(r => r.token)).not.toContain(token);

    // Replace root B's tree with unrelated content. CompB unmounts, taking
    // its pending transition update with it: root B is done with the batch
    // without ever committing it.
    await act(() => {
      rootB.render(<Text text="B replaced" />);
    });
    assertLog(['B replaced']);

    // No commit report on B ever contains the token: B's committed view
    // never showed the batch's writes (prune ≠ commit).
    expect(
      commitsOn(events, containerB).filter(c => c.tokens.includes(token)),
    ).toEqual([]);

    // The token still retired exactly once, committed=true (root A committed
    // it), at the commit that pruned B's share — after B's (batchless)
    // commit report for that same commit.
    expect(events.retired.filter(r => r.token === token)).toEqual([
      {type: 'retired', token, committed: true},
    ]);
    const bCommits = commitsOn(events, containerB);
    const pruneCommit = bCommits[bCommits.length - 1];
    expect(pruneCommit.tokens).toEqual([]);
    const retireIndex = events.log.findIndex(
      e => e.type === 'retired' && e.token === token,
    );
    expect(retireIndex).toBeGreaterThan(events.log.indexOf(pruneCommit));

    // Resolving the gate afterwards is a no-op: nothing left to commit.
    resolveGate();
    await act(() => gate);
    assertLog([]);
    expect(events.retired.filter(r => r.token === token).length).toBe(1);
    unsubscribe();
  });

  // Spec test 25: write-set closure at commit. Every commit of a root
  // exposes to that root's committed view exactly the write set the
  // committing pass rendered: the pass's included batches equal the commit's
  // reported delta plus the batches the root's table already held (live
  // lock-ins). A batch that is pending but unrendered never leaks into a
  // commit; a batch the root already committed is never dropped from one.
  it('a commit exposes exactly the write set the committing pass rendered', async () => {
    const {events, unsubscribe} = subscribe();

    // Replays the whole event log, asserting the closure invariant at every
    // commit of every root.
    function assertWriteSetClosure() {
      const lastPassByContainer = new Map();
      const tableByContainer = new Map();
      const retiredTokens = new Set();
      let commitsChecked = 0;
      for (let i = 0; i < events.log.length; i++) {
        const entry = events.log[i];
        if (entry.type === 'passStart') {
          lastPassByContainer.set(entry.container, entry.included);
        } else if (entry.type === 'retired') {
          retiredTokens.add(entry.token);
        } else if (entry.type === 'rootCommitted') {
          const included = lastPassByContainer.get(entry.container) || [];
          let table = tableByContainer.get(entry.container);
          if (table === undefined) {
            table = new Set();
            tableByContainer.set(entry.container, table);
          }
          const liveTable = [];
          table.forEach(t => {
            if (!retiredTokens.has(t)) {
              liveTable.push(t);
            }
          });
          const exposed = new Set([...liveTable, ...entry.tokens]);
          expect(new Set(included)).toEqual(exposed);
          entry.tokens.forEach(t => table.add(t));
          commitsChecked++;
        }
      }
      return commitsChecked;
    }

    let resolveGateA;
    const gateA = new Promise(resolve => {
      resolveGateA = resolve;
    });
    let resolveGateB;
    const gateB = new Promise(resolve => {
      resolveGateB = resolve;
    });
    let setValue;
    let setN;
    function CompA() {
      const [value, _setValue] = useState(0);
      const [n, _setN] = useState(0);
      setValue = _setValue;
      setN = _setN;
      if (value === 1) {
        React.use(gateA); // t1 suspends on root A
      }
      return <Text text={`A v=${value} n=${n}`} />;
    }
    let setB;
    function CompB() {
      const [on, _set] = useState(false);
      setB = _set;
      if (on) {
        React.use(gateB); // t2 stays pending on root B
      }
      return <Text text={`B on=${on}`} />;
    }

    const rootA = ReactNoop.createRoot();
    await act(() => {
      rootA.render(<CompA />);
    });
    assertLog(['A v=0 n=0']);
    const containerA = lastContainer(events);

    // Phase 1 — exclusion: t1 is pending on root A (suspended, unrendered
    // by any commit). An urgent commit on A must not leak it.
    let t1 = null;
    await act(() => {
      startTransition(() => {
        t1 = React.unstable_getCurrentWriteBatch();
        setValue(1);
      });
    });
    assertLog([]); // suspended before logging; nothing committed
    expect(commitsOn(events, containerA).length).toBe(1); // mount only

    let u1 = null;
    await act(() => {
      u1 = React.unstable_getCurrentWriteBatch(); // ambient default batch
      setN(1);
    });
    assertLog(['A v=0 n=1']);
    const urgentCommit = commitsOn(events, containerA)[1];
    // The urgent commit's delta is exactly {u1}: the pending, unrendered t1
    // stays out of the committed view.
    expect(urgentCommit.tokens).toEqual([u1]);
    expect(t1 & 1).toBe(1);
    expect(u1 & 1).toBe(0);
    expect(events.retired.map(r => r.token)).not.toContain(t1);

    // t1 settles and commits: its own delta, in its own commit.
    resolveGateA();
    await act(() => gateA);
    assertLog(['A v=1 n=1']);
    expect(commitsOn(events, containerA)[2].tokens).toEqual([t1]);
    expect(events.retired.filter(r => r.token === t1)).toEqual([
      {type: 'retired', token: t1, committed: true},
    ]);

    // Phase 2 — lock-in inclusion: t2 spans roots A and B; A commits it
    // while B keeps it pending. A's next urgent pass must keep including t2
    // (its committed tree already shows it), and that commit's delta must be
    // only the new urgent batch.
    const rootB = ReactNoop.createRoot();
    await act(() => {
      rootB.render(<CompB />);
    });
    assertLog(['B on=false']);

    let t2 = null;
    await act(() => {
      startTransition(() => {
        t2 = React.unstable_getCurrentWriteBatch();
        setN(2);
        setB(true);
      });
    });
    assertLog(['A v=1 n=2']); // A committed t2; B suspended on gateB
    expect(commitsOn(events, containerA)[3].tokens).toEqual([t2]);

    let u2 = null;
    await act(() => {
      u2 = React.unstable_getCurrentWriteBatch();
      setN(3);
    });
    assertLog(['A v=1 n=3']);
    const lockInCommit = commitsOn(events, containerA)[4];
    // Delta is only the urgent batch; the pass itself included the locked-in
    // t2 as well — the closure check below proves included == table ∪ delta.
    expect(lockInCommit.tokens).toEqual([u2]);
    const lockInPassIndex = events.log.lastIndexOf(
      events.passes[events.passes.length - 1],
    );
    const lockInPass = events.log[lockInPassIndex];
    expect(new Set(lockInPass.included)).toEqual(new Set([u2, t2]));

    // B settles: t2 commits there and retires.
    resolveGateB();
    await act(() => gateB);
    assertLog(['B on=true']);
    expect(events.retired.filter(r => r.token === t2)).toEqual([
      {type: 'retired', token: t2, committed: true},
    ]);

    // The closure invariant held at every commit of every root above:
    // A mount, u1, t1, t2, u2 on root A; mount, t2 on root B.
    const commitsChecked = assertWriteSetClosure();
    expect(commitsChecked).toBe(events.commits.length);
    expect(commitsChecked).toBe(7);
    unsubscribe();
  });

  // Write-set closure under ENTANGLED sibling transitions. Two transitions
  // claim separate lanes and separate tokens, but the second writes through
  // a hook queue that already holds the first's pending update, so React
  // entangles the lanes: whichever lane names the render, the pass consumes
  // BOTH batches' updates (entangledRenderLanes). The channel must report
  // the write set the tree actually shows — both tokens included in the
  // pass, both in the commit's delta, both retired committed=true — or a
  // consumer resolving reads against included-batches misses a write the
  // committed view visibly contains. (Under enableParallelTransitions —
  // on in www test runs — sibling transitions render on single lanes as a
  // matter of course, making this the common shape, not an edge case.)
  it('reports entangled sibling-transition batches together: included, committed, retired', async () => {
    const {events, unsubscribe} = subscribe();
    let resolveGate;
    const gate = new Promise(resolve => {
      resolveGate = resolve;
    });
    let setValue;
    function App() {
      const [value, _setValue] = useState(0);
      setValue = _setValue;
      if (value === 1) {
        React.use(gate); // t1 alone suspends; the rebased fold to 2 does not
      }
      return <Text text={`v=${value}`} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => {
      root.render(<App />);
    });
    assertLog(['v=0']);
    const container = lastContainer(events);

    // Transition 1 suspends and stays pending on its own lane.
    let t1 = null;
    await act(() => {
      startTransition(() => {
        t1 = React.unstable_getCurrentWriteBatch();
        setValue(1);
      });
    });
    assertLog([]); // suspended before logging anything
    expect(commitsOn(events, container).length).toBe(1); // mount only

    // Transition 2, a separate event: its own lane, its own token — and an
    // entanglement with t1 through the shared useState queue.
    let t2 = null;
    await act(() => {
      startTransition(() => {
        t2 = React.unstable_getCurrentWriteBatch();
        setValue(2);
      });
    });
    assertLog(['v=2']);
    expect(t2).not.toBe(t1);

    // The committing pass reported BOTH batches, whatever lane named it.
    const commitPass = events.passes[events.passes.length - 1];
    expect(new Set(commitPass.included)).toEqual(new Set([t1, t2]));

    // One commit, delta = both batches: the committed view shows the folded
    // write set (v=2 consumed t1's update), so both must be reported and
    // neither may be mistaken for a prune.
    const containerCommits = commitsOn(events, container);
    const finalCommit = containerCommits[containerCommits.length - 1];
    expect(containerCommits.length).toBe(2);
    expect(new Set(finalCommit.tokens)).toEqual(new Set([t1, t2]));
    expect(
      events.retired
        .filter(r => r.token === t1 || r.token === t2)
        .map(r => r.committed),
    ).toEqual([true, true]);

    // The gate that t1's lone render suspended on is irrelevant after the
    // fold: resolving it must be a no-op.
    resolveGate();
    await act(() => gate);
    assertLog([]);
    expect(commitsOn(events, container).length).toBe(2);
    unsubscribe();
  });
});
