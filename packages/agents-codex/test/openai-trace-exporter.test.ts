import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { OpenAITraceExporter } from '../src/runtime/telemetry';
import { invokeTraceDelivery } from '../src/runtime/trace-delivery';
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

for (const status of [302, 403, 408, 409, 429, 503]) {
  it(`handles HTTP ${status} without exposing export credentials`, async () => {
    const requests: {
      headers: Record<string, unknown>;
      body: Record<string, any>;
      at: number;
    }[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString()),
        at: performance.now(),
      });
      const retryHeaders =
        status === 409
          ? { 'retry-after-ms': 'NaN', 'retry-after': '0.035' }
          : status === 503
            ? { 'retry-after': 'Thu, 01 Jan 2099 00:00:00 GMT' }
            : { 'retry-after-ms': '35' };
      response
        .writeHead(requests.length === 1 ? status : 200, retryHeaders)
        .end();
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
        maxRetries: 5,
        timeoutMs: 1500,
        retryDelayMs: 5,
        maxRetryDelayMs: 50,
      });
      if ([408, 409, 429, 503].includes(status)) {
        await exporter.onEvent(event);
        expect(requests).toHaveLength(2);
        expect(requests[1].at - requests[0].at).toBeGreaterThanOrEqual(30);
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

for (const test of [
  {
    name: 'server retry veto',
    status: 429,
    veto: true,
    delay: 0,
    timeout: 1500,
  },
  {
    name: 'delivery deadline during backoff',
    status: 503,
    veto: false,
    delay: 1000,
    timeout: 100,
  },
]) {
  it(`stops trace retries at the ${test.name}`, async () => {
    let requests = 0;
    const server = createServer(async (request, response) => {
      for await (const _ of request) {
        /* Drain the request before responding. */
      }
      requests++;
      response
        .writeHead(test.status, {
          'x-should-retry': test.veto ? ' false ' : 'true',
        })
        .end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Collector did not start');
    try {
      const exporter = new OpenAITraceExporter({
        apiKey: 'synthetic-private-key',
        endpoint: `http://127.0.0.1:${address.port}/ingest`,
        maxRetries: 5,
        timeoutMs: test.timeout,
        retryDelayMs: test.delay,
        maxRetryDelayMs: test.delay,
      });
      await expect(exporter.onEvent(event)).rejects.toThrow(
        'Native OpenAI trace export failed',
      );
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
}

for (const status of [200, 403, 429, 503]) {
  it(`preserves HTTP ${status} retry decisions when response body cleanup fails`, async () => {
    const attempts: number[] = [];
    const request = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => {
        attempts.push(performance.now());
        if (attempts.length > 1) return new Response(null, { status: 200 });
        const body = new ReadableStream({
          start(controller) {
            controller.error(new Error('Synthetic response body failure'));
          },
        });
        return new Response(body, {
          status,
          headers: {
            'x-should-retry': status === 429 ? 'false' : 'true',
            'retry-after-ms': '15',
          },
        });
      });
    try {
      const exporter = new OpenAITraceExporter({
        apiKey: 'synthetic-key',
        maxRetries: 2,
      });
      if (status === 503) {
        await exporter.onEvent(event);
        expect(attempts).toHaveLength(2);
        expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(10);
      } else {
        await expect(exporter.onEvent(event)).rejects.toThrow(
          'Native OpenAI trace export failed',
        );
        expect(attempts).toHaveLength(1);
      }
    } finally {
      request.mockRestore();
    }
  });
}

it('caps exponential trace retry backoff within the delivery budget', async () => {
  const times: number[] = [];
  const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    times.push(performance.now());
    return new Response(null, { status: times.length <= 10 ? 503 : 200 });
  });
  try {
    const exporter = new OpenAITraceExporter({
      apiKey: 'synthetic-key',
      maxRetries: 10,
      retryDelayMs: 5,
      maxRetryDelayMs: 5,
    });
    await exporter.onEvent(event);
    expect(request).toHaveBeenCalledTimes(11);
    expect(times.at(-1)! - times[0]).toBeGreaterThanOrEqual(45);
  } finally {
    vi.restoreAllMocks();
  }
});

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

it.each([200, 503])(
  'delivers admitted traces from a mixed batch after loss (HTTP %i)',
  async (status) => {
    const requests: Record<string, any>[][] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()).data);
      response.writeHead(status).end();
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
        maxRetries: 1,
      });
      exporter._onNativeTraceLoss();
      const fresh = {
        ...event,
        trace_id: 'c'.repeat(32),
        span_id: 'd'.repeat(16),
        name: 'fresh-workflow',
      };
      await expect(
        exporter.onEvents([event, { ...fresh, lifecycle: 'start' }, fresh]),
      ).rejects.toThrow(
        status === 200
          ? 'Native trace root descriptor is unavailable'
          : 'Native OpenAI trace export failed; Native trace root descriptor is unavailable',
      );
      expect(requests).toHaveLength(status === 200 ? 1 : 2);
      for (const request of requests) {
        expect(request).toHaveLength(2);
        expect(request[0]).toMatchObject({
          id: `trace_${fresh.trace_id}`,
          workflow_name: 'fresh-workflow',
        });
        expect(request[1]).toMatchObject({
          trace_id: `trace_${fresh.trace_id}`,
          span_data: { name: 'fresh-workflow' },
        });
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

it.each([false, true])(
  'accounts for later completions in a failed batch (unknown child=%s)',
  async (rejectedChild) => {
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
      const roots = Array.from({ length: 1024 }, (_, index): TraceEvent => ({
        ...event,
        lifecycle: 'start',
        trace_id: index.toString(16).padStart(32, '0'),
        name: `original-root-${index}`,
        attributes: { 'sdk.group_id': 'original-group' },
      }));
      const overflow: TraceEvent = {
        ...roots[0],
        trace_id: 'f'.repeat(32),
        name: 'overflow-root',
      };
      const rejected = rejectedChild
        ? { ...overflow, parent_span_id: 'c'.repeat(16) }
        : overflow;
      await exporter.onEvents(roots);
      await expect(
        exporter.onEvents([
          rejected,
          { ...roots[0], lifecycle: 'end' },
          overflow,
        ]),
      ).rejects.toThrow(rejectedChild ? 'descriptor' : 'capacity');
      expect(requests).toHaveLength(2);
      expect(requests.at(-1)![0]).toMatchObject({
        workflow_name: 'overflow-root',
      });
      await exporter.onEvent({
        ...overflow,
        lifecycle: 'end',
        name: 'renamed-end',
      });
      expect(requests.at(-1)).toHaveLength(1);
      expect(requests.at(-1)![0]).toMatchObject({
        object: 'trace.span',
        span_data: { name: 'renamed-end' },
      });
      exporter.setApiKey('synthetic-rotated');
      await exporter.onEvent({ ...roots[1], lifecycle: 'end' });
      expect(requests.at(-1)![0]).toMatchObject({
        workflow_name: 'original-root-1',
        group_id: 'original-group',
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

it('routes original native snapshots by credential and retires forwarding authority', async () => {
  const received: {
    authorization: string | undefined;
    organization: string | undefined;
    body: any;
  }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({
      authorization: request.headers.authorization,
      organization: request.headers['openai-organization'] as
        string | undefined,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    response.writeHead(200).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Collector did not start');
  try {
    const exporter = new OpenAITraceExporter({
      apiKey: 'fallback-key',
      organization: 'fallback-org',
      endpoint: `http://127.0.0.1:${address.port}/v1/traces/ingest`,
    });
    const a = Object.freeze({
      ...event,
      credential_required: true,
      sequence: 2,
      processor_ids: ['host-1', 'host-2'],
    });
    const b = Object.freeze({
      ...event,
      credential_required: true,
      sequence: 3,
      processor_ids: ['host-1'],
      span_id: 'c'.repeat(16),
    });
    const routes = {
      '2': {
        identity: 'native-A',
        headers: { authorization: 'Bearer scope-A' },
        processor_ids: ['host-1'],
      },
      '3': {
        identity: 'native-B',
        headers: { authorization: 'Bearer scope-B' },
        processor_ids: ['host-1'],
      },
    };
    await invokeTraceDelivery([a, b], routes, 'host-1', async () => {
      await expect(
        exporter.onEvent({ ...a, name: 'copied foreign root' }),
      ).rejects.toThrow('credential delivery is unavailable');
      await exporter.onEvents([a, b]);
    });
    await expect(exporter.onEvent(a)).rejects.toThrow(
      'credential delivery is unavailable',
    );
    await invokeTraceDelivery([a], routes, 'host-1', () => exporter.onEvent(a));
    await invokeTraceDelivery([a], routes, 'host-2', async () => {
      await expect(exporter.onEvent({ ...a })).rejects.toThrow(
        'credential delivery is unavailable',
      );
      await exporter.onEvent(a);
    });
    await invokeTraceDelivery([a], undefined, 'host-2', async () => {
      await expect(exporter.onEvent(a)).rejects.toThrow(
        'credential delivery is unavailable',
      );
    });
    await exporter.onEvent({ ...event, trace_id: 'd'.repeat(32), sequence: 4 });
    const stopped = new AbortController();
    await invokeTraceDelivery(
      [a],
      routes,
      'host-1',
      async () => {
        stopped.abort();
        await expect(exporter.onEvent(a)).rejects.toThrow(
          'credential delivery is unavailable',
        );
      },
      stopped.signal,
    );
    expect(received.map((request) => request.authorization)).toEqual([
      'Bearer scope-A',
      'Bearer scope-B',
      'Bearer scope-A',
      'Bearer fallback-key',
      'Bearer fallback-key',
    ]);
    expect(
      received.every((request) => request.organization === 'fallback-org'),
    ).toBe(true);
    expect(
      received.map(
        (request) =>
          request.body.data.filter((item: any) => item.object === 'trace')
            .length,
      ),
    ).toEqual([1, 1, 1, 1, 1]);
    expect(received[0].body.data[0].workflow_name).toBe('synthetic operation');
    expect(JSON.stringify(received.map((request) => request.body))).not.toMatch(
      /scope-A|scope-B|fallback-key|credential_required|native-A|native-B/,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
