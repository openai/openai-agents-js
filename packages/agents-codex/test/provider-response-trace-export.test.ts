import { expect, it, vi } from 'vitest';
import { OpenAITraceExporter } from '../src/runtime/openai-trace-exporter';
import type { TraceEvent } from '../src/runtime/telemetry';

const event: TraceEvent = {
  sequence: 1,
  processor_ids: ['fixture'],
  lifecycle: 'end',
  trace_id: 'a'.repeat(32),
  span_id: 'b'.repeat(16),
  parent_span_id: null,
  name: 'response',
  kind: 'custom',
  start_time_unix_nanos: '1700000000123456789',
  end_time_unix_nanos: '1700000001987654321',
  attributes: {},
  outcome: 'ok',
  dropped_attributes_count: 0,
};

for (const responseId of ['resp_synthetic', undefined, 42]) {
  it('exports admitted native model facts as a typed response: ' + responseId, async () => {
    const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    try {
      const exporter = new OpenAITraceExporter({
        apiKey: 'synthetic-key',
        endpoint: 'http://127.0.0.1/v1/traces/ingest',
      });
      await exporter.onEvent({
        ...event,
        attributes: {
          'sdk.span.kind': 'model',
          ...(responseId === undefined ? {} : { 'sdk.response.id': responseId }),
        },
      });
      const records = JSON.parse(String(send.mock.calls[0][1]?.body)).data;
      expect(records[1].id).toBe('span_' + '0'.repeat(8) + event.span_id);
      expect(records[1].parent_id).toBeNull();
      expect(records[1].span_data).toEqual({
        type: 'response',
        response_id: typeof responseId === 'string' ? responseId : null,
        usage: null,
      });
    } finally {
      send.mockRestore();
    }
  });
}

it('retains generic native spans as custom records', async () => {
  const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
  try {
    const exporter = new OpenAITraceExporter({
      apiKey: 'synthetic-key',
      endpoint: 'http://127.0.0.1/v1/traces/ingest',
    });
    await exporter.onEvent(event);
    const records = JSON.parse(String(send.mock.calls[0][1]?.body)).data;
    expect(records[1].span_data).toEqual({
      type: 'custom',
      name: event.name,
      data: {},
    });
  } finally {
    send.mockRestore();
  }
});
