import {
  Agent,
  Runner,
  RunState,
  UserError,
  handoff,
  tool,
  webSearchTool,
  type HandoffInputData,
} from '@openai/agents';
import { removeAllTools } from '@openai/agents-core/extensions';
import { CodexProvider } from '../../../src/experimental/codex';
import { beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';

const boundary = vi.hoisted(() => ({ open: vi.fn() }));

// Runner and the provider stay real; only the stock CLI process is replaced.
vi.mock('../../../src/experimental/codex/appServer', () => ({
  openCodexAppServer: boundary.open,
}));

type Event = { method: string; params: Record<string, unknown>; id?: number };
const localImage =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6uGQAAAAASUVORK5CYII=';

function agentMessage(
  text: string,
  phase: 'commentary' | 'final_answer',
): Event {
  return {
    method: 'item/completed',
    params: {
      threadId: 'thread',
      turnId: 'turn',
      item: { type: 'agentMessage', id: 'message', text, phase },
    },
  };
}

function completed(text: string): Event[] {
  return [
    agentMessage(text, 'final_answer'),
    {
      method: 'turn/completed',
      params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } },
    },
  ];
}

function callback(toolName: string, namespace: string | null = null): Event[] {
  return [
    {
      id: 7,
      method: 'item/tool/call',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        callId: 'sdk-call',
        namespace,
        tool: toolName,
        arguments: {},
      },
    },
    {
      method: 'turn/completed',
      params: {
        threadId: 'thread',
        turn: { id: 'turn', status: 'interrupted' },
      },
    },
  ];
}

function server(events: Event[] | AsyncIterable<Event>) {
  const connection = {
    request: vi.fn(async (method: string, _params?: unknown) => {
      if (method === 'thread/start') return { thread: { id: 'thread' } };
      if (method === 'turn/start') return { turn: { id: 'turn' } };
      return {};
    }),
    notify: vi.fn(),
    close: vi.fn(async () => {}),
    events: Array.isArray(events)
      ? (async function* () {
          yield* events;
        })()
      : events,
  };
  boundary.open.mockResolvedValueOnce(connection);
  return connection;
}

function runner() {
  return new Runner({
    modelProvider: new CodexProvider(),
    tracingDisabled: true,
  });
}

beforeEach(() => {
  boundary.open.mockReset();
});

test('parses structured output and forwards separate consecutive text and local-image user messages', async () => {
  const connection = server(completed('{"label":"diagram"}'));
  const image = localImage;
  const agent = new Agent({
    name: 'assistant',
    instructions: 'Describe the image.',
    outputType: z.object({ label: z.string() }),
  });

  const result = await runner().run(agent, [
    { role: 'user', content: 'Describe this image.' },
    { role: 'user', content: [{ type: 'input_image', image }] },
  ]);

  expect(result.finalOutput).toEqual({ label: 'diagram' });
  expect(connection.request).toHaveBeenCalledWith(
    'initialize',
    expect.objectContaining({
      capabilities: expect.objectContaining({ experimentalApi: true }),
    }),
  );
  expect(connection.notify).toHaveBeenCalledWith('initialized');
  expect(connection.request).toHaveBeenCalledWith(
    'thread/start',
    expect.objectContaining({ ephemeral: true }),
  );
  expect(connection.request).toHaveBeenCalledWith(
    'turn/start',
    expect.objectContaining({
      input: [
        expect.objectContaining({ type: 'text', text: 'Describe this image.' }),
        { type: 'image', url: image },
      ],
      outputSchema: expect.objectContaining({
        type: 'object',
        properties: { label: { type: 'string' } },
      }),
    }),
  );
  expect(connection.close).toHaveBeenCalledOnce();
});

test('delivers text deltas before completion without repeating final text and records usage', async () => {
  let release!: () => void;
  let finished = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const connection = server(
    (async function* () {
      yield {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread',
          turnId: 'turn',
          itemId: 'message',
          delta: 'Hello ',
        },
      };
      await gate;
      yield {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread',
          turnId: 'turn',
          itemId: 'message',
          delta: 'world.',
        },
      };
      yield {
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'thread',
          turnId: 'turn',
          tokenUsage: {
            total: {
              inputTokens: 17,
              cachedInputTokens: 3,
              cacheWriteInputTokens: 2,
              outputTokens: 12,
              reasoningOutputTokens: 4,
              totalTokens: 29,
            },
          },
        },
      };
      finished = true;
      yield* completed('Hello world.');
    })(),
  );
  const result = await runner().run(
    new Agent({ name: 'assistant' }),
    'Hello.',
    { stream: true },
  );
  const deltas: string[] = [];
  for await (const event of result) {
    if (
      event.type === 'raw_model_stream_event' &&
      event.data.type === 'output_text_delta'
    ) {
      deltas.push(event.data.delta);
      if (deltas.length === 1) {
        expect(finished).toBe(false);
        release();
      }
    }
  }
  expect(deltas).toEqual(['Hello ', 'world.']);
  expect(result.finalOutput).toBe('Hello world.');
  expect(result.state.usage).toMatchObject({
    inputTokens: 17,
    outputTokens: 12,
    totalTokens: 29,
    inputTokensDetails: [{ cached_tokens: 3, cache_write_tokens: 2 }],
    outputTokensDetails: [{ reasoning_tokens: 4 }],
  });
  expect(connection.close).toHaveBeenCalledOnce();
});

test('lets Runner execute a function tool and replays its exact call ID into a fresh thread', async () => {
  const first = server([
    agentMessage('I will look up the account.', 'commentary'),
    ...callback('lookup'),
  ]);
  const second = server(completed('Account found.'));
  const execute = vi.fn(async () => 'account-42');
  const lookup = tool({
    name: 'lookup',
    description: 'Find an account.',
    parameters: z.object({}),
    execute,
  });
  const agent = new Agent({ name: 'assistant', tools: [lookup] });

  const result = await runner().run(agent, [
    { role: 'user', content: 'Find my account.' },
    { role: 'user', content: [{ type: 'input_image', image: localImage }] },
  ]);

  expect(result.finalOutput).toBe('Account found.');
  expect(result.newItems.map((item) => item.rawItem)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', phase: 'commentary' }),
      expect.objectContaining({ role: 'assistant', phase: 'final_answer' }),
    ]),
  );
  expect(execute).toHaveBeenCalledOnce();
  expect(first.request).toHaveBeenCalledWith(
    'thread/start',
    expect.objectContaining({
      dynamicTools: [
        expect.objectContaining({
          type: 'function',
          name: 'lookup',
          inputSchema: expect.objectContaining({ type: 'object' }),
        }),
      ],
    }),
  );
  expect(first.request).toHaveBeenCalledWith('turn/interrupt', {
    threadId: 'thread',
    turnId: 'turn',
  });
  expect(first.close).toHaveBeenCalledOnce();
  expect(second.request).toHaveBeenCalledWith(
    'thread/inject_items',
    expect.objectContaining({
      items: expect.arrayContaining([
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', image_url: localImage }],
        },
        expect.objectContaining({
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          content: [
            { type: 'output_text', text: 'I will look up the account.' },
          ],
        }),
        expect.objectContaining({
          type: 'function_call',
          call_id: 'sdk-call',
          name: 'lookup',
          arguments: '{}',
        }),
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'sdk-call',
          output: [{ type: 'input_text', text: 'account-42' }],
        }),
      ]),
    }),
  );
  expect(second.close).toHaveBeenCalledOnce();
  expect(boundary.open).toHaveBeenCalledTimes(2);
});

test('closes the transport while SDK approval is pending and resumes serialized RunState', async () => {
  const first = server(callback('approve_lookup'));
  const execute = vi.fn(async () => 'approved account');
  const lookup = tool({
    name: 'approve_lookup',
    description: 'Find an account after approval.',
    parameters: z.object({}),
    needsApproval: true,
    execute,
  });
  const agent = new Agent({ name: 'assistant', tools: [lookup] });
  const sdkRunner = runner();

  const pending = await sdkRunner.run(agent, 'Find my account.');
  expect(pending.interruptions).toHaveLength(1);
  expect(execute).not.toHaveBeenCalled();
  expect(first.close).toHaveBeenCalledOnce();
  const restored = await RunState.fromString(agent, pending.state.toString());
  restored.approve(restored.getInterruptions()[0]!);
  const second = server(completed('Approved.'));
  const result = await sdkRunner.run(agent, restored);

  expect(result.finalOutput).toBe('Approved.');
  expect(execute).toHaveBeenCalledOnce();
  expect(second.close).toHaveBeenCalledOnce();
  expect(boundary.open).toHaveBeenCalledTimes(2);
});

test('lets Runner apply handoff filters and target instructions', async () => {
  const first = server([
    agentMessage('I will transfer this request.', 'commentary'),
    ...callback('transfer_to_specialist'),
  ]);
  const second = server(completed('Specialist answer.'));
  const specialist = new Agent({
    name: 'specialist',
    instructions: 'Answer as the specialist.',
  });
  const filter = vi.fn((data: HandoffInputData) =>
    removeAllTools({ ...data, inputHistory: 'Filtered task.' }),
  );
  const agent = new Agent({
    name: 'assistant',
    instructions: 'Route the request.',
    handoffs: [handoff(specialist, { inputFilter: filter })],
  });

  const result = await runner().run(agent, 'Private original task.');

  expect(result.finalOutput).toBe('Specialist answer.');
  expect(result.lastAgent).toBe(specialist);
  expect(filter).toHaveBeenCalledOnce();
  expect(second.request).toHaveBeenCalledWith(
    'thread/start',
    expect.objectContaining({
      developerInstructions: 'Answer as the specialist.',
    }),
  );
  const replay = second.request.mock.calls.find(
    ([method]) => method === 'thread/inject_items',
  );
  expect(JSON.stringify(replay)).toContain('Filtered task.');
  expect(JSON.stringify(replay)).not.toContain('Private original task.');
  expect(JSON.stringify(replay)).not.toContain('transfer_to_specialist');
  expect(second.request).toHaveBeenCalledWith(
    'turn/start',
    expect.objectContaining({ input: [] }),
  );
  expect(first.close).toHaveBeenCalledOnce();
  expect(second.close).toHaveBeenCalledOnce();
});

test('rejects Responses IDs and hosted tools before opening the CLI', async () => {
  const sdkRunner = runner();
  await expect(
    sdkRunner.run(new Agent({ name: 'assistant' }), 'Continue.', {
      previousResponseId: 'resp_123',
    }),
  ).rejects.toThrow(UserError);
  await expect(
    sdkRunner.run(
      new Agent({ name: 'assistant', tools: [webSearchTool()] }),
      'Search.',
    ),
  ).rejects.toThrow(UserError);
  expect(boundary.open).not.toHaveBeenCalled();
});

test.each([
  ['unconfigured tool', 'unknown', null],
  ['mismatched namespace', 'lookup', 'unconfigured'],
])(
  'rejects a callback for %s without executing SDK tools',
  async (_label, name, namespace) => {
    const connection = server(callback(name!, namespace));
    const execute = vi.fn(async () => 'account');
    const agent = new Agent({
      name: 'assistant',
      tools: [
        tool({
          name: 'lookup',
          description: 'Find account.',
          parameters: z.object({}),
          execute,
        }),
      ],
    });
    await expect(runner().run(agent, 'Find account.')).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalledOnce();
  },
);
