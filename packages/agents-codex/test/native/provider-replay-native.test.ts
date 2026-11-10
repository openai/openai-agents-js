import { expect, it } from 'vitest';
import { z } from 'zod';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { Agent, AiSdkModel, NativeProvider, ToolOutput, tool } from '../../src';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const image = `data:image/png;base64,${png}`;
const versions = ['v2', 'v3', 'v4'] as const;

it('normalizes empty raw Responses object arguments through the native tool loop', async () => {
  let requests = 0;
  let effects = 0;
  const openai = createOpenAI({
    apiKey: 'synthetic',
    fetch: async () => {
      requests++;
      return new Response(
        JSON.stringify({
          id: `resp_${requests}`,
          object: 'response',
          status: 'completed',
          created_at: 0,
          model: 'gpt-4.1',
          output:
            requests === 1
              ? [
                  {
                    type: 'function_call',
                    id: 'fc_empty',
                    call_id: 'empty-call',
                    name: 'lookup',
                    arguments: '',
                    status: 'completed',
                  },
                ]
              : [
                  {
                    type: 'message',
                    id: 'msg_done',
                    role: 'assistant',
                    status: 'completed',
                    content: [
                      {
                        type: 'output_text',
                        text: 'completed',
                        annotations: [],
                      },
                    ],
                  },
                ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const lookup = tool({
    name: 'lookup',
    parameters: z.object({}),
    execute() {
      effects++;
      return 'found';
    },
  });
  await using provider = new NativeProvider({
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'synthetic',
    modelBackend: new AiSdkModel(openai.responses('gpt-4.1')),
  });
  await using session = await new Agent({
    model: 'gpt-4.1',
    instructions: 'Use lookup.',
    tools: [lookup],
    provider,
  }).session();
  expect((await (await session.submit('Look it up.')).wait()).finalOutput).toBe(
    'completed',
  );
  expect(effects).toBe(1);
  expect(requests).toBe(2);
});

it.each(versions)(
  'replays an image tool result through native %s continuation',
  async (specificationVersion) => {
    let effects = 0;
    const requests: any[] = [];
    const backend = new AiSdkModel({
      specificationVersion,
      modelId: 'fixture',
      provider: 'fixture.messages',
      doGenerate(options) {
        requests.push(options);
        if (requests.length === 1)
          return {
            finishReason: 'tool-calls',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'image-call',
                toolName: 'paint',
                input: '{}',
              },
            ],
          };
        const output = options.prompt.find(
          (message: any) => message.role === 'tool',
        ).content[0].output;
        expect(output).toEqual({
          type: 'content',
          value: [
            specificationVersion === 'v4'
              ? {
                  type: 'file',
                  mediaType: 'image/png',
                  data: { type: 'data', data: png },
                }
              : {
                  type: specificationVersion === 'v3' ? 'image-data' : 'media',
                  mediaType: 'image/png',
                  data: png,
                },
          ],
        });
        return {
          finishReason: 'stop',
          content: [{ type: 'text', text: 'image received' }],
        };
      },
    });
    const paint = tool({
      name: 'paint',
      parameters: z.object({}),
      execute() {
        effects++;
        return ToolOutput.image(image);
      },
    });
    await using provider = new NativeProvider({
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'synthetic',
      modelBackend: backend,
    });
    await using session = await new Agent({
      model: 'gpt-4.1',
      instructions: 'Use paint.',
      tools: [paint],
      provider,
    }).session();
    const turn = await session.submit('Draw an image.');
    const result = await turn.wait().catch((error) => {
      throw new Error(
        `Image replay failed after ${effects} effects and ${requests.length} provider requests`,
        { cause: error },
      );
    });
    expect(result.finalOutput).toBe('image received');
    expect(effects).toBe(1);
    expect(requests).toHaveLength(2);
  },
);

it('replays an image tool result through the actual Anthropic provider wire', async () => {
  const requests: any[] = [];
  let effects = 0;
  const anthropic = createAnthropic({
    apiKey: 'synthetic',
    fetch: async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      requests.push(body);
      if (requests.length === 2) {
        const message = body.messages.find((entry: any) =>
          entry.content?.some((part: any) => part.type === 'tool_result'),
        );
        expect(message.content[0].content).toEqual([
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: png },
          },
        ]);
      }
      return new Response(
        JSON.stringify({
          id: `msg_${requests.length}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content:
            requests.length === 1
              ? [
                  {
                    type: 'tool_use',
                    id: 'image-call',
                    name: 'paint',
                    input: {},
                  },
                ]
              : [{ type: 'text', text: 'image received' }],
          stop_reason: requests.length === 1 ? 'tool_use' : 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const backend = new AiSdkModel(anthropic('claude-sonnet-4-6'));
  const paint = tool({
    name: 'paint',
    parameters: z.object({}),
    execute() {
      effects++;
      return ToolOutput.image(image);
    },
  });
  await using provider = new NativeProvider({
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'synthetic',
    modelBackend: backend,
  });
  await using session = await new Agent({
    model: 'gpt-4.1',
    instructions: 'Use paint.',
    tools: [paint],
    provider,
  }).session();
  const result = await (await session.submit('Draw an image.')).wait();
  expect(result.finalOutput).toBe('image received');
  expect(effects).toBe(1);
  expect(requests).toHaveLength(2);
});

it.each(
  versions.flatMap((specificationVersion) => [
    { specificationVersion, input: '' as string | undefined, label: 'empty' },
    {
      specificationVersion,
      input: undefined as string | undefined,
      label: 'omitted',
    },
  ]),
)(
  'normalizes $specificationVersion $label object arguments before native dispatch',
  async ({ specificationVersion, input }) => {
    let requests = 0;
    let effects = 0;
    const backend = new AiSdkModel({
      specificationVersion,
      modelId: 'fixture',
      provider: 'fixture.messages',
      doGenerate() {
        requests++;
        return requests === 1
          ? {
              finishReason: 'tool-calls',
              content: [
                {
                  type: 'tool-call',
                  toolCallId: 'empty-call',
                  toolName: 'lookup',
                  ...(input === undefined ? {} : { input }),
                },
              ],
            }
          : {
              finishReason: 'stop',
              content: [{ type: 'text', text: 'completed' }],
            };
      },
    });
    const lookup = tool({
      name: 'lookup',
      parameters: z.object({}),
      execute() {
        effects++;
        return 'found';
      },
    });
    await using provider = new NativeProvider({
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'synthetic',
      modelBackend: backend,
    });
    await using session = await new Agent({
      model: 'gpt-4.1',
      instructions: 'Use lookup.',
      tools: [lookup],
      provider,
    }).session();
    const result = await (await session.submit('Look it up.')).wait();
    expect(result.finalOutput).toBe('completed');
    expect(effects).toBe(1);
    expect(requests).toBe(2);
  },
);
