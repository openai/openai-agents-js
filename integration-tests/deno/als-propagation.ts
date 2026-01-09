// @ts-check

import { getCurrentTrace, setTraceProcessors, withTrace } from '@openai/agents';

// Disable default exporters (e.g., OpenAI exporter) to keep this script hermetic.
setTraceProcessors([]);

const report = await withTrace('Deno ALS propagation', async (trace) => {
  const matchesTrace = () => getCurrentTrace()?.traceId === trace.traceId;
  const results: Record<string, boolean> = {
    sync: matchesTrace(),
  };

  await Promise.resolve().then(() => {
    results.promiseThen = matchesTrace();
  });

  await new Promise<void>((resolve) =>
    queueMicrotask(() => {
      results.queueMicrotask = matchesTrace();
      resolve();
    }),
  );

  await new Promise<void>((resolve) =>
    setTimeout(() => {
      results.setTimeout = matchesTrace();
      resolve();
    }, 0),
  );

  await crypto.subtle.digest('SHA-256', new Uint8Array([1, 2, 3]));
  results.cryptoDigest = matchesTrace();

  const pullStream = new ReadableStream({
    pull(controller) {
      results.readablePull = matchesTrace();
      controller.enqueue('x');
      controller.close();
    },
  });
  await pullStream.getReader().read();

  const transform = new TransformStream({
    transform(chunk, controller) {
      results.transformStreamTransform = matchesTrace();
      controller.enqueue(chunk);
    },
    flush() {
      results.transformStreamFlush = matchesTrace();
    },
  });

  const source = new ReadableStream({
    start(controller) {
      controller.enqueue('y');
      controller.close();
    },
  });

  const transformed = source.pipeThrough(transform);
  const reader = transformed.getReader();
  await reader.read();
  await reader.read();

  return results;
});

console.log(`[ALS_REPORT]${JSON.stringify(report)}[/ALS_REPORT]`);
