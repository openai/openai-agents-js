import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  codeInterpreter,
  fileSearch,
  hostedTool,
  hostedMcp,
  toolSearch,
  toolRef,
  parseSessionState,
  tool,
} from '../../src';
import { ModelServer, message, call } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-hosted-choice',
    supportsWebsockets: false,
  });
}

it('leaves prompt-cache defaults omitted and clears mode independently of TTL', async () => {
  const server = new ModelServer(
    Array.from({ length: 3 }, () => [message('done')]),
  );
  await using provider = await providerFor(server);
  const agent = new Agent({
    provider,
    model: 'fixture-cache-controls',
    instructions: 'Use the captured cache settings.',
  });
  await using session = await agent.session();
  await (await session.submit('Provider default.')).wait();
  await session.update({
    modelSettings: { promptCacheMode: 'explicit', promptCacheTtl: '30m' },
  });
  await (await session.submit('Explicit cache.')).wait();
  await session.update({ modelSettings: { promptCacheMode: null } });
  await (await session.submit('Retain the TTL.')).wait();
  expect(
    server.requests.map((request) => request.prompt_cache_options),
  ).toEqual([undefined, { mode: 'explicit', ttl: '30m' }, { ttl: '30m' }]);
  server.assertExhausted();
});

it('projects a captured hosted selector and clears it with the current literal setting', async () => {
  const server = new ModelServer(
    Array.from({ length: 4 }, () => [message('done')]),
  );
  await using provider = await providerFor(server);
  const agent = new Agent({
    provider,
    model: 'fixture-hosted-choice',
    instructions: 'Inspect the synthetic store.',
    tools: [fileSearch(['vs_fixture'])],
    modelSettings: { toolChoice: { type: 'file_search' } },
  });
  const session = await agent.session();
  await (await session.submit('Choose the hosted tool.')).wait();
  expect(server.requests[0]?.tool_choice).toEqual({ type: 'file_search' });
  expect(server.requests[0]?.tools).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'file_search',
        vector_store_ids: ['vs_fixture'],
      }),
    ]),
  );
  const saved = parseSessionState(JSON.stringify(await session.saveState()));
  await session.update({ modelSettings: { toolChoice: 'auto' } });
  await (await session.submit('Use ordinary choice.')).wait();
  expect(server.requests[1]?.tool_choice).toBe('auto');
  await session.close();
  {
    await using restored = await agent.session({ state: saved });
    await (await restored.submit('Restore the captured selector.')).wait();
  }
  {
    await using restored = await agent.session({
      state: saved,
    });
    await restored.update({ modelSettings: { toolChoice: 'auto' } });
    await (await restored.submit('Use the current explicit override.')).wait();
  }
  expect(server.requests.map((request) => request.tool_choice)).toEqual([
    { type: 'file_search' },
    'auto',
    { type: 'file_search' },
    'auto',
  ]);
  server.assertExhausted();
});

it('cannot turn a same-name captured function into a hosted declaration', async () => {
  let effects = 0;
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    provider,
    model: 'fixture-hosted-choice',
    instructions: 'Inspect.',
    tools: [
      tool({
        name: 'file_search',
        parameters: z.object({}),
        execute: () => {
          effects++;
          return 'function';
        },
      }),
    ],
    modelSettings: { toolChoice: { type: 'file_search' } },
  }).session();
  await expect((await session.submit('Choose.')).wait()).rejects.toThrow(
    /hosted.*catalog/i,
  );
  expect(server.requests).toHaveLength(0);
  expect(effects).toBe(0);
});

it('clears only the invocation preference and preserves the captured default', async () => {
  const server = new ModelServer([[message('ordinary')], [message('default')]]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    provider,
    model: 'fixture-hosted-choice',
    instructions: 'Inspect.',
    tools: [fileSearch(['vs_fixture'])],
    modelSettings: { toolChoice: { type: 'file_search' } },
  });
  await using session = await agent.session();
  await (
    await session.submit('Use an invocation override.', {
      modelSettingsOverride: { toolChoice: 'auto' },
    })
  ).wait();
  await (await session.submit('Use the captured default.')).wait();
  expect(server.requests.map((request) => request.tool_choice)).toEqual([
    'auto',
    { type: 'file_search' },
  ]);
  server.assertExhausted();
});

it('switches a hosted preference to the captured function', async () => {
  let effects = 0;
  const server = new ModelServer([
    [message('initial')],
    [call('lookup', {}, { callId: 'choice-lookup' })],
    [message('done')],
  ]);
  await using provider = await providerFor(server);
  const lookup = tool({
    name: 'lookup',
    parameters: z.object({}),
    execute: () => {
      effects++;
      return 'found';
    },
  });
  await using session = await new Agent({
    provider,
    model: 'fixture-hosted-choice',
    instructions: 'Inspect.',
    tools: [fileSearch(['vs_fixture']), lookup],
    modelSettings: { toolChoice: { type: 'file_search' } },
  }).session();
  await (await session.submit('Start.')).wait();
  await session.update({ modelSettings: { toolChoice: toolRef('lookup') } });
  await (await session.submit('Use lookup.')).wait();
  expect(server.requests[1]?.tool_choice).toBe('required');
  expect(effects).toBe(1);
});

it.each(['auto', 'none'] as const)(
  'clears hosted forcing from a managed profile with %s',
  async (mode) => {
    const server = new ModelServer([
      [message('initial')],
      [message('updated')],
    ]);
    await using provider = await providerFor(server);
    const worker = new Agent({
      name: 'Worker',
      tools: [fileSearch(['vs_fixture'])],
      provider,
      model: 'fixture-hosted-choice',
      instructions: 'Work.',
    });
    await using session = await new Agent({
      name: 'Root',
      provider,
      model: 'fixture-hosted-choice',
      instructions: 'Inspect.',
      tools: [fileSearch(['vs_fixture'])],
      handoffs: [worker],
      modelSettings: { toolChoice: { type: 'file_search' } },
    }).session();
    await (await session.submit('Start.')).wait();
    await session.update({ modelSettings: { toolChoice: mode } });
    await (await session.submit('Use the current mode.')).wait();
    expect(server.requests[1]?.tool_choice).toBe(mode);
  },
);

it('selects a named MCP tool when its declaration omits an allowed name list', async () => {
  const server = new ModelServer([[message('done')]]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    provider,
    model: 'fixture-hosted-choice',
    instructions: 'Inspect.',
    tools: [
      hostedMcp({
        serverLabel: 'docs',
        serverUrl: 'https://docs.invalid/mcp',
        requireApproval: 'never',
      }),
    ],
    modelSettings: {
      toolChoice: { type: 'mcp', serverLabel: 'docs', name: 'lookup' },
    },
  }).session();
  await (await session.submit('Choose lookup.')).wait();
  expect(server.requests[0]?.tool_choice).toEqual({
    type: 'mcp',
    server_label: 'docs',
    name: 'lookup',
  });
  expect(server.requests[0]?.tools).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'mcp', server_label: 'docs' }),
    ]),
  );
});

it.each([true, false])(
  'forces a provider-owned programmatic declaration only when offered (%s)',
  async (declared) => {
    const server = new ModelServer([[message('provider completed')]]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Use the configured provider declaration.',
      tools: [
        codeInterpreter({
          container: 'cntr_fixture',
          allowedCallers: ['programmatic'],
        }),
        ...(declared
          ? [hostedTool({ type: 'programmatic_tool_calling' })]
          : []),
      ],
      modelSettings: { toolChoice: { type: 'programmatic_tool_calling' } },
    });
    if (!declared) {
      await expect(agent.run('Inspect the synthetic program.')).rejects.toThrow(
        /outside the final offered catalog/,
      );
      expect(server.requests).toHaveLength(0);
      return;
    }
    expect(
      (await agent.run('Inspect the synthetic program.')).finalOutput,
    ).toBe('provider completed');
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.tool_choice).toEqual({
      type: 'programmatic_tool_calling',
    });
    expect(server.requests[0]?.tools).toEqual(
      expect.arrayContaining([
        { type: 'programmatic_tool_calling' },
        {
          type: 'code_interpreter',
          container: 'cntr_fixture',
          allowed_callers: ['programmatic'],
        },
      ]),
    );
  },
);

it.each(['absent', 'direct-only', 'search', 'programmatic-only'] as const)(
  'validates the actual programmatic tool companion (%s)',
  async (companion) => {
    const server = new ModelServer([[message('provider completed')]]);
    await using provider = await providerFor(server);
    const declaration = hostedTool({ type: 'programmatic_tool_calling' });
    const interpreter = codeInterpreter({
      container: 'cntr_fixture',
      allowedCallers:
        companion === 'direct-only' ? ['direct'] : ['programmatic'],
    });
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Use a provider tool.',
      tools:
        companion === 'absent'
          ? [declaration]
          : companion === 'search'
            ? [
                declaration,
                toolSearch({ execution: 'server' }),
                tool({
                  name: 'lookup',
                  parameters: z.object({}),
                  deferLoading: true,
                  execute: () => 'ok',
                }),
              ]
            : companion === 'direct-only'
              ? [declaration, interpreter]
              : [interpreter],
    });
    if (companion === 'search') {
      expect((await agent.run('Use the tool.')).finalOutput).toBe(
        'provider completed',
      );
      expect(server.requests).toHaveLength(1);
      return;
    }
    const expected =
      companion === 'programmatic-only'
        ? /Programmatic-only tools require a provider programmatic tool declaration/
        : /requires an offered programmatic caller or tool search/;
    await expect(agent.run('Use the tool.')).rejects.toThrow(expected);
    expect(server.requests).toHaveLength(0);
  },
);

it('replays a provider program and its result on the next native turn', async () => {
  const program = {
    type: 'program',
    id: 'program_item',
    call_id: 'program-call',
    code: 'lookup()',
    fingerprint: 'synthetic-fingerprint',
  };
  const output = {
    type: 'program_output',
    id: 'program_output_item',
    call_id: 'program-call',
    status: 'completed',
    result: 'native program result',
  };
  const server = new ModelServer([
    [program, output, message('provider completed')],
    [message('used previous program')],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Use the provider program.',
    tools: [
      codeInterpreter({
        container: 'cntr_fixture',
        allowedCallers: ['programmatic'],
      }),
      hostedTool({ type: 'programmatic_tool_calling' }),
    ],
  });
  await using session = await agent.session();
  expect(
    (await (await session.submit('Run the program.')).wait()).finalOutput,
  ).toBe('provider completed');
  expect(
    (await (await session.submit('What happened?')).wait()).finalOutput,
  ).toBe('used previous program');
  const input = server.requests[1]?.input;
  expect(Array.isArray(input)).toBe(true);
  expect(
    (input as (typeof program)[]).filter(
      (item) => item.type === 'program' || item.type === 'program_output',
    ),
  ).toEqual([program, output]);
  server.assertExhausted();
});

it.each([false, true])(
  'uses a hosted prompt program only with a prompt-owned catalog (explicit=%s)',
  async (explicit) => {
    const server = new ModelServer([
      [
        {
          type: 'program',
          id: 'program_prompt',
          call_id: 'p',
          code: 'return 1',
        },
        {
          type: 'program_output',
          id: 'program_output_prompt',
          call_id: 'p',
          status: 'completed',
          result: '1',
        },
        message('provider completed'),
      ],
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      provider,
      hostedPrompt: { id: 'pmpt_programmatic' },
      ...(explicit ? { tools: [] } : {}),
    });
    if (explicit) {
      await expect(agent.run('Use the saved prompt.')).rejects.toThrow(
        /without an offered programmatic tool/,
      );
      expect(server.requests[0]?.tools).toEqual([]);
    } else {
      expect((await agent.run('Use the saved prompt.')).finalOutput).toBe(
        'provider completed',
      );
      expect(server.requests[0]).not.toHaveProperty('tools');
    }
    expect(server.requests[0]?.prompt).toEqual({ id: 'pmpt_programmatic' });
    server.assertExhausted();
  },
);

it('does not dispatch a provider-program-owned call through a direct host function', async () => {
  let calls = 0;
  const server = new ModelServer([
    [
      {
        ...call('lookup', {}, { callId: 'direct' }),
        caller: { type: 'direct' },
      },
    ],
    [message('direct function completed')],
    [
      {
        ...call('lookup', {}, { callId: 'provider-owned' }),
        caller: { type: 'program', caller_id: 'provider-program' },
      },
      message('provider finished'),
    ],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Use the lookup function when requested.',
    tools: [
      tool({
        name: 'lookup',
        parameters: z.object({}),
        execute: () => {
          calls++;
          return 'lookup result';
        },
      }),
      toolSearch(),
      hostedTool({ type: 'programmatic_tool_calling' }),
    ],
  });

  expect((await agent.run('Use the direct function.')).finalOutput).toBe(
    'direct function completed',
  );
  expect(calls).toBe(1);
  await expect(agent.run('Observe the provider-owned call.')).rejects.toThrow();
  expect(calls).toBe(1);
  expect(server.requests).toHaveLength(3);
  server.assertExhausted();
});
