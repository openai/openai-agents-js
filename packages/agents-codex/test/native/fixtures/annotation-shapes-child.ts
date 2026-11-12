import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Trace } from '@openai/agents-core';
import { telemetry, type TraceOptions, type TraceEvent } from '../../../src';

type Metadata = NonNullable<TraceOptions['metadata']>;
type OtlpSpan = {
  name: string;
  attributes: { key: string; value: { stringValue?: string } }[];
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
    mode === 'otlp'
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
    traceProcessors: [
      {
        onEvent(event) {
          events.push(event);
        },
      },
    ],
    ...(mode === 'generic' ? { spanAttributes: generic } : {}),
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
    ...(mode === 'wide-queue'
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
    if (mode === 'collision') {
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
          metadata: { x: 'x'.repeat(65536) },
        }),
        /64 KiB/,
      );
      const over = await telemetry.startTrace({
        name: 'completion',
        includeSensitiveData: true,
      });
      try {
        assert.throws(
          () => over.end({ data: { x: 'x'.repeat(32768) } }),
          /32 KiB/,
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
        Array.from({ length: 3000 }, (_, i) => ['f' + i, 0]),
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
      const metadata = { x: 'x'.repeat(40000) };
      const data = {
        x: mode === 'combined' ? 'y'.repeat(30000) : '\\'.repeat(16375),
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
    } else if (mode === 'otlp') {
      const metadata = {
        ...payload('top-level'),
        'a-long': 'x'.repeat(8192),
        'b-encoded': ['x'.repeat(3000), 'y'.repeat(3000)],
      };
      await telemetry.withTrace(
        { name: 'bounds.otlp.root', metadata },
        async () => {
          await telemetry.withSpan(
            { name: 'bounds.otlp.child', metadata },
            () => {},
          );
        },
      );
      assert.equal(
        (await telemetry.forceFlush({ timeoutMs: 5000 })).status,
        'success',
      );
      const spans = records
        .flatMap((record) =>
          record.resourceSpans.flatMap((resource) =>
            resource.scopeSpans.flatMap((scope) => scope.spans),
          ),
        )
        .filter((span) => span.name.startsWith('bounds.otlp.'));
      assert.deepEqual(spans.map((span) => span.name).sort(), [
        'bounds.otlp.child',
        'bounds.otlp.root',
      ]);
      for (const span of spans) {
        const attrs = Object.fromEntries(
          span.attributes.map((item) => [item.key, item.value.stringValue!]),
        );
        assert(!Object.hasOwn(attrs, 'sdk.metadata'));
        metadataMatches(attrs, metadata);
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
