import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import {
  setTraceProcessors,
  setTracingDisabled,
  withTrace,
  type GenerationSpanData,
  type ModelRequest,
  type Span,
} from '@openai/agents-core';
import { OpenAIChatCompletionsModel } from '../src/openaiChatCompletionsModel';
import { OpenAITracingExporter } from '../src/openaiTracingExporter';

const fixtureURL = new URL(
  'https://provider.invalid/v1?credential=fixture-token#fixture-fragment',
);
fixtureURL.username = 'fixture-user';
fixtureURL.password = 'fixture-password';
const privateBaseURL = fixtureURL.href;
const spans: Span<GenerationSpanData>[] = [];
beforeEach(() => {
  spans.length = 0;
  setTracingDisabled(false);
  setTraceProcessors([
    {
      async onTraceStart() {},
      async onTraceEnd() {},
      async onSpanStart() {},
      async onSpanEnd(span) {
        if (span.spanData.type === 'generation')
          spans.push(span as Span<GenerationSpanData>);
      },
      async shutdown() {},
      async forceFlush() {},
    },
  ]);
});
afterEach(() => {
  setTracingDisabled(true);
  setTraceProcessors([]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function* chunks() {
  yield {
    id: 'chat-fixture',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fixture',
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', content: 'answer' },
        finish_reason: null,
      },
    ],
  };
  yield {
    id: 'chat-fixture',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fixture',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  };
}

describe.each([false, true])(
  'Chat model configuration tracing (stream=%s)',
  (stream) => {
    it.each([{}, false, 0, ''])(
      'omits implicit client URL configuration for settings %j',
      async (settings) => {
        // Falsy primitives are deliberate invalid-input probes, not new supported ModelSettings values.
        const client = new OpenAI({
          apiKey: 'synthetic-key',
          baseURL: privateBaseURL,
        });
        const create = vi
          .spyOn(client.chat.completions, 'create')
          .mockImplementation(
            (params) =>
              Promise.resolve(
                params.stream
                  ? chunks()
                  : {
                      id: 'chat-fixture',
                      object: 'chat.completion',
                      created: 1,
                      model: 'fixture',
                      choices: [
                        {
                          index: 0,
                          message: { role: 'assistant', content: 'answer' },
                          finish_reason: 'stop',
                        },
                      ],
                      usage: {
                        prompt_tokens: 1,
                        completion_tokens: 1,
                        total_tokens: 2,
                      },
                    },
              ) as any,
          );
        const model = new OpenAIChatCompletionsModel(client, 'fixture');
        const request: ModelRequest = {
          input: 'hello',
          modelSettings: settings as unknown as ModelRequest['modelSettings'],
          tools: [],
          handoffs: [],
          outputType: 'text',
          tracing: 'enabled_without_data',
        };
        await withTrace('model configuration', async () => {
          if (stream) {
            const events = [];
            for await (const event of model.getStreamedResponse(request))
              events.push(event);
            expect(events.length).toBeGreaterThan(0);
          } else {
            await model.getResponse(request);
          }
        });
        expect(create).toHaveBeenCalledTimes(1);
        expect(spans).toHaveLength(1);
        expect(
          JSON.parse(JSON.stringify(spans[0].spanData.model_config)),
        ).toEqual({});
        expect(JSON.stringify(spans[0].toJSON())).not.toContain(
          'fixture-password',
        );
        expect(JSON.stringify(spans[0].toJSON())).not.toContain(
          'fixture-token',
        );
        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValue(Response.json({}));
        vi.stubGlobal('fetch', fetch);
        await new OpenAITracingExporter({
          apiKey: 'synthetic-export-key',
          maxRetries: 1,
        }).export(spans);
        expect(fetch).toHaveBeenCalledTimes(1);
        const body = fetch.mock.calls[0][1]?.body as string;
        expect(body).not.toContain(privateBaseURL);
        expect(body).not.toContain('fixture-password');
        expect(body).not.toContain('fixture-token');
      },
    );
  },
);
