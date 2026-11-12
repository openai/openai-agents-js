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

it.each([ChatCompletionsModel, ResponsesModel])(
  'uses scoped options in the borrowed adapter on the issuing native turn with %s',
  async (Adapter) => {
    const seen: Array<{
      url: URL;
      headers: Headers;
      body: Record<string, unknown>;
    }> = [];
    let credentialCalls = 0;
    const client = new OpenAI({
      apiKey: async () => {
        credentialCalls += 1;
        return 'synthetic-borrowed-' + credentialCalls;
      },
      baseURL: 'http://test.invalid/v1',
      defaultHeaders: { 'x-drop': 'client' },
      defaultQuery: { keep: 'client', empty: 'client' },
      fetch: async (url, init) => {
        seen.push({
          url: new URL(String(url)),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        });
        return Response.json(
          Adapter === ChatCompletionsModel
            ? {
                id: `chat-${seen.length}`,
                choices: [
                  {
                    finish_reason: 'stop',
                    message: { role: 'assistant', content: 'ok' },
                  },
                ],
              }
            : {
                id: `response-${seen.length}`,
                status: 'completed',
                output: [
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
    await using provider = new NativeProvider({
      baseUrl: 'https://unused.invalid/v1',
      modelBackend: new Adapter(client, undefined, {
        requestOptions: {
          headers: { 'X-Routing': 'adapter', 'x-adapter': 'retained' },
          query: { route: 'adapter' },
        },
      }),
    });
    await using session = await new Agent({
      model: 'gpt-5',
      instructions: 'Answer.',
      provider,
    }).session();
    const first = await session.submit('Scoped.', {
      modelSettingsOverride: {
        extraHeaders: { 'x-routing': 'operation', 'x-drop': null },
        extraQuery: { route: 'operation', empty: null, count: 2 },
      },
    });
    expect((await first.wait()).finalOutput).toBe('ok');
    const second = await session.submit('Defaults.');
    expect((await second.wait()).finalOutput).toBe('ok');
    expect(seen).toHaveLength(2);
    expect(seen[0].headers.get('authorization')).toBe(
      'Bearer synthetic-borrowed-1',
    );
    expect(seen[0].headers.get('x-routing')).toBe('operation');
    expect(seen[0].headers.get('x-adapter')).toBe('retained');
    expect(seen[0].headers.has('x-drop')).toBe(false);
    expect(Object.fromEntries(seen[0].url.searchParams)).toEqual({
      route: 'operation',
      keep: 'client',
      empty: '',
      count: '2',
    });
    expect(seen[1].headers.get('authorization')).toBe(
      'Bearer synthetic-borrowed-2',
    );
    expect(seen[1].headers.get('x-routing')).toBe('adapter');
    expect(seen[1].headers.get('x-drop')).toBe('client');
    expect(Object.fromEntries(seen[1].url.searchParams)).toEqual({
      route: 'adapter',
      keep: 'client',
      empty: 'client',
    });
    for (const call of seen)
      expect(call.body).not.toHaveProperty('request_transport');
  },
);
