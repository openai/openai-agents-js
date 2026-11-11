import OpenAI from 'openai';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  ChatCompletionsModel,
  ResponsesModel,
  tool,
  type ModelRequest,
} from '../../src';

for (const Adapter of [ChatCompletionsModel, ResponsesModel]) {
  for (const exhausted of [false, true]) {
    it(`keeps ${Adapter.name} transport retries inside one native request (exhausted=${exhausted})`, async () => {
      let calls = 0;
      let factories = 0;
      const effects: number[] = [];
      const ids: string[] = [];
      const client = new OpenAI({
        apiKey: 'fixture',
        maxRetries: 0,
        fetch: async (url, init) => {
          calls++;
          expect(new Headers(init?.headers).get('x-native-request')).toBe(
            String(factories),
          );
          expect(new URL(String(url)).searchParams.get('request')).toBe(
            String(factories),
          );
          if (exhausted || calls === 1)
            return Response.json(
              { error: { message: 'retry' } },
              { status: 500, headers: { 'retry-after-ms': '1' } },
            );
          const invoke = calls === 2;
          return Response.json(
            Adapter === ChatCompletionsModel
              ? {
                  id: `chat_${calls}`,
                  choices: [
                    {
                      finish_reason: invoke ? 'tool_calls' : 'stop',
                      message: invoke
                        ? {
                            role: 'assistant',
                            content: null,
                            tool_calls: [
                              {
                                id: 'call_lookup',
                                type: 'function',
                                function: {
                                  name: 'lookup',
                                  arguments: '{"value":2}',
                                },
                              },
                            ],
                          }
                        : { role: 'assistant', content: 'ok' },
                    },
                  ],
                }
              : {
                  id: `resp_${calls}`,
                  status: 'completed',
                  output: invoke
                    ? [
                        {
                          type: 'function_call',
                          id: 'fc_lookup',
                          call_id: 'call_lookup',
                          name: 'lookup',
                          arguments: '{"value":2}',
                        },
                      ]
                    : [
                        {
                          type: 'message',
                          role: 'assistant',
                          content: [{ type: 'output_text', text: 'ok' }],
                        },
                      ],
                },
          );
        },
      });
      const model = new Adapter(client, undefined, {
        requestOptions(request: ModelRequest) {
          factories++;
          ids.push(request.sessionId);
          return {
            headers: { 'x-native-request': String(factories) },
            query: { request: factories },
            maxRetries: 1,
            timeoutMs: 1000,
          };
        },
      });
      await using provider = new NativeProvider({
        baseUrl: 'https://unused.invalid/v1',
        modelBackend: model,
      });
      const lookup = tool({
        name: 'lookup',
        description: 'Lookup.',
        parameters: z.object({ value: z.number() }),
        execute({ value }) {
          effects.push(value);
          return String(value);
        },
      });
      const agent = new Agent({
        model: 'gpt-4.1',
        instructions: 'Use lookup once.',
        tools: [lookup],
        provider,
      });
      if (exhausted) {
        await expect(agent.run('Lookup2.')).rejects.toThrow();
        expect(calls).toBe(2);
        expect(factories).toBe(1);
        expect(effects).toEqual([]);
      } else {
        expect((await agent.run('Lookup2.')).finalOutput).toBe('ok');
        expect(calls).toBe(3);
        expect(factories).toBe(2);
        expect(effects).toEqual([2]);
        expect(ids[0]).toBe(ids[1]);
      }
      expect(client.maxRetries).toBe(0);
    });
  }
}
