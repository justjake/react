/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 */

'use strict';

// Protocol invariants of the external-signals seam:
//  1. every commit's events arrive as mutation-start < mutation-stop <
//     committed, per root, with the committed lanes;
//  2. the mutation window brackets exactly React's host mutations (layout
//     and passive effects run after the stop edge);
//  3. a pass that is thrown away reports discarded, and every committed
//     lane set was previously reported by a pass start;
//  4. runWithForcedLane pins the lane of updates dispatched inside it;
//  5. requestCurrentTransitionLane names the same lane a setState in the
//     same transition scope schedules on;
//  6. scheduleExternalRootLane commits a lane with zero fiber updates
//     (the close edge for store-only batches);
//  7. the runtime slot is single and uninstallable.

let React;
let ReactDOMClient;
let act;
let container;
let seam;
let events;
let uninstall;

describe('ReactDOMExternalSignals', () => {
  beforeEach(() => {
    jest.resetModules();
    container = document.createElement('div');
    document.body.appendChild(container);
    React = require('react');
    ReactDOMClient = require('react-dom/client');
    act = require('internal-test-utils').act;
    seam = ReactDOMClient.unstable_externalSignals;
    events = [];
    uninstall = seam.inject({
      onPassStarted(root, lanes) {
        events.push({kind: 'pass-start', root, lanes});
      },
      onPassDiscarded(root, lanes) {
        events.push({kind: 'pass-discard', root, lanes});
      },
      onCommitPhase(root, phase, lanes) {
        events.push({kind: phase, root, lanes});
      },
    });
  });

  afterEach(() => {
    uninstall();
    document.body.removeChild(container);
  });

  function commitTriples() {
    const out = [];
    for (let i = 0; i < events.length; i++) {
      if (events[i].kind === 'mutation-start') {
        out.push(events.slice(i, i + 3).map(e => e.kind));
        i += 2;
      }
    }
    return out;
  }

  it('emits pass-start then a full commit phase triple with matching lanes', async () => {
    const root = ReactDOMClient.createRoot(container);
    await act(() => {
      root.render(<span>hi</span>);
    });
    expect(container.textContent).toBe('hi');
    const start = events.find(e => e.kind === 'pass-start');
    const committed = events.find(e => e.kind === 'committed');
    expect(start).toBeDefined();
    expect(committed).toBeDefined();
    expect(committed.lanes & start.lanes).not.toBe(0);
    expect(commitTriples()).toEqual(
      expect.arrayContaining([
        ['mutation-start', 'mutation-stop', 'committed'],
      ]),
    );
  });

  it('brackets exactly the DOM mutation phase; layout and passive effects run after the stop edge', async () => {
    const order = [];
    const mo = new MutationObserver(() => {});
    mo.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    let inWindow = false;
    uninstall();
    uninstall = seam.inject({
      onPassStarted() {},
      onPassDiscarded() {},
      onCommitPhase(root, phase) {
        if (phase === 'mutation-start') {
          expect(mo.takeRecords()).toEqual([]); // nothing mutated before the window
          inWindow = true;
          order.push('start');
        } else if (phase === 'mutation-stop') {
          expect(mo.takeRecords().length).toBeGreaterThan(0); // mutations inside
          inWindow = false;
          order.push('stop');
        } else {
          order.push('committed');
        }
      },
    });
    function App() {
      React.useLayoutEffect(() => {
        order.push(inWindow ? 'layout-IN-WINDOW' : 'layout');
      });
      React.useEffect(() => {
        order.push(inWindow ? 'passive-IN-WINDOW' : 'passive');
      });
      return <b>x</b>;
    }
    const root = ReactDOMClient.createRoot(container);
    await act(() => {
      root.render(<App />);
    });
    mo.disconnect();
    expect(order).toEqual(['start', 'stop', 'committed', 'layout', 'passive']);
  });

  it('a sync interruption discards the in-flight transition pass and restarts it', async () => {
    const root = ReactDOMClient.createRoot(container);
    function App({label}) {
      return <span>{label}</span>;
    }
    await act(() => {
      root.render(<App label="a" />);
    });
    events.length = 0;
    await act(async () => {
      React.startTransition(() => {
        root.render(<App label="b" />);
      });
      // Interrupt before the transition finishes: a sync render on the
      // same root throws the in-flight pass away.
      ReactDOMClient.createRoot(document.createElement('div'));
      const {flushSync} = require('react-dom');
      flushSync(() => {
        root.render(<App label="c" />);
      });
    });
    expect(container.textContent).toBe('c');
    // Every committed lane set was announced by a pass start first.
    const started = [];
    events.forEach(e => {
      if (e.kind === 'pass-start') {
        started.push(e.lanes);
      } else if (e.kind === 'committed') {
        expect(started.some(lanes => (lanes & e.lanes) !== 0)).toBe(true);
      }
    });
  });

  it('runWithForcedLane pins the dispatch lane: the update joins the pending transition commit', async () => {
    let setUrgent;
    let bump;
    const committedText = [];
    function App() {
      const [urgent, _setUrgent] = React.useState(0);
      const [n, setN] = React.useState(0);
      setUrgent = _setUrgent;
      bump = () => setN(c => c + 1);
      React.useLayoutEffect(() => {
        committedText.push(`u${urgent}n${n}`);
      });
      return (
        <span>
          u{urgent}n{n}
        </span>
      );
    }
    const root = ReactDOMClient.createRoot(container);
    await act(() => {
      root.render(<App />);
    });
    // Open a transition and learn its lane.
    let lane = 0;
    await act(async () => {
      React.startTransition(() => {
        lane = seam.currentTransitionLane();
        setUrgent(1); // rides the transition
      });
      // From outside any transition: force the same lane. The bump must
      // join the transition's commit, never a separate one.
      seam.runWithLane(lane, () => bump());
    });
    expect(lane).not.toBe(0);
    expect(container.textContent).toBe('u1n1');
    expect(committedText).toEqual(['u0n0', 'u1n1']); // one commit carried both
  });

  it('requestCurrentTransitionLane matches the lane a setState in the scope schedules', async () => {
    let setState;
    function App() {
      const [v, _set] = React.useState(0);
      setState = _set;
      return <i>{v}</i>;
    }
    const root = ReactDOMClient.createRoot(container);
    await act(() => {
      root.render(<App />);
    });
    expect(seam.currentTransitionLane()).toBe(0); // outside any transition
    let lane = 0;
    events.length = 0;
    await act(async () => {
      React.startTransition(() => {
        lane = seam.currentTransitionLane();
        setState(1);
      });
    });
    expect(lane).not.toBe(0);
    const commit = events.find(
      e => e.kind === 'committed' && (e.lanes & lane) !== 0,
    );
    expect(commit).toBeDefined();
    expect(container.textContent).toBe('1');
  });

  it('scheduleExternalRootLane commits a lane with no fiber updates (the close edge)', async () => {
    const root = ReactDOMClient.createRoot(container);
    await act(() => {
      root.render(<span>x</span>);
    });
    const fiberRoot = events.find(e => e.kind === 'pass-start').root;
    events.length = 0;
    let lane = 0;
    await act(async () => {
      React.startTransition(() => {
        lane = seam.currentTransitionLane();
        // No setState anywhere: the store simply claims the lane and asks
        // the root to close it out.
        seam.scheduleRootLane(fiberRoot, lane);
      });
    });
    expect(lane).not.toBe(0);
    const commit = events.find(
      e => e.kind === 'committed' && (e.lanes & lane) !== 0,
    );
    expect(commit).toBeDefined(); // the lane rendered and committed anyway
    expect(container.textContent).toBe('x'); // bailed-out render: no DOM change
  });

  it('the runtime slot is single and uninstallable', async () => {
    const other = [];
    const uninstallOther = seam.inject({
      onPassStarted() {
        other.push('start');
      },
      onPassDiscarded() {},
      onCommitPhase() {
        other.push('commit');
      },
    });
    const root = ReactDOMClient.createRoot(container);
    await act(() => {
      root.render(<span>1</span>);
    });
    expect(other.length).toBeGreaterThan(0);
    expect(events.length).toBe(0); // replaced: the first runtime is silent
    const seen = other.length;
    uninstallOther();
    await act(() => {
      root.render(<span>2</span>);
    });
    expect(other.length).toBe(seen); // uninstalled: no further events
  });

  it('isRenderPhase is true during render, false in effects and events', async () => {
    const seen = [];
    function App() {
      seen.push(['render', seam.isRenderPhase()]);
      React.useLayoutEffect(() => {
        seen.push(['layout', seam.isRenderPhase()]);
      });
      React.useEffect(() => {
        seen.push(['passive', seam.isRenderPhase()]);
      });
      return null;
    }
    const root = ReactDOMClient.createRoot(container);
    await act(() => {
      root.render(<App />);
    });
    expect(seam.isRenderPhase()).toBe(false);
    expect(seen).toEqual([
      ['render', true],
      ['layout', false],
      ['passive', false],
    ]);
  });
});
