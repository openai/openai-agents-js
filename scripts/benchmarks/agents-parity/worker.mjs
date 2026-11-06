import process from 'node:process';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { get as httpGet, Agent as HttpAgent } from 'node:http';

const [side, workload] = process.argv.slice(2);
const entry = process.env[side === 'v0' ? 'V0_ENTRY' : 'V1_ENTRY'];
assert(entry, `Set ${side === 'v0' ? 'V0_ENTRY' : 'V1_ENTRY'}`);
const tImport = performance.now();
const sdk = await import(pathToFileURL(entry).href);
const importMs = performance.now() - tImport;
const facadeImportedFromProcessStartMs =
  performance.timeOrigin +
  performance.now() -
  Number(process.env.BENCH_PARENT_START_EPOCH_MS);
if (workload === 'cold-import') {
  console.log(
    JSON.stringify({
      side,
      workload,
      importMs,
      facadeImportedFromProcessStartMs,
      errors: 0,
      completed: 0,
    }),
  );
  process.exit();
}
const lifecycleStart = performance.now();
const require = createRequire(pathToFileURL(entry));
const { z } = require('zod');
const baseUrl = process.env.BENCH_BASE_URL;
const tracing = process.env.BENCH_TRACE === 'on';
let traceRecords = 0;
if (side === 'v0') {
  sdk.setTracingDisabled(!tracing);
  sdk.setTraceProcessors([
    {
      onTraceStart() {
        traceRecords++;
      },
      onTraceEnd() {
        traceRecords++;
      },
      onSpanStart() {
        traceRecords++;
      },
      onSpanEnd() {
        traceRecords++;
      },
      async forceFlush() {},
      async shutdown() {},
    },
  ]);
} else if (tracing) {
  await sdk.telemetry.configure({
    traceProcessors: [
      {
        onEvent() {
          traceRecords++;
        },
      },
    ],
  });
}
const nativeTraceOptions = tracing
  ? { tracing: { name: 'Benchmark', includeSensitiveData: false } }
  : {};
let toolCalls = 0,
  completed = 0,
  errors = 0;
let logicalInputBytes = 0,
  logicalOutputBytes = 0,
  measuredInputBytes = 0,
  measuredOutputBytes = 0,
  streamedTextBytes = 0;
const chain = workload === 'tool-chain8';
const toolCount = ['tool8', 'tool-chain8'].includes(workload)
  ? 8
  : workload === 'tool1'
    ? 1
    : 0;
const tools = toolCount
  ? [
      sdk.tool({
        name: 'echo',
        description: 'Return value.',
        parameters: z.object({ value: z.string() }),
        execute: ({ value }) => {
          toolCalls++;
          return value;
        },
      }),
    ]
  : [];
const provider =
  side === 'v0'
    ? new sdk.OpenAIProvider({
        baseURL: baseUrl,
        apiKey: 'fixture',
        useResponses: true,
        useResponsesWebSocket: false,
      })
    : new sdk.NativeProvider({
        baseUrl,
        apiKey: 'fixture',
        supportsWebsockets: false,
      });
const agent = new sdk.Agent({
  name: 'Benchmark',
  instructions: 'Use echo if asked, then answer.',
  model: 'gpt-5',
  modelSettings:
    side === 'v0'
      ? { reasoning: { effort: 'low' } }
      : { reasoningEffort: 'low' },
  tools,
  ...(side === 'v1' ? { provider } : {}),
});
const runner =
  side === 'v0'
    ? new sdk.Runner({
        modelProvider: provider,
        tracingDisabled: !tracing,
        traceIncludeSensitiveData: false,
      })
    : null;
const count =
  workload === 'cold-first' ? 1 : Number(process.env.BENCH_TURNS ?? 20);
const lanes = workload === 'concurrent8' ? 8 : 1;
const stream = workload === 'stream-session';
const oneShot = workload === 'warm-one-shot' || workload === 'cold-first';
const latencies = [],
  firstText = [],
  openTimes = [],
  closeTimes = [];
let readyLanes = 0,
  finishedLanes = 0,
  timedStart,
  timedEnd,
  measuredCpuStart,
  measuredCpu;
let fixtureBefore,
  fixtureAfter,
  fixtureControlBeforeMs,
  fixtureControlAfterMs,
  firstUsefulFromProcessStartMs,
  firstUsefulAfterConstructionMs;
const fixtureControlAgent = new HttpAgent({ keepAlive: false });
const fixtureStats = (phase) =>
  new Promise((resolve, reject) => {
    httpGet(
      `${baseUrl.slice(0, -3)}/stats?phase=${phase}`,
      { agent: fixtureControlAgent },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          try {
            assert.equal(response.statusCode, 200);
            resolve(JSON.parse(Buffer.concat(chunks)));
          } catch (error) {
            reject(error);
          }
        });
        response.on('error', reject);
      },
    ).on('error', reject);
  });
let releaseReady, rejectReady;
const allReady = new Promise((resolve, reject) => {
  releaseReady = resolve;
  rejectReady = reject;
});
let releaseFinished, rejectFinished;
const allFinished = new Promise((resolve, reject) => {
  releaseFinished = resolve;
  rejectFinished = reject;
});
void allReady.catch(() => {});
void allFinished.catch(() => {});
let profiler, profilePost;
if (process.env.BENCH_CPU_PROFILE_DIR) {
  const { Session } = await import('node:inspector');
  profiler = new Session();
  profiler.connect();
  profilePost = (method) =>
    new Promise((resolve, reject) =>
      profiler.post(method, (error, result) =>
        error ? reject(error) : resolve(result),
      ),
    );
  await profilePost('Profiler.enable');
}
async function lane(index) {
  const sessionId = `lane${index}`;
  let session;
  let observationCursor = 0;
  const tOpen = performance.now();
  if (!oneShot)
    session =
      side === 'v0'
        ? new sdk.MemorySession()
        : await agent.session(nativeTraceOptions);
  if (side === 'v0' && session && process.env.BENCH_DROP_TOOL_HISTORY === '1') {
    const getItems = session.getItems.bind(session);
    session.getItems = async (...args) =>
      (await getItems(...args)).filter(
        (item) =>
          item.type !== 'function_call' && item.type !== 'function_call_output',
      );
  }
  openTimes.push(performance.now() - tOpen);
  async function turn(turnIndex, timed = true) {
    const input = `BENCH:${sessionId}:${turnIndex}:${toolCount} ${workload === 'history100' ? 'x'.repeat(1024) : 'hello'}`;
    const expected = `ANSWER:${sessionId}:${turnIndex}`.padEnd(
      Number(process.env.BENCH_OUTPUT_BYTES ?? 256),
      '.',
    );
    const start = performance.now();
    let result,
      text = '',
      first;
    if (side === 'v0') {
      const runSession =
        process.env.BENCH_DROP_HISTORY === '1' && turnIndex >= 2000
          ? undefined
          : session;
      result = await runner.run(agent, input, {
        ...(runSession ? { session: runSession } : {}),
        ...(stream ? { stream: true } : {}),
        ...(chain ? { maxTurns: 12 } : {}),
      });
      if (stream) {
        for await (const delta of result.toTextStream()) {
          first ??= performance.now() - start;
          text += delta;
        }
        await result.completed;
      }
    } else if (oneShot) result = await agent.run(input, nativeTraceOptions);
    else {
      const turn = await session.submit(input, { ifBusy: 'reject' });
      if (stream)
        for await (const event of turn.events({ after: observationCursor })) {
          assert.notEqual(event.type, 'gap', 'Stream observation gap');
          observationCursor = event.sequence;
          if (event.type === 'output_text_delta') {
            first ??= performance.now() - start;
            text += event.delta;
          }
        }
      result = await turn.wait();
    }
    const elapsed = performance.now() - start;
    assert.equal(result.finalOutput, expected);
    firstUsefulFromProcessStartMs ??=
      performance.timeOrigin +
      performance.now() -
      Number(process.env.BENCH_PARENT_START_EPOCH_MS);
    firstUsefulAfterConstructionMs ??= performance.now() - start;
    if (stream) {
      assert.equal(text, expected);
      assert(first !== undefined);
    }
    logicalInputBytes += Buffer.byteLength(input);
    logicalOutputBytes += Buffer.byteLength(expected);
    if (stream) streamedTextBytes += Buffer.byteLength(text);
    if (timed) {
      measuredInputBytes += Buffer.byteLength(input);
      measuredOutputBytes += Buffer.byteLength(expected);
    }
    completed++;
    if (timed) {
      latencies.push(elapsed);
      if (first !== undefined) firstText.push(first);
    }
  }
  try {
    if (workload === 'history100')
      for (let i = 0; i < 100; i++) await turn(i, false);
    if (workload !== 'cold-first') await turn(1000, false);
    if (++readyLanes === lanes) {
      const controlStart = performance.now();
      fixtureBefore = await fixtureStats('begin');
      fixtureControlBeforeMs = performance.now() - controlStart;
      if (profiler) await profilePost('Profiler.start');
      measuredCpuStart = process.cpuUsage();
      timedStart = performance.now();
      releaseReady();
    }
    await allReady;
    for (let i = 0; i < count; i++) await turn(2000 + i);
    if (++finishedLanes === lanes) {
      timedEnd = performance.now();
      measuredCpu = process.cpuUsage(measuredCpuStart);
      let profile;
      if (profiler) {
        ({ profile } = await profilePost('Profiler.stop'));
      }
      const controlStart = performance.now();
      fixtureAfter = await fixtureStats('end');
      fixtureControlAfterMs = performance.now() - controlStart;
      if (profiler) {
        const { mkdir, writeFile } = await import('node:fs/promises');
        const directory = process.env.BENCH_CPU_PROFILE_DIR;
        await mkdir(directory, { recursive: true });
        await writeFile(
          `${directory}/${side}-${workload}-${process.pid}.cpuprofile`,
          JSON.stringify(profile),
        );
        profiler.disconnect();
      }
      releaseFinished();
    }
    await allFinished;
  } catch (error) {
    rejectReady(error);
    rejectFinished(error);
    throw error;
  } finally {
    const start = performance.now();
    if (side === 'v1' && session) await session.close();
    closeTimes.push(performance.now() - start);
  }
}
const start = performance.now();
const cpuStart = process.cpuUsage();
try {
  await Promise.all(Array.from({ length: lanes }, (_, i) => lane(i)));
} catch (error) {
  errors++;
  console.error(error.stack);
}
const wallMs = performance.now() - start;
await provider.close();
fixtureControlAgent.destroy();
let traceFlush = null,
  traceFlushMs = 0,
  traceShutdownMs = 0;
const flushStart = performance.now();
if (side === 'v1' && tracing) {
  traceFlush = await sdk.telemetry.forceFlush();
  assert.equal(traceFlush.status, 'success');
  assert.equal(traceFlush.droppedRecords, 0);
  assert.equal(traceFlush.failedDeliveries, 0);
  traceFlushMs = performance.now() - flushStart;
}
if (side === 'v1' && tracing) {
  const shutdownStart = performance.now();
  await sdk.telemetry.shutdown();
  traceShutdownMs = performance.now() - shutdownStart;
}
if (side === 'v0' && tracing) {
  await sdk.getGlobalTraceProvider().forceFlush();
  traceFlushMs = performance.now() - flushStart;
}
if (tracing) assert(traceRecords > 0, 'Tracing emitted no records');
else assert.equal(traceRecords, 0, 'Disabled tracing emitted records');
const lifecycleMs = performance.now() - lifecycleStart;
const sorted = (values) => [...values].sort((a, b) => a - b);
const quantile = (values, q) => {
  const s = sorted(values);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null;
};
const resources = process.resourceUsage();
console.log(
  JSON.stringify({
    side,
    workload,
    trace: tracing,
    traceProcessorInstalled: side === 'v0' || tracing,
    traceExporterConfigured: false,
    nativeTelemetryConfigured: side === 'v1' && tracing,
    importMs,
    facadeImportedFromProcessStartMs,
    firstUsefulFromProcessStartMs,
    firstUsefulAfterConstructionMs,
    wallMs,
    lifecycleMs,
    traceFlushMs,
    traceShutdownMs,
    traceFlush,
    traceDeliveryCountersAvailable: side === 'v1' && tracing,
    measuredWallMs: timedEnd - timedStart,
    timedCompleted: count * lanes,
    measuredCpu,
    profiled: Boolean(profiler),
    serverMeasuredCpuMs:
      fixtureAfter &&
      (fixtureAfter.cpu.user -
        fixtureBefore.cpu.user +
        fixtureAfter.cpu.system -
        fixtureBefore.cpu.system) /
        1000,
    measuredNewModelConnections:
      fixtureAfter &&
      fixtureAfter.modelConnections - fixtureBefore.modelConnections,
    measuredModelConnections: fixtureAfter?.measuredModelConnections,
    fixtureControlBeforeMs,
    fixtureControlAfterMs,
    parameters: {
      outputBytes: Number(process.env.BENCH_OUTPUT_BYTES ?? 256),
      streamChunks: Number(process.env.BENCH_STREAM_CHUNKS ?? 8),
      modelDelayMs: Number(process.env.BENCH_MODEL_DELAY_MS ?? 0),
      historyPrefill: workload === 'history100' ? 100 : 0,
      inputPaddingBytes: workload === 'history100' ? 1024 : 0,
      toolCount,
      serialToolChain: chain,
      streaming: stream,
      oneShot,
    },
    count,
    lanes,
    completed,
    errors,
    toolCalls,
    expectedRequests: completed * (chain ? 9 : toolCount ? 2 : 1),
    logicalInputBytes,
    logicalOutputBytes,
    measuredInputBytes,
    measuredOutputBytes,
    streamedTextBytes,
    p50Ms: quantile(latencies, 0.5),
    p95Ms: quantile(latencies, 0.95),
    turnP50Ms: quantile(latencies, 0.5),
    turnP95Ms: quantile(latencies, 0.95),
    minMs: quantile(latencies, 0),
    maxMs: quantile(latencies, 1),
    firstTextP50Ms: quantile(firstText, 0.5),
    openTimes,
    closeTimes,
    latencies,
    traceRecords,
    cpu: process.cpuUsage(cpuStart),
    rssBytes: process.memoryUsage().rss,
    peakRssBytes: resources.maxRSS * 1024,
    voluntaryContextSwitches: resources.voluntaryContextSwitches,
    involuntaryContextSwitches: resources.involuntaryContextSwitches,
  }),
);
if (errors) process.exitCode = 1;
