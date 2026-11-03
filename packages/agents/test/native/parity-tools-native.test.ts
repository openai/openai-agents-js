import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  ToolOutput,
  manualTool,
  tool,
  type ToolContext,
} from '@openai/agents';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

async function provider(server: ModelServer) {
  const config = await server.config();
  const selected = config['model_providers.fixture'] as { base_url: string };
  return new NativeProvider({
    baseUrl: selected.base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
}

it('passes application context, exact turn, and original versus validated arguments', async () => {
  const server = new ModelServer([
    [call('lookup', { key: ' x ' }, { callId: 'lookup-1' })],
    [message('done')],
  ]);
  const context = { records: new Map([['x', 'found']]) };
  let observed: ToolContext<typeof context> | undefined;
  const agent = new Agent<typeof context>({
    instructions: 'Use lookup.',
    model: 'gpt-5',
    provider: await provider(server),
    tools: [
      tool({
        name: 'lookup',
        parameters: z.object({
          key: z.string().trim(),
          limit: z.number().default(2),
        }),
        execute(args, call: ToolContext<typeof context>) {
          observed = call;
          expect(args).toEqual({ key: 'x', limit: 2 });
          return call.context.records.get(args.key)!;
        },
      }),
    ],
  });
  const session = await agent.session({ context });
  try {
    const turn = await session.submit('lookup x');
    const result = await turn.wait();
    expect(result.finalOutput).toBe('done');
    expect(observed?.context).toBe(context);
    expect(observed?.submission).toBe(turn);
    expect(observed?.originalArguments).toEqual({ key: ' x ' });
    expect(observed?.effectiveArguments).toEqual({ key: 'x', limit: 2 });
    expect(observed?.callId).toBe('lookup-1');
    server.assertExhausted();
  } finally {
    await session.close();
    await agent.provider.close();
  }
});

it('revokes a timed-out callback result while joining its entered work', async () => {
  const server = new ModelServer([
    [call('slow', {}, { callId: 'slow-1' })],
    [message('recovered')],
  ]);
  let release!: () => void;
  const finish = new Promise<void>((resolve) => {
    release = resolve;
  });
  let aborted!: () => void;
  const stopped = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  const agent = new Agent({
    instructions: 'Call slow.',
    model: 'gpt-5',
    provider: await provider(server),
    tools: [
      tool({
        name: 'slow',
        parameters: z.object({}),
        callbackTimeout: 0.02,
        async execute(_, context) {
          context.signal.addEventListener('abort', aborted, { once: true });
          await finish;
          return 'must not publish';
        },
      }),
    ],
  });
  const session = await agent.session();
  try {
    const turn = await session.submit('start');
    let settled = false;
    const result = turn.wait().then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await stopped;
    expect(settled).toBe(false);
    release();
    const failure = await result;
    expect(failure).toBeInstanceOf(Error);
    await expect(turn.wait()).rejects.toBe(failure);
    expect(server.requests).toHaveLength(1);
    const items = [];
    for await (const item of session.items()) items.push(item);
    expect(JSON.stringify(items)).not.toContain('must not publish');
    const next = await session.submit('continue');
    expect((await next.wait()).finalOutput).toBe('recovered');
    server.assertExhausted();
  } finally {
    release();
    await session.close();
    await agent.provider.close();
  }
});

function recordedToolText(server: ModelServer, callId: string): string {
  const items = server.requests[1].input as Array<{
    type: string;
    call_id?: string;
    output?: string | Array<{ text?: string }>;
  }>;
  const output = items.find(
    (item) => item.type === 'function_call_output' && item.call_id === callId,
  )?.output;
  expect(output).toBeDefined();
  return typeof output === 'string'
    ? output
    : output!.map((part) => part.text ?? '').join('');
}

it.each(['function', 'manual'] as const)(
  'preserves native-shaped business JSON returned by a %s tool',
  async (kind) => {
    const server = new ModelServer([
      [call('business', {}, { callId: 'business-1' })],
      [message('done')],
    ]);
    const selected = await provider(server);
    const value = {
      success: false,
      contentItems: [{ type: 'inputText' as const, text: 'business value' }],
    };
    let supplied = 0;
    const manual = manualTool({
      name: 'business',
      description: 'Get a business record',
      parameters: z.object({}),
      result: z.object({
        success: z.boolean(),
        contentItems: z.array(
          z.object({ type: z.literal('inputText'), text: z.string() }),
        ),
      }),
    });
    const agent = new Agent({
      instructions: 'Get the business record.',
      model: 'gpt-5',
      provider: selected,
      tools: [
        kind === 'manual'
          ? manual
          : tool({
              name: 'business',
              parameters: z.object({}),
              execute() {
                supplied++;
                return value;
              },
            }),
      ],
    });
    try {
      const result = await agent.run('start', {
        onInteraction(action) {
          const request = manual.match(action);
          if (!request) throw new Error('Unexpected manual request');
          supplied++;
          return request.reply(value);
        },
      });
      expect(result.finalOutput).toBe('done');
      expect(supplied).toBe(1);
      expect(JSON.parse(recordedToolText(server, 'business-1'))).toEqual(value);
      server.assertExhausted();
    } finally {
      await selected.close();
    }
  },
);

it('gives the callback its full timeout after argument validation', async () => {
  const server = new ModelServer([
    [call('lookup', {}, { callId: 'validation-1' })],
    [message('done')],
  ]);
  const selected = await provider(server);
  const stages: string[] = [];
  const agent = new Agent({
    instructions: 'Use lookup.',
    model: 'gpt-5',
    provider: selected,
    tools: [
      tool({
        name: 'lookup',
        callbackTimeout: 0.01,
        parameters: z.object({}).refine(() => {
          const end = performance.now() + 50;
          while (performance.now() < end) {
            // Model an application validator that occupies the event loop.
          }
          stages.push('validated');
          return true;
        }),
        execute() {
          stages.push('executed');
          return 'immediate result';
        },
      }),
    ],
  });
  try {
    expect((await agent.run('start')).finalOutput).toBe('done');
    expect(stages).toEqual(['validated', 'executed']);
    expect(recordedToolText(server, 'validation-1')).toBe('immediate result');
    server.assertExhausted();
  } finally {
    await selected.close();
  }
});

it('preserves explicit media tool output in history and sends supported content to the model', async () => {
  const server = new ModelServer([
    [call('media', {}, { callId: 'media-1' })],
    [message('received media')],
  ]);
  const selected = await provider(server);
  const imageUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const audioUrl =
    'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';
  let calls = 0;
  const agent = new Agent({
    instructions: 'Read the media tool result.',
    model: 'gpt-5',
    provider: selected,
    tools: [
      tool({
        name: 'media',
        parameters: z.object({}),
        execute() {
          calls++;
          return new ToolOutput([
            { type: 'inputText', text: 'media caption' },
            { type: 'inputImage', imageUrl },
            { type: 'inputAudio', audioUrl },
          ]);
        },
      }),
    ],
  });
  const session = await agent.session();
  try {
    expect((await (await session.submit('start')).wait()).finalOutput).toBe(
      'received media',
    );
    const history = [];
    for await (const item of session.items()) history.push(item);
    expect(
      history.find((item) => item.type === 'function_call_output'),
    ).toMatchObject({
      output: [
        { type: 'input_text', text: 'media caption' },
        { type: 'input_image', image_url: imageUrl, detail: 'high' },
        { type: 'input_audio', audio_url: audioUrl },
      ],
    });
    expect(calls).toBe(1);
    const input = server.requests[1].input as Array<Record<string, unknown>>;
    expect(
      input.find(
        (item) =>
          item.type === 'function_call_output' && item.call_id === 'media-1',
      )?.output,
    ).toEqual([
      { type: 'input_text', text: 'media caption' },
      { type: 'input_image', image_url: imageUrl, detail: 'high' },
      { type: 'input_text', text: expect.any(String) },
    ]);
    server.assertExhausted();
  } finally {
    await session.close();
    await selected.close();
  }
});
