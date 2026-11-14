import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Agent, telemetry } from '../../../src';
import { text, withScriptedResponses } from '../../../src/testing';
import type { TraceEvent } from '../../../src/runtime/telemetry';

async function main() {
  const batches: { data: Record<string, any>[] }[] = [];
  const otlpBatches: { resourceSpans?: unknown[] }[] = [];
  const collector = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    if (request.url === '/v1/traces') {
      otlpBatches.push(payload);
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    assert.equal(request.url, '/v1/traces/ingest');
    assert.equal(request.headers.authorization, 'Bearer synthetic-export-key');
    assert.equal(request.headers['openai-beta'], 'traces=v1');
    batches.push(payload);
    response.writeHead(200).end();
  });
  collector.listen(0, '127.0.0.1');
  await once(collector, 'listening');
  let cleanupError: AggregateError | undefined;
  let configured = false;
  try {
    const address = collector.address();
    assert.ok(address && typeof address !== 'string');
    const exporter = new telemetry.OpenAITraceExporter({
      apiKey: 'synthetic-export-key',
      endpoint: `http://127.0.0.1:${address.port}/v1/traces/ingest`,
    });

    const diagnostics: string[] = [];
    const events: TraceEvent[] = [];
    const largeCompletion = { result: 'λ\"\\'.repeat(40_000) };
    await telemetry.configure({
      traces: {
        kind: 'otlp-http',
        endpoint: `http://127.0.0.1:${address.port}/v1/traces`,
        protocol: 'json',
      },
      traceProcessors: [
        new telemetry.ConsoleTraceProcessor((line) => diagnostics.push(line)),
        exporter,
        {
          onEvent: (event) => {
            events.push(event);
          },
        },
      ],
    });
    configured = true;
    if (process.argv.includes('--fail-after-configure'))
      throw new Error('synthetic fixture primary failure');
    await telemetry.withTrace(
      {
        name: 'allowed',
        includeSensitiveData: true,
        metadata: { tenant: 'native-tenant' },
        groupId: 'native-group',
      },
      async () => {
        telemetry.setTracingDisabled(true);
        await telemetry.withSpan(
          { name: 'suppressed', disabled: false },
          async () => {},
        );
        await telemetry.withTrace({ name: 'suppressed-parent' }, async () => {
          telemetry.setTracingDisabled(false);
          await telemetry.withSpan(
            { name: 'still-suppressed' },
            async () => {},
          );
        });
        telemetry.setSensitiveDataLoggingEnabled(false);
        await telemetry.withSpan(
          { name: 'metadata-only', includeSensitiveData: true },
          async (span) => {
            assert.equal(span.context.includeSensitiveData, false);
            span.end({
              data: { ...largeCompletion, private_fixture: 'must-not-export' },
            });
          },
        );
        telemetry.setSensitiveDataLoggingEnabled(true);
        await telemetry.withSpan(
          { name: 'with-payload', includeSensitiveData: true },
          async (span) => {
            span.end({
              status: 'error',
              category: 'synthetic_error',
              data: { result: 'synthetic completion' },
            });
          },
        );
        await telemetry.withSpan(
          { name: 'large-custom-completion', includeSensitiveData: true },
          async (span) => {
            span.end({ data: largeCompletion });
          },
        );
      },
    );
    telemetry.setTracingDisabled(true);
    await withScriptedResponses(
      [
        async (request) => {
          assert.ok(JSON.stringify(request).includes('synthetic input'));
          return {
            items: [
              text('native dynamic answer', { itemId: 'msg_dynamic_fixture' }),
            ],
            responseId: 'resp_dynamic_fixture',
          };
        },
      ],
      async (peer) => {
        peer.append({
          items: [],
          responseId: 'resp_raw_fixture',
          events: [
            {
              type: 'response.output_item.done',
              item: {
                type: 'message',
                role: 'assistant',
                id: 'msg_raw_fixture',
                content: [{ type: 'output_text', text: 'native raw answer' }],
              },
            },
          ],
        });
        const agent = new Agent({
          instructions: 'Respond.',
          model: 'gpt-5.5',
          provider: peer.provider,
        });
        assert.equal(
          (await agent.run('synthetic input')).finalOutput,
          'native dynamic answer',
        );
        assert.equal(
          (await agent.run('next synthetic input')).finalOutput,
          'native raw answer',
        );
        assert.equal(peer.requests.length, 2);
      },
    );
    telemetry.setTracingDisabled(false);
    assert.equal((await telemetry.forceFlush()).status, 'success');
    const names = events.map((event) => event.name);
    assert.ok(names.includes('allowed'));
    assert.ok(names.includes('with-payload'));
    for (const name of [
      'suppressed',
      'suppressed-parent',
      'still-suppressed',
      'agent.operation',
    ])
      assert.ok(!names.includes(name), name);
    const privateEvent = events.find(
      (event) => event.name === 'metadata-only' && event.lifecycle === 'end',
    )!;
    assert.ok(!JSON.stringify(privateEvent).includes('must-not-export'));
    const completed = events.find(
      (event) => event.name === 'with-payload' && event.lifecycle === 'end',
    )!;
    assert.ok(JSON.stringify(completed).includes('synthetic completion'));
    assert.equal(completed.outcome, 'error');
    const largeEvent = events.find(
      (event) =>
        event.name === 'large-custom-completion' && event.lifecycle === 'end',
    )!;
    assert.equal(
      largeEvent.attributes['sdk.outcome.data'],
      JSON.stringify(largeCompletion),
    );
    const originalDeliveries = events.length;
    await telemetry.dispatchTraceEvent(largeEvent);
    assert.ok(events.length > originalDeliveries);
    const replayed = events.at(-1)!;
    assert.equal(replayed.span_id, largeEvent.span_id);
    assert.equal(
      replayed.attributes['sdk.outcome.data'],
      JSON.stringify(largeCompletion),
    );
    const records = batches.flatMap((batch) => batch.data);
    const exported = records.find(
      (record) =>
        record.object === 'trace.span' &&
        record.span_data.name === 'with-payload',
    )!;
    assert.equal(exported.id, `span_${completed.span_id.padStart(24, '0')}`);
    assert.equal(exported.trace_id, `trace_${completed.trace_id}`);
    assert.equal(
      exported.parent_id,
      `span_${completed.parent_span_id!.padStart(24, '0')}`,
    );
    assert.equal(
      exported.span_data.data['sdk.outcome.data'],
      JSON.stringify({ result: 'synthetic completion' }),
    );
    const largeExport = records.find(
      (record) =>
        record.object === 'trace.span' &&
        record.span_data.name === 'large-custom-completion',
    )!;
    assert.equal(
      largeExport.span_data.data['sdk.outcome.data'],
      JSON.stringify(largeCompletion),
    );
    const otlpSpans = otlpBatches.flatMap(({ resourceSpans }) =>
      (resourceSpans ?? []).flatMap((resource: any) =>
        (resource.scopeSpans ?? []).flatMap((scope: any) => scope.spans ?? []),
      ),
    );
    const otlpSpan = otlpSpans.find(
      (span) => span.name === 'large-custom-completion',
    );
    assert.equal(
      otlpSpan?.attributes.find(
        (entry: any) => entry.key === 'sdk.outcome.data',
      )?.value.stringValue,
      JSON.stringify(largeCompletion),
    );
    assert.ok(!JSON.stringify(otlpSpans).includes('must-not-export'));
    assert.ok(!JSON.stringify(records).includes('must-not-export'));
    assert.ok(diagnostics.some((line) => line.includes('with-payload')));
    assert.ok(!diagnostics.join('').includes('must-not-export'));
    const rootRecord = records.find((record) => record.object === 'trace')!;
    assert.equal(rootRecord.metadata.tenant, 'native-tenant');
    assert.equal(rootRecord.group_id, 'native-group');
    console.log('PASS native capture controls and dynamic fixtures');
  } finally {
    const errors: unknown[] = [];
    try {
      if (configured) await telemetry.shutdown({ timeoutMs: 1000 });
    } catch (error) {
      errors.push(error);
    }
    try {
      collector.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        collector.close((error) => (error ? reject(error) : resolve())),
      );
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      cleanupError = new AggregateError(
        errors,
        'Tracing fixture cleanup failed',
      );
  }
  if (cleanupError) throw cleanupError;
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
