/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 */

'use strict';

// Protocol invariants of the external signal-scheduler bridge
// (globalThis.__SIGNALS_ROYALE_FX1__): store-pinned transition lanes, pass
// starts, per-root commit reports, and the exact DOM mutation window.

let React;
let ReactDOMClient;
let ReactSharedInternals;
let act;
let container;
let bridge;

describe('ReactDOMSignalScheduler', () => {
  beforeEach(() => {
    jest.resetModules();
    React = require('react');
    ReactDOMClient = require('react-dom/client');
    ReactSharedInternals =
      require('react').__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    act = require('internal-test-utils').act;
    container = document.createElement('div');
    document.body.appendChild(container);
    bridge = globalThis.__SIGNALS_ROYALE_FX1__;
    bridge.onPassStart = null;
    bridge.onCommit = null;
    bridge.onMutation = null;
  });

  afterEach(() => {
    bridge.onPassStart = null;
    bridge.onCommit = null;
    bridge.onMutation = null;
    container.remove();
  });

  it('publishes the bridge with claim/introspection entry points', () => {
    expect(typeof bridge.claimTransitionLane).toBe('function');
    expect(typeof bridge.getWorkInProgress).toBe('function');
    expect(typeof bridge.isRendering).toBe('function');
  });

  it('dispatches under a pinned transition share one lane across separate events and commit together', async () => {
    const lane = bridge.claimTransitionLane();
    expect(lane).not.toBe(0);
    const pinned = {_signalLane: lane};

    let setA;
    let setB;
    const commits = [];
    bridge.onCommit = (root, lanes) => commits.push(lanes);
    function App() {
      const [a, _setA] = React.useState(0);
      const [b, _setB] = React.useState(0);
      setA = _setA;
      setB = _setB;
      return `${a},${b}`;
    }
    const root = ReactDOMClient.createRoot(container);
    await act(() => root.render(<App />));
    commits.length = 0;

    await act(async () => {
      // Two dispatches separated by the root-schedule microtask (which ends
      // the "event" and resets the per-event transition lane cache), both
      // under the same pinned transition: they must land in one commit.
      const prev = ReactSharedInternals.T;
      ReactSharedInternals.T = pinned;
      setA(1);
      ReactSharedInternals.T = prev;
      await Promise.resolve();
      await Promise.resolve();
      ReactSharedInternals.T = pinned;
      setB(1);
      ReactSharedInternals.T = prev;
    });
    expect(container.textContent).toBe('1,1');
    const withPin = commits.filter(lanes => (lanes & lane) !== 0);
    expect(withPin.length).toBe(1);
  });

  it('without a pin, transitions in separate events get separate lanes', async () => {
    const laneA = bridge.claimTransitionLane();
    // Flush a root schedule: entering the work loop ends the "event" and
    // resets the per-event transition lane cache.
    const root = ReactDOMClient.createRoot(container);
    await act(() => root.render('x'));
    const laneB = bridge.claimTransitionLane();
    expect(laneA).not.toBe(0);
    expect(laneB).not.toBe(0);
    expect(laneA).not.toBe(laneB);
  });

  it('reports pass starts with root and lanes, and commits with the committed lanes', async () => {
    const passes = [];
    const commits = [];
    bridge.onPassStart = (root, lanes) =>
      passes.push({c: root.containerInfo, lanes});
    bridge.onCommit = (root, lanes) =>
      commits.push({c: root.containerInfo, lanes});
    let setX;
    function App() {
      const [x, _setX] = React.useState(0);
      setX = _setX;
      return String(x);
    }
    const root = ReactDOMClient.createRoot(container);
    await act(() => root.render(<App />));
    expect(passes.length).toBeGreaterThanOrEqual(1);
    expect(commits.length).toBe(1);
    expect(passes[0].c).toBe(container);
    expect(commits[0].c).toBe(container);
    passes.length = 0;
    commits.length = 0;
    const lane = bridge.claimTransitionLane();
    await act(() => {
      const prev = ReactSharedInternals.T;
      ReactSharedInternals.T = {_signalLane: lane};
      setX(1);
      ReactSharedInternals.T = prev;
    });
    expect(commits.length).toBe(1);
    expect(commits[0].lanes & lane).toBe(lane);
    expect(passes.some(p => (p.lanes & lane) !== 0)).toBe(true);
  });

  it('brackets exactly the DOM mutation phase: mutations happen only inside the window', async () => {
    const root = ReactDOMClient.createRoot(container);
    let setX;
    function App() {
      const [x, _setX] = React.useState(0);
      setX = _setX;
      React.useLayoutEffect(() => {
        // Layout effects run outside the mutation window.
        expect(windowOpen).toBe(false);
      });
      return String(x);
    }
    let windowOpen = false;
    const observer = new MutationObserver(() => {});
    observer.observe(container, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    const seenOutsideWindow = [];
    bridge.onMutation = (fiberRoot, start) => {
      if (fiberRoot.containerInfo !== container) {
        return;
      }
      if (start) {
        seenOutsideWindow.push(...observer.takeRecords());
        windowOpen = true;
      } else {
        observer.takeRecords(); // React's own mutations: inside the window
        windowOpen = false;
      }
    };
    await act(() => root.render(<App />));
    await act(() => setX(1));
    seenOutsideWindow.push(...observer.takeRecords());
    expect(container.textContent).toBe('1');
    expect(seenOutsideWindow).toEqual([]);
    observer.disconnect();
  });

  it('isRendering is true during component render and false in effects and events', async () => {
    const observed = [];
    function App() {
      observed.push(['render', bridge.isRendering()]);
      React.useEffect(() => {
        observed.push(['effect', bridge.isRendering()]);
      }, []);
      return null;
    }
    const root = ReactDOMClient.createRoot(container);
    await act(() => root.render(<App />));
    observed.push(['outside', bridge.isRendering()]);
    expect(observed).toEqual([
      ['render', true],
      ['effect', false],
      ['outside', false],
    ]);
  });

  it('getWorkInProgress exposes root and lanes during render, null outside', async () => {
    const seen = [];
    function App() {
      const wip = bridge.getWorkInProgress();
      seen.push(
        wip === null ? null : {c: wip.root.containerInfo, lanes: wip.lanes},
      );
      return null;
    }
    const root = ReactDOMClient.createRoot(container);
    await act(() => root.render(<App />));
    expect(bridge.getWorkInProgress()).toBe(null);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0].c).toBe(container);
    expect(seen[0].lanes).not.toBe(0);
  });

  it('flushSync commits exclude work scheduled on a pinned transition lane', async () => {
    const ReactDOM = require('react-dom');
    let setUrgent;
    let setDeferred;
    function App() {
      const [u, _setU] = React.useState(0);
      const [d, _setD] = React.useState(0);
      setUrgent = _setU;
      setDeferred = _setD;
      return `${u},${d}`;
    }
    const root = ReactDOMClient.createRoot(container);
    await act(() => root.render(<App />));
    await act(async () => {
      const lane = bridge.claimTransitionLane();
      const prev = ReactSharedInternals.T;
      ReactSharedInternals.T = {_signalLane: lane};
      setDeferred(1);
      ReactSharedInternals.T = prev;
      ReactDOM.flushSync(() => setUrgent(1));
      // The sync flush landed the urgent update alone.
      expect(container.textContent).toBe('1,0');
    });
    // The pinned transition still lands afterward.
    expect(container.textContent).toBe('1,1');
  });
});
