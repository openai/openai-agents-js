import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { z } from 'zod';
import { Agent, telemetry, tool } from '../../../src';
import { text, toolCall, withScriptedResponses } from '../../../src/testing';
import type { TraceEvent } from '../../../src/runtime/telemetry';
import { withNativeCallbackContext } from '../../../src/runtime/tracing-context';

async function main() {
  const mode = process.argv[2];
  const received: unknown[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const events: TraceEvent[] = [];
  let generatedCalls = 0;
  await telemetry.configure({
    traceProcessors: [
      {
        async onEvent(event) {
          events.push(event);
          if (mode === 'restrictions' && event.name === 'metadata-only') {
            await telemetry.withTrace(
              { name: 'processor-suppressed' },
              (span) => {
                assert.equal(span.context.disabled, true);
              },
            );
          }
        },
      },
      new telemetry.OpenAITraceExporter({
        apiKey: 'synthetic-id-annotation-key',
        endpoint: `http://127.0.0.1:${address.port}`,
      }),
    ],
  });
  try {
    if (mode === 'ids') {
      const storage = new AsyncLocalStorage<
        ReturnType<typeof telemetry.getCurrentSpan>
      >();
      telemetry.setTraceContextStorage({
        getStore: () => storage.getStore(),
        run: (span, callback) => storage.run(span, callback),
      });
      let count = 0;
      let laterCount = 0;
      let callbackSeen = false;
      const supplied = new Set<string>();
      telemetry.setTracingIdGenerator({
        generateTraceId() {
          telemetry.setTracingIdGenerator({
            generateTraceId: () => '2'.repeat(32),
            generateSpanId() {
              const value = (++laterCount + 0xb0)
                .toString(16)
                .padStart(16, '0');
              supplied.add(value);
              return value;
            },
          });
          return '1'.repeat(32);
        },
        generateSpanId: () => (++count).toString(16).padStart(16, '0'),
      });
      await telemetry.withTrace({ name: 'generated-root' }, async (root) => {
        await Promise.resolve();
        assert.equal(storage.getStore(), root);
        assert.equal(root.context.traceId, '1'.repeat(32));
        assert.equal(root.context.spanId, '0000000000000001');
        await telemetry.withSpan({ name: 'generated-child' }, (child) => {
          assert.equal(child.context.traceId, root.context.traceId);
          assert.equal(child.context.parentSpanId, root.context.spanId);
          assert.equal(child.context.spanId, '00000000000000b1');
          assert.equal(telemetry.getCurrentTrace(), root);
        });
        await telemetry.withSpan(
          { name: 'explicit-child', spanId: 'c'.repeat(16) },
          (span) => {
            assert.equal(span.context.spanId, 'c'.repeat(16));
          },
        );
        root.validate(() => {
          assert.equal(
            telemetry.getCurrentSpan()?.context.spanId,
            '00000000000000b2',
          );
        });
        await withScriptedResponses(
          [
            [toolCall('probe', {}, { callId: 'policy-tool' })],
            [text('native-policy-answer')],
          ],
          async (peer) => {
            const agent = new Agent({
              instructions: 'Use probe.',
              model: 'fixture',
              provider: peer.provider,
              tools: [
                tool({
                  name: 'probe',
                  parameters: z.object({}),
                  execute() {
                    const context = telemetry.getCurrentSpan()?.context;
                    assert(context);
                    assert.equal(
                      storage.getStore()?.context.spanId,
                      context.spanId,
                    );
                    assert.equal(context.traceId, root.context.traceId);
                    assert(supplied.has(context.spanId));
                    callbackSeen = true;
                    return 'native-policy-answer';
                  },
                }),
              ],
            });
            const result = await agent.run('input');
            assert.equal(result.finalOutput, 'native-policy-answer');
            assert(callbackSeen);
            peer.assertExhausted();
          },
        );
      });
      assert.equal(storage.getStore(), undefined);
      telemetry.setTraceContextStorage();
      assert.equal(count, 1);
      assert(
        laterCount > 2,
        'Native callback scopes have been consuming the captured policy',
      );
      telemetry.setTracingIdGenerator();
      await telemetry.withTrace({ name: 'native-default' }, (span) => {
        assert.notEqual(span.context.traceId, '2'.repeat(32));
        assert.notEqual(span.context.spanId, '00000000000000b1');
      });
    } else if (mode === 'automatic') {
      let count = 0;
      telemetry.setTracingIdGenerator({
        generateTraceId: () => '7'.repeat(32),
        generateSpanId: () => (++count).toString(16).padStart(16, '0'),
      });
      await withScriptedResponses(
        [[text('automatic-answer')]],
        async (peer) => {
          const agent = new Agent({
            instructions: 'Answer.',
            model: 'fixture',
            provider: peer.provider,
          });
          assert.equal(
            (await agent.run('input', { tracing: {} })).finalOutput,
            'automatic-answer',
          );
          peer.assertExhausted();
        },
      );
      assert(count >= 1);
    } else if (mode === 'collision') {
      const credential = new telemetry.TraceExportCredentials({
        headers: { Authorization: 'Bearer synthetic-private-owner' },
      });
      try {
        await telemetry.withTrace(
          {
            name: 'identity-owner',
            traceId: '3'.repeat(32),
            spanId: 'a'.repeat(16),
            includeSensitiveData: true,
            exportCredential: credential,
          },
          async (root) => {
            await assert.rejects(
              telemetry.withTrace(
                {
                  name: 'identity-intruder',
                  detached: true,
                  traceId: '3'.repeat(32),
                  spanId: 'a'.repeat(16),
                },
                () => assert.fail('Duplicate identity admitted'),
              ),
              /identity is already active/,
            );
            assert.equal(telemetry.getCurrentSpan(), root);
            await telemetry.withSpan(
              { name: 'identity-child', spanId: 'b'.repeat(16) },
              (span) => {
                assert.equal(span.context.parentSpanId, root.context.spanId);
              },
            );
          },
        );
      } finally {
        credential.close();
      }
    } else if (mode === 'receiver') {
      class StatefulIds {
        traces = 0;
        spans = 0;
        generateTraceId() {
          this.traces++;
          return '6'.repeat(32);
        }
        generateSpanId() {
          return (++this.spans).toString(16).padStart(16, '0');
        }
      }
      const generator = new StatefulIds();
      telemetry.setTracingIdGenerator(generator);
      await telemetry.withTrace({ name: 'receiver-root' }, async (root) => {
        assert.equal(root.context.traceId, '6'.repeat(32));
        assert.equal(root.context.spanId, '0000000000000001');
        await telemetry.withSpan({ name: 'receiver-child' }, (child) => {
          assert.equal(child.context.spanId, '0000000000000002');
        });
      });
      assert.equal(generator.traces, 1);
      assert.equal(generator.spans, 2);
    } else if (mode === 'cancelled-callback') {
      let calls = 0;
      telemetry.setTracingIdGenerator({
        generateSpanId() {
          calls++;
          return '5'.repeat(16);
        },
      });
      await telemetry.withTrace(
        {
          name: 'cancelled-root',
          traceId: '4'.repeat(32),
          spanId: '4'.repeat(16),
        },
        async (root) => {
          const context = root.retain();
          const controller = new AbortController();
          try {
            const queued = Promise.resolve().then(() =>
              withNativeCallbackContext(
                context,
                () => {
                  assert.equal(
                    telemetry.getCurrentSpan()?.context.spanId,
                    '5'.repeat(16),
                  );
                },
                controller.signal,
              ),
            );
            controller.abort();
            await queued;
          } finally {
            root.releaseContext(context);
          }
        },
      );
      assert.equal(calls, 1);
    } else if (mode === 'annotations') {
      const payload = {
        large: 'é'.repeat(16000),
        nested: { numbers: Array.from({ length: 64 }, (_, i) => i) },
      };
      await telemetry.withTrace(
        { name: 'large-allowed', includeSensitiveData: true },
        (span) => {
          span.end({ status: 'ok', data: payload });
        },
      );
      const escapedPayload = { escaped: '\\'.repeat(16_375) };
      await telemetry.withTrace(
        { name: 'escaped-annotation', includeSensitiveData: true },
        (span) => {
          span.end({ status: 'ok', data: escapedPayload });
        },
      );
      await telemetry.withTrace({ name: 'large-hidden' }, (span) => {
        span.end({ status: 'ok', data: payload });
      });
      const over = await telemetry.startTrace({ name: 'over-bound' });
      try {
        assert.throws(
          () => over.end({ data: { large: 'x'.repeat(32769) } }),
          /32 KiB/,
        );
      } finally {
        over.close();
      }
      const malformed = await telemetry.startTrace({
        name: 'malformed-unicode',
      });
      try {
        assert.throws(
          () =>
            malformed.end({
              data: { private: 'synthetic-private-annotation' + '\ud800' },
            }),
          /Invalid tracing span outcome/,
        );
      } finally {
        malformed.close();
      }
      await assert.rejects(
        telemetry.startTrace({
          name: 'metadata-still-bounded',
          metadata: { value: 'é'.repeat(3000) },
        }),
        /4096 UTF-8 bytes/,
      );
      assert.equal(
        (await telemetry.forceFlush({ timeoutMs: 3000 })).status,
        'success',
      );
      const allowed = events.find(
        (event) => event.name === 'large-allowed' && event.lifecycle === 'end',
      );
      const hidden = events.find(
        (event) => event.name === 'large-hidden' && event.lifecycle === 'end',
      );
      const escaped = events.find(
        (event) =>
          event.name === 'escaped-annotation' && event.lifecycle === 'end',
      );
      assert(allowed && hidden && escaped);
      assert.deepEqual(
        JSON.parse(String(allowed.attributes['sdk.outcome.data'])),
        payload,
      );
      assert.deepEqual(
        JSON.parse(String(escaped.attributes['sdk.outcome.data'])),
        escapedPayload,
      );
      assert.equal(hidden.attributes['sdk.outcome.data'], undefined);
      assert(JSON.stringify(received).includes(payload.large));
    } else if (mode === 'restrictions') {
      telemetry.setTracingIdGenerator({
        generateSpanId() {
          generatedCalls++;
          return 'd'.repeat(16);
        },
      });
      await telemetry.withTrace({ name: 'disabled', disabled: true }, () =>
        telemetry.withSpan({ name: 'cannot-relax', disabled: false }, () => {}),
      );
      assert.equal(generatedCalls, 0);
      await telemetry.withTrace({ name: 'metadata-only' }, (span) => {
        assert.equal(span.context.spanId, 'd'.repeat(16));
        assert.equal(span.context.includeSensitiveData, false);
      });
    } else if (mode === 'invalid') {
      assert.throws(
        () =>
          telemetry.setTracingIdGenerator({
            generateSpanId: (async () => 'e'.repeat(16)) as never,
          }),
        /synchronous/,
      );
      telemetry.setTracingIdGenerator({ generateSpanId: () => '0'.repeat(16) });
      await assert.rejects(
        telemetry.withTrace({ name: 'invalid-id' }, () => {}),
        /invalid identifier/,
      );
      assert.equal(telemetry.getCurrentSpan(), undefined);
      telemetry.setTracingIdGenerator();
      await telemetry.withTrace({ name: 'recovered' }, () => {});
    } else {
      throw new Error(`Unknown case: ${mode}`);
    }
    assert.equal(
      (await telemetry.forceFlush({ timeoutMs: 3000 })).status,
      'success',
    );
    if (mode === 'automatic')
      assert(
        events.some(
          (event) =>
            event.trace_id === '7'.repeat(32) &&
            event.span_id === '0000000000000001',
        ),
      );
    if (mode === 'collision')
      assert(!events.some((event) => event.name === 'identity-intruder'));
    if (mode === 'ids')
      assert(events.some((event) => event.span_id === '00000000000000b1'));
    if (mode === 'cancelled-callback') {
      const callback = events.find(
        (event) => event.lifecycle === 'end' && event.kind === 'callback',
      );
      assert(callback);
      assert.equal(callback.span_id, '5'.repeat(16));
      assert.equal(callback.attributes['sdk.outcome.status'], 'cancelled');
    }
    if (mode === 'restrictions') assert.equal(generatedCalls, 1);
  } finally {
    telemetry.setTracingIdGenerator();
    telemetry.setTraceContextStorage();
    await telemetry.shutdown({ timeoutMs: 3000 });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  console.log(`PASS ${mode}`);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
