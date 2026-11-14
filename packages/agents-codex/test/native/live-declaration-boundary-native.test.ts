import OpenAI from 'openai';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  ChatCompletionsModel,
  tool,
  type FunctionTool,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
afterEach(() => ModelServer.closeAll());

it.each(['responses', 'lite', 'chat'] as const)(
  'has been applying live application policy and admitted tools at each %s sampling boundary',
  async (transport) => {
    const seen: string[][] = [];
    const effects: string[] = [];
    const instructionSamples: string[] = [];
    const recordInstructions = (value: unknown) => {
      const text = JSON.stringify(value);
      expect(
        text.includes('LIVE_INITIAL') && text.includes('LIVE_UPDATED'),
      ).toBe(false);
      instructionSamples.push(
        text.includes('LIVE_UPDATED')
          ? 'LIVE_UPDATED'
          : text.includes('LIVE_INITIAL')
            ? 'LIVE_INITIAL'
            : 'missing',
      );
    };
    let currentInstructions = 'LIVE_INITIAL';
    let selected: readonly FunctionTool[] = [];
    const b = tool({
      name: 'b',
      description: 'Second admitted callback.',
      parameters: z.object({}),
      execute: () => {
        effects.push('b');
        selected = [];
        return 'B';
      },
    });
    const a = tool({
      name: 'a',
      description: 'Change next active declaration.',
      parameters: z.object({}),
      execute: () => {
        effects.push('a');
        selected = [b];
        currentInstructions = 'LIVE_UPDATED';
        return 'A';
      },
    });
    selected = [a];
    const server = new ModelServer([
      [call('a', {}, { callId: 'a-1' })],
      [call('b', {}, { callId: 'b-1' })],
      [message('done')],
    ]);
    const config = await server.config();
    let chatRequests = 0;
    const client = new OpenAI({
      apiKey: 'fixture',
      maxRetries: 0,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as JsonObject;
        recordInstructions(body.messages);
        seen.push(
          ((body.tools ?? []) as { function: { name: string } }[]).map(
            (x) => x.function.name,
          ),
        );
        chatRequests++;
        return Response.json({
          id: 'chat-' + chatRequests,
          choices: [
            {
              finish_reason: chatRequests < 3 ? 'tool_calls' : 'stop',
              message:
                chatRequests < 3
                  ? {
                      role: 'assistant',
                      content: null,
                      tool_calls: [
                        {
                          id: chatRequests === 1 ? 'a-1' : 'b-1',
                          type: 'function',
                          function: {
                            name: chatRequests === 1 ? 'a' : 'b',
                            arguments: '{}',
                          },
                        },
                      ],
                    }
                  : { role: 'assistant', content: 'done' },
            },
          ],
        });
      },
    });
    await using provider =
      transport === 'chat'
        ? new NativeProvider({
            modelBackend: new ChatCompletionsModel(
              client,
              'fixture-live-declaration',
            ),
            supportsWebsockets: false,
            responseMode: 'buffered',
          })
        : new NativeProvider({
            baseUrl: (config['model_providers.fixture'] as JsonObject)
              .base_url as string,
            apiKey: 'fixture',
            supportsWebsockets: false,
          });
    const agent = new Agent({
      provider,
      model: transport === 'lite' ? 'gpt-5.6-sol' : 'fixture-live-declaration',
      instructions: 'Follow the application policy supplied for this request.',
      tools: [a, b],
      transformContext: ({ items }) => [
        ...items,
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: currentInstructions }],
        },
      ],
    });
    await using session = await agent.session();
    const indices: number[] = [];
    const turn = await session.submit('Continue.', {
      beforeStep: ({ stepIndex }) => {
        indices.push(stepIndex);
        return selected;
      },
    });
    expect((await turn.wait()).finalOutput).toBe('done');
    expect(effects).toEqual(['a', 'b']);
    expect(indices).toEqual([0, 1, 2]);
    if (transport !== 'chat')
      for (const request of server.requests) {
        recordInstructions(request.input);
        const tools: { name: string }[] = [];
        const add = (values: unknown) => {
          if (Array.isArray(values))
            for (const value of values) {
              if (value.type === 'namespace') add(value.tools);
              else if (value.type === 'function' || value.type === 'custom')
                tools.push(value);
            }
        };
        add(request.tools);
        if (Array.isArray(request.input))
          for (const item of request.input)
            if (
              item !== null &&
              typeof item === 'object' &&
              !Array.isArray(item) &&
              item.type === 'additional_tools'
            )
              add(item.tools);
        seen.push(tools.map((x) => x.name));
      }
    expect(seen).toEqual([['a'], ['b'], []]);
    expect(instructionSamples).toEqual([
      'LIVE_INITIAL',
      'LIVE_UPDATED',
      'LIVE_UPDATED',
    ]);
    expect(agent.instructions).toBe(
      'Follow the application policy supplied for this request.',
    );
    expect(agent.tools).toEqual([a, b]);
    const saved = await session.saveState();
    expect(JSON.stringify(saved)).toContain(
      'Follow the application policy supplied for this request.',
    );
    expect(JSON.stringify(saved)).not.toContain('LIVE_INITIAL');
    expect(JSON.stringify(saved)).not.toContain('LIVE_UPDATED');
    if (transport === 'chat') expect(server.requests).toEqual([]);
    else server.assertExhausted();
  },
);

it('has been rejecting a newly created unadmitted callback before later sampling', async () => {
  const effects: string[] = [];
  let selected: readonly FunctionTool[] = [];
  const unadmitted = tool({
    name: 'new_callback',
    parameters: z.object({}),
    execute: () => {
      effects.push('unadmitted');
      return 'unsafe';
    },
  });
  const admitted = tool({
    name: 'change',
    parameters: z.object({}),
    execute: () => {
      effects.push('admitted');
      selected = [unadmitted];
      return 'changed';
    },
  });
  selected = [admitted];
  const server = new ModelServer([
    [call('change', {}, { callId: 'change-1' })],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as JsonObject)
      .base_url as string,
    apiKey: 'fixture',
    supportsWebsockets: false,
  });
  await using session = await new Agent({
    provider,
    model: 'gpt-5.6-sol',
    instructions: 'Keep original registration.',
    tools: [admitted],
  }).session();
  const turn = await session.submit('Continue.', {
    beforeStep: () => selected,
  });
  await expect(turn.wait()).rejects.toThrow('not admitted');
  expect(effects).toEqual(['admitted']);
  expect(server.requests).toHaveLength(1);
  server.assertExhausted();
});
