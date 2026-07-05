/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 * @jest-environment node
 */

/**
 * Reconciler-level tests for the external-runtime batch-token protocol
 * (ReactFiberBatchRegistry + ReactFiberExternalRuntime). These run against
 * React source with the noop renderer, so the protocol can be validated —
 * including mid-render, via time slicing — without any consumer library.
 * The consumer-side contract lives in cosignal's patch-contract tests.
 */

'use strict';

let React;
let ReactNoop;
let Scheduler;
let useState;
let startTransition;
let act;
let assertLog;

describe('ReactFiberBatchRegistry', () => {
  beforeEach(() => {
    jest.resetModules();
    React = require('react');
    ReactNoop = require('react-noop-renderer');
    Scheduler = require('scheduler');
    useState = React.useState;
    startTransition = React.startTransition;

    const InternalTestUtils = require('internal-test-utils');
    act = InternalTestUtils.act;
    assertLog = InternalTestUtils.assertLog;
  });

  function Text({text}) {
    Scheduler.log(text);
    return text;
  }

  function subscribe() {
    const events = {passes: [], retired: []};
    const unsubscribe = React.unstable_subscribeToExternalRuntime({
      onRenderPassStart(container, includedBatches) {
        events.passes.push({container, included: includedBatches.slice()});
      },
      onBatchRetired(token, committed) {
        events.retired.push({token, committed});
      },
    });
    return {events, unsubscribe};
  }

  it('mints one token per batch: stable within a transition scope, distinct across events', async () => {
    const {events, unsubscribe} = subscribe();
    let t1a = null;
    let t1b = null;
    let t2 = null;
    await act(() => {
      startTransition(() => {
        t1a = React.unstable_getCurrentWriteBatch();
        t1b = React.unstable_getCurrentWriteBatch();
      });
    });
    await act(() => {
      startTransition(() => {
        t2 = React.unstable_getCurrentWriteBatch();
      });
    });
    expect(t1a).toBe(t1b);
    // Tokens are non-zero integers; the low bit is the deferred flag.
    expect(Number.isInteger(t1a)).toBe(true);
    expect(t1a).toBeGreaterThan(0);
    expect(t1a & 1).toBe(1);
    expect(t2).not.toBe(t1a);
    // Both store-only batches retired uncommitted at their event close.
    expect(events.retired.map(r => r.token)).toEqual([t1a, t2]);
    expect(events.retired.every(r => r.committed === false)).toBe(true);
    unsubscribe();
  });

  it('classifies writes without minting: isCurrentWriteDeferred causes no retirement', async () => {
    const {events, unsubscribe} = subscribe();
    let deferredInside = null;
    await act(() => {
      expect(React.unstable_isCurrentWriteDeferred()).toBe(false);
      startTransition(() => {
        deferredInside = React.unstable_isCurrentWriteDeferred();
      });
    });
    expect(deferredInside).toBe(true);
    // Classification alone mints nothing, so there is nothing to retire.
    expect(events.retired).toEqual([]);
    unsubscribe();
  });

  it('a transition that renders and commits retires exactly once, committed', async () => {
    const {events, unsubscribe} = subscribe();
    let setValue;
    function App() {
      const [value, _setValue] = useState(0);
      setValue = _setValue;
      return <Text text={`v=${value}`} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => {
      root.render(<App />);
    });
    assertLog(['v=0']);

    let token = null;
    await act(() => {
      startTransition(() => {
        token = React.unstable_getCurrentWriteBatch();
        setValue(1);
      });
    });
    assertLog(['v=1']);
    expect(events.retired.filter(r => r.token === token)).toEqual([
      {token, committed: true},
    ]);
    unsubscribe();
  });

  it('retires at commit when React work was scheduled before the token was minted', async () => {
    // Ordinary line order inside one transition: setState first, store write
    // second. The pending edge misses the setState (no token existed yet);
    // the root scheduler's back-fill repairs it before the close edge, so
    // the batch retires committed at its real commit, not early at event
    // close as "store-only".
    const {events, unsubscribe} = subscribe();
    let setValue;
    function App() {
      const [value, _setValue] = useState(0);
      setValue = _setValue;
      return <Text text={`v=${value}`} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => {
      root.render(<App />);
    });
    assertLog(['v=0']);

    let token = null;
    await act(() => {
      startTransition(() => {
        setValue(1); // React work FIRST
        token = React.unstable_getCurrentWriteBatch(); // minted after
      });
    });
    assertLog(['v=1']);
    expect(events.retired.filter(r => r.token === token)).toEqual([
      {token, committed: true},
    ]);
    unsubscribe();
  });

  it('render passes report included batches; interrupting urgent renders exclude pending transitions', async () => {
    const {events, unsubscribe} = subscribe();
    let setUrgent;
    let setValue;
    function App() {
      const [urgent, _setUrgent] = useState(0);
      const [value, _setValue] = useState(0);
      setUrgent = _setUrgent;
      setValue = _setValue;
      return <Text text={`u=${urgent} v=${value}`} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => {
      root.render(<App />);
    });
    assertLog(['u=0 v=0']);

    let token = null;
    let urgentToken = null;
    await act(async () => {
      startTransition(() => {
        token = React.unstable_getCurrentWriteBatch();
        setValue(1);
      });
      // Interrupt with an urgent update before the transition commits.
      urgentToken = React.unstable_getCurrentWriteBatch();
      setUrgent(1);
    });
    assertLog(['u=1 v=0', 'u=1 v=1']);
    // Urgent tokens carry a 0 deferred bit; transition tokens a 1.
    expect(urgentToken & 1).toBe(0);
    expect(token & 1).toBe(1);
    // No pass includes both batches; the urgent pass excludes the pending
    // transition, and the transition's own pass includes it.
    const mixed = events.passes.filter(
      p => p.included.includes(token) && p.included.includes(urgentToken),
    );
    expect(mixed).toEqual([]);
    expect(
      events.passes.some(
        p => p.included.includes(urgentToken) && !p.included.includes(token),
      ),
    ).toBe(true);
    expect(events.passes.some(p => p.included.includes(token))).toBe(true);
    unsubscribe();
  });

  it('parks a store-only async action until the action settles', async () => {
    const {events, unsubscribe} = subscribe();
    let resolveGate;
    const gate = new Promise(resolve => {
      resolveGate = resolve;
    });
    let token = null;
    startTransition(async () => {
      token = React.unstable_getCurrentWriteBatch();
      await gate;
    });
    // Let the event's scheduling microtask (the close edge) run.
    await act(() => {});
    expect(token & 1).toBe(1);
    expect(events.retired.map(r => r.token)).not.toContain(token);

    resolveGate();
    await act(() => gate);
    expect(events.retired.filter(r => r.token === token)).toEqual([
      {token, committed: false},
    ]);
    unsubscribe();
  });

  it('locks a committed batch into later renders on that root while other roots are pending', async () => {
    const {events, unsubscribe} = subscribe();
    let resolveGate;
    const gate = new Promise(resolve => {
      resolveGate = resolve;
    });
    let setA;
    let bumpA;
    let setB;
    function CompA() {
      const [on, _set] = useState(false);
      const [n, _setN] = useState(0);
      setA = _set;
      bumpA = _setN;
      return <Text text={`A on=${on} n=${n}`} />;
    }
    function CompB() {
      const [on, _set] = useState(false);
      setB = _set;
      if (on) {
        React.use(gate); // suspends the transition render on root B
      }
      return <Text text={`B on=${on}`} />;
    }
    const rootA = ReactNoop.createRoot();
    await act(() => {
      rootA.render(<CompA />);
    });
    assertLog(['A on=false n=0']);
    const containerA = events.passes[events.passes.length - 1].container;
    const rootB = ReactNoop.createRoot();
    await act(() => {
      rootB.render(<CompB />);
    });
    assertLog(['B on=false']);

    let token = null;
    await act(() => {
      startTransition(() => {
        token = React.unstable_getCurrentWriteBatch();
        setA(true);
        setB(true);
      });
    });
    // Root A committed the batch; root B is suspended on the gate, so the
    // token must not retire yet.
    assertLog(['A on=true n=0']);
    expect(events.retired.map(r => r.token)).not.toContain(token);

    // A later urgent render on root A includes the committed-but-unretired
    // batch (root A's committed tree already shows it).
    events.passes.length = 0;
    await act(() => {
      bumpA(1);
    });
    assertLog(['A on=true n=1']);
    const aPasses = events.passes.filter(p => p.container === containerA);
    expect(aPasses.length).toBeGreaterThan(0);
    expect(aPasses.every(p => p.included.includes(token))).toBe(true);

    // Root B settles: the batch commits everywhere and retires exactly once.
    resolveGate();
    await act(() => gate);
    assertLog(['B on=true']);
    expect(events.retired.filter(r => r.token === token)).toEqual([
      {token, committed: true},
    ]);
    unsubscribe();
  });

  describe('protocol handshake', () => {
    // Every capability bit this build implements AND pins with tests: batch
    // tokens, pass lifecycle, retirement, mutation window (S1); pass
    // yield/resume edges + end disposition, discardAllWip (S3); runInBatch
    // (S4, pinned by ReactFiberRunInBatch-test.js). Growing this constant
    // is deliberate: a bit may only be added together with the runtime
    // capability it names and the tests that pin it.
    const IMPLEMENTED_CAPABILITIES =
      (1 << 0) |
      (1 << 1) |
      (1 << 2) |
      (1 << 3) |
      (1 << 4) |
      (1 << 6) |
      (1 << 8);

    function getSharedInternals(ReactModule) {
      return ReactModule.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    }

    it('exposes version and capability bits on both sides of the channel', () => {
      const protocol = React.unstable_externalRuntimeProtocol;
      expect(protocol.version).toBe(1);
      expect(protocol.capabilities).toBe(IMPLEMENTED_CAPABILITIES);
      // The renderer (required in beforeEach) registered a provider echoing
      // the version and capabilities its reconciler was built with.
      expect(protocol.providerProtocols).toEqual([
        {version: 1, capabilities: IMPLEMENTED_CAPABILITIES},
      ]);
    });

    it('a renderer refuses to load against a react package without the registry (no silent no-op)', () => {
      jest.resetModules();
      const FreshReact = require('react');
      // Simulate version skew: a react package that never created the
      // external-runtime registry (stock React, or a pre-protocol build).
      getSharedInternals(FreshReact).E = null;
      expect(() => require('react-noop-renderer')).toThrow(
        /does not provide the external-runtime registry/,
      );
    });

    it('a renderer refuses to load across a protocol version mismatch (fails loudly)', () => {
      jest.resetModules();
      const FreshReact = require('react');
      // Simulate a react package built for a future protocol version.
      getSharedInternals(FreshReact).E.protocol = {
        version: 2,
        capabilities: 0,
      };
      expect(() => require('react-noop-renderer')).toThrow(
        /protocol version skew: the react package speaks v2 but this renderer was built for v1/,
      );
    });
  });
});
