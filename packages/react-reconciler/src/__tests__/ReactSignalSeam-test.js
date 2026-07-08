/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 * @jest-environment node
 */

'use strict';

let React;
let ReactNoop;
let Scheduler;
let act;
let assertLog;
let seam;

describe('ReactSignalSeam', () => {
  beforeEach(() => {
    jest.resetModules();
    React = require('react');
    ReactNoop = require('react-noop-renderer');
    Scheduler = require('scheduler');
    act = require('internal-test-utils').act;
    assertLog = require('internal-test-utils').assertLog;
    seam = require('shared/ReactSignalSeam');
  });

  afterEach(() => {
    seam.registerSignalSeamRuntime(null);
  });

  function installRecorder() {
    const events = [];
    seam.registerSignalSeamRuntime({
      onPassStart(container, lanes) {
        events.push({kind: 'pass-start', container, lanes});
      },
      onPassCommit(container, lanes, remainingLanes) {
        events.push({kind: 'pass-commit', container, lanes, remainingLanes});
      },
      onMutationPhase(phase, container) {
        events.push({kind: 'mutation-' + phase, container});
      },
    });
    return events;
  }

  it('reports pass start and exactly one commit per flush, with matching lanes', async () => {
    const events = installRecorder();
    let setCount;
    function App() {
      const [count, setter] = React.useState(0);
      setCount = setter;
      return <span prop={count} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => {
      root.render(<App />);
    });
    events.length = 0;
    await act(() => {
      setCount(1);
    });
    const starts = events.filter(e => e.kind === 'pass-start' && e.lanes !== 0);
    const commits = events.filter(e => e.kind === 'pass-commit');
    expect(starts.length).toBe(1);
    expect(commits.length).toBe(1);
    expect(commits[0].lanes).toBe(starts[0].lanes);
    expect(commits[0].remainingLanes).toBe(0);
  });

  it('currentUpdateLane inside a transition names the lane the pass then renders', async () => {
    const events = installRecorder();
    let setCount;
    function App() {
      const [count, setter] = React.useState(0);
      setCount = setter;
      return <span prop={count} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => {
      root.render(<App />);
    });
    events.length = 0;
    let writeLane = 0;
    await act(() => {
      React.startTransition(() => {
        writeLane = seam.signalSeamCurrentUpdateLane();
        setCount(1);
      });
    });
    expect(writeLane).not.toBe(0);
    const commit = events.find(e => e.kind === 'pass-commit' && e.lanes !== 0);
    expect(commit.lanes & writeLane).toBe(writeLane);
  });

  it('runWithPinnedLane schedules into a live transition lane: one shared commit', async () => {
    const events = installRecorder();
    let setA;
    let setB;
    function App() {
      const [a, setterA] = React.useState(0);
      const [b, setterB] = React.useState(0);
      setA = setterA;
      setB = setterB;
      return <span prop={a * 10 + b} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => {
      root.render(<App />);
    });
    events.length = 0;
    let lane = 0;
    await act(() => {
      React.startTransition(() => {
        lane = seam.signalSeamCurrentUpdateLane();
        setA(1);
      });
      // A corrective update from outside the transition joins its lane.
      seam.runWithPinnedLane(lane, () => {
        setB(2);
      });
    });
    const commits = events.filter(
      e => e.kind === 'pass-commit' && e.lanes !== 0,
    );
    expect(commits.length).toBe(1);
    expect(root.getChildrenAsJSX().props.prop).toBe(12);
  });

  it('brackets the mutation phase exactly once per mutating commit', async () => {
    const events = installRecorder();
    const root = ReactNoop.createRoot();
    await act(() => {
      root.render(<span prop={1} />);
    });
    const brackets = events.filter(e => e.kind.startsWith('mutation-'));
    expect(brackets.map(e => e.kind)).toEqual([
      'mutation-start',
      'mutation-stop',
    ]);
    events.length = 0;
    await act(() => {
      root.render(<span prop={2} />);
    });
    const again = events.filter(e => e.kind.startsWith('mutation-'));
    expect(again.map(e => e.kind)).toEqual(['mutation-start', 'mutation-stop']);
    // The bracket sits between pass-commit bookkeeping and layout: the pass
    // commit event was reported before the mutation window opened.
    expect(events.findIndex(e => e.kind === 'pass-commit')).toBeLessThan(
      events.findIndex(e => e.kind === 'mutation-start'),
    );
  });

  it('currentRenderInfo is non-null exactly while rendering', async () => {
    installRecorder();
    const infos = [];
    function App() {
      infos.push(seam.signalSeamCurrentRenderInfo());
      return null;
    }
    const root = ReactNoop.createRoot();
    expect(seam.signalSeamCurrentRenderInfo()).toBe(null);
    await act(() => {
      root.render(<App />);
    });
    expect(infos.length).toBeGreaterThan(0);
    expect(infos[0]).not.toBe(null);
    expect(infos[0].lanes).not.toBe(0);
    expect(seam.signalSeamCurrentRenderInfo()).toBe(null);
  });

  it('a detached runtime costs nothing and throws nothing', async () => {
    const root = ReactNoop.createRoot();
    await act(() => {
      root.render(<span prop={1} />);
    });
    expect(root.getChildrenAsJSX().props.prop).toBe(1);
    Scheduler.unstable_clearLog();
    assertLog([]);
  });
});
