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
 * Existence proofs for the pass/commit serialization and insertion facts of
 * the external-runtime protocol (cosignal spec §4.1 facts 2 and 4, §4.4
 * tests 22, 24, 28): a same-root commit never happens while an older
 * same-root pass is still in flight (React discards the pass first and
 * restarts it after), and work inserted after a pass has completed — but not
 * yet committed — forces a pre-commit restart rather than committing the
 * stale tree.
 *
 * Channel semantics pinned here (current generation): a pass frame opens at
 * onRenderPassStart and closes at onRenderPassEnd, which fires when the
 * render loop completes the tree (before the commit) or implicitly when a
 * restart discards the work-in-progress. The planned yield/resume +
 * end-disposition edges (spec fact 2, session S3) will extend the frame to
 * the commit/discard edge; the serialization fact proven below — the
 * discard edge always precedes any same-root committed-view advance — is
 * what that extension builds on.
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

      // Serialization: after the yielded pass started, the first
      // committed-view advance on this root comes AFTER the pass-end edge
      // that discarded the yielded pass — never while it was open.
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
    // that included the batch ended (the tree is done), yet no commit
    // report followed and the token is still live.
    const completedPass = events.passes[events.passes.length - 1];
    expect(completedPass.included).toEqual([t]);
    const completedIndex = events.log.indexOf(completedPass);
    const afterCompleted = events.log.slice(completedIndex + 1);
    expect(
      afterCompleted.some(
        e => e.type === 'passEnd' && e.container === container,
      ),
    ).toBe(true);
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
    unsubscribe();
  });

  // Spec test 28: no same-root committed-view advance while a same-root
  // pass frame is open — checked as an invariant at every commit across an
  // interleaving that includes a yielded pass, a cross-root commit inside
  // the yield gap (allowed: the invariant is per root, not global), a
  // same-root urgent interrupt, and the restarted transition's commit.
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
