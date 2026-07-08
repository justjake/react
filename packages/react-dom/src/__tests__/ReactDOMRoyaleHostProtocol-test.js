/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 */

'use strict';

// Tests for the royale host protocol: render-slice events, commit events,
// the DOM mutation window, lane probing, and lane pinning. These pin the
// invariants packages/react-signals-royale-fm2 depends on.

let React;
let ReactDOMClient;
let act;
let container;
let internals;
let events;

describe('ReactDOMRoyaleHostProtocol', () => {
  beforeEach(() => {
    jest.resetModules();
    React = require('react');
    ReactDOMClient = require('react-dom/client');
    act = require('internal-test-utils').act;
    internals =
      React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    container = document.createElement('div');
    document.body.appendChild(container);
    events = [];
  });

  afterEach(() => {
    internals.royaleHost = null;
    document.body.removeChild(container);
  });

  function attachHost() {
    internals.royaleHost = (kind, c, lanes) => {
      events.push({kind, container: c, lanes});
    };
  }

  it('exposes the protocol helpers on shared internals', () => {
    expect(typeof internals.royaleProbeLane).toBe('function');
    expect(typeof internals.royaleRunWithLane).toBe('function');
  });

  it('brackets every render slice and reports the commit with its lanes', async () => {
    attachHost();
    const root = ReactDOMClient.createRoot(container);
    await act(() => {
      root.render(<span>hi</span>);
    });
    const kinds = events.map(e => e.kind);
    expect(kinds).toContain('render-start');
    expect(kinds).toContain('render-stop');
    expect(kinds).toContain('commit');
    // Starts and stops pair up in order.
    let depth = 0;
    for (const k of kinds) {
      if (k === 'render-start') depth++;
      if (k === 'render-stop') {
        depth--;
        expect(depth).toBeGreaterThanOrEqual(0);
      }
    }
    expect(depth).toBe(0);
    // Every event carries this root's container.
    for (const e of events) {
      expect(e.container).toBe(container);
    }
    // The commit's lanes intersect the lanes some render slice reported.
    const commit = events.find(e => e.kind === 'commit');
    const renderStart = events.find(e => e.kind === 'render-start');
    expect(commit.lanes & renderStart.lanes).not.toBe(0);
  });

  it('emits the mutation window exactly around DOM mutation, inside the commit', async () => {
    attachHost();
    const root = ReactDOMClient.createRoot(container);
    await act(() => {
      root.render(<span>one</span>);
    });
    events.length = 0;
    await act(() => {
      root.render(<span>two</span>);
    });
    const kinds = events.map(e => e.kind);
    const commitIdx = kinds.indexOf('commit');
    const startIdx = kinds.indexOf('mutation-start');
    const stopIdx = kinds.indexOf('mutation-stop');
    expect(commitIdx).not.toBe(-1);
    expect(startIdx).toBeGreaterThan(commitIdx);
    expect(stopIdx).toBe(startIdx + 1);
    // A commit whose mutation phase has nothing to do emits no window.
    const same = <span>two</span>;
    await act(() => {
      root.render(same);
    });
    events.length = 0;
    await act(() => {
      root.render(same);
    });
    expect(events.map(e => e.kind)).not.toContain('mutation-start');
  });

  it('probeLane is zero outside a transition and a stable transition lane inside', () => {
    expect(internals.royaleProbeLane()).toBe(0);
    let first;
    let second;
    React.startTransition(() => {
      first = internals.royaleProbeLane();
      second = internals.royaleProbeLane();
    });
    expect(first).not.toBe(0);
    expect(first).toBe(second);
    expect(internals.royaleProbeLane()).toBe(0);
  });

  it('runWithLane pins an update to the given lane, and unwinds after', async () => {
    attachHost();
    let setValue;
    function App() {
      const [value, set] = React.useState(0);
      setValue = set;
      return <span>{value}</span>;
    }
    const root = ReactDOMClient.createRoot(container);
    await act(() => {
      root.render(<App />);
    });
    let lane;
    React.startTransition(() => {
      lane = internals.royaleProbeLane();
    });
    events.length = 0;
    await act(() => {
      internals.royaleRunWithLane(lane, () => setValue(1));
    });
    expect(container.textContent).toBe('1');
    const commit = events.find(e => e.kind === 'commit');
    expect(commit.lanes & lane).not.toBe(0);
    // The pin does not leak past runWithLane.
    events.length = 0;
    await act(() => {
      setValue(2);
    });
    const commit2 = events.find(e => e.kind === 'commit');
    expect(commit2.lanes & lane).toBe(0);
  });

  it('is inert with no host registered', async () => {
    const root = ReactDOMClient.createRoot(container);
    await act(() => {
      root.render(<span>plain</span>);
    });
    expect(container.textContent).toBe('plain');
    expect(events).toEqual([]);
  });
});
