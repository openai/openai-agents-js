import { createServer } from 'node:http';
import { once } from 'node:events';
import OpenAI from 'openai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  AiSdkModel,
  ChatCompletionsModel,
  NativeProvider,
  NativeError,
  ResponsesModel,
  tool,
} from '../../src';

const ordinaryCases = (
  ['responses', 'ai-sdk-chat', 'ai-sdk-responses'] as const
).flatMap((adapter) =>
  (['complete', 'incomplete', 'refusal', 'cancel'] as const).map((outcome) => ({
    adapter,
    outcome,
    cacheMode: 'ordinary',
    cacheKey: undefined as string | undefined,
    penalties: false,
  })),
);
const cacheCases = (
  ['chat', 'responses', 'ai-sdk-chat', 'ai-sdk-responses'] as const
).flatMap((adapter) =>
  (
    [
      { cacheMode: 'inherited', cacheKey: undefined },
      { cacheMode: 'explicit', cacheKey: 'application-cache-key' },
      { cacheMode: 'empty', cacheKey: '' },
    ] as const
  ).map((selection) => ({
    adapter,
    outcome: 'complete' as const,
    penalties: false,
    ...selection,
  })),
);
const penaltyCases = (['chat', 'ai-sdk-chat'] as const).map((adapter) => ({
  adapter,
  outcome: 'complete' as const,
  cacheMode: 'inherited-with-penalties',
  cacheKey: undefined,
  penalties: true,
}));
const reasoningCases = (
  ['reasoning-summary', 'reasoning-empty', 'reasoning-renamed'] as const
).map((outcome) => ({
  adapter: 'ai-sdk-responses' as const,
  outcome,
  cacheMode: 'reasoning',
  cacheKey: 'private-reasoning-cache-key',
  penalties: false,
}));
const controlCases = [
  ...(['ai-sdk-chat', 'ai-sdk-responses'] as const).map((adapter) => ({
    adapter,
    outcome: 'refusal' as const,
    cacheMode: 'renamed-openai',
    cacheKey: undefined,
    penalties: false,
  })),
  ...(['responses', 'ai-sdk-responses'] as const).map((adapter) => ({
    adapter,
    outcome: 'cache-write' as const,
    cacheMode: 'ordinary',
    cacheKey: undefined,
    penalties: false,
  })),
  {
    adapter: 'ai-sdk-responses' as const,
    outcome: 'summary-auto' as const,
    cacheMode: 'summary-native',
    cacheKey: undefined,
    penalties: false,
  },
];
it.each([
  ...ordinaryCases,
  ...cacheCases,
  ...penaltyCases,
  ...reasoningCases,
  ...controlCases,
])(
  'keeps borrowed $adapter $outcome $cacheMode cache key inside the native tool loop',
  async ({ adapter, outcome, cacheMode, cacheKey, penalties }) => {
    const reasoning = outcome.startsWith('reasoning-');
    const renamed =
      outcome === 'reasoning-renamed' || cacheMode === 'renamed-openai';
    const success =
      outcome === 'complete' ||
      reasoning ||
      outcome === 'cache-write' ||
      outcome === 'summary-auto';
    const reasoningSummary =
      outcome === 'reasoning-empty'
        ? []
        : [
            { type: 'summary_text', text: 'first summary' },
            { type: 'summary_text', text: 'second summary' },
          ];
    const seen: any[] = [];
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const effects: number[] = [];
    const fallback: string[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (request.url?.startsWith('/fallback')) {
        fallback.push(request.url);
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ error: { message: 'Unexpected native fallback' } }),
        );
        return;
      }
      seen.push(body);
      enter();
      if (outcome === 'cancel') await released;
      const final = seen.length > 1;
      if (reasoning) {
        expect(body.metadata).toEqual({ owner: 'private-options' });
        if (final)
          expect(
            body.input.find((item: any) => item.type === 'reasoning'),
          ).toEqual({
            type: 'reasoning',
            id: 'rs_native',
            encrypted_content: 'opaque-native-reasoning',
            summary: reasoningSummary,
          });
      }
      if (final)
        expect(JSON.stringify(body.input ?? body.messages)).toContain('42');
      let result: any;
      if (adapter !== 'ai-sdk-chat' && adapter !== 'chat')
        result = {
          id: `resp_${seen.length}`,
          object: 'response',
          created_at: 0,
          model: 'gpt-4.1',
          status:
            outcome === 'incomplete' || outcome === 'refusal'
              ? 'incomplete'
              : 'completed',
          output: final
            ? [
                {
                  type: 'message',
                  id: 'msg_result',
                  role: 'assistant',
                  status: 'completed',
                  content: [
                    { type: 'output_text', text: '42', annotations: [] },
                  ],
                },
              ]
            : [
                {
                  type: 'function_call',
                  id: 'fc_double',
                  call_id: 'call_double',
                  name: 'double',
                  arguments: '{"value":21}',
                  status: 'completed',
                },
              ],
          usage: {
            input_tokens: 3,
            output_tokens: 2,
            total_tokens: 5,
            input_tokens_details: {
              cached_tokens: 1,
              ...(outcome === 'cache-write' ? { cache_write_tokens: 2 } : {}),
            },
            output_tokens_details: { reasoning_tokens: 1 },
          },
        };
      else
        result = {
          id: `chatcmpl_${seen.length}`,
          object: 'chat.completion',
          created: 0,
          model: 'gpt-4.1',
          choices: [
            {
              index: 0,
              finish_reason:
                outcome === 'incomplete' || outcome === 'refusal'
                  ? 'length'
                  : final
                    ? 'stop'
                    : 'tool_calls',
              message: {
                role: 'assistant',
                content: final ? '42' : null,
                ...(final
                  ? {}
                  : {
                      tool_calls: [
                        {
                          id: 'call_double',
                          type: 'function',
                          function: {
                            name: 'double',
                            arguments: '{"value":21}',
                          },
                        },
                      ],
                    }),
              },
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        };
      if (reasoning && !final)
        result.output.unshift({
          type: 'reasoning',
          id: 'rs_native',
          encrypted_content: 'opaque-native-reasoning',
          summary: reasoningSummary,
        });
      if (outcome === 'refusal') {
        if (adapter !== 'ai-sdk-chat')
          result.output.push({
            type: 'message',
            id: 'msg_refusal',
            role: 'assistant',
            status: 'completed',
            content: [
              { type: 'refusal', refusal: 'synthetic-private-refusal' },
            ],
          });
        else result.choices[0].message.refusal = 'synthetic-private-refusal';
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result));
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing local peer');
    const baseURL = `http://127.0.0.1:${address.port}/v1`;
    const double = tool({
      name: 'double',
      description: 'Double.',
      parameters: z.object({ value: z.number() }),
      execute: ({ value }) => {
        effects.push(value);
        return String(value * 2);
      },
    });
    try {
      const client = new OpenAI({
        apiKey: 'synthetic',
        baseURL,
        maxRetries: 0,
      });
      const options =
        cacheKey === undefined ? {} : { promptCacheKey: cacheKey };
      const openaiOptions: Record<
        string,
        string | boolean | Record<string, string>
      > = {
        store: true,
        parallelToolCalls: false,
      };
      if (cacheKey !== undefined) openaiOptions.promptCacheKey = cacheKey;
      if (reasoning) {
        openaiOptions.metadata = { owner: 'private-options' };
        openaiOptions.reasoningSummary = 'detailed';
      }
      const providerOptions = { openai: openaiOptions };
      const adapterOptions: { providerFamily?: 'openai' } = renamed
        ? { providerFamily: 'openai' }
        : {};
      const backend =
        adapter === 'responses'
          ? new ResponsesModel(client, undefined, options)
          : adapter === 'chat'
            ? new ChatCompletionsModel(client, undefined, options)
            : new AiSdkModel(
                adapter === 'ai-sdk-chat'
                  ? createOpenAI({
                      apiKey: 'synthetic',
                      baseURL,
                      ...(renamed ? { name: 'proxy' } : {}),
                    }).chat('gpt-4.1')
                  : createOpenAI({
                      apiKey: 'synthetic',
                      baseURL,
                      ...(renamed ? { name: 'proxy' } : {}),
                    }).responses(
                      reasoning || outcome === 'summary-auto'
                        ? 'gpt-5'
                        : 'gpt-4.1',
                    ),
                cacheMode === 'ordinary' ? {} : providerOptions,
                adapterOptions,
              );
      delete adapterOptions.providerFamily;
      options.promptCacheKey = 'mutated-after-declaration';
      providerOptions.openai.promptCacheKey = 'mutated-after-declaration';
      if (reasoning)
        (openaiOptions.metadata as Record<string, string>).owner =
          'mutated-after-declaration';
      await using provider = new NativeProvider({
        baseUrl: `http://127.0.0.1:${address.port}/fallback/v1`,
        modelBackend: backend,
      });
      await using session = await new Agent({
        model: reasoning || outcome === 'summary-auto' ? 'gpt-5' : 'gpt-4.1',
        instructions: 'Use double.',
        ...(cacheMode !== 'ordinary'
          ? {
              modelSettings: {
                parallelToolCalls: true,
                ...(outcome === 'summary-auto'
                  ? { reasoningSummary: 'auto' }
                  : {}),
                ...(penalties
                  ? {
                      extraBody: {
                        frequency_penalty: 0.4,
                        presence_penalty: 0.2,
                      },
                    }
                  : {}),
              },
            }
          : {}),
        tools: [double],
        provider,
      }).session();
      const turn = await session.submit('Double21.');
      if (outcome === 'cancel') {
        await entered;
        const stopping = turn.cancel();
        release();
        await stopping;
        await expect(turn.wait()).rejects.toThrow();
      } else if (outcome === 'incomplete') {
        await expect(turn.wait()).rejects.toThrow(/completed response/);
      } else if (outcome === 'refusal') {
        const failure = await turn.wait().then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(NativeError);
        expect((failure as NativeError).responseIntegrityReason).toBe(
          'provider_refusal',
        );
        expect(String(failure)).not.toContain('synthetic-private-refusal');
      } else {
        const result = await turn.wait().catch((error) => {
          if (reasoning)
            throw new Error(
              `Reasoning replay failed after ${effects.length} tool effects and ${seen.length} client requests`,
              { cause: error },
            );
          throw error;
        });
        expect(result.finalOutput).toBe('42');
        expect(result.threadUsage?.totalTokenUsage.inputTokens).toBe(6);
        expect(result.threadUsage?.totalTokenUsage.outputTokens).toBe(4);
        if (outcome === 'cache-write') {
          expect(
            result.threadUsage?.totalTokenUsage.cacheWriteInputTokens,
          ).toBe(4);
          const turns = [];
          for await (const recorded of session.turns()) turns.push(recorded);
          expect(turns[0].usage?.inputTokensDetails.cacheWriteTokens).toBe(4);
        }
        if (reasoning || outcome === 'summary-auto')
          for (const body of seen) expect(body.reasoning?.summary).toBe('auto');
      }
      expect(effects).toEqual(success ? [21] : []);
      expect(seen).toHaveLength(success ? 2 : 1);
      expect(fallback).toEqual([]);
      expect(seen[0].stream ?? false).toBe(false);
      if (penalties) {
        for (const body of seen) {
          expect(body.frequency_penalty).toBe(0.4);
          expect(body.presence_penalty).toBe(0.2);
        }
      }
      if (cacheMode !== 'ordinary') {
        for (const body of seen) {
          if (cacheKey === undefined) {
            expect(body.prompt_cache_key).toEqual(expect.any(String));
            expect(body.prompt_cache_key).not.toBe('');
            expect(body.prompt_cache_key).not.toBe('mutated-after-declaration');
          } else expect(body.prompt_cache_key).toBe(cacheKey);
          if (adapter.startsWith('ai-sdk-')) {
            expect(body.store).toBe(false);
            expect(body.parallel_tool_calls).toBe(true);
          }
        }
      }
    } finally {
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  30_000,
);

it.each(['v2', 'v3', 'v4', 'anthropic-v3'] as const)(
  'keeps complete %s text in native one-shot finalOutput',
  async (version) => {
    let fallback = 0;
    const server = createServer((request, response) => {
      request.resume();
      if (request.url?.startsWith('/fallback')) {
        fallback++;
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ error: { message: 'Unexpected fallback' } }),
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'msg_split',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [
            { type: 'text', text: '4' },
            { type: 'text', text: '2' },
          ],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as { port: number };
    const baseURL = `http://127.0.0.1:${address.port}`;
    try {
      const model =
        version === 'anthropic-v3'
          ? createAnthropic({ apiKey: 'fixture', baseURL })('claude-sonnet-4-5')
          : {
              specificationVersion: version,
              provider: 'fixture.messages',
              modelId: 'fixture',
              doGenerate() {
                return {
                  finishReason: 'stop',
                  content: [
                    { type: 'text', text: '4' },
                    { type: 'text', text: '2' },
                  ],
                };
              },
            };
      await using provider = new NativeProvider({
        apiKey: 'fixture',
        baseUrl: `${baseURL}/fallback`,
        modelBackend: new AiSdkModel(model),
      });
      expect(
        (
          await new Agent({
            model: 'gpt-4.1',
            instructions: 'Reply42.',
            provider,
          }).run('Reply.')
        ).finalOutput,
      ).toBe('42');
      expect(fallback).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
