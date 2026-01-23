import { Agent } from '../../src/agent';
import { StreamedRunResult } from '../../src/result';
import { RunContext } from '../../src/runContext';
import { RunState } from '../../src/runState';
import { getEventListeners } from 'node:events';

/**
 * Manual GC-based leak regression check for StreamedRunResult abort listeners.
 *
 * How to run from the repo root:
 * `node --expose-gc --import tsx packages/agents-core/test/manual/streamedRunResultLeakCheck.ts`.
 *
 * Notes:
 * - Requires WeakRef and FinalizationRegistry support.
 * - GC timing is nondeterministic, so this is a best-effort sanity check.
 * - The script intentionally retains the abort signal to mimic Node retaining signals.
 *
 * Optional environment variables:
 * - LEAK_CHECK_RETAIN_SIGNAL=0 disables signal retention.
 * - LEAK_CHECK_DEBUG=1 prints extra diagnostics.
 * - LEAK_CHECK_ATTEMPTS=<n> increases GC cycles.
 * - LEAK_CHECK_PRESSURE_SIZE=<n> increases memory pressure per cycle.
 * - LEAK_CHECK_FORCE_REMOVE_FAIL=1 forces removeEventListener to throw.
 *   This stress mode is best-effort and may still fail due to GC nondeterminism.
 */

type WeakRefLike<T extends object> = {
  deref(): T | undefined;
};
type WeakRefConstructor = new <T extends object>(value: T) => WeakRefLike<T>;
type FinalizationRegistryLike<T> = {
  register(target: object, heldValue: T): void;
};
type FinalizationRegistryConstructor = new <T>(
  cleanup: (heldValue: T) => void,
) => FinalizationRegistryLike<T>;

const weakRefConstructor = (globalThis as { WeakRef?: WeakRefConstructor })
  .WeakRef;
const finalizationRegistryConstructor = (
  globalThis as {
    FinalizationRegistry?: FinalizationRegistryConstructor;
  }
).FinalizationRegistry;

type ScenarioRefs = {
  agentRef: WeakRefLike<Agent<any, any>>;
  stateRef: WeakRefLike<RunState<any, Agent<any, any>>>;
  resultRef: WeakRefLike<StreamedRunResult<any, Agent<any, any>>>;
  tokens: {
    agent: string;
    state: string;
    result: string;
  };
};

const maybeGc = (globalThis as { gc?: () => void }).gc;
if (typeof maybeGc !== 'function') {
  console.error('global.gc is not available. Run with --expose-gc.');
  process.exit(2);
}
const gc: () => void = maybeGc;

if (
  typeof weakRefConstructor !== 'function' ||
  typeof finalizationRegistryConstructor !== 'function'
) {
  console.error(
    'WeakRef/FinalizationRegistry are not available in this runtime.',
  );
  process.exit(2);
}
const weakRefCtor: WeakRefConstructor = weakRefConstructor;
const finalizationRegistryCtor: FinalizationRegistryConstructor =
  finalizationRegistryConstructor;

// Retain abort signals to mimic Node's persistent abort-signal bookkeeping.
const retainedSignals: AbortSignal[] = [];
const retainSignals = process.env.LEAK_CHECK_RETAIN_SIGNAL !== '0';
const debug = process.env.LEAK_CHECK_DEBUG === '1';
const collectionAttempts = Number(process.env.LEAK_CHECK_ATTEMPTS ?? 120);
const pressureSize = Number(process.env.LEAK_CHECK_PRESSURE_SIZE ?? 80_000);
const forceRemoveFail = process.env.LEAK_CHECK_FORCE_REMOVE_FAIL === '1';

function patchAbortSignalRemovalFailure(): (() => void) | undefined {
  if (!forceRemoveFail) {
    return undefined;
  }
  const proto = AbortSignal.prototype as {
    removeEventListener?: typeof AbortSignal.prototype.removeEventListener;
  };
  const original = proto.removeEventListener;
  if (typeof original !== 'function') {
    return undefined;
  }
  // Simulate environments where listener detachment fails and the signal retains handlers.
  proto.removeEventListener = (() => {
    throw new Error('forced removeEventListener failure');
  }) as typeof original;
  return () => {
    proto.removeEventListener = original;
  };
}

const finalizedTokens = new Set<string>();
// Use finalization tokens because WeakRef alone is not a stable assertion surface.
const registry = new finalizationRegistryCtor<string>((token) => {
  finalizedTokens.add(token);
});

const waitTick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function runScenario(kind: 'done' | 'error'): Promise<ScenarioRefs> {
  // Register three tokens so we can detect that all relevant objects are collected.
  const tokens = {
    agent: `${kind}:agent`,
    state: `${kind}:state`,
    result: `${kind}:result`,
  };
  let agent: Agent<any, any> | undefined = new Agent({
    name: `leak-check-${kind}`,
  });
  let state: RunState<any, Agent<any, any>> | undefined = new RunState(
    new RunContext(),
    '',
    agent,
    1,
  );
  registry.register(agent, tokens.agent);
  registry.register(state, tokens.state);
  const agentRef = new weakRefCtor(agent);
  const stateRef = new weakRefCtor(state);

  let result: StreamedRunResult<any, Agent<any, any>> | undefined =
    new StreamedRunResult({ state });
  registry.register(result, tokens.result);
  const resultRef = new weakRefCtor(result);
  const signal = result._getAbortSignal();
  if (retainSignals && signal) {
    // This mirrors the reported retention chain through AbortSignal.
    retainedSignals.push(signal);
  }

  if (kind === 'done') {
    result._done();
    await result.completed;
  } else {
    const err = new Error('boom');
    result._raiseError(err);
    try {
      await result.completed;
    } catch {
      // Ignore expected rejection.
    }
  }

  if (debug && signal) {
    const listeners = getEventListeners(signal, 'abort').length;
    console.log(`listeners after ${kind}: ${listeners}`);
  }

  result = undefined;
  state = undefined;
  agent = undefined;

  return { agentRef, stateRef, resultRef, tokens };
}

async function forceCollection(refs: ScenarioRefs): Promise<boolean> {
  for (let i = 0; i < collectionAttempts; i += 1) {
    gc();
    // Apply memory pressure to encourage full collections in practice.
    const pressure = new Array(pressureSize).fill(i);
    void pressure;
    await waitTick();
    const finalized =
      finalizedTokens.has(refs.tokens.agent) &&
      finalizedTokens.has(refs.tokens.state) &&
      finalizedTokens.has(refs.tokens.result);
    if (finalized) {
      if (debug) {
        const resultAlive = Boolean(refs.resultRef.deref());
        console.log(`result alive after collection: ${resultAlive}`);
      }
      return true;
    }
  }
  const weakCollected = !refs.agentRef.deref() && !refs.stateRef.deref();
  const finalized =
    finalizedTokens.has(refs.tokens.agent) &&
    finalizedTokens.has(refs.tokens.state) &&
    finalizedTokens.has(refs.tokens.result);
  return weakCollected || finalized;
}

async function main() {
  const restoreRemoveEventListener = patchAbortSignalRemovalFailure();
  try {
    const doneRefs = await runScenario('done');
    const errorRefs = await runScenario('error');

    const doneCollected = await forceCollection(doneRefs);
    const errorCollected = await forceCollection(errorRefs);

    if (!doneCollected || !errorCollected) {
      if (debug) {
        console.error(
          `done finalized: agent=${finalizedTokens.has(doneRefs.tokens.agent)} state=${finalizedTokens.has(doneRefs.tokens.state)} result=${finalizedTokens.has(doneRefs.tokens.result)}`,
        );
        console.error(
          `error finalized: agent=${finalizedTokens.has(errorRefs.tokens.agent)} state=${finalizedTokens.has(errorRefs.tokens.state)} result=${finalizedTokens.has(errorRefs.tokens.result)}`,
        );
      }
      console.error(
        `collection failed: done=${doneCollected} error=${errorCollected}`,
      );
      process.exit(1);
    }

    console.log('OK: streamed run state is collectable.');
  } finally {
    restoreRemoveEventListener?.();
  }
}

main().catch((err) => {
  console.error(`unexpected error: ${err}`);
  process.exit(1);
});
