import { createServer } from 'node:http';
import { once } from 'node:events';
import OpenAI from 'openai';
import { createOpenAI } from '@ai-sdk/openai';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  AiSdkModel,
  NativeProvider,
  NativeError,
  ResponsesModel,
  tool,
} from '../../src';

it.each(
  (['responses', 'ai-sdk-chat', 'ai-sdk-responses'] as const).flatMap(
    (adapter) =>
      (['complete', 'incomplete', 'refusal', 'cancel'] as const).map(
        (outcome) => ({ adapter, outcome }),
      ),
  ),
)(
  'keeps borrowed $adapter $outcome generation inside the native tool loop',
  async ({ adapter, outcome }) => {
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
      if (final)
        expect(JSON.stringify(body.input ?? body.messages)).toContain('42');
      let result: any;
      if (adapter !== 'ai-sdk-chat')
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
            input_tokens_details: { cached_tokens: 1 },
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
      const backend =
        adapter === 'responses'
          ? new ResponsesModel(
              new OpenAI({ apiKey: 'synthetic', baseURL, maxRetries: 0 }),
            )
          : new AiSdkModel(
              adapter === 'ai-sdk-chat'
                ? createOpenAI({ apiKey: 'synthetic', baseURL }).chat('gpt-4.1')
                : createOpenAI({ apiKey: 'synthetic', baseURL }).responses(
                    'gpt-4.1',
                  ),
            );
      await using provider = new NativeProvider({
        baseUrl: `http://127.0.0.1:${address.port}/fallback/v1`,
        modelBackend: backend,
      });
      await using session = await new Agent({
        model: 'gpt-4.1',
        instructions: 'Use double.',
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
        const result = await turn.wait();
        expect(result.finalOutput).toBe('42');
        expect(result.threadUsage?.totalTokenUsage.inputTokens).toBe(6);
        expect(result.threadUsage?.totalTokenUsage.outputTokens).toBe(4);
      }
      expect(effects).toEqual(outcome === 'complete' ? [21] : []);
      expect(seen).toHaveLength(outcome === 'complete' ? 2 : 1);
      expect(fallback).toEqual([]);
      expect(seen[0].stream ?? false).toBe(false);
    } finally {
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  30_000,
);
