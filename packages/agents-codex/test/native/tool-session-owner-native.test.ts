import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeProvider,
  tool,
} from '../../src';
import { _nativeToolSessionOwner } from '../../src/internal';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

it('attributes root and child callbacks to one opaque Session owner', async () => {
  const owners: object[] = [];
  const identities: string[] = [];
  const lookup = tool({
    name: 'lookup',
    parameters: z.object({}),
    execute(_, context) {
      owners.push(_nativeToolSessionOwner(context));
      identities.push(context.submission.sessionId);
      return 'accepted';
    },
  });
  let rootId: string | undefined;
  let rootRequests = 0;
  let childRequests = 0;
  const reply = (request: JsonObject) => {
    const metadata = request.client_metadata as Record<string, string>;
    const id = String(JSON.parse(metadata['x-codex-turn-metadata']).thread_id);
    rootId ??= id;
    if (id === rootId) {
      const step = rootRequests++;
      if (step === 0) return [call('lookup', {}, { callId: 'root-lookup' })];
      if (step === 1)
        return [
          call(
            'spawn_agent',
            { task_name: 'child', message: 'Use lookup.' },
            { namespace: 'collaboration', callId: 'spawn-child' },
          ),
        ];
      return [message('root complete')];
    }
    return childRequests++ === 0
      ? [call('lookup', {}, { callId: 'child-lookup' })]
      : [message('child complete')];
  };
  const server = new ModelServer(Array.from({ length: 5 }, () => reply));
  const executor = await startPublicExecutor();
  try {
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic',
      supportsWebsockets: false,
    });
    await using session = await new Agent({
      instructions: 'Use lookup, then delegate.',
      model: 'gpt-5.5',
      provider,
      tools: [lookup, new NativeAgents({ maxChildren: 1 })],
    }).session({
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
      }),
    });
    expect((await (await session.submit('Start.')).wait()).finalOutput).toBe(
      'root complete',
    );
    const children = await vi.waitFor(async () => {
      const children = await Array.fromAsync(session.subagents());
      expect(children[0]?.turn).toBeTruthy();
      return children;
    });
    expect((await children[0].turn!.wait()).finalOutput).toBe('child complete');
    expect(owners).toHaveLength(2);
    expect(owners[1]).toBe(owners[0]);
    expect(owners[0]).not.toBe(session);
    expect(Object.keys(owners[0])).toEqual([]);
    expect(identities).toEqual([session.id, session.id]);
    server.assertExhausted();
  } finally {
    await executor.close();
  }
});
