import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeError,
  NativeProvider,
  tool,
  type Completed,
  type Session,
  type Turn,
} from '@openai/agents';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

it('rejects child callbacks waiting on an active parent but permits its settled result', async () => {
  const executor = await startPublicExecutor();
  const ready = Promise.withResolvers<void>();
  const releaseRoot = Promise.withResolvers<void>();
  const rootSettled = Promise.withResolvers<void>();
  type Probe = {
    status: 'pending' | 'fulfilled' | 'rejected';
    error?: unknown;
  };
  const attempted = Promise.withResolvers<Probe[]>();
  let completedParents: Completed[] | undefined;
  let rootId: string | undefined;
  const counts = new Map<string, number>();
  const respond = async (request: JsonObject) => {
    const metadata = request.client_metadata as Record<string, string>;
    const id = String(JSON.parse(metadata['x-codex-turn-metadata']).thread_id);
    rootId ??= id;
    const count = (counts.get(id) ?? 0) + 1;
    counts.set(id, count);
    if (id === rootId) {
      if (count === 1)
        return [
          call(
            'spawn_agent',
            {
              task_name: 'child',
              message: 'Use check.',
            },
            { namespace: 'collaboration', callId: 'spawn' },
          ),
        ];
      await releaseRoot.promise;
      return [message('root finished')];
    }
    return count === 1
      ? [call('check', {}, { callId: 'child-check' })]
      : [message('child finished')];
  };
  const server = new ModelServer(Array.from({ length: 4 }, () => respond));
  const config = await server.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
  let session: Session | undefined;
  let root: Turn;
  const check = tool({
    name: 'check',
    parameters: z.object({}),
    async execute() {
      await ready.promise;
      const probe = (wait: () => Promise<unknown>): Probe => {
        const state: Probe = { status: 'pending' };
        void Promise.resolve()
          .then(wait)
          .then(
            () => {
              state.status = 'fulfilled';
            },
            (error) => {
              state.status = 'rejected';
              state.error = error;
            },
          );
        return state;
      };
      const probes = [probe(() => root.wait()), probe(() => session!.wait())];
      // The parent response is held; only an immediate ownership rejection can settle.
      await new Promise<void>((resolve) => setImmediate(resolve));
      attempted.resolve(probes.map((probe) => ({ ...probe })));
      await rootSettled.promise;
      completedParents = await Promise.all([root.wait(), session!.wait()]);
      return 'checked';
    },
  });
  const agent = new Agent({
    instructions: 'Delegate.',
    model: 'gpt-5.5',
    provider,
    tools: [new NativeAgents(), check],
  });
  try {
    session = await agent.session({
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
      }),
    });
    root = await session.submit('begin');
    const externalWait = root.wait();
    ready.resolve();
    const activeParentProbes = await attempted.promise;
    releaseRoot.resolve();
    const completed = await externalWait;
    rootSettled.resolve();
    const children = [];
    for await (const child of session.subagents()) children.push(child);
    expect(children).toHaveLength(1);
    expect((await children[0].turn!.wait()).finalOutput).toBe('child finished');
    expect(completed.finalOutput).toBe('root finished');
    for (const probe of activeParentProbes) {
      expect(probe.status).toBe('rejected');
      expect(probe.error).toBeInstanceOf(NativeError);
    }
    expect(completedParents).toHaveLength(2);
    expect(completedParents?.[0]).toBe(completed);
    expect(completedParents?.[1]).toBe(completed);
    server.assertExhausted();
  } finally {
    ready.resolve();
    releaseRoot.resolve();
    rootSettled.resolve();
    try {
      await session?.close();
    } finally {
      try {
        await provider.close();
      } finally {
        await executor.close();
      }
    }
  }
}, 20_000);
