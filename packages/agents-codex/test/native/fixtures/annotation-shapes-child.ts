import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import * as telemetry from '../../../src/runtime/telemetry';
import type { TraceOptions, TraceEvent } from '../../../src/runtime/telemetry';

type Metadata = NonNullable<TraceOptions['metadata']>;
type OtlpSpan = {
  name: string;
  attributes: { key: string; value: { stringValue?: string } }[];
  droppedAttributesCount?: number;
};
type OtlpRecord = { resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[] };
const shapes = [
  'array',
  'object',
  'nested',
  'string',
  'encoded',
  'unicode',
  'top-level',
];
function payload(mode: string): Metadata {
  if (mode === 'array') return { x: Array(65).fill(0) };
  if (mode === 'object')
    return {
      x: Object.fromEntries(
        Array.from({ length: 65 }, (_, i) => [String(i), i]),
      ),
    };
  if (mode === 'nested') {
    let value: Metadata[string] = 'leaf';
    for (let i = 0; i < 16; i++) value = { x: value };
    return { x: value };
  }
  if (mode === 'string') return { x: 'x'.repeat(8192) };
  if (mode === 'encoded') return { x: ['x'.repeat(3000), 'y'.repeat(3000)] };
  if (mode === 'unicode') return { x: 'é'.repeat(2100) };
  if (mode === 'top-level')
    return Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => ['field-' + i, i]),
    );
  throw new Error('Unknown shape');
}
function metadataMatches(
  attributes: TraceEvent['attributes'],
  expected: Metadata,
) {
  const delivered = Object.fromEntries(
    Object.entries(attributes)
      .filter(([key]) => key.startsWith('sdk.metadata.'))
      .map(([key, value]) => [key.slice('sdk.metadata.'.length), value]),
  );
  assert.deepEqual(Object.keys(delivered).sort(), Object.keys(expected).sort());
  for (const [key, value] of Object.entries(expected)) {
    const actual = delivered[key];
    assert(typeof actual === 'string');
    assert.deepEqual(
      typeof value === 'string' ? actual : JSON.parse(actual),
      value,
    );
  }
}
async function main() {
  const mode = process.argv[2];
  if (mode === 'classic') {
    const { Trace } = await import('@openai/agents-core');
    for (const shape of shapes) {
      const metadata = payload(shape);
      const trace = new Trace({ metadata });
      assert.deepEqual(
        (trace.toJSON() as { metadata: unknown }).metadata,
        metadata,
      );
    }
    console.log('PASS classic');
    return;
  }
  const events: TraceEvent[] = [];
  const records: OtlpRecord[] = [];
  const server =
    mode === 'otlp' ||
    mode === 'carrier-otlp' ||
    mode === 'processor-large-export-bounded'
      ? createServer(async (request, response) => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          records.push(JSON.parse(Buffer.concat(chunks).toString()));
          response.end('{}');
        })
      : undefined;
  if (server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }
  const address = server?.address();
  const generic = Object.fromEntries(
    Array.from({ length: 200 }, (_, i) => ['generic.field-' + i, 'small']),
  );
  generic['generic.000-long'] = 'x'.repeat(8192);
  await telemetry.configure({
    traceProcessors:
      mode === 'processor-large-export-bounded'
        ? []
        : [
            {
              onEvent(event) {
                events.push(event);
              },
            },
          ],
    ...(mode === 'generic' ? { spanAttributes: generic } : {}),
    ...(mode === 'redispatch-configured'
      ? {
          spanAttributes: Object.fromEntries(
            Array.from({ length: 8 }, (_, i) => [
              'sdk.metadata.config-' + i,
              'c'.repeat(4000),
            ]),
          ),
        }
      : {}),
    ...(mode.startsWith('carrier-')
      ? {
          spanAttributes: {
            'sdk.metadata': 'service-label',
            'service.fixture': 'retained',
          },
        }
      : {}),
    ...(mode === 'collision'
      ? {
          spanAttributes: {
            'sdk.metadata.x': 'configured',
            ...Object.fromEntries(
              Array.from({ length: 20 }, (_, i) => [
                'generic.field-' + i,
                'g'.repeat(4000),
              ]),
            ),
          },
        }
      : {}),
    ...(mode === 'wide-queue' ||
    mode === 'redispatch-queue' ||
    mode === 'redispatch-root-queue'
      ? { traceDelivery: { maxQueueBytes: 60000 } }
      : {}),
    ...(address && typeof address !== 'string'
      ? {
          traces: {
            kind: 'otlp-http' as const,
            endpoint: 'http://127.0.0.1:' + address.port + '/v1/traces',
            protocol: 'json' as const,
          },
        }
      : {}),
  });
  try {
    if (mode === 'processor-large-export-bounded') {
      // Register independently: adding this route must retain native OTLP export.
      await telemetry.addTraceProcessor({
        onEvent(event) {
          events.push(event);
        },
      });
      const metadata = {
        payload: 'x'.repeat(160 * 1024),
        marker: 'local-large',
      };
      assert(Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 128 * 1024);
      await telemetry.withTrace(
        { name: 'bounds.processor-large-export-bounded', metadata },
        (root) => assert.deepEqual(root.traceMetadata, metadata),
      );
      assert.equal(
        (await telemetry.forceFlush({ timeoutMs: 5000 })).status,
        'success',
      );
      const snapshots = events.filter(
        (event) => event.name === 'bounds.processor-large-export-bounded',
      );
      assert.deepEqual(
        snapshots.map((event) => event.lifecycle),
        ['start', 'end'],
      );
      for (const snapshot of snapshots)
        metadataMatches(snapshot.attributes, metadata);
      const exported = records
        .flatMap((record) =>
          record.resourceSpans.flatMap((resource) =>
            resource.scopeSpans.flatMap((scope) => scope.spans),
          ),
        )
        .filter(
          (span) => span.name === 'bounds.processor-large-export-bounded',
        );
      assert.equal(
        exported.length,
        1,
        'native default exporter must remain active',
      );
      for (const span of exported) {
        const projected = Object.fromEntries(
          span.attributes
            .filter((attribute) => attribute.key.startsWith('sdk.metadata.'))
            .map((attribute) => [attribute.key, attribute.value.stringValue]),
        );
        assert(
          Buffer.byteLength(JSON.stringify(projected), 'utf8') <= 128 * 1024,
          'large local observations must not enlarge default-export metadata',
        );
        assert(
          !JSON.stringify(span).includes(metadata.payload),
          'the native default exporter must not receive the full local payload',
        );
        assert.equal(projected['sdk.metadata.marker'], metadata.marker);
        assert(!Object.hasOwn(projected, 'sdk.metadata.payload'));
        assert((span.droppedAttributesCount ?? 0) >= 1);
      }
    } else if (mode.startsWith('redispatch-')) {
      let metadata: Metadata = Object.fromEntries(
        Array.from({ length: 9000 }, (_, i) => ['f' + i, 0]),
      );
      let literal: unknown = 'literal';
      for (let i = 0; i < 65; i++) literal = { x: literal };
      metadata = { ...metadata, literal: JSON.stringify(literal) };
      const original = await telemetry.withTrace(
        {
          name: 'bounds.replay.root',
          metadata:
            mode === 'redispatch-configured'
              ? { x: 'x'.repeat(100000) }
              : mode === 'redispatch-queue' ||
                  mode === 'redispatch-root-queue' ||
                  mode === 'redispatch-unrelated' ||
                  mode === 'redispatch-receipt'
                ? { x: 0 }
                : metadata,
        },
        (root) => root,
      );
      if (mode.startsWith('redispatch-root') || mode === 'redispatch-receipt')
        await telemetry.withSpan(
          { name: 'bounds.replay.child', parent: original },
          () => {},
        );
      assert.equal(
        (await telemetry.forceFlush({ timeoutMs: 5000 })).status,
        'success',
      );
      const recorded = events
        .filter((event) => event.lifecycle === 'end')
        .at(-1)!;
      const replay = JSON.parse(JSON.stringify(recorded)) as TraceEvent;
      if (mode.startsWith('redispatch-root')) {
        assert(
          !Object.keys(recorded.attributes).some((key) =>
            key.startsWith('sdk.metadata.'),
          ),
        );
        assert(
          Object.keys(
            (replay.root_descriptor as { attributes: Record<string, unknown> })
              .attributes,
          ).some((key) => key.startsWith('sdk.metadata.')),
        );
      }
      if (mode === 'redispatch-queue')
        Object.assign(
          replay.attributes,
          Object.fromEntries(
            Object.entries(metadata).map(([key, value]) => [
              'sdk.metadata.' + key,
              typeof value === 'string' ? value : String(value),
            ]),
          ),
        );
      if (mode === 'redispatch-root-queue')
        Object.assign(
          (replay.root_descriptor as { attributes: Record<string, unknown> })
            .attributes,
          Object.fromEntries(
            Object.entries(metadata).map(([key, value]) => [
              'sdk.metadata.' + key,
              typeof value === 'string' ? value : String(value),
            ]),
          ),
        );
      if (mode === 'redispatch-root-unrelated')
        Object.assign(replay.root_descriptor!, {
          unrelated: 'g'.repeat(70000),
        });
      if (mode === 'redispatch-queue')
        Object.assign(replay, {
          __sdk_annotations: JSON.stringify({ ...metadata, x: 0 }),
        });
      if (mode === 'redispatch-root-queue')
        Object.assign(replay.root_descriptor!, {
          __sdk_annotations: JSON.stringify({ ...metadata, x: 0 }),
        });
      if (mode === 'redispatch-unrelated')
        Object.assign(replay.attributes, {
          'sdk.metadata.': 'not-a-valid-key',
          unrelated: 'g'.repeat(70000),
        });
      if (mode.endsWith('-legacy')) {
        Reflect.deleteProperty(replay, '__sdk_annotations');
        if (replay.root_descriptor)
          Reflect.deleteProperty(replay.root_descriptor, '__sdk_annotations');
      }
      const count = events.length;
      if (mode === 'redispatch-receipt') {
        const parent = JSON.parse(
          JSON.stringify(
            events.find(
              (event) =>
                event.lifecycle === 'end' && event.name.endsWith('.root'),
            )!,
          ),
        ) as TraceEvent;
        Object.assign(parent, { __sdk_annotations: '{"x":1}' });
        Object.assign(replay.root_descriptor!, {
          __sdk_annotations: '{"x":1}',
        });
        await assert.rejects(telemetry.dispatchTraceEvent(parent), /receipt/);
        await assert.rejects(telemetry.dispatchTraceEvent(replay), /receipt/);
        assert.equal(events.length, count);
      } else if (
        mode === 'redispatch-queue' ||
        mode === 'redispatch-unrelated' ||
        mode === 'redispatch-root-queue' ||
        mode === 'redispatch-root-unrelated'
      ) {
        await assert.rejects(
          telemetry.dispatchTraceEvent(replay),
          /queue capacity/,
        );
        assert.equal(events.length, count);
      } else {
        await telemetry.dispatchTraceEvent(replay);
        assert.equal(events.length, count + 1);
        assert.deepEqual(events.at(-1)!.attributes, recorded.attributes);
        assert.deepEqual(
          events.at(-1)!.root_descriptor,
          replay.root_descriptor,
        );
      }
      assert.equal(telemetry.getCurrentSpan(), undefined);
    } else if (mode === 'collision') {
      await telemetry.withTrace(
        { name: 'bounds.collision', metadata: { x: 'x'.repeat(40000) } },
        () => {},
      );
      const flushed = await telemetry.forceFlush({ timeoutMs: 5000 });
      assert.equal(flushed.status, 'partial');
      assert.equal(flushed.droppedRecords, 2);
      assert.equal(events.length, 0);
    } else if (shapes.includes(mode)) {
      const value = payload(mode);
      await telemetry.withTrace(
        { name: 'bounds.root', metadata: value, includeSensitiveData: true },
        async (root) => {
          assert.deepEqual(root.traceMetadata, value);
          await telemetry.withSpan(
            {
              name: 'bounds.child',
              metadata: value,
              includeSensitiveData: true,
            },
            (child) => child.end({ status: 'ok', data: value }),
          );
        },
      );
      assert.equal(
        (await telemetry.forceFlush({ timeoutMs: 5000 })).status,
        'success',
      );
      for (const name of ['bounds.root', 'bounds.child']) {
        const ended = events.filter(
          (event) => event.lifecycle === 'end' && event.name === name,
        );
        assert.equal(ended.length, 1);
        metadataMatches(ended[0].attributes, value);
      }
      const end = events.find(
        (event) => event.lifecycle === 'end' && event.name === 'bounds.child',
      )!;
      assert.deepEqual(
        JSON.parse(String(end.attributes['sdk.outcome.data'])),
        value,
      );
    } else if (mode.startsWith('outcome-')) {
      const value = payload(mode.slice('outcome-'.length));
      await telemetry.withTrace(
        { name: 'bounds.outcome', includeSensitiveData: true },
        (span) => span.end({ status: 'ok', data: value }),
      );
      assert.equal(
        (await telemetry.forceFlush({ timeoutMs: 5000 })).status,
        'success',
      );
      const end = events.find((event) => event.lifecycle === 'end')!;
      assert.deepEqual(
        JSON.parse(String(end.attributes['sdk.outcome.data'])),
        value,
      );
    } else if (mode === 'bounds') {
      await assert.rejects(
        telemetry.startTrace({
          name: 'too-large',
          metadata: { x: 'x'.repeat(4 * 1024 * 1024) },
        }),
        /native event limit/,
      );
      const over = await telemetry.startTrace({
        name: 'completion',
        includeSensitiveData: true,
      });
      try {
        assert.throws(
          () => over.end({ data: { x: 'x'.repeat(65536) } }),
          /64 KiB/,
        );
      } finally {
        over.close();
      }
      let value: Metadata[string] = 'leaf';
      for (let i = 0; i < 64; i++) value = { x: value };
      await assert.rejects(
        telemetry.startTrace({ name: 'too-deep', metadata: { x: value } }),
        /maximum depth/,
      );
      await assert.rejects(
        telemetry.startTrace({
          name: 'key',
          metadata: { ['x'.repeat(257)]: 1 },
        }),
        /256/,
      );
      assert.equal(telemetry.getCurrentSpan(), undefined);
      await telemetry.withTrace(
        { name: 'following', metadata: { accepted: true } },
        (root) => assert.deepEqual(root.traceMetadata, { accepted: true }),
      );
    } else if (mode === 'generic') {
      await telemetry.withTrace({ name: 'bounds.generic' }, () => {});
      assert.equal(
        (await telemetry.forceFlush({ timeoutMs: 5000 })).status,
        'success',
      );
      const ended = events.find((event) => event.lifecycle === 'end')!;
      assert.equal(ended.attributes['generic.000-long'], 'x'.repeat(4096));
      assert(Object.keys(ended.attributes).length <= 128);
      assert(ended.dropped_attributes_count > 0);
    } else if (mode === 'wide' || mode === 'wide-queue') {
      const metadata = Object.fromEntries(
        Array.from({ length: 9000 }, (_, i) => ['f' + i, 0]),
      );
      const root = await telemetry.withTrace(
        { name: 'bounds.wide.root', metadata },
        (span) => span,
      );
      await telemetry.withSpan(
        { name: 'bounds.wide.late-child', parent: root },
        () => {},
      );
      const flushed = await telemetry.forceFlush({ timeoutMs: 5000 });
      if (mode === 'wide-queue') {
        assert.equal(flushed.status, 'partial');
        assert.equal(events.length, 0);
      } else {
        assert.equal(flushed.status, 'success');
        const ended = events.filter((event) => event.lifecycle === 'end');
        assert.deepEqual(ended.map((event) => event.name).sort(), [
          'bounds.wide.late-child',
          'bounds.wide.root',
        ]);
        metadataMatches(
          ended.find((event) => event.name === 'bounds.wide.root')!.attributes,
          metadata,
        );
      }
    } else if (mode === 'combined' || mode === 'combined-escaped') {
      const metadata = { x: 'x'.repeat(100000) };
      const data = {
        x:
          mode === 'combined'
            ? 'y'.repeat(65536 - 8)
            : '\\'.repeat((65536 - 8) / 2),
      };
      await telemetry.withTrace(
        { name: 'bounds.combined', metadata, includeSensitiveData: true },
        (root) => root.end({ status: 'ok', data }),
      );
      assert.equal(
        (await telemetry.forceFlush({ timeoutMs: 5000 })).status,
        'success',
      );
      const ended = events.filter((event) => event.lifecycle === 'end');
      assert.equal(ended.length, 1);
      metadataMatches(ended[0].attributes, metadata);
      assert.deepEqual(
        JSON.parse(String(ended[0].attributes['sdk.outcome.data'])),
        data,
      );
      await telemetry.dispatchTraceEvent(JSON.parse(JSON.stringify(ended[0])));
      assert.deepEqual(events.at(-1)!.attributes, ended[0].attributes);
      const oversized = JSON.parse(JSON.stringify(ended[0]));
      oversized.attributes['sdk.outcome.data'] = JSON.stringify({
        x: 'x'.repeat(65536),
      });
      await assert.rejects(
        () => telemetry.dispatchTraceEvent(oversized),
        /queue capacity/,
      );
    } else if (mode === 'otlp' || mode.startsWith('carrier-')) {
      const metadata = {
        ...payload('top-level'),
        'a-long': 'x'.repeat(70000),
        'b-encoded': ['x'.repeat(3000), 'y'.repeat(3000)],
      };
      const childMetadata = mode.startsWith('carrier-')
        ? { ...metadata, child: 'owned' }
        : metadata;
      await telemetry.withTrace(
        { name: 'bounds.otlp.root', metadata },
        async () => {
          await telemetry.withSpan(
            { name: 'bounds.otlp.child', metadata: childMetadata },
            () => {},
          );
        },
      );
      assert.equal(
        (await telemetry.forceFlush({ timeoutMs: 5000 })).status,
        'success',
      );
      if (mode === 'carrier-host') {
        for (const event of events) {
          metadataMatches(
            event.attributes,
            event.name.endsWith('.child') ? childMetadata : metadata,
          );
          assert.equal(event.attributes['sdk.metadata'], 'service-label');
          assert.equal(event.attributes['service.fixture'], 'retained');
        }
      }
      const spans = records
        .flatMap((record) =>
          record.resourceSpans.flatMap((resource) =>
            resource.scopeSpans.flatMap((scope) => scope.spans),
          ),
        )
        .filter((span) => span.name.startsWith('bounds.otlp.'));
      if (mode !== 'carrier-host')
        assert.deepEqual(spans.map((span) => span.name).sort(), [
          'bounds.otlp.child',
          'bounds.otlp.root',
        ]);
      for (const span of spans) {
        const attrs = Object.fromEntries(
          span.attributes.map((item) => [item.key, item.value.stringValue!]),
        );
        if (mode !== 'carrier-otlp')
          assert(!Object.hasOwn(attrs, 'sdk.metadata'));
        metadataMatches(
          attrs,
          span.name.endsWith('.child') ? childMetadata : metadata,
        );
        if (mode === 'carrier-otlp') {
          assert.equal(attrs['sdk.metadata'], 'service-label');
          assert.equal(attrs['service.fixture'], 'retained');
        }
      }
    } else throw new Error('Unknown case');
    assert.equal(telemetry.getCurrentSpan(), undefined);
    console.log('PASS ' + mode);
  } finally {
    await telemetry.shutdown({ timeoutMs: 5000 });
    if (server) {
      server.close();
      await once(server, 'close');
    }
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
