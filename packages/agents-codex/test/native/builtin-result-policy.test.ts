import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  Agent,
  Environment,
  NativeProvider,
  type ExecutorContext,
  toolRef,
} from '@openai/agents';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

// Successful native effects need sandbox helpers unavailable on this host.
// Keep strict execution required in CI and cancellation coverage active locally.
const effectTest = it.skipIf(
  process.env.OPENAI_AGENTS_TEST_IN_CODEX_SANDBOX === '1' &&
    process.env.GITHUB_ACTIONS !== 'true' &&
    process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1',
);

effectTest.each(['direct', 'code_mode'] as const)(
  'replaces a %s builtin result before model, observation and history publication',
  async (route) => {
    const executor = await startPublicExecutor();
    const privateOutput = 'synthetic-private-native-output';
    // The marker exists only in the actual process output, not its command text.
    const encoded = Buffer.from(privateOutput).toString('base64');
    const command = `printf '%s' '${encoded}' | base64 -d`;
    const model = new ModelServer([
      [
        route === 'direct'
          ? call(
              'exec_command',
              { cmd: command },
              { callId: 'controlled-result' },
            )
          : {
              type: 'custom_tool_call',
              name: 'exec',
              call_id: 'controlled-cell',
              input: `text(JSON.stringify(await tools.exec_command(${JSON.stringify({ cmd: command })})));`,
            },
      ],
      (request) => {
        expect(request.tools ?? []).toEqual([]);
        expect(JSON.stringify(request)).toContain('accepted-public-output');
        expect(JSON.stringify(request)).not.toContain(privateOutput);
        return [message('complete')];
      },
    ]);
    const config = await model.config();
    const provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-result-policy',
      supportsWebsockets: false,
    });
    const calls: ExecutorContext[] = [];
    const rawResults: unknown[] = [];
    const environment = new Environment({
      url: executor.url,
      cwd: executor.cwd,
      headers: executor.headers,
      tools: ['exec_command'],
      transformResult(info, value) {
        calls.push(info);
        rawResults.push(value);
        return { output: 'accepted-public-output' };
      },
    });
    const agent = new Agent({
      instructions: 'Run the command.',
      provider,
      model: 'gpt-5',
      tools: [],
      programmaticToolCalling: route === 'code_mode',
    });
    let session: Awaited<ReturnType<typeof agent.session>> | undefined;
    try {
      session = await agent.session({ environment });
      const turn = await session.submit('Run the command.', {
        tools: [toolRef('exec_command')],
        beforeStep: ({ stepIndex }) => (stepIndex === 0 ? undefined : []),
      });
      const observations = [];
      for await (const event of turn.events()) observations.push(event);
      expect((await turn.wait()).finalOutput).toBe('complete');
      const items = [];
      for await (const item of session.items()) items.push(item);
      expect(calls).toHaveLength(1);
      expect(JSON.stringify(rawResults)).toContain(privateOutput);
      expect(calls[0]?.submission).toBe(turn);
      expect(calls[0]?.callId).toBe(
        route === 'direct' ? 'controlled-result' : null,
      );
      if (route === 'direct') expect(calls[0]?.cellId).toBeNull();
      else {
        expect(calls[0]?.outerCallId).toBe('controlled-cell');
        expect(calls[0]?.cellId).toBeTypeOf('string');
        expect(calls[0]?.runtimeToolCallId).toBeTypeOf('string');
      }
      expect(
        executor.requests.filter(
          (request) => request.method === 'process/start',
        ),
      ).toHaveLength(1);
      expect(JSON.stringify({ observations, items })).not.toContain(
        privateOutput,
      );
      expect(JSON.stringify(items)).toContain('accepted-public-output');
      model.assertExhausted();
    } finally {
      try {
        try {
          await session?.close();
        } finally {
          await provider.close();
        }
      } finally {
        await executor.close();
      }
    }
  },
  25_000,
);

it('cancels publication immediately and joins an abort-ignoring result callback', async () => {
  const executor = await startPublicExecutor();
  const model = new ModelServer([
    [
      call(
        'exec_command',
        {
          cmd: `printf '%s' '${Buffer.from('cancellation-private-output').toString('base64')}' | base64 -d`,
        },
        { callId: 'held-result' },
      ),
    ],
  ]);
  const config = await model.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-result-cancellation',
    supportsWebsockets: false,
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const environment = new Environment({
    url: executor.url,
    cwd: executor.cwd,
    headers: executor.headers,
    tools: ['exec_command'],
    async transformResult() {
      entered.resolve();
      await release.promise;
      return { output: 'late-public-value' };
    },
  });
  const agent = new Agent({
    instructions: 'Run the command.',
    provider,
    model: 'gpt-5',
  });
  let session: Awaited<ReturnType<typeof agent.session>> | undefined;
  let cancellation: Promise<void> | undefined;
  let completion: Promise<unknown> | undefined;
  try {
    session = await agent.session({ environment });
    const turn = await session.submit('Run.');
    completion = turn.wait().catch((error: unknown) => error);
    await entered.promise;
    let cancelled = false;
    cancellation = turn.cancel().then(() => {
      cancelled = true;
    });
    // Cancellation must join entered application code before releasing its owner.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(cancelled).toBe(false);
    release.resolve();
    await cancellation;
    await expect(completion).resolves.toBeInstanceOf(Error);
    expect(model.requests).toHaveLength(1);
    const observations = [];
    for await (const event of turn.events()) observations.push(event);
    expect(JSON.stringify(observations)).not.toContain(
      'cancellation-private-output',
    );
    expect(JSON.stringify(observations)).not.toContain('late-public-value');
    expect(
      executor.requests.filter((request) => request.method === 'process/start'),
    ).toHaveLength(1);
  } finally {
    // Preserve fixture cleanup even if an assertion fails while the callback waits.
    release.resolve();
    try {
      try {
        await cancellation;
        await completion;
      } finally {
        try {
          await session?.close();
        } finally {
          await provider.close();
        }
      }
    } finally {
      await executor.close();
    }
  }
}, 25_000);

effectTest('keeps the real process identity while replacing exec and stdin output', async () => {
  const executor = await startPublicExecutor();
  const privateOutput = 'synthetic-private-poll-output';
  const policies: string[] = [];
  const rawResults: unknown[] = [];
  const model = new ModelServer([
    [
      call(
        'exec_command',
        {
          cmd: 'cat private.txt; read -r line; cat private.txt',
          tty: true,
          yield_time_ms: 1000,
        },
        { callId: 'start' },
      ),
    ],
    (request) => {
      const start = (request.input as Array<Record<string, unknown>>).find(
        (item) =>
          item.type === 'function_call_output' && item.call_id === 'start',
      );
      expect(start).toBeDefined();
      const accepted = JSON.parse(String(start!.output));
      expect(
        accepted.session_id,
        JSON.stringify({ accepted, rawResults }),
      ).toBeDefined();
      return [
        call(
          'write_stdin',
          { session_id: accepted.session_id, chars: '\n', yield_time_ms: 1000 },
          { callId: 'poll' },
        ),
      ];
    },
    (request) => {
      expect(JSON.stringify(request)).toContain('accepted-poll-output');
      expect(JSON.stringify(request)).not.toContain(privateOutput);
      return [message('polled')];
    },
  ]);
  const config = await model.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-poll-policy',
    supportsWebsockets: false,
  });
  const environment = new Environment({
    url: executor.url,
    cwd: executor.cwd,
    headers: executor.headers,
    tools: ['exec_command', 'write_stdin'],
    transformResult(info, value) {
      policies.push(info.toolName);
      rawResults.push(value);
      if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Expected executor result object');
      return { ...value, output: 'accepted-poll-output' };
    },
  });
  const agent = new Agent({
    instructions: 'Run and poll once.',
    provider,
    model: 'gpt-5',
  });
  let session: Awaited<ReturnType<typeof agent.session>> | undefined;
  try {
    await writeFile(join(executor.cwd, 'private.txt'), privateOutput);
    session = await agent.session({ environment });
    const turn = await session.submit('Run and poll.');
    const observations = [];
    for await (const event of turn.events()) observations.push(event);
    expect((await turn.wait()).finalOutput).toBe('polled');
    const items = [];
    for await (const item of session.items()) items.push(item);
    expect(policies).toEqual(['exec_command', 'write_stdin']);
    expect(
      JSON.stringify({ observations, items, requests: model.requests }),
    ).not.toContain(privateOutput);
    expect(
      executor.requests.some((request) => request.method === 'process/write'),
    ).toBe(true);
    model.assertExhausted();
  } finally {
    try {
      try {
        await session?.close();
      } finally {
        await provider.close();
      }
    } finally {
      await executor.close();
    }
  }
}, 30_000);

effectTest('replaces the whole native patch result after one committed patch', async () => {
  const executor = await startPublicExecutor();
  const model = new ModelServer([
    [
      {
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: 'patch',
        input:
          '*** Begin Patch\n*** Add File: artifact.txt\n+checked\n*** End Patch',
      },
    ],
    (request) => {
      expect(JSON.stringify(request)).toContain('accepted-patch-result');
      expect(JSON.stringify(request)).not.toContain('Success. Updated');
      return [message('patched')];
    },
  ]);
  const config = await model.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-patch-policy',
    supportsWebsockets: false,
  });
  const transformResult = vi.fn((_info: ExecutorContext, value: unknown) => {
    // Core exposes an empty JSON result for apply_patch; the committed file
    // and accepted model output below prove the effect and replacement.
    expect(value).toEqual({});
    return { accepted: 'accepted-patch-result' };
  });
  const environment = new Environment({
    url: executor.url,
    cwd: executor.cwd,
    headers: executor.headers,
    tools: ['apply_patch'],
    transformResult,
  });
  const agent = new Agent({
    instructions: 'Apply the patch once.',
    provider,
    model: 'gpt-6.1-sol',
  });
  let session: Awaited<ReturnType<typeof agent.session>> | undefined;
  try {
    session = await agent.session({ environment });
    const turn = await session.submit('Apply patch.');
    const events: unknown[] = [];
    const reader = (async () => {
      for await (const event of turn.events()) events.push(event);
    })();
    let cancellation: Promise<void> | undefined;
    const deadline = setTimeout(() => {
      cancellation = turn.cancel();
      // The original await below and finally join both remain the owners.
      void cancellation.catch(() => {});
    }, 8000);
    try {
      expect((await turn.wait()).finalOutput).toBe('patched');
    } catch (error) {
      throw new Error(
        JSON.stringify({
          message: 'Patch did not settle with accepted output',
          resultCallbacks: transformResult.mock.calls.length,
          executorMethods: executor.requests.map((request) => request.method),
          declaredTools: model.requests.map((request) => request.tools),
          events,
        }),
        { cause: error },
      );
    } finally {
      clearTimeout(deadline);
      try {
        await cancellation;
      } finally {
        await reader;
      }
    }
    expect(await readFile(join(executor.cwd, 'artifact.txt'), 'utf8')).toBe(
      'checked\n',
    );
    expect(transformResult).toHaveBeenCalledTimes(1);
    expect(transformResult.mock.calls[0]?.[0].submission).toBe(turn);
    model.assertExhausted();
  } finally {
    try {
      try {
        await session?.close();
      } finally {
        await provider.close();
      }
    } finally {
      await executor.close();
    }
  }
}, 25_000);
