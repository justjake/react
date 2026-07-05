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
 * The pass-lifecycle facts of the external-runtime protocol (cosignal spec
 * §4.1 fact 2, §4.4 tests 7–10, 21–22, 24, 27–28), plus the pass/commit
 * serialization and insertion existence proofs those edges formalize.
 *
 * Channel semantics pinned here: a pass FRAME opens at onRenderPassStart
 * and closes exactly once at onRenderPassEnd(container, committed), which
 * fires at the commit that lands the pass's tree (committed = true, inside
 * that commit and before its onRootCommitted report) or at the discard
 * that abandons it (committed = false: a restart's implicit end, an
 * interrupted suspended render, a canceled pending commit) — NOT at render
 * completion. The frame spans onRenderPassYield/onRenderPassResume gaps
 * (strictly alternating) and the completed-but-uncommitted period (e.g. a
 * commit suspended on resources). Truth about "in render" stays per
 * callstack: code running in a yield gap or while a completed tree waits
 * to commit observes getRenderContext() === null even though the frame is
 * open. Serialization fact: no same-root committed-view advance while a
 * same-root frame is open — a same-root commit implies the frame closed
 * (commit for its own tree, discard for anything older).
 */

'use strict';

let React;
let ReactNoop;
let Scheduler;
let useState;
let startTransition;
let ViewTransition;
let act;
let assertLog;
let waitFor;
let waitForAll;

describe('ReactFiberExternalRuntimePass', () => {
  beforeEach(() => {
    jest.resetModules();
    React = require('react');
    ReactNoop = require('react-noop-renderer');
    Scheduler = require('scheduler');
    useState = React.useState;
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
      },
      onBatchRetired(token, committed) {
        const entry = {type: 'retired', token, committed};
        events.log.push(entry);
        events.retired.push(entry);
      },
    });
    return {events, unsubscribe};
  }

  // Events for one container, in order, as compact strings — the shape most
  // assertions below want.
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

  // Replays an event log against the pass-frame state machine the protocol
  // guarantees, per container:
  //
  //   closed --start--> open --yield--> yielded --resume--> open
  //   open|yielded --end(commit|discard)--> closed
  //
  // plus: every rootCommitted arrives with the frame CLOSED, consuming the
  // end(commit) that closed it (so a commit report can neither overlap an
  // open frame, follow a discard, nor double up on one commit-close).
  // Violations of ANY exactly-once or ordering rule — double yield, double
  // resume, resume without yield, double end, start over an open frame,
  // commit-report during an open frame — surface as log-position-tagged
  // strings, so a regression names the exact event that broke the contract.
  function checkFrameInvariants(log) {
    const state = new Map(); // container -> 'open' | 'yielded' (absent = closed)
    const pendingCommitClose = new Set(); // containers whose last close was end(commit), unconsumed
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

  // Spec tests 7 and 8: the yield edge is observed when a time-sliced pass
  // parks in a gap, the resume edge when the work loop re-enters it — at
  // most once per gap, strictly alternating (a double yield or double
  // resume is structurally unemittable), ordered start < yield < resume <
  // end, with the frame closing only at the commit.
  it('emits yield and resume edges around time-slicing gaps, strictly alternating', async () => {
    const {events, unsubscribe} = subscribe();
    let setValue;
    function App() {
      const [value, _setValue] = useState(0);
      setValue = _setValue;
      return (
        <>
          <Text text={`A${value}`} />
          <Text text={`B${value}`} />
          <Text text={`C${value}`} />
        </>
      );
    }
    const root = ReactNoop.createRoot();
    await act(() => {
      root.render(<App />);
    });
    assertLog(['A0', 'B0', 'C0']);
    const container = events.passes[0].container;

    await act(async () => {
      startTransition(() => setValue(1));
      await waitFor(['A1']);
      const startIndex = events.log.indexOf(
        events.passes[events.passes.length - 1],
      );
      // Exactly one yield since the pass started: the frame is parked in
      // its first gap, open (no end), and nothing else fired on this root.
      expect(frameEventsFor(events, container, startIndex + 1)).toEqual([
        'yield',
      ]);

      await waitFor(['B1']);
      // Re-entry resumed the pass exactly once before more work rendered,
      // then parked it again — never two yields (or resumes) in a row.
      expect(frameEventsFor(events, container, startIndex + 1)).toEqual([
        'yield',
        'resume',
        'yield',
      ]);

      await waitForAll(['C1']);
      // The final resume runs the tree to completion; the frame stays open
      // through completion and closes at the commit, and only then does
      // the committed view advance.
      expect(frameEventsFor(events, container, startIndex + 1)).toEqual([
        'yield',
        'resume',
        'yield',
        'resume',
        'end(commit)',
        'rootCommitted',
      ]);
    });
    expect(checkFrameInvariants(events.log)).toEqual([]);
    unsubscribe();
  });

  // Spec test 9: a handler running in a yield gap observes NOT-in-render —
  // truth is per callstack, not per frame — while component bodies inside
  // the very same (still open) pass observe the render context.
  it('a handler in a yield gap classifies as not-in-render while the frame is open', async () => {
    const {events, unsubscribe} = subscribe();
    const renderContexts = [];
    let setValue;
    function App() {
      const [value, _setValue] = useState(0);
      setValue = _setValue;
      renderContexts.push(React.unstable_getRenderContext());
      return (
        <>
          <Text text={`A${value}`} />
          <Text text={`B${value}`} />
        </>
      );
    }
    const root = ReactNoop.createRoot();
    await act(() => {
      root.render(<App />);
    });
    assertLog(['A0', 'B0']);
    const container = events.passes[0].container;

    await act(async () => {
      startTransition(() => setValue(1));
      await waitFor(['A1']);

      // The frame is open and parked in a gap: start seen, yield seen,
      // no end.
      const startIndex = events.log.indexOf(
        events.passes[events.passes.length - 1],
      );
      expect(frameEventsFor(events, container, startIndex + 1)).toEqual([
        'yield',
      ]);

      // Per-callstack truth in the gap: not in render, and a write issued
      // right now would not be deferred.
      expect(React.unstable_getRenderContext()).toBe(null);
      expect(React.unstable_isCurrentWriteDeferred()).toBe(false);

      await waitForAll(['B1']);
    });

    // Every component-body probe observed the render context with the
    // right container — including the probe inside the yielded pass.
    expect(renderContexts.length).toBeGreaterThanOrEqual(2);
    renderContexts.forEach(ctx => {
      expect(ctx).not.toBe(null);
      expect(ctx.container).toBe(container);
    });
    expect(checkFrameInvariants(events.log)).toEqual([]);
    unsubscribe();
  });

  // Spec test 10 — the regression scar that motivated per-callstack truth:
  // a consumer modeling "in render on this root" as the wall-clock
  // [passStart, passEnd) interval would attribute a yield-gap write to the
  // open pass's deferred batch. The truth: the gap write mints the ambient
  // urgent batch, distinct from the open pass's transition batch, and
  // reaches the committed view through its own (earlier) commit.
  it('wall-clock pass scope is wrong: a yield-gap write joins the ambient batch, not the open pass', async () => {
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

    let t = null;
    let gapToken = null;
    await act(async () => {
      startTransition(() => {
        t = React.unstable_getCurrentWriteBatch();
        setValue(1);
      });
      await waitFor(['U0', 'A1']);

      // The wall-clock model says "in render": the frame IS open (start,
      // yield, no end). But the write happening NOW classifies against the
      // callstack:
      const openFrame = events.passes[events.passes.length - 1];
      expect(openFrame.included).toEqual([t]);
      expect(
        frameEventsFor(events, container, events.log.indexOf(openFrame) + 1),
      ).toEqual(['yield']);

      gapToken = React.unstable_getCurrentWriteBatch();
      setUrgent(1); // same callstack: joins gapToken's ambient batch
      expect(gapToken).not.toBe(t);
      expect(gapToken & 1).toBe(0); // urgent, not deferred
      expect(t & 1).toBe(1);

      // Default priority does not preempt a transition: the open pass
      // resumes and finishes WITHOUT the gap write (still U0), commits,
      // and only then does the gap batch render and commit.
      await waitForAll(['B1', 'U1', 'A1', 'B1']);
    });

    // The open pass committed exactly its own write set — the gap write,
    // which wall-clock attribution would have folded into it (tearing the
    // committed view), landed in its own distinct, later commit.
    const gapCommit = events.commits.find(c => c.tokens.includes(gapToken));
    const tCommit = events.commits.find(c => c.tokens.includes(t));
    expect(gapCommit).not.toBe(undefined);
    expect(tCommit).not.toBe(undefined);
    expect(gapCommit).not.toBe(tCommit);
    expect(tCommit.tokens).toEqual([t]); // no gap-write leak into the pass
    expect(gapCommit.tokens).toEqual([gapToken]);
    expect(events.log.indexOf(tCommit)).toBeLessThan(
      events.log.indexOf(gapCommit),
    );
    expect(checkFrameInvariants(events.log)).toEqual([]);
    unsubscribe();
  });

  // Spec test 22: a same-root urgent commit discards an older yielded
  // same-root pass BEFORE any committed-view advance, and the discarded
  // pass's batch reaches the committed view only through a fresh pass.
  it('an urgent commit discards an older yielded pass before any committed-view advance', async () => {
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
          <Text text={`C${value}`} />
        </>
      );
    }
    const root = ReactNoop.createRoot();
    await act(() => {
      root.render(<App />);
    });
    assertLog(['U0', 'A0', 'B0', 'C0']);
    const container = events.passes[0].container;

    let t = null;
    let u = null;
    await act(async () => {
      startTransition(() => {
        t = React.unstable_getCurrentWriteBatch();
        setValue(1);
      });
      // Partially render the transition, then yield: the pass stays open.
      await waitFor(['U0', 'A1']);

      const yieldedPassStart = events.passes[events.passes.length - 1];
      expect(yieldedPassStart.included).toEqual([t]);
      const yieldedIndex = events.log.indexOf(yieldedPassStart);

      // In the yield gap, an urgent same-root update commits synchronously.
      ReactNoop.flushSync(() => {
        u = React.unstable_getCurrentWriteBatch();
        setUrgent(1);
      });
      assertLog(['U1', 'A0', 'B0', 'C0']);
      expect(t & 1).toBe(1);
      expect(u & 1).toBe(0);

      // Serialization, with dispositions: after the yielded pass started,
      // the first same-root pass-end is the DISCARD of that yielded pass,
      // and the urgent commit's view advance arrives only after it —
      // through the urgent pass's own frame closing with the commit
      // disposition. Never an advance while a frame was open.
      const tail = events.log.slice(yieldedIndex + 1);
      const endOffset = tail.findIndex(
        e => e.type === 'passEnd' && e.container === container,
      );
      const commitOffset = tail.findIndex(
        e => e.type === 'rootCommitted' && e.container === container,
      );
      expect(endOffset).not.toBe(-1);
      expect(commitOffset).not.toBe(-1);
      expect(endOffset).toBeLessThan(commitOffset);
      expect(tail[endOffset].committed).toBe(false); // the discard edge
      expect(
        frameEventsFor(events, container, yieldedIndex + 1).slice(0, 5),
      ).toEqual([
        'yield', // the open pass parked in its gap
        'end(discard)', // …is discarded by the urgent restart, mid-gap…
        'start',
        'end(commit)', // …and only the urgent pass's own close commits…
        'rootCommitted', // …immediately before the reported advance.
      ]);

      // The urgent commit exposes only the urgent batch; the discarded
      // pass's transition batch stays out of the committed view.
      const urgentCommit = tail[commitOffset];
      expect(urgentCommit.tokens).toEqual([u]);

      // The interrupted transition then restarts from scratch and commits.
      await waitForAll(['U1', 'A1', 'B1', 'C1']);
    });

    // The transition batch reached the committed view exactly once, through
    // a fresh pass that started after the urgent commit — the discarded
    // pass itself never committed.
    const commitsWithT = events.commits.filter(c => c.tokens.includes(t));
    expect(commitsWithT.length).toBe(1);
    const passStartsWithT = events.passes.filter(p => p.included.includes(t));
    expect(passStartsWithT.length).toBe(2); // original + post-discard restart
    const urgentCommitIndex = events.log.findIndex(
      e => e.type === 'rootCommitted' && e.tokens.includes(u),
    );
    const restartIndex = events.log.indexOf(passStartsWithT[1]);
    const tCommitIndex = events.log.indexOf(commitsWithT[0]);
    expect(urgentCommitIndex).toBeLessThan(restartIndex);
    expect(restartIndex).toBeLessThan(tCommitIndex);
    expect(events.retired.filter(r => r.token === t)).toEqual([
      {type: 'retired', token: t, committed: true},
    ]);
    expect(checkFrameInvariants(events.log)).toEqual([]);
    unsubscribe();
  });

  // Spec test 21: a discarded pass can never later commit — even when its
  // commit was already PENDING. A completed transition pass suspends its
  // commit on resource A; a second transition discards it (canceling that
  // pending commit) and suspends its own commit on resource B. Resolving
  // the discarded pass's resource later must be inert; only the live
  // frame's own resolution advances the committed view. Note the frame ≠
  // batch distinction: the discarded FRAME never commits, while its BATCH,
  // rebased into the restarted pass, commits with that fresh frame.
  // @gate enableViewTransition
  it('a discarded pass can never later commit', async () => {
    const {events, unsubscribe} = subscribe();
    let setSrc;
    function App() {
      const [src, _setSrc] = useState(null);
      setSrc = _setSrc;
      return (
        <ViewTransition>
          <Text text={src === null ? 'empty' : `showing ${src}`} />
          {src !== null ? (
            <suspensey-thing
              src={src}
              onLoadStart={() => Scheduler.log(`load ${src}`)}
            />
          ) : null}
        </ViewTransition>
      );
    }
    const root = ReactNoop.createRoot();
    await act(() => {
      root.render(<App />);
    });
    assertLog(['empty']);
    const container = events.passes[0].container;
    expect(events.commits.length).toBe(1);

    // Pass 1 completes; its commit suspends on image A. Frame stays open.
    let tA = null;
    await act(() => {
      startTransition(() => {
        tA = React.unstable_getCurrentWriteBatch();
        setSrc('A');
      });
    });
    assertLog(['showing A', 'load A']);
    expect(ReactNoop.getSuspenseyThingStatus('A')).toBe('pending');
    expect(events.commits.length).toBe(1);
    const passA = events.passes[events.passes.length - 1];
    expect(passA.included).toEqual([tA]);
    const passAIndex = events.log.indexOf(passA);

    // Pass 2 (another transition) discards pass 1 — canceling its pending
    // commit — and suspends its own commit on image B. Both transition
    // lanes rebase into the fresh pass, so it includes both batches.
    let tB = null;
    await act(() => {
      startTransition(() => {
        tB = React.unstable_getCurrentWriteBatch();
        setSrc('B');
      });
    });
    assertLog(['showing B', 'load B']);
    expect(ReactNoop.getSuspenseyThingStatus('B')).toBe('pending');
    expect(events.commits.length).toBe(1);
    const passB = events.passes[events.passes.length - 1];
    expect(passB).not.toBe(passA);
    expect(new Set(passB.included)).toEqual(new Set([tA, tB]));
    // Pass 1's frame closed with the discard disposition before pass 2
    // started.
    const discardAIndex = events.log.findIndex(
      (e, i) =>
        i > passAIndex && e.type === 'passEnd' && e.container === container,
    );
    expect(discardAIndex).not.toBe(-1);
    expect(events.log[discardAIndex].committed).toBe(false);
    expect(discardAIndex).toBeLessThan(events.log.indexOf(passB));

    // THE PIN: the discarded pass's resource resolves — its canceled
    // commit must be inert. No committed-view advance, no channel events,
    // no output change.
    const logLengthBefore = events.log.length;
    await act(() => {
      ReactNoop.resolveSuspenseyThing('A');
    });
    assertLog([]);
    expect(events.log.length).toBe(logLengthBefore);
    expect(events.commits.length).toBe(1);
    expect(root).toMatchRenderedOutput('empty');

    // The live frame's own resource commits it: exactly one new commit,
    // carrying both rebased batches, closing pass 2's frame with the
    // commit disposition.
    await act(() => {
      ReactNoop.resolveSuspenseyThing('B');
    });
    assertLog([]);
    expect(root).toMatchRenderedOutput(
      <>
        showing B
        <suspensey-thing src="B" />
      </>,
    );
    expect(events.commits.length).toBe(2);
    expect(new Set(events.commits[1].tokens)).toEqual(new Set([tA, tB]));
    expect(
      frameEventsFor(events, container, events.log.indexOf(passB) + 1),
    ).toEqual(['end(commit)', 'rootCommitted']);
    expect(
      events.retired
        .filter(r => r.token === tA || r.token === tB)
        .map(r => r.committed),
    ).toEqual([true, true]);
    expect(checkFrameInvariants(events.log)).toEqual([]);
    unsubscribe();
  });

  // Spec test 24: updates inserted after a pass has completed but not yet
  // committed force a pre-commit restart — the completed tree is discarded
  // without ever reaching the committed view, and the batch commits later
  // through a fresh pass. The completed-but-uncommitted window is a
  // suspensey commit: <ViewTransition> opts its subtree into
  // SuspenseyImagesMode, so a pending suspensey-thing suspends the commit
  // phase even while enableSuspenseyImages is off.
  // @gate enableViewTransition
  it('an update inserted after a completed-but-uncommitted pass forces a pre-commit restart', async () => {
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

    // A transition mounts the suspensey image: the render pass COMPLETES
    // (pass-end edge fires) but the commit suspends on the pending image.
    let t = null;
    await act(() => {
      startTransition(() => {
        t = React.unstable_getCurrentWriteBatch();
        setSrc('A');
      });
    });
    assertLog(['step 0 +img', 'Image requested [A]']);
    expect(ReactNoop.getSuspenseyThingStatus('A')).toBe('pending');

    // Completed but not committed, observed through the channel: the pass
    // frame that included the batch is STILL OPEN — under the
    // end-disposition semantics a frame outlives render completion and
    // waits for its commit or discard edge — so no pass-end fired, no
    // commit report followed, the token is live, the committed view
    // unchanged.
    const completedPass = events.passes[events.passes.length - 1];
    expect(completedPass.included).toEqual([t]);
    const completedIndex = events.log.indexOf(completedPass);
    const afterCompleted = events.log.slice(completedIndex + 1);
    expect(
      afterCompleted.some(
        e => e.type === 'passEnd' && e.container === container,
      ),
    ).toBe(false);
    expect(events.commits.length).toBe(1); // the mount only
    expect(events.retired.map(r => r.token)).not.toContain(t);
    expect(root).toMatchRenderedOutput('step 0');

    // Insertion: an urgent update while the completed tree waits to commit.
    let u = null;
    await act(() => {
      u = React.unstable_getCurrentWriteBatch();
      setStep(1);
    });
    // The urgent pass commits first (without the pending transition batch),
    // then React RESTARTS the transition work from scratch — the previously
    // completed tree was discarded before it ever committed. The restarted
    // pass completes and suspends its commit again (image still pending).
    assertLog(['step 1', 'step 1 +img']);
    expect(root).toMatchRenderedOutput('step 1');

    // Exactly one new commit (the urgent one), carrying only the urgent
    // batch: no commit of the transition batch ever happened.
    expect(events.commits.length).toBe(2);
    const urgentCommit = events.commits[1];
    expect(urgentCommit.tokens).toEqual([u]);
    expect(events.retired.map(r => r.token)).not.toContain(t);

    // The insertion is what finally closed the completed-but-uncommitted
    // frame — with the DISCARD disposition (its pending commit was
    // canceled), before the urgent commit's view advance.
    const discardIndex = events.log.findIndex(
      (e, i) =>
        i > completedIndex && e.type === 'passEnd' && e.container === container,
    );
    expect(discardIndex).not.toBe(-1);
    expect(events.log[discardIndex].committed).toBe(false);
    expect(discardIndex).toBeLessThan(events.log.indexOf(urgentCommit));

    // The pre-commit restart, in order: completed pass with t, then the
    // urgent commit, then a FRESH pass including t.
    const urgentCommitIndex = events.log.indexOf(urgentCommit);
    expect(urgentCommitIndex).toBeGreaterThan(completedIndex);
    const passStartsWithT = events.passes.filter(p => p.included.includes(t));
    expect(passStartsWithT.length).toBe(2); // original + post-insertion restart
    const restartIndex = events.log.indexOf(passStartsWithT[1]);
    expect(restartIndex).toBeGreaterThan(urgentCommitIndex);

    // The image resolves: the suspended commit proceeds, the batch reaches
    // the committed view exactly once, and the token retires.
    await act(() => {
      ReactNoop.resolveSuspenseyThing('A');
    });
    assertLog([]);
    expect(root).toMatchRenderedOutput(
      <>
        step 1 +img
        <suspensey-thing src="A" />
      </>,
    );
    expect(events.commits.length).toBe(3);
    expect(events.commits[2].tokens).toEqual([t]);
    expect(events.retired.filter(r => r.token === t)).toEqual([
      {type: 'retired', token: t, committed: true},
    ]);

    // The frame that closed here is the restarted pass's — closed exactly
    // once, with the commit disposition, at RESOLUTION time: its close was
    // deferred from render completion (the previous act) to the moment the
    // suspended commit could actually land.
    const closesAfterRestart = events.log.filter(
      (e, i) =>
        i > restartIndex && e.type === 'passEnd' && e.container === container,
    );
    expect(closesAfterRestart).toEqual([
      {type: 'passEnd', container, committed: true},
    ]);
    expect(checkFrameInvariants(events.log)).toEqual([]);
    unsubscribe();
  });

  // Spec test 27: unstable_discardAllWip synchronously abandons every WIP
  // pass on every root — a pass parked mid-render in a yield gap AND a
  // completed-but-uncommitted pass whose commit is suspended on resources —
  // firing each frame's end(discard) edge before it returns and starting
  // nothing new. The abandoned batches stay live; React re-schedules them,
  // and every later retry is a FRESH pass (a new passStart over the same
  // tokens) that commits normally. A second call with nothing in flight is
  // a no-op.
  // @gate enableViewTransition
  it('discardAllWip synchronously closes every open frame on every root; retries are fresh passes', async () => {
    const {events, unsubscribe} = subscribe();
    let setValue;
    function AppA() {
      const [value, _setValue] = useState(0);
      setValue = _setValue;
      return (
        <>
          <Text text={`a${value}`} />
          <Text text={`b${value}`} />
          <Text text={`c${value}`} />
        </>
      );
    }
    let setSrc;
    function AppB() {
      const [src, _setSrc] = useState(null);
      setSrc = _setSrc;
      return (
        <ViewTransition>
          <Text text={src === null ? 'empty' : `showing ${src}`} />
          {src !== null ? (
            <suspensey-thing
              src={src}
              onLoadStart={() => Scheduler.log(`load ${src}`)}
            />
          ) : null}
        </ViewTransition>
      );
    }
    const rootA = ReactNoop.createRoot();
    await act(() => {
      rootA.render(<AppA />);
    });
    assertLog(['a0', 'b0', 'c0']);
    const containerA = events.passes[0].container;
    const rootB = ReactNoop.createRoot();
    await act(() => {
      rootB.render(<AppB />);
    });
    assertLog(['empty']);
    const containerB = events.passes[events.passes.length - 1].container;
    expect(containerB).not.toBe(containerA);

    // Root B: completed pass, commit suspended on the image — frame open.
    let tB = null;
    await act(() => {
      startTransition(() => {
        tB = React.unstable_getCurrentWriteBatch();
        setSrc('X');
      });
    });
    assertLog(['showing X', 'load X']);
    expect(ReactNoop.getSuspenseyThingStatus('X')).toBe('pending');
    expect(events.commits.length).toBe(2); // the two mounts only

    let tA = null;
    await act(async () => {
      // Root A: transition parked mid-render in a yield gap — frame open.
      startTransition(() => {
        tA = React.unstable_getCurrentWriteBatch();
        setValue(1);
      });
      await waitFor(['a1']);

      // Discard everything, synchronously: exactly two events appear
      // before the call returns — one end(discard) per open frame — and
      // nothing new has started or committed.
      const logLengthBefore = events.log.length;
      React.unstable_discardAllWip();
      const discardEvents = events.log.slice(logLengthBefore);
      expect(discardEvents.length).toBe(2);
      discardEvents.forEach(e => {
        expect(e.type).toBe('passEnd');
        expect(e.committed).toBe(false);
      });
      expect(new Set(discardEvents.map(e => e.container))).toEqual(
        new Set([containerA, containerB]),
      );
      expect(events.commits.length).toBe(2);
      // The batches themselves stay live: nothing retired.
      expect(events.retired.length).toBe(0);

      // With no frame open, a second call is a no-op.
      React.unstable_discardAllWip();
      expect(events.log.length).toBe(logLengthBefore + 2);

      // React re-schedules the abandoned lanes: each root retries as a
      // FRESH pass over the same still-live batch. Root A's retry renders
      // from scratch and commits; root B's re-suspends its commit on the
      // still-pending image.
      await waitForAll(['a1', 'b1', 'c1', 'showing X']);
    });
    const aPasses = events.passes.filter(p => p.included.includes(tA));
    expect(aPasses.length).toBe(2); // original + post-discard fresh pass
    const bPasses = events.passes.filter(p => p.included.includes(tB));
    expect(bPasses.length).toBe(2);
    const aCommits = events.commits.filter(c => c.tokens.includes(tA));
    expect(aCommits.length).toBe(1);
    expect(aCommits[0].container).toBe(containerA);
    expect(events.retired.filter(r => r.token === tA)).toEqual([
      {type: 'retired', token: tA, committed: true},
    ]);
    expect(events.retired.map(r => r.token)).not.toContain(tB);

    // The image resolves: root B's retried pass commits — its frame closes
    // with the commit disposition, only now.
    await act(() => {
      ReactNoop.resolveSuspenseyThing('X');
    });
    assertLog([]);
    const bCommits = events.commits.filter(c => c.tokens.includes(tB));
    expect(bCommits.length).toBe(1);
    expect(bCommits[0].container).toBe(containerB);
    expect(events.retired.filter(r => r.token === tB)).toEqual([
      {type: 'retired', token: tB, committed: true},
    ]);
    expect(checkFrameInvariants(events.log)).toEqual([]);
    unsubscribe();
  });

  // Spec test 28: no same-root committed-view advance while a same-root
  // pass frame is open — checked as an invariant at every commit across an
  // interleaving that includes a yielded pass, a cross-root commit inside
  // the yield gap (allowed: the invariant is per root, not global), a
  // same-root urgent interrupt, and the restarted transition's commit.
  // Under the end-disposition semantics the frame close is itself part of
  // the commit sequence (end(commit) fires inside commitRoot, before the
  // advance is reported), so this invariant holds by construction — this
  // test keeps proving it against real scheduler interleavings, where the
  // frames being closed are discarded/restarted ones, not just the
  // committing pass's own.
  it('never advances a committed view while the same root has an open pass frame', async () => {
    const openByContainer = new Map();
    let totalCommits = 0;
    let sameRootCommitsDuringOpenPass = 0;
    let crossRootCommitsDuringOpenPass = 0;
    const unsubscribe = React.unstable_subscribeToExternalRuntime({
      onRenderPassStart(container) {
        openByContainer.set(container, true);
      },
      onRenderPassEnd(container) {
        openByContainer.set(container, false);
      },
      onRootCommitted(container) {
        totalCommits++;
        if (openByContainer.get(container) === true) {
          sameRootCommitsDuringOpenPass++;
        } else {
          let anyOtherOpen = false;
          openByContainer.forEach((open, other) => {
            if (open && other !== container) {
              anyOtherOpen = true;
            }
          });
          if (anyOtherOpen) {
            crossRootCommitsDuringOpenPass++;
          }
        }
      },
    });

    let setValue;
    let setUrgent;
    function AppA() {
      const [value, _setValue] = useState(0);
      const [urgent, _setUrgent] = useState(0);
      setValue = _setValue;
      setUrgent = _setUrgent;
      return (
        <>
          <Text text={`u${urgent}`} />
          <Text text={`x${value}`} />
          <Text text={`y${value}`} />
          <Text text={`z${value}`} />
        </>
      );
    }
    let setB;
    function AppB() {
      const [on, _set] = useState(false);
      setB = _set;
      return <Text text={`b${on}`} />;
    }

    const rootA = ReactNoop.createRoot();
    await act(() => {
      rootA.render(<AppA />);
    });
    assertLog(['u0', 'x0', 'y0', 'z0']);
    const rootB = ReactNoop.createRoot();
    await act(() => {
      rootB.render(<AppB />);
    });
    assertLog(['bfalse']);

    await act(async () => {
      startTransition(() => {
        setValue(1);
      });
      // Yield mid-pass on root A: A's frame stays open.
      await waitFor(['u0', 'x1']);

      // A commit on the OTHER root while A's frame is open: legal, and
      // proves the invariant below is per-root scoped rather than
      // trivially satisfied by nothing overlapping.
      ReactNoop.flushSync(() => {
        setB(true);
      });
      assertLog(['btrue']);

      // A same-root urgent commit: React must close (discard) A's open
      // frame before this commit's view advance.
      ReactNoop.flushSync(() => {
        setUrgent(1);
      });
      assertLog(['u1', 'x0', 'y0', 'z0']);

      // Let the interrupted transition restart and commit.
      await waitForAll(['u1', 'x1', 'y1', 'z1']);
    });

    // Mounts (2) + cross-root B commit + urgent A commit + transition A
    // commit = 5 committed-view advances, none while its own root had an
    // open pass frame, at least one while ANOTHER root's frame was open.
    expect(totalCommits).toBe(5);
    expect(sameRootCommitsDuringOpenPass).toBe(0);
    expect(crossRootCommitsDuringOpenPass).toBeGreaterThanOrEqual(1);
    unsubscribe();
  });
});
