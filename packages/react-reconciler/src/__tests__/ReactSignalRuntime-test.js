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
let waitForAll;

describe('ReactSignalRuntime', () => {
  beforeEach(() => {
    jest.resetModules();
    React = require('react');
    ReactNoop = require('react-noop-renderer');
    Scheduler = require('scheduler');
    waitForAll = require('internal-test-utils').waitForAll;
  });

  it('uses one React lane as the transition write identity', () => {
    let firstLane;
    let secondLane;
    let deferred;

    React.startTransition(() => {
      firstLane = React.unstable_getCurrentSignalWriteLane();
      secondLane = React.unstable_getCurrentSignalWriteLane();
      deferred = React.unstable_isCurrentSignalWriteDeferred();
    });

    expect(firstLane).toBeGreaterThan(0);
    expect(secondLane).toBe(firstLane);
    expect(deferred).toBe(true);
    expect(React.unstable_isCurrentSignalWriteDeferred()).toBe(false);
  });

  it('reports the active render lanes and commit edges', async () => {
    const events = [];
    const contexts = [];
    let setValue;
    let transitionLane;
    const unsubscribe = React.unstable_subscribeToSignalRuntime({
      onRenderStart(container, lanes) {
        events.push(['render-start', container, lanes]);
      },
      onCommitStart(container, lanes) {
        events.push(['commit-start', container, lanes]);
      },
      onCommitStop(container, lanes, remainingLanes) {
        events.push(['commit-stop', container, lanes, remainingLanes]);
      },
      onRenderStop(container, lanes, committed) {
        events.push(['render-stop', container, lanes, committed]);
      },
    });

    function App() {
      const [value, set] = React.useState(0);
      setValue = set;
      contexts.push(React.unstable_getSignalRenderContext());
      Scheduler.log(value);
      return value;
    }

    const root = ReactNoop.createRoot();
    root.render(<App />);
    await waitForAll([0]);
    events.length = 0;
    contexts.length = 0;

    React.startTransition(() => {
      transitionLane = React.unstable_getCurrentSignalWriteLane();
      React.unstable_runWithSignalLane(transitionLane, () => setValue(1));
    });
    await waitForAll([1]);

    expect(contexts).toHaveLength(1);
    expect(contexts[0].lanes & transitionLane).toBe(transitionLane);
    expect(events.map(event => event[0])).toEqual([
      'render-start',
      'commit-start',
      'render-stop',
      'commit-stop',
    ]);
    expect(events[0][2] & transitionLane).toBe(transitionLane);
    expect(events[2][3]).toBe(true);
    unsubscribe();
  });

  it('lets lane zero escape a surrounding transition', async () => {
    let setDeferred;
    let setUrgent;

    function App() {
      const [deferred, setDeferredState] = React.useState(0);
      const [urgent, setUrgentState] = React.useState(0);
      setDeferred = setDeferredState;
      setUrgent = setUrgentState;
      Scheduler.log(`${deferred}:${urgent}`);
      return null;
    }

    const root = ReactNoop.createRoot();
    root.render(<App />);
    await waitForAll(['0:0']);

    React.startTransition(() => {
      const lane = React.unstable_getCurrentSignalWriteLane();
      React.unstable_runWithSignalLane(lane, () => setDeferred(1));
      React.unstable_runWithSignalLane(0, () => setUrgent(1));
    });
    await waitForAll(['0:1', '1:1']);
  });

  it('keeps a layout correction on its owning lane', async () => {
    const renderLanes = [];
    const remainingLanes = [];
    let setVisible;
    let transitionLane;
    const unsubscribe = React.unstable_subscribeToSignalRuntime({
      onRenderStart(container, lanes) {
        renderLanes.push(lanes);
      },
      onCommitStop(container, lanes, remaining) {
        if ((lanes & transitionLane) !== 0) remainingLanes.push(remaining);
      },
    });

    function Child() {
      const [revision, setRevision] = React.useState(0);
      React.useLayoutEffect(() => {
        if (revision === 0) {
          React.unstable_runWithSignalLane(transitionLane, () => {
            setRevision(1);
          });
        }
      }, [revision]);
      Scheduler.log(`child:${revision}`);
      return null;
    }

    function App() {
      const [visible, set] = React.useState(false);
      setVisible = set;
      return visible ? <Child /> : null;
    }

    const root = ReactNoop.createRoot();
    root.render(<App />);
    await waitForAll([]);
    renderLanes.length = 0;

    React.startTransition(() => {
      transitionLane = React.unstable_getCurrentSignalWriteLane();
      React.unstable_runWithSignalLane(transitionLane, () => setVisible(true));
    });
    await waitForAll(['child:0', 'child:1']);

    expect(renderLanes).toHaveLength(2);
    expect(renderLanes[0] & transitionLane).toBe(transitionLane);
    expect(renderLanes[1] & transitionLane).toBe(transitionLane);
    expect(remainingLanes[0] & transitionLane).toBe(transitionLane);
    expect(remainingLanes[1] & transitionLane).toBe(0);
    unsubscribe();
  });

  it('brackets mutation before layout and closes the commit afterward', async () => {
    const events = [];
    const unsubscribe = React.unstable_subscribeToSignalRuntime({
      onCommitStart() {
        events.push('commit-start');
      },
      onMutationStart() {
        events.push('mutation-start');
      },
      onMutationStop() {
        events.push('mutation-stop');
      },
      onCommitStop() {
        events.push('commit-stop');
      },
    });

    function App() {
      React.useLayoutEffect(() => {
        events.push('layout');
      });
      return 'value';
    }

    const root = ReactNoop.createRoot();
    root.render(<App />);
    await waitForAll([]);
    expect(events).toEqual([
      'commit-start',
      'mutation-start',
      'mutation-stop',
      'layout',
      'commit-stop',
    ]);
    unsubscribe();
  });

  it('has one explicit, reclaimable listener slot', () => {
    const unsubscribe = React.unstable_subscribeToSignalRuntime({});
    expect(() => React.unstable_subscribeToSignalRuntime({})).toThrow(
      'Only one signal runtime can be registered at a time.',
    );
    unsubscribe();
    const nextUnsubscribe = React.unstable_subscribeToSignalRuntime({});
    nextUnsubscribe();
  });
});
