import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import * as telemetry from '../../../src/runtime/telemetry';
import type { TraceEvent, TraceSpan } from '../../../src/runtime/telemetry';

async function main() {
  const large = process.argv.includes('--large');
  const rootName = 'retained-workflow' + (large ? 'r'.repeat(4000) : '');
  const childName = 'late-child' + (large ? 'c'.repeat(4000) : '');
  const metadata = {
    tenant: 'original-tenant',
    ...(large
      ? Object.fromEntries(
          Array.from({ length: 14 }, (_, i) => [`pad_${i}`, 'm'.repeat(4000)]),
        )
      : {}),
  };
  const records: Record<string, any>[] = [];
  const observed: TraceEvent[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    records.push(...JSON.parse(Buffer.concat(chunks).toString()).data);
    response.writeHead(200).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let configured = false;
  try {
    await telemetry.configure({
      traceProcessors: [
        new telemetry.OpenAITraceExporter({
          apiKey: 'synthetic',
          endpoint: `http://127.0.0.1:${address.port}/ingest`,
        }),
        {
          onEvent(event) {
            observed.push(event);
          },
          onEvents(events) {
            observed.push(...events);
          },
        },
      ],
    });
    configured = true;
    let parent!: TraceSpan;
    await telemetry.withTrace(
      {
        name: rootName,
        detached: true,
        groupId: 'retained-group',
        metadata,
        includeSensitiveData: large,
      },
      (span) => {
        parent = span;
      },
    );
    assert.equal(
      (await telemetry.forceFlush({ timeoutMs: 15000 })).status,
      'success',
    );
    for (let index = 0; index < 1024; index++) {
      await telemetry.withTrace(
        { name: `churn-${index}`, detached: true },
        () => {},
      );
      if (index % 32 === 31) {
        const result = await telemetry.forceFlush({ timeoutMs: 15000 });
        assert.equal(result.status, 'success');
        assert.equal(result.droppedRecords, 0);
      }
    }
    await telemetry.withSpan({ name: childName, parent }, (child) => {
      child.end({
        status: 'ok',
        data: {
          private:
            'retained-context-private-sentinel' +
            (large ? 'p'.repeat(3900) : ''),
        },
      });
    });
    const result = await telemetry.forceFlush({ timeoutMs: 15000 });
    const late = observed.filter((event) => event.name === childName);
    console.log(
      JSON.stringify({
        late_native_events: late.length,
        flush: result,
        native_parent: parent.context.spanId,
        late_parents: late.map((event) => event.parent_span_id),
      }),
    );
    assert.equal(late.length, 2);
    assert.ok(
      late.every(
        (event) =>
          event.trace_id === parent.context.traceId &&
          event.parent_span_id === parent.context.spanId,
      ),
    );
    assert.equal(result.droppedRecords, 0);
    assert.equal(result.status, 'success');
    const traces = records.filter(
      (record) =>
        record.object === 'trace' &&
        record.id === `trace_${parent.context.traceId}`,
    );
    assert.equal(traces.at(-1)?.workflow_name, rootName);
    assert.equal(traces.at(-1)?.group_id, 'retained-group');
    assert.equal(traces.at(-1)?.metadata.tenant, 'original-tenant');
    assert.equal(
      JSON.stringify(records).includes('retained-context-private-sentinel'),
      large,
    );
    assert.equal(traces.length, 2);
    assert.deepEqual(traces.at(-1)?.metadata, {
      ...metadata,
      runtime: 'native',
    });
    const exported = records.filter(
      (record) =>
        record.object === 'trace.span' && record.span_data.name === childName,
    );
    assert.equal(exported.length, 1);
    assert.equal(exported[0].trace_id, `trace_${parent.context.traceId}`);
    assert.equal(
      exported[0].parent_id,
      `span_${parent.context.spanId.padStart(24, '0')}`,
    );
    if (!large) {
      const native = await (
        await import('../../../src/runtime/binding')
      ).binding();
      for (let index = 0; index < 1600; index++) {
        const root = JSON.parse(
          native.start_trace_span(
            JSON.stringify({
              name: 'loss-' + 'x'.repeat(4000),
              kind: 'workflow',
              detached: true,
              metadata: {},
            }),
          ),
        );
        native.end_trace_span(root.handle, '{"status":"ok"}');
        native.release_trace_span(root.handle);
      }
      const loss = await telemetry.forceFlush({ timeoutMs: 15000 });
      assert.ok(loss.droppedRecords > 0);
      await telemetry.withSpan(
        { name: 'retained-after-loss', parent },
        () => {},
      );
      const rejected = await telemetry.forceFlush({ timeoutMs: 15000 });
      const stale = observed.filter(
        (event) => event.name === 'retained-after-loss',
      );
      assert.equal(stale.length, 2);
      assert.ok(stale.every((event) => event.root_descriptor));
      assert.ok(rejected.failedDeliveries >= loss.failedDeliveries + 2);
      assert.ok(
        !records.some(
          (record) => record.span_data?.name === 'retained-after-loss',
        ),
      );
    }
    console.log('PASS retained native context after descriptor eviction');
  } finally {
    try {
      if (configured) await telemetry.shutdown({ timeoutMs: 15000 });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
