import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { z } from 'zod';
import {
  Agent,
  DecisionError,
  NativeProvider,
  telemetry,
  tool,
} from '../../../src';
import { binding } from '../../../src/runtime/binding';
import { ModelServer, call, message } from './model-server';

async function main() {
  const mode = process.argv[2];
  const native = await binding();
  const failedEngine = () =>
    native.create_engine('{"not_a_native_option":true}', '{}', null);
  const once = 'Codex telemetry can only be configured once per process';
  const late = 'Configure telemetry before creating any Codex clients';
  if (
    mode === 'completion-decisions' ||
    mode === 'completion-decisions-disabled' ||
    mode === 'completion-decisions-unknown' ||
    mode === 'completion-decisions-refusal'
  ) {
    const events: telemetry.TraceEvent[] = [];
    await telemetry.configure({
      traceProcessors: [
        {
          onEvent(event) {
            events.push(event);
          },
        },
      ],
    });
    const server = new ModelServer([[message('4')]], {
      input_tokens: 4,
      output_tokens: 1,
      total_tokens: 5,
    });
    const config = await server.config();
    const provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-traced-decision',
      supportsWebsockets: false,
    });
    let hooks = 0;
    let decisions = 0;
    try {
      const agent = new Agent({
        instructions: 'Answer.',
        provider,
        decisions: {
          async getDecision() {
            decisions++;
            if (mode === 'completion-decisions-refusal')
              throw new DecisionError('refusal', {
                usage: {
                  inputTokens: 7,
                  cachedInputTokens: 0,
                  cacheWriteInputTokens: 0,
                  outputTokens: 3,
                  reasoningOutputTokens: 0,
                  totalTokens: 10,
                },
              });
            return {
              value: true,
              ...(mode === 'completion-decisions-unknown'
                ? {}
                : {
                    usage: {
                      inputTokens: 7,
                      cachedInputTokens: 0,
                      cacheWriteInputTokens: 0,
                      outputTokens: 3,
                      reasoningOutputTokens: 0,
                      totalTokens: 10,
                    },
                  }),
              requestId: 'request-without-payload',
              model: 'decision-model',
            };
          },
        },
        async beforeComplete(context) {
          hooks++;
          const decision = context.decide('PRIVATE_DECISION_QUESTION', {
            input: 'PRIVATE_DECISION_INPUT',
          });
          if (mode === 'completion-decisions-refusal')
            await assert.rejects(decision, DecisionError);
          else assert.equal(await decision, true);
        },
      });
      const session = await agent.session({
        tracing: { disabled: mode === 'completion-decisions-disabled' },
      });
      try {
        const result = await (
          await session.submit('What is 2 + 2?', { budget: { maxTokens: 5 } })
        ).wait();
        assert.equal(result.finalOutput, '4');
        assert.equal(result.threadUsage?.totalTokenUsage.totalTokens, 5);
        assert.equal(hooks, 1);
        assert.equal(decisions, 1);
        server.assertExhausted();
      } finally {
        await session.close();
      }
    } finally {
      await provider.close();
      await ModelServer.closeAll();
      await telemetry.forceFlush();
      await telemetry.shutdown();
    }
    const usageSpans = events.filter(
      (event) => event.name === 'decision.usage' && event.lifecycle === 'start',
    );
    const decisionsSpans = events.filter(
      (event) => event.name === 'decision' && event.lifecycle === 'start',
    );
    if (mode === 'completion-decisions-disabled') {
      assert.equal(usageSpans.length, 0);
      assert.equal(decisionsSpans.length, 0);
    } else {
      assert.equal(usageSpans.length, 1);
      assert.equal(decisionsSpans.length, 1);
      assert.equal(usageSpans[0]!.parent_span_id, decisionsSpans[0]!.span_id);
      const metadata = usageSpans[0]!.attributes;
      assert.equal(
        JSON.parse(String(metadata['sdk.metadata.usage_known'])),
        mode !== 'completion-decisions-unknown',
      );
      assert.equal(
        metadata['sdk.metadata.outcome'],
        mode === 'completion-decisions-refusal' ? 'refusal' : 'completed',
      );
      if (mode === 'completion-decisions-unknown')
        assert.equal(metadata['sdk.metadata.total_tokens'], undefined);
      else
        assert.equal(
          JSON.parse(String(metadata['sdk.metadata.total_tokens'])),
          10,
        );
      assert(!JSON.stringify(usageSpans).includes('PRIVATE_DECISION_'));
    }
  } else if (mode === 'processor-handlers') {
    await assert.rejects(
      telemetry.configure({
        traceProcessors: [{} as telemetry.TraceProcessorRegistration],
      }),
      /traceProcessors/,
    );
    const configured: telemetry.TraceEvent[] = [];
    await telemetry.configure({
      traceProcessors: [
        {
          onEvents(events) {
            configured.push(...events);
          },
        },
      ],
    });
    class PerEventProcessor implements telemetry.TraceProcessor {
      events: telemetry.TraceEvent[] = [];
      onEvent(event: telemetry.TraceEvent) {
        this.events.push(event);
      }
    }
    const perEvent = new PerEventProcessor();
    await telemetry.addTraceProcessor(perEvent);
    const added: telemetry.TraceEvent[] = [];
    await telemetry.addTraceProcessor({
      onEvents(events) {
        added.push(...events);
      },
    });
    await assert.rejects(
      telemetry.addTraceProcessor({} as telemetry.TraceProcessorRegistration),
      /traceProcessors/,
    );
    await assert.rejects(
      telemetry.setTraceProcessors([
        {} as telemetry.TraceProcessorRegistration,
      ]),
      /traceProcessors/,
    );
    await telemetry.withTrace({ name: 'before-replacement' }, async () => {});
    assert.equal((await telemetry.forceFlush()).status, 'success');
    for (const events of [configured, perEvent.events, added]) {
      assert(events.some((event) => event.name === 'before-replacement'));
    }
    const replaced: telemetry.TraceEvent[] = [];
    await telemetry.setTraceProcessors([
      {
        onEvents(events) {
          replaced.push(...events);
        },
      },
    ]);
    await telemetry.withTrace({ name: 'after-replacement' }, async () => {});
    assert.equal((await telemetry.forceFlush()).status, 'success');
    assert(replaced.some((event) => event.name === 'after-replacement'));
    for (const events of [configured, perEvent.events, added]) {
      assert(!events.some((event) => event.name === 'after-replacement'));
    }
    await telemetry.shutdown();
  } else if (mode === 'lifecycle') {
    await assert.rejects(
      telemetry.shutdown(),
      /Configure telemetry successfully/,
    );
    await assert.rejects(
      telemetry.configure({ logs: { kind: 'otlp-http', endpoint: '' } }),
      /logs endpoint/,
    );
    await telemetry.configure();
    await assert.rejects(telemetry.configure(), { message: once });
    await telemetry.shutdown();
    await telemetry.shutdown();
    await assert.rejects(failedEngine(), /shut down or failed to initialize/);
    await assert.rejects(telemetry.configure(), { message: once });
  } else if (mode === 'restart-credentials') {
    const authorizations: (string | undefined)[] = [];
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) {
        /* Drain the complete export body. */
      }
      authorizations.push(request.headers.authorization);
      response.writeHead(200).end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    assert(address && typeof address !== 'string');
    const exporter = new telemetry.OpenAITraceExporter({
      endpoint: `http://127.0.0.1:${address.port}/v1/traces/ingest`,
      apiKey: 'synthetic-fallback',
    });
    const credentials = new telemetry.TraceExportCredentials({
      headers: { Authorization: 'Bearer synthetic-open-credential' },
    });
    let oldScope: telemetry.TraceSpan | undefined;
    try {
      await telemetry.configure({ traceProcessors: [exporter] });
      await telemetry.withTrace(
        { name: 'credential before restart', exportCredential: credentials },
        async (span) => {
          oldScope = span;
        },
      );
      const reference = credentials.register(native);
      assert.equal((await telemetry.forceFlush()).status, 'success');
      const before = authorizations.length;
      assert(before > 0);
      await telemetry.shutdown();
      await telemetry.configure({
        restartAfterShutdown: true,
        traceProcessors: [exporter],
      });
      await telemetry.withTrace(
        { name: 'credential after restart', exportCredential: credentials },
        async () => {},
      );
      assert.equal((await telemetry.forceFlush()).status, 'success');
      assert(authorizations.length > before);
      assert(
        authorizations.every(
          (value) => value === 'Bearer synthetic-open-credential',
        ),
      );
      await assert.rejects(
        telemetry.withSpan(
          { name: 'stale credential scope', parent: oldScope },
          async () => {},
        ),
        /retired telemetry provider/,
      );
      credentials.close();
      await assert.rejects(
        telemetry.withTrace(
          { name: 'closed credential', exportCredential: credentials },
          async () => {},
        ),
        /credentials are closed/,
      );
      assert.throws(
        () =>
          native.start_trace_span(
            JSON.stringify({
              name: 'released registration',
              kind: 'workflow',
              credential_ref: reference,
            }),
          ),
        /unknown trace credential reference/,
      );
      await telemetry.shutdown();
    } finally {
      credentials.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  } else if (mode === 'restart') {
    const first: string[] = [];
    const second: string[] = [];
    await telemetry.configure({
      traceProcessors: [{ onEvent: (event) => void first.push(event.name) }],
    });
    await assert.rejects(
      telemetry.configure({
        restartAfterShutdown: true,
        traceProcessors: [{ onEvent: (event) => void second.push(event.name) }],
      }),
    );
    const { handle: retiredParent } = JSON.parse(
      native.start_trace_span(
        JSON.stringify({ name: 'before native restart', kind: 'workflow' }),
      ),
    ) as { handle: string };
    native.end_trace_span(retiredParent, JSON.stringify({ status: 'ok' }));
    assert.equal((await telemetry.forceFlush()).status, 'success');
    const live = await native.create_engine(
      '{"web_search":"disabled"}',
      '{"ephemeral":true}',
      'synthetic-key',
    );
    await telemetry.shutdown();
    await assert.rejects(
      telemetry.configure({ restartAfterShutdown: true }),
      /all Codex clients to close/,
    );
    await live.close();

    await telemetry.configure({
      restartAfterShutdown: true,
      traceProcessors: [{ onEvent: (event) => void second.push(event.name) }],
    });
    assert.throws(
      () =>
        native.start_trace_span(
          JSON.stringify({
            name: 'retired child',
            kind: 'custom',
            parent: retiredParent,
          }),
        ),
      /retired telemetry provider/,
    );
    native.release_trace_span(retiredParent);
    await telemetry.withTrace({ name: 'after native restart' }, async () => {});
    assert.equal((await telemetry.forceFlush()).status, 'success');
    await telemetry.shutdown();

    assert(first.includes('before native restart'));
    assert(!first.includes('after native restart'));
    assert(second.includes('after native restart'));
    assert(!second.includes('before native restart'));
  } else if (mode === 'preclaim') {
    await assert.rejects(
      native.configure_telemetry('{"not_a_native_option":true}'),
      /Native telemetry operation failed/,
    );
    await telemetry.configure();
    await telemetry.shutdown();
  } else if (mode === 'late') {
    await assert.rejects(failedEngine());
    await assert.rejects(telemetry.configure(), { message: late });
  } else if (mode === 'postclaim') {
    const secret = 'synthetic-secret-must-not-escape';
    await assert.rejects(
      telemetry.configure({
        logs: {
          kind: 'otlp-http',
          endpoint: 'https://127.0.0.1:9',
          tls: { caCertificate: `/missing/${secret}` },
        },
      }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert(!String(error).includes(secret));
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    await assert.rejects(telemetry.configure(), { message: once });
    await assert.rejects(failedEngine(), /shut down or failed to initialize/);
    await assert.rejects(
      telemetry.shutdown(),
      /Configure telemetry successfully/,
    );
  } else if (mode === 'race') {
    const results = await Promise.allSettled([
      telemetry.configure(),
      failedEngine(),
    ]);
    assert.equal(results[1].status, 'rejected');
    if (results[0].status === 'fulfilled') {
      await telemetry.shutdown();
    } else {
      assert.equal(results[0].reason.message, late);
      await assert.rejects(telemetry.configure(), { message: late });
    }
  } else if (
    mode === 'payload' ||
    mode === 'default-payload' ||
    mode === 'failed-export' ||
    mode === 'workers'
  ) {
    const received: unknown[] = [];
    const headers: unknown[] = [];
    const collector = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push(JSON.parse(Buffer.concat(chunks).toString()));
      headers.push(request.headers['x-native-secret']);
      response
        .writeHead(mode === 'failed-export' ? 400 : 200, {
          'content-type': 'application/json',
        })
        .end('{}');
    });
    await new Promise<void>((resolve) =>
      collector.listen(0, '127.0.0.1', resolve),
    );
    const address = collector.address();
    assert(address && typeof address !== 'string');
    const opted = mode !== 'default-payload';
    const secret = 'synthetic-header-only';
    await telemetry.configure({
      logs: {
        kind: 'otlp-http',
        endpoint: `http://127.0.0.1:${address.port}/v1/logs`,
        protocol: 'json',
        headers: { 'x-native-secret': secret },
      },
      logUserPrompt: opted,
      logAgentResponses: opted,
      toolResultMaxBytes: opted ? 5 : 0,
      environment: 'fixture-environment',
    });
    if (mode === 'workers') {
      const workerPath = join(__dirname, 'telemetry-worker.mjs');
      async function worker() {
        const value = new Worker(workerPath);
        const ready = new Promise<void>((resolve, reject) => {
          value.once('message', () => resolve());
          value.once('error', reject);
        });
        await ready;
        return value;
      }
      // Both isolates load this same addon image while bootstrap remains loaded.
      const first = await worker();
      const second = await worker();
      async function turn(worker: Worker) {
        const done = new Promise<void>((resolve, reject) => {
          worker.once('message', (message) =>
            message.error ? reject(new Error(message.error)) : resolve(),
          );
          worker.once('error', reject);
        });
        worker.postMessage('turn');
        await done;
      }
      await Promise.all([turn(first), turn(second)]);
      first.postMessage('close');
      await new Promise<void>((resolve) => first.once('exit', () => resolve()));
      await turn(second);
      second.postMessage('close');
      await new Promise<void>((resolve) =>
        second.once('exit', () => resolve()),
      );
    } else {
      const server = new ModelServer([
        [call('probe', { argument: 'FULL_TOOL_ARGUMENT' }, { callId: 'a' })],
        [{ ...message('FINAL_RESPONSE_ONE'), phase: 'final_answer' }],
        [call('probe', { argument: 'FULL_TOOL_ARGUMENT' }, { callId: 'b' })],
        [{ ...message('FINAL_RESPONSE_TWO'), phase: 'final_answer' }],
      ]);
      const config = await server.config();
      // Raw startup overrides intentionally conflict with the successful process policy.
      const conflicting = {
        'otel.exporter': 'none',
        'otel.log_user_prompt': !opted,
        'otel.log_agent_responses': !opted,
        'otel.tool_result': { max_bytes: opted ? 0 : 100 },
      };
      class FixtureProvider extends NativeProvider {
        override _acquire() {
          const lease = super._acquire();
          // Keep the real lease, including its opening and cleanup ownership.
          Object.assign(lease.config, config, conflicting);
          return lease;
        }
      }
      const provider = new FixtureProvider({ apiKey: 'fixture' });
      const agent = new Agent({
        name: 'Telemetry fixture',
        instructions: 'Use probe.',
        model: 'gpt-5',
        provider,
        tools: [
          tool({
            name: 'probe',
            parameters: z.object({ argument: z.string() }),
            execute: () => 'éééTOOL_OUTPUT_SUFFIX',
          }),
        ],
      });
      try {
        const first = await agent.session();
        let saved;
        try {
          assert.equal(
            (await (await first.submit('USER_PROMPT_ONE')).wait()).finalOutput,
            'FINAL_RESPONSE_ONE',
          );
          saved = await first.saveState();
          assert(!JSON.stringify(saved).includes(secret));
          assert(!JSON.stringify(saved).includes(`:${address.port}/v1/logs`));
        } finally {
          await first.close();
        }
        const restored = await agent.session({ state: saved });
        try {
          assert.equal(
            (await (await restored.submit('USER_PROMPT_TWO')).wait())
              .finalOutput,
            'FINAL_RESPONSE_TWO',
          );
        } finally {
          await restored.close();
        }
        server.assertExhausted();
      } finally {
        await provider.close();
        await ModelServer.closeAll();
      }
    }
    // Core discards individual exporter shutdown errors. Even a rejected export
    // must retire admissions and make repeated shutdown harmless.
    await telemetry.shutdown();
    await telemetry.shutdown();
    await assert.rejects(failedEngine(), /shut down or failed to initialize/);
    collector.closeAllConnections();
    await new Promise<void>((resolve) => collector.close(() => resolve()));
    assert(received.length > 0);
    assert(headers.every((header) => header === secret));
    const text = JSON.stringify(received);
    if (mode === 'workers') {
      assert(text.includes('WORKER_FINAL_1'));
      assert(text.includes('WORKER_FINAL_2')); // Export after the first worker exited.
      assert(text.includes('WORKER_PROMPT'));
    } else {
      assert.equal(text.includes('USER_PROMPT_ONE'), opted);
      assert.equal(text.includes('USER_PROMPT_TWO'), opted);
      assert.equal(text.includes('FINAL_RESPONSE_ONE'), opted);
      assert.equal(text.includes('FINAL_RESPONSE_TWO'), opted);
      assert(text.includes('FULL_TOOL_ARGUMENT'));
      assert(!text.includes('TOOL_OUTPUT_SUFFIX'));
      assert(!text.includes('ééé'));
      if (opted) assert(text.includes('éé'));
    }
    console.log(JSON.stringify({ records: received.length, mode }));
  } else {
    throw new Error('Unknown telemetry fixture mode');
  }
  console.log(`PASS ${mode}`);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
