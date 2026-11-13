import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, tool } from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
}
it('has been dispatching only the final opted-in bare function', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const server = new ModelServer([
    [call('lookup', { value: 'input' }, { callId: 'winner' })],
    [message('done')],
  ]);
  const effects: string[] = [];
  const first = tool({
    name: 'lookup',
    description: 'First lookup',
    parameters: z.object({ value: z.string() }),
    execute: () => {
      effects.push('loser');
      throw new Error('Losing callback entered');
    },
  });
  const last = tool({
    name: 'lookup',
    description: 'Final lookup',
    parameters: z.object({ value: z.string() }),
    execute: ({ value }) => {
      effects.push('winner:' + value);
      return 'selected';
    },
  });
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Use lookup.',
    provider,
    tools: [first, last],
    toolNameCollisionPolicy: 'warn',
  });
  await using session = await agent.session();
  expect((await (await session.submit('start')).wait()).finalOutput).toBe(
    'done',
  );
  expect(effects).toEqual(['winner:input']);
  server.assertExhausted();
});
it('has been retaining the final handoff ahead of every colliding bare function', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const server = new ModelServer([
    [call('transfer_to_worker', {}, { callId: 'route' })],
    [message('done')],
  ]);
  const effects: string[] = [];
  await using provider = await providerFor(server);
  const first = new Agent({
    name: 'worker',
    instructions: 'LOSING_HANDOFF_INSTRUCTIONS',
    provider,
  });
  const last = new Agent({
    name: 'worker',
    instructions: 'WINNING_HANDOFF_INSTRUCTIONS',
    provider,
  });
  const shadow = tool({
    name: 'transfer_to_worker',
    description: 'Unselected ordinary function',
    parameters: z.object({}),
    execute: () => {
      effects.push('loser');
      throw new Error('Losing callback entered');
    },
  });
  const agent = new Agent({
    instructions: 'Transfer to Worker.',
    provider,
    tools: [shadow],
    handoffs: [first, last],
    toolNameCollisionPolicy: 'warn',
  });
  await using session = await agent.session();
  expect((await (await session.submit('start')).wait()).finalOutput).toBe(
    'done',
  );
  expect(effects).toEqual([]);
  expect(JSON.stringify(server.requests[1])).toContain(
    'WINNING_HANDOFF_INSTRUCTIONS',
  );
  expect(JSON.stringify(server.requests[1])).not.toContain(
    'LOSING_HANDOFF_INSTRUCTIONS',
  );
  server.assertExhausted();
});
it('has been rejecting duplicate bare functions under the strict default before admission', async () => {
  const server = new ModelServer([]);
  const execute = vi.fn(() => 'unused');
  await using provider = await providerFor(server);
  const make = () =>
    tool({ name: 'lookup', parameters: z.object({}), execute });
  await expect(
    new Agent({
      instructions: 'Do not enter.',
      provider,
      tools: [make(), make()],
    }).session(),
  ).rejects.toThrow(/Duplicate/);
  expect(execute).not.toHaveBeenCalled();
  expect(server.requests).toEqual([]);
});
it.each(['namespace', 'deferred'] as const)(
  'has been retaining strict %s duplicate rejection under warn',
  async (mode) => {
    const server = new ModelServer([]);
    const execute = vi.fn(() => 'unused');
    await using provider = await providerFor(server);
    const make = () =>
      tool({
        name: 'lookup',
        description: 'Strict lookup',
        parameters: z.object({}),
        execute,
        ...(mode === 'namespace'
          ? { namespace: 'audit' }
          : { deferLoading: true }),
      });
    await expect(
      new Agent({
        instructions: 'Do not enter.',
        provider,
        tools: [make(), make()],
        toolNameCollisionPolicy: 'warn',
      }).session(),
    ).rejects.toThrow(/unique identities/);
    expect(execute).not.toHaveBeenCalled();
    expect(server.requests).toEqual([]);
  },
);

it('has been restoring only the opted-in winning callback declaration', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const server = new ModelServer([
    [call('lookup', { value: 'first' }, { callId: 'first' })],
    [message('first done')],
    [call('lookup', { value: 'second' }, { callId: 'second' })],
    [message('second done')],
  ]);
  const effects: string[] = [];
  await using provider = await providerFor(server);
  const first = tool({
    name: 'lookup',
    parameters: z.object({ value: z.string() }),
    execute: () => {
      throw new Error('Losing callback entered');
    },
  });
  const last = tool({
    name: 'lookup',
    parameters: z.object({ value: z.string() }),
    execute: ({ value }) => {
      effects.push(value);
      return 'winner';
    },
  });
  const agent = new Agent({
    instructions: 'Use lookup.',
    provider,
    tools: [first, last],
    toolNameCollisionPolicy: 'warn',
  });
  const session = await agent.session();
  let state;
  try {
    expect((await (await session.submit('start')).wait()).finalOutput).toBe(
      'first done',
    );
    state = JSON.parse(JSON.stringify(await session.saveState()));
  } finally {
    await session.close();
  }
  await using restored = await agent.session({ state });
  expect((await (await restored.submit('continue')).wait()).finalOutput).toBe(
    'second done',
  );
  expect(effects).toEqual(['first', 'second']);
  server.assertExhausted();
});
