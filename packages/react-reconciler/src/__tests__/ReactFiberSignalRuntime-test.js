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
let waitFor;
let waitForAll;
let assertLog;

describe('ReactFiberSignalRuntime', () => {
  beforeEach(() => {
    jest.resetModules();
    React = require('react');
    ReactNoop = require('react-noop-renderer');
    Scheduler = require('scheduler');
    const TestUtils = require('internal-test-utils');
    waitFor = TestUtils.waitFor;
    waitForAll = TestUtils.waitForAll;
    assertLog = TestUtils.assertLog;
  });

  it('classifies transition writes and pins correction updates to their lane', async () => {
    let setValue;
    let value;
    const commits = [];
    React.unstable_subscribeToSignalRuntime({
      onRootCommit(container, finishedLanes) {
        commits.push(finishedLanes);
      },
    });

    function App() {
      const state = React.useState(0);
      value = state[0];
      setValue = state[1];
      return value;
    }

    ReactNoop.render(<App />);
    await waitForAll([]);
    commits.length = 0;

    let lane;
    React.startTransition(() => {
      const classified = React.unstable_getSignalWriteLane();
      expect(classified).toBeLessThan(0);
      lane = -classified;
      setValue(1);
    });
    React.unstable_runInSignalLane(lane, () => {
      expect(React.unstable_getSignalWriteLane()).toBe(-lane);
      setValue(2);
    });
    await waitForAll([]);

    expect(value).toBe(2);
    expect(commits).toHaveLength(1);
    expect((commits[0] & lane) !== 0).toBe(true);
  });

  it('reports pass, pending-root, commit, and mutation edges in order', async () => {
    const events = [];
    let setValue;
    React.unstable_subscribeToSignalRuntime({
      onRenderStart(container, lanes) {
        events.push(['start', container, lanes]);
      },
      onRenderEnd(container, committed) {
        events.push(['end', container, committed]);
      },
      onRootPending(container, lanes) {
        events.push(['pending', container, lanes]);
      },
      onRootCommit(container, lanes) {
        events.push(['commit', container, lanes]);
      },
      onBeforeMutation(container) {
        events.push(['before', container]);
      },
      onAfterMutation(container) {
        events.push(['after', container]);
      },
      onEventEnd() {
        events.push(['event-end']);
      },
    });

    function App() {
      const state = React.useState(0);
      setValue = state[1];
      Scheduler.log(`render ${state[0]}`);
      expect(React.unstable_getSignalRenderRoot()).not.toBe(null);
      expect(React.unstable_getSignalRenderLanes()).not.toBe(0);
      return state[0];
    }

    ReactNoop.render(<App />);
    await waitForAll(['render 0']);
    events.length = 0;
    setValue(1);
    await waitForAll(['render 1']);

    const names = events.map(event => event[0]);
    expect(names).toContain('pending');
    expect(names).toContain('start');
    expect(names).toContain('end');
    expect(names).toContain('commit');
    expect(names.indexOf('start')).toBeLessThan(names.indexOf('end'));
    expect(names.indexOf('end')).toBeLessThan(names.indexOf('commit'));
    expect(names.indexOf('before')).toBeLessThan(names.indexOf('after'));
  });

  it('closes an interrupted pass as discard before starting its replacement', async () => {
    const ends = [];
    let setValue;
    React.unstable_subscribeToSignalRuntime({
      onRenderEnd(container, committed) {
        ends.push(committed);
      },
    });

    function Text({label, value}) {
      Scheduler.log(`${label}${value}`);
      return value;
    }

    function App() {
      const state = React.useState(0);
      setValue = state[1];
      return (
        <>
          <Text label="A" value={state[0]} />
          <Text label="B" value={state[0]} />
        </>
      );
    }

    ReactNoop.render(<App />);
    await waitForAll(['A0', 'B0']);
    ends.length = 0;
    React.startTransition(() => setValue(1));
    await waitFor(['A1']);
    ReactNoop.flushSync(() => setValue(2));
    assertLog(['A2', 'B2']);
    await waitForAll([]);

    expect(ends).toContain(false);
    expect(ends[ends.length - 1]).toBe(true);
  });

  it('closes a scheduling event even when an external write creates no React work', async () => {
    let eventEnds = 0;
    React.unstable_subscribeToSignalRuntime({
      onEventEnd() {
        eventEnds++;
      },
    });
    React.startTransition(() => {
      expect(React.unstable_getSignalWriteLane()).toBeLessThan(0);
    });
    await waitForAll([]);
    expect(eventEnds).toBe(1);
  });
});
