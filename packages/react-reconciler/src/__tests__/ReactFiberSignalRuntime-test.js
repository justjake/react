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
let act;
let events;

describe('ReactFiberSignalRuntime', () => {
  beforeEach(() => {
    jest.resetModules();
    React = require('react');
    ReactNoop = require('react-noop-renderer');
    act = require('internal-test-utils').act;
    events = [];
    React.unstable_registerSignalRuntime({
      batchScheduled(batch) {
        events.push(['batch', batch]);
      },
      renderStart(container, batches) {
        events.push(['render', batches]);
      },
      renderEnd(completed) {
        events.push(['end', completed]);
      },
      commit(container, batches) {
        events.push(['commit', batches]);
      },
      mutation(start) {
        events.push([start ? 'mutation-start' : 'mutation-stop']);
      },
    });
  });

  it('attributes a transition to its external batch', async () => {
    await act(() => {
      React.unstable_runWithSignalBatch(7, () => {
        React.startTransition(() => ReactNoop.render(<div>seven</div>));
      });
    });

    expect(events).toContainEqual(['batch', 7]);
    expect(events).toContainEqual(['render', [7]]);
    expect(events).toContainEqual(['commit', [7]]);
  });

  it('does not attribute a later urgent update to the transition', async () => {
    await act(() => {
      React.unstable_runWithSignalBatch(3, () => {
        React.startTransition(() => ReactNoop.render(<div>draft</div>));
      });
    });
    events = [];
    await act(() => ReactNoop.render(<div>urgent</div>));

    expect(events).toContainEqual(['render', []]);
    expect(events).toContainEqual(['commit', []]);
  });

  it('brackets the host mutation phase', async () => {
    await act(() => ReactNoop.render(<div>first</div>));
    const start = events.findIndex(event => event[0] === 'mutation-start');
    const stop = events.findIndex(event => event[0] === 'mutation-stop');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(stop).toBe(start + 1);
  });

  it('rejects a second runtime', () => {
    expect(() => React.unstable_registerSignalRuntime({})).toThrow(
      'A different signal runtime is already registered.',
    );
  });
});
