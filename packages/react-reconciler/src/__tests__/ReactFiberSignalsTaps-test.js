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
let taps;
let act;
let assertLog;
let waitFor;
let waitForAll;
let waitForThrow;

describe('ReactFiberSignalsTaps', () => {
  beforeEach(() => {
    jest.resetModules();
    React = require('react');
    ReactNoop = require('react-noop-renderer');
    Scheduler = require('scheduler');
    const internals =
      React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    taps = internals.E;

    const InternalTestUtils = require('internal-test-utils');
    act = InternalTestUtils.act;
    assertLog = InternalTestUtils.assertLog;
    waitFor = InternalTestUtils.waitFor;
    waitForAll = InternalTestUtils.waitForAll;
    waitForThrow = InternalTestUtils.waitForThrow;
  });

  afterEach(() => {
    taps.consumer = null;
    taps.watchedLanes = 0;
  });

  function Text({text}) {
    Scheduler.log(text);
    return text;
  }

  it('exports opaque-root render, commit, and mutation facts', async () => {
    expect(taps.forkProtocolVersion).toBe(1);
    const events = [];
    let renderContext;
    taps.watchedLanes = 0x7fffffff;
    taps.consumer = {
      onRootUpdated(root, container, lanes) {
        events.push({type: 'updated', root, container, lanes});
      },
      onScheduledRootPending() {},
      onEventClosed() {},
      onRenderPassStart(root, container, lanes) {
        events.push({type: 'start', root, container, lanes});
      },
      onRenderPassYield() {},
      onRenderPassResume() {},
      onRootCommitted(root, container, finished, remaining, repended) {
        events.push({
          type: 'committed',
          root,
          container,
          finished,
          remaining,
          repended,
        });
      },
      onBeforeMutation(container) {
        events.push({type: 'before', container});
      },
      onAfterMutation(container) {
        events.push({type: 'after', container});
      },
    };

    function App() {
      renderContext = taps.getRenderContext();
      return <Text text="mounted" />;
    }
    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['mounted']);

    const start = events.find(event => event.type === 'start');
    const committed = events.find(event => event.type === 'committed');
    expect(renderContext).not.toBe(null);
    expect(start.root).toBe(renderContext.root);
    expect(committed.root).toBe(renderContext.root);
    expect(start.container).toBe(renderContext.container);
    expect(committed.container).toBe(renderContext.container);
    expect(start.lanes).not.toBe(0);
    expect(committed.finished & start.lanes).not.toBe(0);
    expect(events.map(event => event.type)).toEqual([
      'updated',
      'start',
      'committed',
      'before',
      'after',
    ]);
  });

  it('closes the mutation window when a mutation effect throws', async () => {
    const events = [];
    taps.consumer = {
      onRootUpdated() {},
      onScheduledRootPending() {},
      onEventClosed() {},
      onRenderPassStart() {},
      onRenderPassYield() {},
      onRenderPassResume() {},
      onRootCommitted() {},
      onBeforeMutation() {
        events.push('before');
      },
      onAfterMutation() {
        events.push('after');
      },
    };
    class ThrowsOnUnmount extends React.Component {
      componentWillUnmount() {
        throw new Error('mutation failed');
      }
      render() {
        return <Text text="mounted" />;
      }
    }
    const root = ReactNoop.createRoot();
    await act(() => root.render(<ThrowsOnUnmount />));
    assertLog(['mounted']);
    events.length = 0;

    root.render(null);
    await waitForThrow('mutation failed');
    expect(events.length).toBeGreaterThan(0);
    expect(events.length % 2).toBe(0);
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i]).toBe('before');
      expect(events[i + 1]).toBe('after');
    }
  });

  it('backfills state scheduled before a store claims the transition lane', async () => {
    const events = [];
    taps.consumer = {
      onRootUpdated() {
        events.push('updated');
      },
      onScheduledRootPending(root, container, lanes) {
        events.push({type: 'scheduled', root, container, lanes});
      },
      onEventClosed(actionLane, actionThenable) {
        events.push({type: 'closed', actionLane, actionThenable});
      },
      onRenderPassStart() {},
      onRenderPassYield() {},
      onRenderPassResume() {},
      onRootCommitted() {},
      onBeforeMutation() {},
      onAfterMutation() {},
    };
    let setValue;
    function App() {
      const [value, set] = React.useState(0);
      setValue = set;
      return <Text text={value} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog([0]);
    events.length = 0;

    let packedLane;
    await act(async () => {
      React.startTransition(() => {
        setValue(1);
        packedLane = taps.getCurrentWriteLane();
        taps.watchedLanes |= packedLane & 0x7fffffff;
      });
      await waitForAll([1]);
    });

    const scheduled = events.findIndex(event => event.type === 'scheduled');
    const closed = events.findIndex(event => event.type === 'closed');
    expect(events).not.toContain('updated');
    expect(scheduled).toBeGreaterThanOrEqual(0);
    expect(closed).toBeGreaterThan(scheduled);
    expect(events[scheduled].lanes & (packedLane & 0x7fffffff)).not.toBe(0);
  });

  it('reports raw yield and resume edges around each time-slicing gap', async () => {
    const events = [];
    taps.consumer = {
      onRootUpdated() {},
      onScheduledRootPending() {},
      onEventClosed() {},
      onRenderPassStart() {
        events.push('start');
      },
      onRenderPassYield() {
        events.push('yield');
      },
      onRenderPassResume() {
        events.push('resume');
      },
      onRootCommitted() {
        events.push('commit');
      },
      onBeforeMutation() {},
      onAfterMutation() {},
    };
    let setValue;
    function App() {
      const [value, set] = React.useState(0);
      setValue = set;
      return (
        <>
          <Text text={`A${value}`} />
          <Text text={`B${value}`} />
          <Text text={`C${value}`} />
        </>
      );
    }
    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['A0', 'B0', 'C0']);
    events.length = 0;

    await act(async () => {
      React.startTransition(() => setValue(1));
      await waitFor(['A1']);
      expect(events).toEqual(['start', 'yield']);
      expect(taps.getRenderContext()).toBe(null);
      await waitFor(['B1']);
      expect(events).toEqual(['start', 'yield', 'resume', 'yield']);
      await waitForAll(['C1']);
    });
    expect(events).toEqual([
      'start',
      'yield',
      'resume',
      'yield',
      'resume',
      'commit',
    ]);
  });

  it('classifies writes and preserves deferred and urgent lane pins', () => {
    let deferredLane;
    React.startTransition(() => {
      deferredLane = taps.getCurrentWriteLane();
    });
    expect(deferredLane & 0x80000000).not.toBe(0);
    let nestedDeferred;
    expect(
      taps.runInBatch(deferredLane, () => {
        nestedDeferred = taps.getCurrentWriteLane();
        return 42;
      }),
    ).toBe(42);
    expect(nestedDeferred).toBe(deferredLane);

    const urgentLane = taps.getCurrentWriteLane();
    expect(urgentLane & 0x80000000).toBe(0);
    let nestedUrgent;
    taps.runInBatch(urgentLane, () => {
      nestedUrgent = taps.getCurrentWriteLane();
    });
    expect(nestedUrgent).toBe(urgentLane);

    taps.runInBatch(deferredLane, () => {
      expect(taps.getCurrentWriteLane()).toBe(deferredLane);
      taps.runInBatch(urgentLane, () => {
        expect(taps.getCurrentWriteLane()).toBe(urgentLane);
      });
      expect(taps.getCurrentWriteLane()).toBe(deferredLane);
    });
  });

  it('rejects runInBatch during render', async () => {
    function App() {
      expect(() => taps.runInBatch(0, () => {})).toThrow(
        'runInBatch must not be called while React is rendering',
      );
      return null;
    }
    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
  });
});
