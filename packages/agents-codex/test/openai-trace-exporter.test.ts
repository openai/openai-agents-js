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
  parent_span_id: 'c'.repeat(16),
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
        expect(span.parent_id).toBe(`span_${'0'.repeat(8)}${'c'.repeat(16)}`);
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
