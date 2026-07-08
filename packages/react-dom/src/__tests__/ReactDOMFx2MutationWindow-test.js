/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 * @jest-environment jsdom
 */

'use strict';

// Protocol tests for the fx2 external-state mutation window:
// __FX2_MUTATION_WINDOW__(containerInfo, isStart) brackets exactly the host
// mutation phase of every root commit, and __FX2_REACT_PROTOCOL__ === 1 is
// the load-time handshake external runtimes check before registering.

describe('ReactDOMFx2MutationWindow', () => {
  let React;
  let ReactDOMClient;
  let act;
  let container;
  let events;

  beforeEach(() => {
    jest.resetModules();
    delete globalThis.__FX2_MUTATION_WINDOW__;
    events = [];
    React = require('react');
    ReactDOMClient = require('react-dom/client');
    act = require('internal-test-utils').act;
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    delete globalThis.__FX2_MUTATION_WINDOW__;
    container.remove();
  });

  function installHook() {
    globalThis.__FX2_MUTATION_WINDOW__ = (containerInfo, isStart) => {
      events.push({phase: isStart ? 'start' : 'stop', containerInfo});
    };
  }

  it('sets the protocol handshake marker at module load', () => {
    expect(globalThis.__FX2_REACT_PROTOCOL__).toBe(1);
  });

  it('brackets every commit: one start/stop pair, strictly nested, never reentrant', async () => {
    installHook();
    const root = ReactDOMClient.createRoot(container);
    function App({n}) {
      return <span>{n}</span>;
    }
    await act(() => root.render(<App n={1} />));
    await act(() => root.render(<App n={2} />));
    expect(events.length % 2).toBe(0);
    expect(events.length).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i].phase).toBe('start');
      expect(events[i + 1].phase).toBe('stop');
      expect(events[i].containerInfo).toBe(container);
      expect(events[i + 1].containerInfo).toBe(container);
    }
    root.unmount();
  });

  it('host mutations happen only inside the window; layout and passive effects after stop', async () => {
    const order = [];
    globalThis.__FX2_MUTATION_WINDOW__ = (containerInfo, isStart) => {
      order.push(isStart ? 'start' : 'stop');
    };
    const observer = new MutationObserver(() => {});
    observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    const mutationsAt = [];
    globalThis.__FX2_MUTATION_WINDOW__ = (containerInfo, isStart) => {
      order.push(isStart ? 'start' : 'stop');
      // Any records visible at the start edge arrived OUTSIDE the window.
      mutationsAt.push({
        edge: isStart ? 'start' : 'stop',
        leaked: observer.takeRecords().length,
      });
    };
    function App({n}) {
      React.useEffect(() => {
        order.push('passive');
      }, [n]);
      React.useLayoutEffect(() => {
        order.push('layout');
      }, [n]);
      return <span>{n}</span>;
    }
    const root = ReactDOMClient.createRoot(container);
    await act(() => root.render(<App n={1} />));
    await act(() => root.render(<App n={2} />));
    // Per commit: start, stop, layout, then passive. Never layout/passive
    // between start and stop.
    for (let i = 0; i < order.length; i++) {
      if (order[i] === 'start') {
        expect(order[i + 1]).toBe('stop');
        expect(order[i + 2]).toBe('layout');
      }
    }
    // No React mutations leaked outside the window: every record set drained
    // at a start edge (pre-window) is empty.
    for (const m of mutationsAt) {
      if (m.edge === 'start') {
        expect(m.leaked).toBe(0);
      }
    }
    // The commits did mutate the DOM (the window is not vacuous).
    expect(container.textContent).toBe('2');
    observer.disconnect();
    root.unmount();
  });

  it('reports the owning container per root, including multi-root commits', async () => {
    installHook();
    const container2 = document.createElement('div');
    document.body.appendChild(container2);
    const root1 = ReactDOMClient.createRoot(container);
    const root2 = ReactDOMClient.createRoot(container2);
    await act(() => {
      root1.render(<b>one</b>);
      root2.render(<i>two</i>);
    });
    const owners = new Set(events.map(e => e.containerInfo));
    expect(owners.has(container)).toBe(true);
    expect(owners.has(container2)).toBe(true);
    // Pairs never interleave across roots: each start is followed by a stop
    // for the same container.
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i].phase).toBe('start');
      expect(events[i + 1].phase).toBe('stop');
      expect(events[i + 1].containerInfo).toBe(events[i].containerInfo);
    }
    root1.unmount();
    root2.unmount();
    container2.remove();
  });

  it('fires an (empty) window even for commits without host mutations', async () => {
    installHook();
    let bump;
    function App() {
      const [, setN] = React.useState(0);
      bump = () => setN(n => n + 1);
      // Renders identical output every time: the update commits with no
      // host mutations, and the window still brackets the (empty) phase.
      return <span>static</span>;
    }
    const root = ReactDOMClient.createRoot(container);
    await act(() => root.render(<App />));
    const before = events.length;
    await act(() => bump());
    expect(events.length).toBe(before + 2);
    expect(events[before].phase).toBe('start');
    expect(events[before + 1].phase).toBe('stop');
    root.unmount();
  });

  it('stock behavior is unchanged when no hook is installed', async () => {
    const root = ReactDOMClient.createRoot(container);
    await act(() => root.render(<span>plain</span>));
    expect(container.textContent).toBe('plain');
    expect(events).toEqual([]);
    root.unmount();
  });
});
