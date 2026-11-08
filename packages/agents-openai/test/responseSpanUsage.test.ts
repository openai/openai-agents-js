import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import {
  setTraceProcessors,
  setTracingDisabled,
  withTrace,
  type ModelRequest,
  type ResponseSpanData,
  type Span,
} from '@openai/agents-core';
import { OpenAIResponsesModel } from '../src/openaiResponsesModel';

const privateValue = 'private-response-usage-sentinel';
const endpoint = 'https://api.openai.com/v1/responses';
const spans: Span<ResponseSpanData>[] = [];

beforeEach(() => {
  spans.length = 0;
  setTracingDisabled(false);
  setTraceProcessors([
    {
      async onTraceStart() {},
      async onTraceEnd() {},
      async onSpanStart() {},
      async onSpanEnd(span) {
        if (span.spanData.type === 'response') {
          spans.push(span as Span<ResponseSpanData>);
        }
      },
      async shutdown() {},
      async forceFlush() {},
    },
  ]);
});

afterEach(() => {
  setTracingDisabled(true);
  setTraceProcessors([]);
});

function terminal(usage: unknown, status = 'completed') {
  return {
    id: 'resp_usage',
    object: 'response',
    created_at: 1,
    model: 'gpt-test',
    status,
    output: [
      {
        id: 'msg_usage',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: privateValue, annotations: [] }],
      },
    ],
    ...(usage === undefined ? {} : { usage }),
    ...(status === 'incomplete'
      ? { incomplete_details: { reason: 'max_output_tokens' } }
      : {}),
    ...(status === 'failed'
      ? { error: { code: 'server_error', message: privateValue } }
      : {}),
    private_response_field: privateValue,
  };
}

function fixture(
  body: ReturnType<typeof terminal>,
  stream: boolean,
  httpStatus = 200,
) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
    expect(String(url)).toBe(endpoint);
    const data = stream
      ? [
          { type: 'response.created', response: { id: body.id } },
          { type: `response.${body.status}`, response: body },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join('') + 'data: [DONE]\n\n'
      : JSON.stringify(body);
    const response = new Response(data, {
      status: httpStatus,
      headers: {
        'Content-Type': stream ? 'text/event-stream' : 'application/json',
        'x-request-id': 'req_usage',
      },
    });
    // The injected transport represents this exact trusted endpoint.
    Object.defineProperty(response, 'url', { value: endpoint });
    return response;
  });
  const client = new OpenAI({
    apiKey: 'synthetic-usage-test',
    maxRetries: 0,
    fetch,
  });
  return { model: new OpenAIResponsesModel(client, 'gpt-test'), fetch };
}

function request(tracing: ModelRequest['tracing']): ModelRequest {
  return {
    systemInstructions: privateValue,
    input: privateValue,
    modelSettings: {},
    tools: [],
    handoffs: [],
    outputType: 'text',
    tracing,
  };
}

async function invoke(
  model: OpenAIResponsesModel,
  stream: boolean,
  tracing: ModelRequest['tracing'],
) {
  return withTrace('response usage', async () => {
    if (stream) {
      for await (const _event of model.getStreamedResponse(request(tracing))) {
        // Drain the real model stream so its span reaches its terminal owner.
      }
    } else {
      await model.getResponse(request(tracing));
    }
  });
}

function recorded() {
  expect(spans).toHaveLength(1);
  const span = spans[0];
  const json = span.toJSON() as { span_data: ResponseSpanData };
  expect(json.span_data.response_id).toBe('resp_usage');
  expect(json.span_data).not.toHaveProperty('_input');
  expect(json.span_data).not.toHaveProperty('_response');
  expect(JSON.stringify(json)).not.toContain(privateValue);
  return { span, data: json.span_data };
}

describe.each([false, true])(
  'automatic response usage (stream=%s)',
  (stream) => {
    it('emits no response span for a disabled model request inside an active trace', async () => {
      const { model, fetch } = fixture(
        terminal({ input_tokens: 3, output_tokens: 4, privateValue }),
        stream,
      );
      await invoke(model, stream, false);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(spans).toEqual([]);
    });

    it('emits no response span when tracing is globally disabled', async () => {
      setTracingDisabled(true);
      const { model, fetch } = fixture(
        terminal({ input_tokens: 3, output_tokens: 4, privateValue }),
        stream,
      );
      await invoke(model, stream, 'enabled_without_data');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(spans).toEqual([]);
    });

    it.each([true, 'enabled_without_data'] as const)(
      'exports only safe received counts with tracing=%s',
      async (tracing) => {
        const { model, fetch } = fixture(
          terminal({
            input_tokens: 3,
            output_tokens: 4,
            total_tokens: 7,
            input_tokens_details: { cached_tokens: 1, privateValue },
            details: { privateValue },
            privateValue,
          }),
          stream,
        );
        await invoke(model, stream, tracing);
        const { span, data } = recorded();
        expect(data.usage).toEqual({ input_tokens: 3, output_tokens: 4 });
        expect(fetch).toHaveBeenCalledTimes(1);
        if (tracing === 'enabled_without_data') {
          expect(span.spanData).not.toHaveProperty('_input');
          expect(span.spanData).not.toHaveProperty('_response');
        } else {
          // The exported counts must not share the retained raw response object.
          const raw = span.spanData._response as {
            usage: { input_tokens: number };
          };
          raw.usage.input_tokens = 999;
          expect(span.spanData.usage).toEqual({
            input_tokens: 3,
            output_tokens: 4,
          });
        }
      },
    );

    it('retains real zeros instead of treating them as absent', async () => {
      const { model } = fixture(
        terminal({ input_tokens: 0, output_tokens: 0, privateValue }),
        stream,
      );
      await invoke(model, stream, 'enabled_without_data');
      expect(recorded().data.usage).toEqual({
        input_tokens: 0,
        output_tokens: 0,
      });
    });

    it.each([undefined, null, { privateValue }])(
      'omits usage without safe received counts: %j',
      async (usage) => {
        const { model } = fixture(terminal(usage), stream);
        await invoke(model, stream, 'enabled_without_data');
        const { span, data } = recorded();
        expect(span.spanData).not.toHaveProperty('usage');
        expect(data).not.toHaveProperty('usage');
      },
    );

    it('does not coerce or export malformed counts', async () => {
      const { model } = fixture(
        terminal({ input_tokens: '0', output_tokens: -1, privateValue }),
        stream,
      );
      await invoke(model, stream, 'enabled_without_data');
      expect(recorded().data).not.toHaveProperty('usage');
    });

    it.each(['incomplete', 'failed'])(
      'retains received counts on a %s terminal without raw data',
      async (status) => {
        const { model, fetch } = fixture(
          terminal({ input_tokens: 0, output_tokens: 2, privateValue }, status),
          stream,
        );
        await expect(
          invoke(model, stream, 'enabled_without_data'),
        ).rejects.toThrow();
        const { span, data } = recorded();
        expect(data.usage).toEqual({ input_tokens: 0, output_tokens: 2 });
        expect(span.error).not.toBeNull();
        expect(fetch).toHaveBeenCalledTimes(1);
      },
    );

    it('leaves no response usage after a transport error', async () => {
      const { model, fetch } = fixture(terminal(undefined), stream, 500);
      await expect(
        invoke(model, stream, 'enabled_without_data'),
      ).rejects.toThrow();
      expect(spans).toHaveLength(1);
      expect(spans[0].spanData).not.toHaveProperty('usage');
      expect(spans[0].error).not.toBeNull();
      expect(JSON.stringify(spans[0].toJSON())).not.toContain(privateValue);
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  },
);
