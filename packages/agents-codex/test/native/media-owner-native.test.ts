import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeProvider,
  ToolOutput,
  fileSessionStore,
  parseSessionState,
  tool,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
import { syntheticAppsCredentials } from './fixtures/chatgpt-apps';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(async () => {
  await ModelServer.closeAll();
});

async function providerFor(server: ModelServer, apps = false) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-media-model-key',
    supportsWebsockets: false,
    ...(apps ? { chatGPT: syntheticAppsCredentials() } : {}),
  });
}

it('keeps API-key file admission separate from configured personal Apps credentials', async () => {
  const server = new ModelServer([[message('file accepted')]]);
  await using provider = await providerFor(server, true);
  const agent = new Agent({
    instructions: 'Read the reference.',
    model: 'gpt-5.5',
    provider,
  });
  const content = [
    { type: 'input_file' as const, file_id: 'opaque-apps-coexistence' },
  ];
  expect((await agent.run({ role: 'user', content })).finalOutput).toBe(
    'file accepted',
  );
  expect(server.requests[0].input).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ role: 'user', content }),
    ]),
  );
  expect(server.requestHeaders[0].authorization).toBe(
    'Bearer synthetic-media-model-key',
  );
  expect(server.requestHeaders[0]['chatgpt-account-id']).toBeUndefined();
  expect(JSON.stringify(server.requests)).not.toContain(
    syntheticAppsCredentials().accessToken,
  );
  server.assertExhausted();
}, 30_000);

it('reopens canonical file history without replaying its accepted tool effect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-media-reopen-'));
  try {
    const server = new ModelServer([
      [call('reference', {}, { callId: 'persisted-reference' })],
      [message('saved')],
      [message('reopened')],
    ]);
    await using provider = await providerFor(server);
    const effects: string[] = [];
    const output = [
      {
        type: 'input_file',
        file_id: 'opaque-persisted-tool',
        filename: 'tool.pdf',
      },
    ];
    const agent = new Agent({
      instructions: 'Use reference once.',
      model: 'gpt-5.5',
      provider,
      tools: [
        tool({
          name: 'reference',
          parameters: z.object({}),
          execute: () => {
            effects.push('accepted');
            return ToolOutput.file({
              file_id: 'opaque-persisted-tool',
              filename: 'tool.pdf',
            });
          },
        }),
      ],
    });
    const content = [
      {
        type: 'input_image' as const,
        file_id: 'opaque-persisted-image',
        detail: 'low' as const,
      },
      {
        type: 'input_file' as const,
        file_url: 'https://files.invalid/persisted.pdf',
        filename: 'user.pdf',
      },
    ];
    let id: string;
    {
      await using session = await agent.session({
        storage: fileSessionStore(directory),
      });
      id = session.id;
      expect(
        (await (await session.submit({ role: 'user', content })).wait())
          .finalOutput,
      ).toBe('saved');
    }
    {
      await using reopened = await agent.session({
        storage: fileSessionStore(directory),
        resume: id,
      });
      const items = await Array.fromAsync(reopened.items());
      expect(items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'user', content }),
          expect.objectContaining({ type: 'function_call_output', output }),
        ]),
      );
      expect(
        (
          await (
            await reopened.submit('Continue without repeating reference.')
          ).wait()
        ).finalOutput,
      ).toBe('reopened');
      expect(server.requests[2].input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'function_call_output',
            call_id: 'persisted-reference',
            output,
          }),
        ]),
      );
    }
    expect(effects).toEqual(['accepted']);
    server.assertExhausted();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it('retains child media input and tool output in its live history and portable graph', async () => {
  const executor = await startPublicExecutor();
  try {
    let rootId: string | undefined;
    let rootRequests = 0;
    let childRequests = 0;
    const respond = (request: Record<string, any>) => {
      const id = JSON.parse(request.client_metadata['x-codex-turn-metadata'])
        .thread_id as string;
      rootId ??= id;
      if (id === rootId) {
        rootRequests++;
        return rootRequests === 1
          ? [
              call(
                'spawn_agent',
                { task_name: 'media', message: 'Say ready.' },
                { namespace: 'collaboration', callId: 'spawn-media' },
              ),
            ]
          : [message('root ready')];
      }
      childRequests++;
      if (childRequests === 1) return [message('child ready')];
      return childRequests === 2
        ? [call('reference', {}, { callId: 'child-reference' })]
        : [message('child accepted')];
    };
    const server = new ModelServer(Array.from({ length: 5 }, () => respond));
    await using provider = await providerFor(server);
    const effects: string[] = [];
    const agent = new Agent({
      instructions: 'Delegate.',
      model: 'gpt-5.5',
      provider,
      tools: [
        new NativeAgents(),
        tool({
          name: 'reference',
          parameters: z.object({}),
          execute: () => {
            effects.push('child');
            return ToolOutput.file({
              file_id: 'opaque-child-output',
              filename: 'child.pdf',
            });
          },
        }),
      ],
    });
    await using session = await agent.session({
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
      }),
    });
    expect((await (await session.submit('Delegate.')).wait()).finalOutput).toBe(
      'root ready',
    );
    const children = await Array.fromAsync(session.subagents());
    expect(children).toHaveLength(1);
    const child = children[0];
    expect((await child.turn!.wait()).finalOutput).toBe('child ready');
    const content = [
      {
        type: 'input_image' as const,
        file_id: 'opaque-child-image',
        detail: 'low' as const,
      },
      {
        type: 'input_file' as const,
        file_id: 'opaque-child-input',
        filename: 'input.pdf',
      },
    ];
    expect(
      (await (await child.submit({ role: 'user', content })).wait())
        .finalOutput,
    ).toBe('child accepted');
    const output = [
      {
        type: 'input_file',
        file_id: 'opaque-child-output',
        filename: 'child.pdf',
      },
    ];
    expect(
      await Array.fromAsync(session.items({ subagentId: child.id })),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content }),
        expect.objectContaining({ type: 'function_call_output', output }),
      ]),
    );
    expect(server.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          input: expect.arrayContaining([
            expect.objectContaining({ role: 'user', content }),
          ]),
        }),
        expect.objectContaining({
          input: expect.arrayContaining([
            expect.objectContaining({
              type: 'function_call_output',
              call_id: 'child-reference',
              output,
            }),
          ]),
        }),
      ]),
    );
    const captured = parseSessionState(
      JSON.stringify(await session.saveState()),
    );
    expect(JSON.stringify(captured)).toContain('opaque-child-input');
    expect(JSON.stringify(captured)).toContain('opaque-child-output');
    expect(effects).toEqual(['child']);
    expect(rootRequests).toBe(2);
    expect(childRequests).toBe(3);
    server.assertExhausted();
  } finally {
    await executor.close();
  }
}, 30_000);

it.each(['user', 'seed'] as const)(
  'rejects inline Low in the known detail-based %s format before any model request',
  async (opening) => {
    const server = new ModelServer([]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Observe the text.',
      model: 'gpt-5',
      provider,
    });
    const image =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
    const input = {
      role: 'user' as const,
      content: [
        {
          type: 'input_image' as const,
          image_url: image,
          detail: 'low' as const,
        },
      ],
    };
    if (opening === 'seed')
      await expect(agent.session({ initialMessages: [input] })).rejects.toThrow(
        /detail 'low' is not supported/,
      );
    else
      await expect(agent.run(input)).rejects.toThrow(
        /detail 'low' is not supported/,
      );
    expect(server.requests).toEqual([]);
  },
  30_000,
);

it('emits a delayed code-mode file through the existing file primitive and retains it on restore without replay', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = new ModelServer([
    [
      {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'file-cell',
        input:
          'for (const part of await tools.reference({})) { if (part.type === "input_file") { const {type, ...source} = part; file(source); } else if (part.type === "input_text") { text(part.text); } }',
      },
    ],
    [message('cell complete')],
    [message('cell restored')],
  ]);
  await using provider = await providerFor(server);
  const routes: string[] = [];
  const agent = new Agent({
    instructions: 'Use reference from code once.',
    model: 'gpt-5.5',
    provider,
    programmaticToolCalling: true,
    tools: [
      tool({
        name: 'reference',
        parameters: z.object({}),
        execute: async (_args, context) => {
          routes.push(context.call!.route);
          entered.resolve();
          await release.promise;
          return new ToolOutput([
            { type: 'inputText', text: 'before-file' },
            {
              type: 'inputFile',
              file_id: 'opaque-code-file',
              filename: 'code.pdf',
            },
            { type: 'inputText', text: 'after-file' },
          ]);
        },
      }),
    ],
  });
  let state;
  const expected = [
    { type: 'input_text', text: expect.stringMatching(/^Script completed\n/) },
    { type: 'input_text', text: 'before-file' },
    { type: 'input_file', file_id: 'opaque-code-file', filename: 'code.pdf' },
    { type: 'input_text', text: 'after-file' },
  ];
  {
    await using session = await agent.session();
    try {
      const result = (await session.submit('Run the cell.')).wait();
      await entered.promise;
      expect(server.requests).toHaveLength(1);
      await expect(session.saveState()).rejects.toThrow();
      release.resolve();
      expect((await result).finalOutput).toBe('cell complete');
      expect(server.requests[1].input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'custom_tool_call_output',
            call_id: 'file-cell',
            output: expected,
          }),
        ]),
      );
      state = parseSessionState(JSON.stringify(await session.saveState()));
    } finally {
      release.resolve();
    }
  }
  {
    await using restored = await agent.session({ state });
    expect(
      (
        await (
          await restored.submit('Continue without repeating the cell.')
        ).wait()
      ).finalOutput,
    ).toBe('cell restored');
    expect(server.requests[2].input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'custom_tool_call_output',
          call_id: 'file-cell',
          output: expected,
        }),
      ]),
    );
  }
  expect(routes).toEqual(['code']);
  server.assertExhausted();
}, 30_000);
