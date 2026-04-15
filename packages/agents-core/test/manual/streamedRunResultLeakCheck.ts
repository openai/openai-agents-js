import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from '../../src/agent';
import { StreamedRunResult } from '../../src/result';
import { RunContext } from '../../src/runContext';
import { RunState } from '../../src/runState';
import { getEventListeners } from 'node:events';
import { getExposedGc } from './gcRuntime';

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

export type StreamedRunResultLeakCheckOptions = {
  retainSignals?: boolean;
  debug?: boolean;
  collectionAttempts?: number;
  pressureSize?: number;
  forceRemoveFail?: boolean;
};

export type StreamedRunResultLeakCheckResult = {
  doneCollected: boolean;
  errorCollected: boolean;
};

type LeakCheckRuntime = {
  gc: () => void;
  weakRefCtor: WeakRefConstructor;
  finalizationRegistryCtor: FinalizationRegistryConstructor;
};

function getLeakCheckRuntime(): LeakCheckRuntime {
  const weakRefConstructor = (globalThis as { WeakRef?: WeakRefConstructor })
    .WeakRef;
  const finalizationRegistryConstructor = (
    globalThis as {
      FinalizationRegistry?: FinalizationRegistryConstructor;
    }
  ).FinalizationRegistry;
  if (
    typeof weakRefConstructor !== 'function' ||
    typeof finalizationRegistryConstructor !== 'function'
  ) {
    throw new Error(
      'WeakRef/FinalizationRegistry are not available in this runtime.',
    );
  }

  return {
    gc: getExposedGc(),
    weakRefCtor: weakRefConstructor,
    finalizationRegistryCtor: finalizationRegistryConstructor,
  };
}

function patchAbortSignalRemovalFailure(
  forceRemoveFail: boolean,
): (() => void) | undefined {
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

const waitTick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function runScenario(
  kind: 'done' | 'error',
  options: {
    debug: boolean;
    registry: FinalizationRegistryLike<string>;
    retainSignals: boolean;
    retainedSignals: AbortSignal[];
    weakRefCtor: WeakRefConstructor;
  },
): Promise<ScenarioRefs> {
  const { debug, registry, retainSignals, retainedSignals, weakRefCtor } =
    options;
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

async function forceCollection(
  refs: ScenarioRefs,
  options: {
    collectionAttempts: number;
    pressureSize: number;
    debug: boolean;
    gc: () => void;
    finalizedTokens: Set<string>;
  },
): Promise<boolean> {
  const { collectionAttempts, pressureSize, debug, gc, finalizedTokens } =
    options;
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

export async function runStreamedRunResultLeakCheck(
  options: StreamedRunResultLeakCheckOptions = {},
): Promise<StreamedRunResultLeakCheckResult> {
  const runtime = getLeakCheckRuntime();
  const retainSignals =
    options.retainSignals ?? process.env.LEAK_CHECK_RETAIN_SIGNAL !== '0';
  const debug = options.debug ?? process.env.LEAK_CHECK_DEBUG === '1';
  const collectionAttempts = Number(
    options.collectionAttempts ?? process.env.LEAK_CHECK_ATTEMPTS ?? 120,
  );
  const pressureSize = Number(
    options.pressureSize ?? process.env.LEAK_CHECK_PRESSURE_SIZE ?? 80_000,
  );
  const forceRemoveFail =
    options.forceRemoveFail ?? process.env.LEAK_CHECK_FORCE_REMOVE_FAIL === '1';
  const retainedSignals: AbortSignal[] = [];
  const finalizedTokens = new Set<string>();
  // Use finalization tokens because WeakRef alone is not a stable assertion surface.
  const registry = new runtime.finalizationRegistryCtor<string>((token) => {
    finalizedTokens.add(token);
  });
  const restoreRemoveEventListener =
    patchAbortSignalRemovalFailure(forceRemoveFail);
  try {
    const doneRefs = await runScenario('done', {
      debug,
      registry,
      retainSignals,
      retainedSignals,
      weakRefCtor: runtime.weakRefCtor,
    });
    const errorRefs = await runScenario('error', {
      debug,
      registry,
      retainSignals,
      retainedSignals,
      weakRefCtor: runtime.weakRefCtor,
    });

    const doneCollected = await forceCollection(doneRefs, {
      collectionAttempts,
      pressureSize,
      debug,
      gc: runtime.gc,
      finalizedTokens,
    });
    const errorCollected = await forceCollection(errorRefs, {
      collectionAttempts,
      pressureSize,
      debug,
      gc: runtime.gc,
      finalizedTokens,
    });

    return { doneCollected, errorCollected };
  } finally {
    restoreRemoveEventListener?.();
  }
}

async function writeLine(stream: NodeJS.WriteStream, line: string) {
  await new Promise<void>((resolve, reject) => {
    stream.write(`${line}\n`, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function main(): Promise<number> {
  const result = await runStreamedRunResultLeakCheck();
  if (!result.doneCollected || !result.errorCollected) {
    await writeLine(
      process.stderr,
      `collection failed: done=${result.doneCollected} error=${result.errorCollected}`,
    );
    return 1;
  }

  await writeLine(process.stdout, 'OK: streamed run state is collectable.');
  return 0;
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(async (err) => {
      await writeLine(process.stderr, `unexpected error: ${err}`);
      process.exit(1);
    });
}
