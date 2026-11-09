import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { OpenAITraceExporter } from '../src/runtime/telemetry';
import type { TraceEvent } from '../src/runtime/telemetry';

const event: TraceEvent = {
  sequence: 1,
  processor_ids: ['fixture'],
  lifecycle: 'end',
  trace_id: 'a'.repeat(32),
  span_id: 'b'.repeat(16),
  parent_span_id: null,
  name: 'synthetic operation',
  kind: 'custom',
  start_time_unix_nanos: '1700000000123456789',
  end_time_unix_nanos: '1700000001987654321',
  attributes: { 'sdk.outcome.category': 'synthetic_error' },
  outcome: 'error',
  dropped_attributes_count: 0,
};

for (const status of [302, 403, 429, 503]) {
  it(`handles HTTP ${status} without exposing export credentials`, async () => {
    const requests: {
      headers: Record<string, unknown>;
      body: Record<string, any>;
    }[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
      response.writeHead(requests.length === 1 ? status : 200).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Collector did not start');
    try {
      const exporter = new OpenAITraceExporter({
        apiKey: 'synthetic-private-key',
        endpoint: `http://127.0.0.1:${address.port}/v1/traces/ingest`,
        maxRetries: 1,
      });
      if (status === 503) {
        await exporter.onEvent(event);
        expect(requests).toHaveLength(2);
        const [trace, span] = requests[1].body.data;
        expect(trace.id).toBe(`trace_${'a'.repeat(32)}`);
        expect(span.id).toBe(`span_${'0'.repeat(8)}${'b'.repeat(16)}`);
        expect(span.parent_id).toBeNull();
        expect(span.started_at).toBe('2023-11-14T22:13:20.123456789Z');
        expect(span.ended_at).toBe('2023-11-14T22:13:21.987654321Z');
        expect(requests[1].headers.authorization).toBe(
          'Bearer synthetic-private-key',
        );
        expect(requests[1].headers['openai-beta']).toBe('traces=v1');
      } else {
        await expect(exporter.onEvent(event)).rejects.toThrow(
          'Native OpenAI trace export failed',
        );
        expect(requests).toHaveLength(1);
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
}

it('retains root metadata across a failed export and credential rotation', async () => {
  const received: { key: string | undefined; data: Record<string, any>[] }[] =
    [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({
      key: request.headers.authorization,
      data: JSON.parse(Buffer.concat(chunks).toString()).data,
    });
    response.writeHead(received.length === 1 ? 503 : 200).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Collector did not start');
  try {
    const exporter = new OpenAITraceExporter({
      apiKey: 'synthetic-old-key',
      endpoint: `http://127.0.0.1:${address.port}/ingest`,
    });
    await expect(
      exporter.onEvent({
        ...event,
        name: 'root-workflow',
        lifecycle: 'start',
        parent_span_id: null,
        attributes: {
          'sdk.group_id': 'root-group',
          'sdk.metadata.tenant': 'synthetic-tenant',
          'sdk.metadata.literal': 'true',
        },
      }),
    ).rejects.toThrow();
    await exporter.onEvent(event);
    exporter.setApiKey('synthetic-new-key');
    await exporter.onEvent(event);
    for (const request of received.slice(1)) {
      expect(request.data[0]).toMatchObject({
        object: 'trace',
        workflow_name: 'root-workflow',
        group_id: 'root-group',
        metadata: {
          runtime: 'native',
          tenant: 'synthetic-tenant',
          literal: 'true',
        },
      });
    }
    expect(received[2].key).toBe('Bearer synthetic-new-key');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('resends the root under a new key after rotation during an in-flight delivery', async () => {
  const received: { key: string | undefined; data: Record<string, any>[] }[] =
    [];
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({
      key: request.headers.authorization,
      data: JSON.parse(Buffer.concat(chunks).toString()).data,
    });
    if (received.length === 1) {
      entered();
      await released;
    }
    response.writeHead(200).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Collector did not start');
  try {
    const exporter = new OpenAITraceExporter({
      apiKey: 'synthetic-old-key',
      endpoint: `http://127.0.0.1:${address.port}/ingest`,
    });
    const old = exporter.onEvent({
      ...event,
      name: 'root-workflow',
      lifecycle: 'start',
      parent_span_id: null,
    });
    await started;
    exporter.setApiKey('synthetic-new-key');
    release();
    await old;
    await exporter.onEvents(
      Array.from({ length: 30 }, (_, index) => ({
        ...event,
        name: `span-${index}`,
        parent_span_id: 'b'.repeat(16),
        span_id: index.toString(16).padStart(16, '0'),
      })),
    );
    expect(received).toHaveLength(2);
    expect(received[0].key).toBe('Bearer synthetic-old-key');
    expect(received[1].key).toBe('Bearer synthetic-new-key');
    expect(received[1].data[0]).toMatchObject({
      object: 'trace',
      workflow_name: 'root-workflow',
    });
    expect(
      received[1].data
        .filter((row) => row.object === 'trace.span')
        .map((row) => row.span_data.name),
    ).toEqual(Array.from({ length: 30 }, (_, index) => `span-${index}`));
  } finally {
    release();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('bounds remembered trace descriptors and re-admits an evicted trace', async () => {
  const requests: Record<string, any>[][] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()).data);
    response.writeHead(200).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Collector did not start');
  try {
    const exporter = new OpenAITraceExporter({
      apiKey: 'synthetic-key',
      endpoint: `http://127.0.0.1:${address.port}/ingest`,
    });
    const roots = Array.from({ length: 1100 }, (_, index): TraceEvent => ({
      ...event,
      lifecycle: 'end',
      parent_span_id: null,
      trace_id: index.toString(16).padStart(32, '0'),
      name: `root-${index}`,
      attributes: {},
    }));
    await exporter.onEvents(roots);
    expect(requests).toHaveLength(1);
    await exporter.onEvent(roots[1099]);
    expect(requests[1].filter((row) => row.object === 'trace')).toHaveLength(0);
    await exporter.onEvent(roots[0]);
    expect(requests).toHaveLength(3);
    expect(requests[2][0]).toMatchObject({
      object: 'trace',
      workflow_name: 'root-0',
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('retains active descendants during completed trace churn and bounds active admission', async () => {
  const requests: Record<string, any>[][] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()).data);
    response.writeHead(200).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('collector missing');
  try {
    const exporter = new OpenAITraceExporter({
      apiKey: 'synthetic',
      endpoint: `http://127.0.0.1:${address.port}/ingest`,
    });
    const root: TraceEvent = {
      ...event,
      lifecycle: 'start',
      parent_span_id: null,
      name: 'retained-root',
      attributes: { 'sdk.group_id': 'retained-group' },
    };
    const child: TraceEvent = {
      ...event,
      lifecycle: 'start',
      parent_span_id: root.span_id,
      span_id: 'd'.repeat(16),
    };
    await exporter.onEvents([root, child, { ...root, lifecycle: 'end' }]);
    await exporter.onEvents(
      Array.from({ length: 1100 }, (_, index): TraceEvent => ({
        ...root,
        lifecycle: 'end',
        trace_id: index.toString(16).padStart(32, '0'),
        name: 'completed-churn',
      })),
    );
    await exporter.onEvent({ ...child, lifecycle: 'end' });
    const descriptors = requests
      .flat()
      .filter(
        (row) => row.object === 'trace' && row.id === `trace_${root.trace_id}`,
      );
    expect(descriptors.length).toBeGreaterThan(0);
    expect(
      descriptors.every(
        (row) =>
          row.workflow_name === 'retained-root' &&
          row.group_id === 'retained-group',
      ),
    ).toBe(true);
    const full = new OpenAITraceExporter({
      apiKey: 'synthetic',
      endpoint: `http://127.0.0.1:${address.port}/ingest`,
    });
    const roots = Array.from({ length: 1024 }, (_, index): TraceEvent => ({
      ...root,
      trace_id: index.toString(16).padStart(32, '0'),
    }));
    await full.onEvents(roots);
    await expect(
      full.onEvent({ ...root, trace_id: 'f'.repeat(32) }),
    ).rejects.toThrow('capacity');
    await expect(
      full.onEvent({ ...child, trace_id: 'f'.repeat(32) }),
    ).rejects.toThrow('descriptor');
    await full.onEvent({ ...roots[0], lifecycle: 'end' });
    await full.onEvent({ ...root, trace_id: 'f'.repeat(32) });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
