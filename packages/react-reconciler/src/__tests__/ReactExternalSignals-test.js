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
let waitFor;
let waitForAll;
let assertLog;
let protocol;

describe('external signals protocol', () => {
  beforeEach(() => {
    jest.resetModules();
    React = require('react');
    ReactNoop = require('react-noop-renderer');
    Scheduler = require('scheduler');
    const InternalTestUtils = require('internal-test-utils');
    act = InternalTestUtils.act;
    waitFor = InternalTestUtils.waitFor;
    waitForAll = InternalTestUtils.waitForAll;
    assertLog = InternalTestUtils.assertLog;
    protocol =
      React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.L;
  });

  it('classifies a transition and pins corrective updates to its lane', () => {
    expect(protocol.version).toBe(1);
    expect(protocol.getWriteLane()).toBe(0);
    let lane;
    React.startTransition(() => {
      lane = protocol.getWriteLane();
      expect(protocol.getWriteLane()).toBe(lane);
    });
    expect(lane).not.toBe(0);
    protocol.runInLane(lane, () => {
      expect(protocol.getWriteLane()).toBe(lane);
    });
  });

  it('reports the render world and its commit disposition', async () => {
    const events = [];
    const stop = protocol.subscribe(event => events.push(event));
    const root = ReactNoop.createRoot();
    let context;
    function App() {
      context = protocol.getRenderContext();
      return 'ok';
    }
    await act(() => root.render(<App />));
    expect(context).not.toBe(null);
    expect(context.lanes).not.toBe(0);
    expect(events.map(event => `${event.type}:${event.phase || ''}`)).toEqual(
      expect.arrayContaining(['pass:start', 'pass:commit', 'commit:']),
    );
    expect(events.find(event => event.type === 'commit').finished).not.toBe(0);
    stop();
  });

  it('commits a correction in the lane supplied by the caller', async () => {
    const events = [];
    const stop = protocol.subscribe(event => events.push(event));
    const root = ReactNoop.createRoot();
    let update;
    function App() {
      const [value, setValue] = React.useState(0);
      update = setValue;
      return value;
    }
    await act(() => root.render(<App />));
    let lane;
    React.startTransition(() => {
      lane = protocol.getWriteLane();
    });
    await act(() => protocol.runInLane(lane, () => update(1)));
    const commit = events.filter(event => event.type === 'commit').pop();
    expect(commit.lanes & lane).toBe(lane);
    stop();
  });

  it('lets urgent work interrupt a lane-pinned correction', async () => {
    let updateSlow;
    let updateUrgent;
    function Text({text}) {
      Scheduler.log(text);
      return text;
    }
    function App() {
      const [slow, setSlow] = React.useState(0);
      const [urgent, setUrgent] = React.useState(0);
      updateSlow = setSlow;
      updateUrgent = setUrgent;
      React.useLayoutEffect(() => Scheduler.log('Commit'));
      return (
        <>
          <Text text={'Slow: ' + slow} />
          {slow === 1 ? (
            <>
              <Text text="A" />
              <Text text="B" />
              <Text text="C" />
            </>
          ) : null}
          <Text text={'Urgent: ' + urgent} />
        </>
      );
    }
    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['Slow: 0', 'Urgent: 0', 'Commit']);
    let lane;
    React.startTransition(() => {
      lane = protocol.getWriteLane();
    });
    protocol.runInLane(lane, () => updateSlow(1));
    await waitFor(['Slow: 1', 'A']);
    ReactNoop.flushSync(() => updateUrgent(1));
    assertLog(['Slow: 0', 'Urgent: 1', 'Commit']);
    await waitForAll(['Slow: 1', 'A', 'B', 'C', 'Urgent: 1', 'Commit']);
  });

  it('brackets the host mutation phase', async () => {
    const phases = [];
    const stop = protocol.subscribe(event => {
      if (event.type === 'mutation') phases.push(event.phase);
    });
    const root = ReactNoop.createRoot();
    await act(() => root.render(<span>A</span>));
    expect(phases).toEqual(['start', 'stop']);
    stop();
  });
});
