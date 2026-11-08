import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Agent, telemetry, tool, ToolOutput } from '@openai/agents';
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';
import { z } from 'zod';

/** A bounded local receiver for this synthetic walkthrough, not a production collector. */
export async function startTraceReceiver() {
  const batches: unknown[] = [];
  let storedBytes = 0;
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/traces') {
      request.resume();
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const chunk of request) {
        bytes += Buffer.byteLength(chunk);
        if (
          bytes > 1_048_576 ||
          storedBytes + bytes > 4_194_304 ||
          batches.length >= 64
        ) {
          response.writeHead(413).end();
          request.resume();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      if (storedBytes + bytes > 4_194_304 || batches.length >= 64) {
        response.writeHead(413).end();
        return;
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      storedBytes += bytes;
      batches.push(body); // Deliberately retain no request headers.
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    } catch {
      if (!response.headersSent) response.writeHead(400).end();
    }
  });
  server.maxConnections = 4;
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1/traces`,
    batches,
    async [Symbol.asyncDispose]() {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      await closed;
    },
  };
}

const spanEnvelope = z.object({
  resourceSpans: z
    .array(
      z.object({
        scopeSpans: z
          .array(
            z.object({
              spans: z.array(
                z.object({
                  traceId: z.string().optional(),
                  spanId: z.string().optional(),
                  name: z.string().optional(),
                  attributes: z
                    .array(
                      z.object({
                        key: z.string(),
                        value: z.unknown(),
                      }),
                    )
                    .optional(),
                }),
              ),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

/** Run once in a fresh process: native telemetry has one process lifetime. */
export async function runNativeTelemetry() {
  await using receiver = await startTraceReceiver();
  const runId = randomUUID();
  const receipts: Array<{
    scenario: string;
    sessionId: string;
    turnId: string | null;
    outcome: 'completed' | 'failed';
    callback: string;
    toolOutput: string | null;
    history: Array<{ id: string; status: string }>;
  }> = [];
  {
    await telemetry.configure({
      traces: {
        kind: 'otlp-http',
        endpoint: receiver.endpoint,
        protocol: 'json',
      },
      environment: 'example',
      spanAttributes: { 'example.run_id': runId },
      // Prompt/response/result content logging stays at its disabled defaults.
    });
    // Disposers preserve primary failures if telemetry or receiver cleanup also fails.
    await using telemetryOwner = {
      [Symbol.asyncDispose]: () => telemetry.shutdown(),
    };
    void telemetryOwner;
    for (const scenario of [
      'success',
      'returned-failure',
      'thrown-callback',
      'invalid-output',
    ] as const) {
      let callback = 'not-called';
      const script =
        scenario === 'invalid-output'
          ? [[text('{"label":42}')]]
          : [
              [toolCall('probe', {}, { callId: scenario })],
              ...(scenario === 'thrown-callback' ? [] : [[text('violet')]]),
            ];
      await telemetry.withTrace({ name: `example.${scenario}` }, () =>
        withScriptedResponses(script, async (peer) => {
          const agent = new Agent<unknown, string | { label: string }>({
            instructions: 'Use probe, then answer briefly.',
            model: 'gpt-5.5',
            provider: peer.provider,
            tools: [
              tool({
                name: 'probe',
                parameters: z.strictObject({}),
                execute: () => {
                  callback = scenario;
                  if (scenario === 'thrown-callback')
                    throw new Error('Synthetic callback failure.');
                  return new ToolOutput(
                    [{ type: 'inputText', text: 'synthetic result' }],
                    scenario !== 'returned-failure',
                  );
                },
              }),
            ],
            ...(scenario === 'invalid-output'
              ? { outputType: z.strictObject({ label: z.string() }) }
              : {}),
          });
          await using session = await agent.session();
          const turn = await telemetry.withSpan({ name: 'admit.probe' }, () =>
            session.submit('Run the synthetic probe.'),
          );
          let outcome: 'completed' | 'failed' = 'completed';
          try {
            await turn.wait();
          } catch {
            outcome = 'failed';
          }
          // Flush completed native records while this Session is still open.
          const flushed = await telemetry.forceFlush({ timeoutMs: 5_000 });
          assert.equal(flushed.status, 'success');
          const history: Array<{ id: string; status: string }> = [];
          for await (const item of session.turns())
            history.push({ id: item.id, status: item.status });
          receipts.push({
            scenario,
            sessionId: session.id,
            turnId: turn.turnId,
            outcome,
            callback,
            toolOutput: peer.toolOutput(scenario) ?? null,
            history,
          });
          peer.assertExhausted();
          assert.equal(
            callback,
            scenario === 'invalid-output' ? 'not-called' : scenario,
          );
          if (scenario === 'success' || scenario === 'returned-failure') {
            assert.equal(peer.toolOutput(scenario), 'synthetic result');
          }
          assert.equal(
            outcome,
            scenario === 'success' || scenario === 'returned-failure'
              ? 'completed'
              : 'failed',
          );
        }),
      );
    }
  }
  // Telemetry has shut down; keep the receiver alive while reading its batches.
  const spans = receiver.batches.flatMap((batch) => {
    const parsed = spanEnvelope.safeParse(batch);
    return parsed.success
      ? (parsed.data.resourceSpans ?? []).flatMap((resource) =>
          (resource.scopeSpans ?? []).flatMap((scope) => scope.spans),
        )
      : [];
  });
  assert(receiver.batches.length > 0, 'No native trace batch arrived.');
  return { runId, receipts, batches: receiver.batches.length, spans };
}

if (typeof require !== 'undefined' && require.main === module) {
  runNativeTelemetry().then(
    (summary) => console.log(JSON.stringify(summary)),
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
