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

// Fork regression coverage for URGENT-lane React.use(pendingPromise) retries
// against a DOM root driven by the public React.act, the way downstream RTL
// suites drive this build.
//
// Downstream (cosignals-alt-a SPEC-RESOLUTIONS note 12) observed a plain
// use(P) consumer stalling on its Suspense fallback forever after an
// urgent-lane suspension, and attributed it to this fork's patched build.
// The stall is real but is NOT a fork regression and is NOT urgent-lane
// specific: it reproduces identically on the pristine upstream base commit
// (e71a6393e6) on the stable, canary, and experimental channels. It only
// occurs when the suspension happens inside a synchronous act(...) scope
// that is never awaited — a misuse React itself warns about ("A component
// suspended inside an `act` scope, but the `act` call was not awaited").
//
// Mechanism of the upstream wedge, for the record: the fallback commit
// spawns a suspended retry lane; sibling prerendering then schedules a
// prewarm render task for it onto the act queue and records it in
// root.callbackNode (the shared fakeActCallbackNode singleton) and
// root.callbackPriority. Because the component suspended via use(),
// ReactSharedInternals.didUsePromise makes flushActQueue return early, and
// the un-awaited act abandons its queue — but root.callbackNode/Priority
// still claim a live task. Every later schedule pass (including the ping and
// the retry after the promise resolves) hits the "priority hasn't changed,
// reuse the existing task" fast path against the dead task, so the root
// never renders again.
//
// These tests pin the true contract: with a correctly awaited act, urgent
// use(P) retries work on this build, on every lane; and they pin the
// upstream-identical wedge so a future upstream merge that changes the
// behavior is noticed.

let React;
let ReactDOMClient;
let act;
let use;
let Suspense;
let startTransition;
let waitForMicrotasks;
let container;

describe('ReactDOMUseUrgentActStall', () => {
  beforeEach(() => {
    jest.resetModules();
    React = require('react');
    ReactDOMClient = require('react-dom/client');
    act = React.act;
    use = React.use;
    Suspense = React.Suspense;
    startTransition = React.startTransition;
    waitForMicrotasks = require('internal-test-utils').waitForMicrotasks;
    container = document.createElement('div');
    document.body.appendChild(container);
    global.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  function deferred() {
    let resolve;
    const promise = new Promise(r => (resolve = r));
    return {promise, resolve};
  }

  // The regression test for downstream note 12: an urgent (default-lane)
  // mount that suspends via use() must retry after the promise resolves.
  // @gate __DEV__
  it('urgent mount: use(P) retries after resolve (awaited act)', async () => {
    const {promise, resolve} = deferred();
    function Content() {
      return use(promise);
    }
    const root = ReactDOMClient.createRoot(container);
    await act(async () => {
      root.render(
        <Suspense fallback="loading">
          <Content />
        </Suspense>,
      );
    });
    expect(container.textContent).toBe('loading');
    await act(async () => {
      resolve('done');
    });
    expect(container.textContent).toBe('done');
  });

  // @gate __DEV__
  it('urgent update: setState reveals use(P), retries after resolve', async () => {
    const {promise, resolve} = deferred();
    let setShow;
    function Content() {
      return use(promise);
    }
    function App() {
      const [show, set] = React.useState(false);
      setShow = set;
      return show ? (
        <Suspense fallback="loading">
          <Content />
        </Suspense>
      ) : (
        'idle'
      );
    }
    const root = ReactDOMClient.createRoot(container);
    await act(async () => {
      root.render(<App />);
    });
    expect(container.textContent).toBe('idle');
    await act(async () => {
      setShow(true);
    });
    expect(container.textContent).toBe('loading');
    await act(async () => {
      resolve('done');
    });
    expect(container.textContent).toBe('done');
  });

  // @gate __DEV__
  it('transition control: use(P) inside startTransition retries after resolve', async () => {
    const {promise, resolve} = deferred();
    let setShow;
    function Content() {
      return use(promise);
    }
    function App() {
      const [show, set] = React.useState(false);
      setShow = set;
      return <Suspense fallback="loading">{show ? <Content /> : 'idle'}</Suspense>;
    }
    const root = ReactDOMClient.createRoot(container);
    await act(async () => {
      root.render(<App />);
    });
    expect(container.textContent).toBe('idle');
    await act(async () => {
      startTransition(() => setShow(true));
    });
    await act(async () => {
      resolve('done');
    });
    expect(container.textContent).toBe('done');
  });

  // The legacy thrown-thenable path never sets didUsePromise, so the act
  // queue drains fully and the root stays schedulable even when the act
  // scope is (incorrectly) not awaited.
  // @gate __DEV__
  it('thrown-thenable control: retries even when the mounting act is not awaited', async () => {
    const {promise, resolve} = deferred();
    let value;
    promise.then(v => (value = v));
    function Content() {
      if (value === undefined) {
        throw promise;
      }
      return value;
    }
    const root = ReactDOMClient.createRoot(container);
    act(() => {
      root.render(
        <Suspense fallback="loading">
          <Content />
        </Suspense>,
      );
    });
    expect(container.textContent).toBe('loading');
    await act(async () => {
      resolve('done');
    });
    expect(container.textContent).toBe('done');
  });

  // Pin of the UPSTREAM behavior that downstream note 12 misattributed to
  // this fork: a use() suspension inside a never-awaited act scope warns and
  // permanently wedges the root — identical on the unpatched base commit
  // e71a6393e6 (stable, canary, and experimental channels). If an upstream
  // merge ever makes this pin fail, upstream changed the act contract:
  // update this pin (and tell downstream the misuse now recovers).
  // @gate __DEV__
  it('upstream wedge pin: use(P) inside a non-awaited act scope warns and never retries', async () => {
    const {promise, resolve} = deferred();
    function Content() {
      return use(promise);
    }
    spyOnDev(console, 'error').mockImplementation(() => {});
    const root = ReactDOMClient.createRoot(container);
    act(() => {
      root.render(
        <Suspense fallback="loading">
          <Content />
        </Suspense>,
      );
    });
    expect(container.textContent).toBe('loading');

    // `act` warns after a few microtasks.
    await waitForMicrotasks();
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error.mock.calls[0][0]).toContain(
      'A component suspended inside an `act` scope, but the `act` ' +
        'call was not awaited.',
    );

    // The root is wedged: neither the ping nor the boundary retry can
    // reschedule it, because root.callbackNode/callbackPriority still point
    // at the prewarm task stranded in the abandoned act queue.
    await act(async () => {
      resolve('done');
    });
    expect(container.textContent).toBe('loading');
  });
});
