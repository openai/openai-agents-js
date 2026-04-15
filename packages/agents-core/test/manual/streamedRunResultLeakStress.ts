import { getEventListeners } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from '../../src/agent';
import { StreamedRunResult } from '../../src/result';
import { RunContext } from '../../src/runContext';
import { RunState } from '../../src/runState';
import { getExposedGc } from './gcRuntime';

/**
 * Stress-style manual leak check that amplifies retention through abort signals.
 *
 * How to run from the repo root:
 * `node --expose-gc --import tsx packages/agents-core/test/manual/streamedRunResultLeakStress.ts`.
 *
 * Intended usage:
 * 1) Run on the strong-handler implementation to reproduce retention.
 * 2) Restore the indirection ref implementation and re-run to compare.
 *
 * Optional environment variables:
 * - LEAK_STRESS_ITERATIONS=<n> controls the number of runs (default: 1000).
 * - LEAK_STRESS_PAYLOAD_BYTES=<n> controls payload size per run (default: 200000).
 * - LEAK_STRESS_SNAPSHOT_EVERY=<n> controls log cadence (default: 250).
 * - LEAK_STRESS_GC_CYCLES=<n> controls GC settle cycles per snapshot (default: 6).
 * - LEAK_STRESS_PRESSURE_SIZE=<n> controls heap pressure per GC cycle (default: 200000).
 * - LEAK_STRESS_ABORT_AFTER_DONE=0 disables the post-completion abort probe.
 * - LEAK_STRESS_RETAIN_SIGNAL=0 disables retaining abort signals.
 * - LEAK_STRESS_REMOVE_MODE=normal|noop|throw controls removeEventListener behavior.
 *   Use noop/throw to simulate environments where listener detachment fails.
 * - LEAK_STRESS_MIN_FINALIZED_RATIO=<n> sets the required finalization ratio (default: 0.9).
 * - LEAK_STRESS_MAX_POST_DONE_ABORT_MUTATIONS=<n> caps post-done abort mutations (default: 0).
 */

type RemoveMode = 'normal' | 'noop' | 'throw';
type FinalizationRegistryLike<T> = {
  register(target: object, heldValue: T): void;
};
type FinalizationRegistryConstructor = new <T>(
  cleanup: (heldValue: T) => void,
) => FinalizationRegistryLike<T>;

export type StreamedRunResultLeakStressOptions = {
  iterations?: number;
  payloadBytes?: number;
  snapshotEvery?: number;
  gcCycles?: number;
  pressureSize?: number;
  abortAfterDone?: boolean;
  retainSignals?: boolean;
  removeMode?: RemoveMode;
  minFinalizedRatio?: number;
  maxPostDoneAbortMutations?: number;
  onLog?: (line: string) => void;
};

export type StreamedRunResultLeakStressResult = {
  finalizedRatio: number;
  minFinalizedRatio: number;
  postDoneAbortMutations: number;
  maxPostDoneAbortMutations: number;
  deltaExternal: number;
  finalizedRatioTooLow: boolean;
  abortMutationExceeded: boolean;
};

function getLeakStressRuntime(): {
  gc: () => void;
  finalizationRegistryCtor: FinalizationRegistryConstructor;
} {
  const finalizationRegistryConstructor = (
    globalThis as {
      FinalizationRegistry?: FinalizationRegistryConstructor;
    }
  ).FinalizationRegistry;
  if (typeof finalizationRegistryConstructor !== 'function') {
    throw new Error('FinalizationRegistry is not available in this runtime.');
  }

  return {
    gc: getExposedGc(),
    finalizationRegistryCtor: finalizationRegistryConstructor,
  };
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const waitTick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function settleGc(options: {
  gc: () => void;
  gcCycles: number;
  pressureSize: number;
}): Promise<void> {
  const { gc, gcCycles, pressureSize } = options;
  // Run multiple GC cycles with ticks so finalizers have a chance to run.
  for (let i = 0; i < gcCycles; i += 1) {
    gc();
    // Apply some heap pressure to encourage full collections in practice.
    const pressure = new Array(pressureSize).fill(i);
    void pressure;
    await waitTick();
  }
}

function makePayload(bytes: number, seed: number): Buffer {
  // Buffers allocate external memory, which is easier to observe for leaks.
  return Buffer.alloc(bytes, seed % 256);
}

function patchSignalRemoval(signal: AbortSignal, removeMode: RemoveMode): void {
  if (removeMode === 'normal') {
    return;
  }
  const originalRemove = signal.removeEventListener;
  if (typeof originalRemove !== 'function') {
    return;
  }
  if (removeMode === 'noop') {
    (
      signal as AbortSignal & { removeEventListener: typeof originalRemove }
    ).removeEventListener = (() => {
      // Intentionally do nothing to simulate a stuck listener.
    }) as typeof originalRemove;
    return;
  }
  (
    signal as AbortSignal & { removeEventListener: typeof originalRemove }
  ).removeEventListener = (() => {
    throw new Error('forced removeEventListener failure');
  }) as typeof originalRemove;
}

async function runOnce(
  i: number,
  options: {
    payloadBytes: number;
    abortAfterDone: boolean;
    retainSignals: boolean;
    retainedSignals: AbortSignal[];
    removeMode: RemoveMode;
    registry: FinalizationRegistryLike<string>;
  },
): Promise<boolean> {
  const {
    payloadBytes,
    abortAfterDone,
    retainSignals,
    retainedSignals,
    removeMode,
    registry,
  } = options;
  let agent: Agent<any, any> | undefined = new Agent({
    name: `leak-stress-${i}`,
  });
  // Attach a large payload directly to the agent to amplify retention.
  (agent as Agent<any, any> & { __payload?: Buffer }).__payload = makePayload(
    payloadBytes,
    i,
  );

  let state: RunState<any, Agent<any, any>> | undefined = new RunState(
    new RunContext(),
    '',
    agent,
    1,
  );

  let result: StreamedRunResult<any, Agent<any, any>> | undefined =
    new StreamedRunResult({ state });
  registry.register(agent, `agent:${i}`);
  registry.register(state, `state:${i}`);
  registry.register(result, `result:${i}`);
  const signal = result._getAbortSignal();
  if (signal) {
    // Patch only this signal so we do not affect unrelated AbortSignal usage.
    patchSignalRemoval(signal, removeMode);
  }
  if (retainSignals && signal) {
    retainedSignals.push(signal);
  }

  result._done();
  await result.completed;

  let mutatedAfterDone = false;
  if (abortAfterDone && signal) {
    // Probe whether a retained signal can still mutate the run after completion.
    const cancelledBeforeAbort = result.cancelled;
    signal.dispatchEvent(new Event('abort'));
    mutatedAfterDone = !cancelledBeforeAbort && result.cancelled;
  }

  // Drop all strong references from this iteration.
  result = undefined;
  state = undefined;
  agent = undefined;

  return mutatedAfterDone;
}

function totalAbortListeners(
  retainedSignals: AbortSignal[],
  retainSignals: boolean,
): number {
  if (!retainSignals) {
    return 0;
  }
  let total = 0;
  for (const signal of retainedSignals) {
    total += getEventListeners(signal, 'abort').length;
  }
  return total;
}

export async function runStreamedRunResultLeakStress(
  options: StreamedRunResultLeakStressOptions = {},
): Promise<StreamedRunResultLeakStressResult> {
  const runtime = getLeakStressRuntime();
  const iterations = Number(
    options.iterations ?? process.env.LEAK_STRESS_ITERATIONS ?? 1000,
  );
  const payloadBytes = Number(
    options.payloadBytes ?? process.env.LEAK_STRESS_PAYLOAD_BYTES ?? 200_000,
  );
  const snapshotEvery = Number(
    options.snapshotEvery ?? process.env.LEAK_STRESS_SNAPSHOT_EVERY ?? 250,
  );
  const gcCycles = Number(
    options.gcCycles ?? process.env.LEAK_STRESS_GC_CYCLES ?? 6,
  );
  const pressureSize = Number(
    options.pressureSize ?? process.env.LEAK_STRESS_PRESSURE_SIZE ?? 200_000,
  );
  const abortAfterDone =
    options.abortAfterDone ?? process.env.LEAK_STRESS_ABORT_AFTER_DONE !== '0';
  const retainSignals =
    options.retainSignals ?? process.env.LEAK_STRESS_RETAIN_SIGNAL !== '0';
  const removeMode =
    options.removeMode ??
    ((process.env.LEAK_STRESS_REMOVE_MODE ?? 'noop') as RemoveMode);
  const minFinalizedRatio = Number(
    options.minFinalizedRatio ??
      process.env.LEAK_STRESS_MIN_FINALIZED_RATIO ??
      0.9,
  );
  const maxPostDoneAbortMutations = Number(
    options.maxPostDoneAbortMutations ??
      process.env.LEAK_STRESS_MAX_POST_DONE_ABORT_MUTATIONS ??
      0,
  );
  const retainedSignals: AbortSignal[] = [];
  const finalizedTokens = new Set<string>();
  const registry = new runtime.finalizationRegistryCtor<string>((token) => {
    finalizedTokens.add(token);
  });
  let postDoneAbortMutations = 0;
  const onLog = options.onLog;
  const settleOptions = {
    gc: runtime.gc,
    gcCycles,
    pressureSize,
  };
  const snapshotMemoryWithOptions = async () => {
    await settleGc(settleOptions);
    const usage = process.memoryUsage();
    return {
      heapUsed: usage.heapUsed,
      external: usage.external,
      rss: usage.rss,
    };
  };

  const baseline = await snapshotMemoryWithOptions();
  onLog?.(
    `baseline heapUsed=${formatMb(baseline.heapUsed)} external=${formatMb(baseline.external)} rss=${formatMb(baseline.rss)} mode=${removeMode} iterations=${iterations} payload=${formatMb(payloadBytes)} gcCycles=${gcCycles} pressureSize=${pressureSize} abortAfterDone=${abortAfterDone}`,
  );

  for (let i = 1; i <= iterations; i += 1) {
    const mutatedAfterDone = await runOnce(i, {
      payloadBytes,
      abortAfterDone,
      retainSignals,
      retainedSignals,
      removeMode,
      registry,
    });
    if (mutatedAfterDone) {
      postDoneAbortMutations += 1;
    }
    if (i % snapshotEvery === 0 || i === iterations) {
      const current = await snapshotMemoryWithOptions();
      const deltaHeap = current.heapUsed - baseline.heapUsed;
      const deltaExternal = current.external - baseline.external;
      const expectedTokens = i * 3;
      const finalizedCount = finalizedTokens.size;
      const finalizedRatio =
        expectedTokens > 0
          ? (finalizedCount / expectedTokens).toFixed(2)
          : '0.00';
      onLog?.(
        `[${i}] heapUsed=${formatMb(current.heapUsed)} deltaHeap=${formatMb(deltaHeap)} external=${formatMb(current.external)} deltaExternal=${formatMb(deltaExternal)} listeners=${totalAbortListeners(retainedSignals, retainSignals)} finalized=${finalizedCount}/${expectedTokens} finalizedRatio=${finalizedRatio} postDoneAbortMutations=${postDoneAbortMutations}`,
      );
    }
  }

  const finalSnapshot = await snapshotMemoryWithOptions();
  const expectedTokens = iterations * 3;
  const finalizedCount = finalizedTokens.size;
  const finalizedRatio =
    expectedTokens > 0 ? finalizedCount / expectedTokens : 1;
  const deltaExternal = finalSnapshot.external - baseline.external;
  const abortMutationExceeded =
    abortAfterDone && postDoneAbortMutations > maxPostDoneAbortMutations;
  const finalizedRatioTooLow = finalizedRatio < minFinalizedRatio;

  return {
    finalizedRatio,
    minFinalizedRatio,
    postDoneAbortMutations,
    maxPostDoneAbortMutations,
    deltaExternal,
    finalizedRatioTooLow,
    abortMutationExceeded,
  };
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
  const result = await runStreamedRunResultLeakStress({
    onLog: (line) => {
      console.log(line);
    },
  });

  if (result.finalizedRatioTooLow || result.abortMutationExceeded) {
    await writeLine(
      process.stderr,
      `leak stress check failed: finalizedRatio=${result.finalizedRatio.toFixed(2)} minFinalizedRatio=${result.minFinalizedRatio} postDoneAbortMutations=${result.postDoneAbortMutations} maxPostDoneAbortMutations=${result.maxPostDoneAbortMutations} deltaExternal=${formatMb(result.deltaExternal)}`,
    );
    return 1;
  }

  await writeLine(
    process.stdout,
    `OK: finalizedRatio=${result.finalizedRatio.toFixed(2)} postDoneAbortMutations=${result.postDoneAbortMutations} deltaExternal=${formatMb(result.deltaExternal)}`,
  );
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
