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

describe('Royale external runtime protocol', () => {
  beforeEach(() => {
    jest.resetModules();
    React = require('react');
    ReactNoop = require('react-noop-renderer');
    act = require('internal-test-utils').act;
  });

  it('classifies urgent and transition writes', () => {
    const urgent = React.unstable_getCurrentUpdateLane();
    let deferred;
    React.startTransition(() => {
      deferred = React.unstable_getCurrentUpdateLane();
    });

    expect(urgent).not.toBe(0);
    expect(deferred).not.toBe(urgent);
    expect(React.unstable_isTransitionLane(urgent)).toBe(false);
    expect(React.unstable_isTransitionLane(deferred)).toBe(true);
    expect(React.unstable_lanesInclude(deferred, deferred)).toBe(true);
  });

  it('reports a self-consistent render context and ordered commit edges', async () => {
    const events = [];
    const contexts = [];
    const stop = React.unstable_subscribeToExternalRuntime({
      onRenderPassStart(container, lanes) {
        events.push(['start', container, lanes]);
      },
      onRenderPassEnd(container) {
        events.push(['end', container]);
      },
      onBeforeMutation(container) {
        events.push(['before', container]);
      },
      onAfterMutation(container) {
        events.push(['after', container]);
      },
      onCommit(container, lanes, remaining) {
        events.push(['commit', container, lanes, remaining]);
      },
    });

    function App() {
      contexts.push(React.unstable_getRenderContext());
      return <span>ready</span>;
    }

    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    stop();

    expect(contexts).toHaveLength(1);
    expect(contexts[0]).not.toBe(null);
    const kinds = events.map(event => event[0]);
    expect(kinds).toEqual(['start', 'end', 'before', 'after', 'commit']);
    expect(events.every(event => event[1] === contexts[0].container)).toBe(
      true,
    );
    expect(
      React.unstable_lanesInclude(events[4][2], contexts[0].renderLanes),
    ).toBe(true);
    expect(React.unstable_getRenderContext()).toBe(null);
  });

  it('closes a replaced pass before starting its replacement', async () => {
    const events = [];
    const stop = React.unstable_subscribeToExternalRuntime({
      onRenderPassStart() {
        events.push('start');
      },
      onRenderPassEnd() {
        events.push('end');
      },
    });
    const root = ReactNoop.createRoot();
    root.render(<span>first</span>);
    root.render(<span>second</span>);
    await act(() => {});
    stop();

    expect(events[0]).toBe('start');
    expect(events[events.length - 1]).toBe('end');
    expect(events.filter(event => event === 'start')).toHaveLength(
      events.filter(event => event === 'end').length,
    );
  });

  it('pins corrective updates to the owning transition lane', async () => {
    let setValue;
    let renderedLanes = 0;
    function App() {
      const [value, set] = React.useState(0);
      setValue = set;
      renderedLanes = React.unstable_getRenderContext().renderLanes;
      return <span>{value}</span>;
    }
    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    let lane;
    React.startTransition(() => {
      lane = React.unstable_getCurrentUpdateLane();
    });
    React.unstable_runInLane(lane, () => setValue(1));
    await act(() => {});

    expect(React.unstable_lanesInclude(renderedLanes, lane)).toBe(true);
    expect(root).toMatchRenderedOutput(<span>1</span>);
  });
});
