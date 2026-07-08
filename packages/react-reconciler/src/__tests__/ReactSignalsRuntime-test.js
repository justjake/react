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

describe('external transactional signals runtime', () => {
  beforeEach(() => {
    jest.resetModules();
    React = require('react');
    ReactNoop = require('react-noop-renderer');
    Scheduler = require('scheduler');
    waitForAll = require('internal-test-utils').waitForAll;
  });

  function runtime(events) {
    const lanes = new Map();
    return {
      lane(batch) {
        return lanes.get(batch) || 0;
      },
      schedule(root, lane, batch) {
        lanes.set(batch, lane);
        events.push(['schedule', lane, batch]);
      },
      render(root, lanes) {
        events.push(['render', lanes]);
        return ['world'];
      },
      commit(root, lanes, remaining) {
        events.push(['commit', lanes, remaining]);
      },
      mutation(root, start) {
        events.push(['mutation', start]);
      },
    };
  }

  it('publishes one render world only while React is rendering', async () => {
    const events = [];
    const signals = React.unstable_Signals;
    signals.register(runtime(events));
    function App() {
      Scheduler.log(signals.world());
      return <span />;
    }
    ReactNoop.render(<App />);
    await waitForAll([['world']]);
    expect(signals.world()).toBe(null);
    expect(events.some(event => event[0] === 'render')).toBe(true);
    expect(events.some(event => event[0] === 'commit')).toBe(true);
  });

  it('attributes updates and reuses the original transition lane', async () => {
    const events = [];
    const signals = React.unstable_Signals;
    signals.register(runtime(events));
    let set;
    function App() {
      const [value, update] = React.useState(0);
      set = update;
      Scheduler.log(value);
      return value;
    }
    ReactNoop.render(<App />);
    await waitForAll([0]);
    React.startTransition(() => signals.run(7, () => set(1)));
    await waitForAll([1]);
    const lane = events.find(event => event[0] === 'schedule')[1];
    signals.run(7, () => set(2));
    await waitForAll([2]);
    const schedules = events.filter(event => event[0] === 'schedule');
    expect(schedules).toEqual([
      ['schedule', lane, 7],
      ['schedule', lane, 7],
    ]);
  });

  it('rejects a competing runtime and can reset the registry', () => {
    const signals = React.unstable_Signals;
    signals.register(runtime([]));
    expect(() => signals.register(runtime([]))).toThrow(
      'different external signal runtime',
    );
    signals.reset();
    expect(() => signals.register(runtime([]))).not.toThrow();
  });
});
