import assert from 'node:assert/strict';
import { Agent, NativeProvider, telemetry } from '../../../src';

async function main() {
  const mode = process.argv[2];
  const events: telemetry.TraceEvent[] = [];
  await telemetry.configure({
    traceProcessors: [
      {
        onEvent: (event) => {
          events.push(event);
        },
      },
    ],
  });
  const flush = async () =>
    assert.equal(
      (await telemetry.forceFlush({ timeoutMs: 5000 })).status,
      'success',
    );
  try {
    const credentials = new telemetry.TraceExportCredentials({
      headers: { authorization: 'Bearer synthetic-borrowed-owner' },
    });
    const source = await telemetry.startTrace({
      name: 'retained-source',
      includeSensitiveData: true,
      metadata: { owner: 'captured' },
      exportCredential: credentials,
    });
    source.close();
    credentials.close();
    await flush();
    const original = events.length;
    if (mode === 'lifecycle') {
      const second = await telemetry.startTrace({ name: 'second-source' });
      second.close();
      await flush();
      const before = events.length;
      const failure = new Error('synthetic callback failure');
      await telemetry.withTraceContext(source, async () => {
        assert.equal(telemetry.getCurrentTrace(), source);
        assert.deepEqual(telemetry.getCurrentSpan()?.traceMetadata, {
          owner: 'captured',
        });
        assert.equal(
          telemetry.getCurrentSpan()?.context.spanId,
          source.context.spanId,
        );
        await assert.rejects(
          telemetry.withTraceContext(second, async () => {
            throw failure;
          }),
          (error) => error === failure,
        );
        assert.equal(
          telemetry.getCurrentSpan()?.context.spanId,
          source.context.spanId,
        );
      });
      const entered = Promise.withResolvers<void>();
      const other = Promise.withResolvers<void>();
      await Promise.all([
        telemetry.withTraceContext(source, async () => {
          entered.resolve();
          await other.promise;
          assert.equal(
            telemetry.getCurrentSpan()?.context.spanId,
            source.context.spanId,
          );
        }),
        telemetry.withTraceContext(second, async () => {
          await entered.promise;
          assert.equal(
            telemetry.getCurrentSpan()?.context.spanId,
            second.context.spanId,
          );
          other.resolve();
        }),
      ]);
      assert.equal(telemetry.getCurrentSpan(), undefined);
      await flush();
      assert.equal(events.length, before);
    } else if (mode === 'native-work') {
      await telemetry.withTraceContext(source, () => {});
      await flush();
      assert.equal(events.length, original);
      let callback = false;
      await using provider = new NativeProvider({
        modelBackend: {
          complete() {
            callback = true;
            assert.equal(
              telemetry.getCurrentSpan()?.context.traceId,
              source.context.traceId,
            );
            assert.equal(telemetry.getCurrentTrace(), source);
            return {
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'native result' }],
                },
              ],
              usage: { input_tokens: 1 },
            };
          },
        },
      });
      const agent = new Agent({ instructions: 'Reply.', provider });
      await telemetry.withTraceContext(source, async () => {
        assert.equal(
          (await agent.run('Synthetic input.')).finalOutput,
          'native result',
        );
      });
      assert(callback);
      await flush();
      assert(
        events.some(
          (event) =>
            event.lifecycle === 'start' &&
            event.parent_span_id === source.context.spanId &&
            event.trace_id === source.context.traceId,
        ),
      );
      assert(
        events
          .filter((event) => event.parent_span_id === source.context.spanId)
          .every((event) => event.credential_required === true),
      );
      assert(!JSON.stringify(events).includes('synthetic-borrowed-owner'));
      assert(
        events.some(
          (event) =>
            event.name.startsWith('op.dispatch.') &&
            event.trace_id === source.context.traceId,
        ),
      );
      const resume = Promise.withResolvers<void>();
      let copied: Promise<void> | undefined;
      await telemetry.withTraceContext(source, () => {
        copied = (async () => {
          await resume.promise;
          await telemetry.withSpan({ name: 'copied-native-child' }, (child) =>
            assert.equal(child.context.parentSpanId, source.context.spanId),
          );
        })();
      });
      resume.resolve();
      await copied;
    } else if (mode === 'privacy') {
      await telemetry.withTrace(
        { name: 'metadata-only', includeSensitiveData: false },
        () =>
          telemetry.withTraceContext(source, async () => {
            assert.equal(
              telemetry.getCurrentSpan()?.context.includeSensitiveData,
              false,
            );
            await telemetry.withSpan(
              { name: 'restricted-child', includeSensitiveData: true },
              (child) => {
                assert.equal(child.context.includeSensitiveData, false);
                child.end({ data: { secret: 'synthetic-must-not-export' } });
              },
            );
          }),
      );
      await telemetry.withTrace(
        { name: 'disabled-ambient', disabled: true },
        () =>
          telemetry.withTraceContext(source, async () => {
            assert.equal(telemetry.getCurrentSpan()?.context.disabled, true);
            await telemetry.withSpan(
              { name: 'disabled-child', disabled: false },
              (child) => assert.equal(child.context.disabled, true),
            );
          }),
      );
      telemetry.setTracingDisabled(true);
      try {
        await telemetry.withTraceContext(source, () =>
          assert.equal(telemetry.getCurrentSpan()?.context.disabled, true),
        );
      } finally {
        telemetry.setTracingDisabled(false);
      }
      telemetry.setSensitiveDataLoggingEnabled(false);
      try {
        await telemetry.withTraceContext(source, () =>
          assert.equal(
            telemetry.getCurrentSpan()?.context.includeSensitiveData,
            false,
          ),
        );
      } finally {
        telemetry.setSensitiveDataLoggingEnabled(true);
      }
      assert.equal(source.context.includeSensitiveData, true);
      assert.equal(source.context.disabled, false);
      await flush();
      assert(!JSON.stringify(events).includes('synthetic-must-not-export'));
      assert(!events.some((event) => event.name === 'disabled-child'));
    } else throw new Error('Unknown native context mode');
    assert.equal(telemetry.getCurrentSpan(), undefined);
    await flush();
    console.log(`PASS ${mode}`);
  } finally {
    await telemetry.shutdown({ timeoutMs: 5000 });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
