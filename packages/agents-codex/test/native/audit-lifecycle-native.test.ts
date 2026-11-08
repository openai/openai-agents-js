import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  localStorage,
  fileSessionStore,
  manualTool,
  tool,
  type Session,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-lifecycle',
    supportsWebsockets: false,
  });
}

it('rejects waiting for an ancestor Session from a nested Session callback', async () => {
  const outerServer = new ModelServer([
    [call('outer', {}, { callId: 'outer-1' })],
    [message('outer done')],
  ]);
  const innerServer = new ModelServer([
    [call('inner', {}, { callId: 'inner-1' })],
    [message('inner done')],
  ]);
  const outerProvider = await providerFor(outerServer);
  const innerProvider = await providerFor(innerServer);
  let guarded = false;
  let inner: Session<string> | undefined;
  const innerAgent = new Agent({
    instructions: 'Use inner.',
    model: 'gpt-5',
    provider: innerProvider,
    tools: [
      tool({
        name: 'inner',
        parameters: z.object({}),
        execute: async () => {
          await expect(outer.wait()).rejects.toThrow('own session');
          guarded = true;
          return 'checked';
        },
      }),
    ],
  });
  const outer: Session<string> = await new Agent({
    instructions: 'Use outer.',
    model: 'gpt-5',
    provider: outerProvider,
    tools: [
      tool({
        name: 'outer',
        parameters: z.object({}),
        execute: async () => {
          inner = await innerAgent.session();
          const nested = await inner.submit('begin');
          return (await nested.wait()).finalOutput;
        },
      }),
    ],
  }).session();
  try {
    const turn = await outer.submit('begin');
    expect((await turn.wait()).finalOutput).toBe('outer done');
    expect(guarded).toBe(true);
    outerServer.assertExhausted();
    innerServer.assertExhausted();
  } finally {
    await outer.close();
    await inner?.close();
    await outerProvider.close();
    await innerProvider.close();
  }
}, 15000);

it('keeps entered manual requests visible to new readers during graceful stop', async () => {
  const server = new ModelServer([
    [call('decision', {}, { callId: 'decision' })],
  ]);
  const provider = await providerFor(server);
  const decision = manualTool({
    name: 'decision',
    description: 'Ask.',
    parameters: z.object({}),
    result: z.string(),
  });
  const session = await new Agent({
    instructions: 'Ask.',
    model: 'gpt-5',
    provider,
    tools: [decision],
  }).session();
  try {
    const turn = await session.submit('begin');
    const first = await turn.wait({ until: 'interaction' });
    if (!('requests' in first)) throw new Error('Expected manual request');
    let stopped = false;
    const stopping = turn.cancel({ mode: 'graceful' }).then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    const pending = await session.pendingInteractions();
    expect(pending).toHaveLength(1);
    const repeated = await turn.wait({
      until: 'interaction',
      signal: AbortSignal.timeout(1000),
    });
    if (!('requests' in repeated))
      throw new Error('Expected retained manual request');
    expect(repeated.requests).toHaveLength(1);
    const request = decision.match(repeated.requests[0]);
    if (!request) throw new Error('Expected current decision');
    await session.respond(request.reply('yes'));
    await stopping;
    expect(stopped).toBe(true);
    expect(await session.pendingInteractions()).toHaveLength(0);
    server.assertExhausted();
  } finally {
    await session.close();
    await provider.close();
  }
}, 15000);

it.each(['custom', 'local'] as const)(
  'validates manual replacement against %s storage before publication',
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-update-'));
    const server = new ModelServer([
      [call('decision', {}, { callId: 'decision-1' })],
      [message('done')],
    ]);
    const provider = await providerFor(server);
    let invoked = 0;
    const automatic = tool({
      name: 'decision',
      parameters: z.object({}),
      execute: () => {
        invoked++;
        return 'automatic';
      },
    });
    const manual = manualTool({
      name: 'decision',
      description: 'Ask.',
      parameters: z.object({}),
      result: z.string(),
    });
    const session = await new Agent({
      instructions: 'Ask.',
      model: 'gpt-5',
      provider,
      tools: [automatic],
    }).session({
      storage:
        kind === 'custom'
          ? fileSessionStore(directory)
          : localStorage(directory),
    });
    try {
      if (kind === 'custom')
        await expect(session.update({ tools: [manual] })).rejects.toThrow(
          'Custom canonical storage',
        );
      else await session.update({ tools: [manual] });
      const turn = await session.submit('begin');
      if (kind === 'local') {
        const pending = await turn.wait({ until: 'interaction' });
        if (!('requests' in pending))
          throw new Error('Expected manual request');
        const request = manual.match(pending.requests[0]);
        if (!request) throw new Error('Expected replacement declaration');
        await session.respond(request.reply('manual'));
      }
      expect((await turn.wait()).finalOutput).toBe('done');
      expect(invoked).toBe(kind === 'custom' ? 1 : 0);
      server.assertExhausted();
    } finally {
      await session.close();
      await provider.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  15000,
);

it('does not expose a revoked manual request after forced stop', async () => {
  const server = new ModelServer([
    [call('decision', {}, { callId: 'force-decision' })],
  ]);
  const provider = await providerFor(server);
  const decision = manualTool({
    name: 'decision',
    description: 'Ask.',
    parameters: z.object({}),
    result: z.string(),
  });
  const session = await new Agent({
    instructions: 'Ask.',
    model: 'gpt-5',
    provider,
    tools: [decision],
  }).session();
  try {
    const turn = await session.submit('begin');
    const pending = await turn.wait({ until: 'interaction' });
    if (!('requests' in pending)) throw new Error('Expected manual request');
    const request = decision.match(pending.requests[0]);
    if (!request) throw new Error('Expected current decision');
    const reply = request.reply('too late');
    await turn.cancel({ mode: 'force' });
    expect(await session.pendingInteractions()).toHaveLength(0);
    await expect(session.respond(reply)).rejects.toThrow();
    server.assertExhausted();
  } finally {
    await session.close();
    await provider.close();
  }
}, 15000);
