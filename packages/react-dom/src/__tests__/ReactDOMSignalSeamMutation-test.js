/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 */

'use strict';

let React;
let ReactDOMClient;
let act;
let seam;

describe('ReactDOMSignalSeamMutation', () => {
  beforeEach(() => {
    jest.resetModules();
    React = require('react');
    ReactDOMClient = require('react-dom/client');
    act = require('internal-test-utils').act;
    seam = require('shared/ReactSharedInternals').default.signalSeam;
  });

  afterEach(() => {
    seam.runtime = null;
  });

  it('brackets exactly the DOM mutation phase of each commit', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const phases = [];
    let textDuringWindow = null;
    seam.runtime = {
      onPassStart() {},
      onRootUpdated() {},
      onCommit() {},
      onMutation(c, active) {
        phases.push([c, active]);
        if (!active && c === container) {
          // At the closing edge the mutation has already been applied.
          textDuringWindow = container.textContent;
        }
      },
    };
    let setX;
    function App() {
      const [x, set] = React.useState('a');
      setX = set;
      return x;
    }
    const root = ReactDOMClient.createRoot(container);
    await act(() => {
      root.render(<App />);
    });
    phases.length = 0;
    await act(() => {
      setX('b');
    });
    // One bracket for this commit, start then stop, on this container, and
    // the DOM change happened inside it.
    const here = phases.filter(p => p[0] === container);
    expect(here.length).toBe(2);
    expect(here[0][1]).toBe(true);
    expect(here[1][1]).toBe(false);
    expect(textDuringWindow).toBe('b');
    root.unmount();
    container.remove();
  });

  it('emits no bracket for a commit with no host mutations', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const phases = [];
    seam.runtime = {
      onPassStart() {},
      onRootUpdated() {},
      onCommit() {},
      onMutation(c, active) {
        phases.push(active);
      },
    };
    function App({n}) {
      // Renders the same host output regardless of n.
      void n;
      return 'same';
    }
    const root = ReactDOMClient.createRoot(container);
    await act(() => {
      root.render(<App n={1} />);
    });
    phases.length = 0;
    await act(() => {
      root.render(<App n={2} />);
    });
    expect(phases).toEqual([]);
    root.unmount();
    container.remove();
  });
});
