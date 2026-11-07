import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeProvider,
  manualTool,
  type ActionRequested,
  type Subagent,
} from '../../src';
import {
  binding,
  type JsonObject,
  type NativeThread,
} from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

it('accepts a live child manual reply during graceful tree interruption', async () => {
  const executor = await startPublicExecutor();
  let rootId: string | undefined;
  const counts = new Map<string, number>();
  const respond = (request: JsonObject) => {
    const metadata = request.client_metadata as Record<string, string>;
    const id = String(JSON.parse(metadata['x-codex-turn-metadata']).thread_id);
    rootId ??= id;
    const count = (counts.get(id) ?? 0) + 1;
    counts.set(id, count);
    if (id !== rootId) return [call('decision', {}, { callId: 'decision' })];
    return count === 1
      ? [
          call(
            'spawn_agent',
            { task_name: 'child', message: 'Ask decision.' },
            { namespace: 'collaboration', callId: 'spawn' },
          ),
        ]
      : [message('root done')];
  };
  const server = new ModelServer(Array.from({ length: 3 }, () => respond));
  const config = await server.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
  const agent = new Agent({
    instructions: 'Delegate.',
    model: 'gpt-5.5',
    provider,
    tools: [
      new NativeAgents(),
      manualTool({
        name: 'decision',
        description: 'Get a decision.',
        parameters: z.object({}),
        result: z.string(),
      }),
    ],
  });
  let session: Awaited<ReturnType<typeof agent.session>> | undefined;
  try {
    session = await agent.session({
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
      }),
    });
    const root = await session.submit('begin');
    expect((await root.wait()).finalOutput).toBe('root done');
    let request: ActionRequested | undefined;
    for await (const event of session.events()) {
      if (event.type === 'action_requested' && event.subagentId) {
        request = event;
        break;
      }
    }
    if (!request) throw new Error('Missing child manual request');
    const childSession = session;
    const child = await vi.waitFor(
      async () => {
        let child: Subagent | undefined;
        for await (const candidate of childSession.subagents()) {
          if (candidate.id === request!.subagentId) child = candidate;
        }
        expect(child?.turn).toBeTruthy();
        return child;
      },
      { timeout: 5_000 },
    );
    if (!child?.turn) throw new Error('Missing live child turn');
    const original = child.turn;
    expect(request.call).toMatchObject({
      sessionId: session.id,
      turnId: original.turnId,
      childId: child.id,
      childIncarnation: original.submissionId.split(':').at(-2),
      callId: 'decision',
      role: null,
      model: 'gpt-5.5',
      route: 'direct',
    });
    const result = original.wait().catch((error: unknown) => error);
    await session.interrupt({ scope: 'all', mode: 'graceful' });
    await expect(child.submit('new input')).rejects.toThrow();
    expect(await child.submit(request.reply('approved-existing-call'))).toBe(
      original,
    );
    expect(await result).toBeInstanceOf(Error);
    const history = [];
    for await (const item of session.items({ subagentId: child.id }))
      history.push(item);
    expect(JSON.stringify(history)).toContain('approved-existing-call');
    await session.close();
    server.assertExhausted();
  } finally {
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

it('rejects delayed manual replies from an evicted child handle', async () => {
  const collaborate = (name: string, args: JsonObject, callId: string) =>
    call(name, args, { namespace: 'collaboration', callId });
  let nextRootCall: JsonObject | undefined = collaborate(
    'spawn_agent',
    { task_name: 'alpha', message: 'Ask.' },
    'spawn-alpha',
  );
  let rootId: string | undefined;
  let alphaId: string | undefined;
  let betaId: string | undefined;
  let alphaCalls = 0;
  const respond = (req: JsonObject) => {
    const metadata = req.client_metadata as Record<string, string>;
    const id = String(JSON.parse(metadata['x-codex-turn-metadata']).thread_id);
    rootId ??= id;
    if (id === rootId) {
      const response = nextRootCall ?? message('root done');
      nextRootCall = undefined;
      return [response];
    }
    alphaId ??= id;
    if (id !== alphaId) {
      betaId = id;
      return [message('beta done')];
    }
    if (++alphaCalls % 2) return [call('decision', {}, { callId: 'reused' })];
    return [
      message(
        JSON.stringify(req.input).includes('fresh-reply')
          ? 'fresh acknowledged'
          : 'completed',
      ),
    ];
  };
  const server = new ModelServer(Array.from({ length: 11 }, () => respond));
  const config = await server.config();
  const executor = await startPublicExecutor();
  try {
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'fixture',
    });
    const agent = new Agent({
      instructions: 'Delegate.',
      model: 'gpt-5.5',
      provider,
      tools: [
        new NativeAgents({ maxChildren: 1 }),
        manualTool({
          name: 'decision',
          description: 'Get a decision.',
          parameters: z.object({}),
          result: z.string(),
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
    async function nextDecision() {
      for await (const event of session.events())
        if (event.type === 'action_requested' && event.subagentId === alphaId)
          return event;
      throw new Error('Session closed before the manual request');
    }
    const alpha = async () =>
      (await Array.fromAsync(session.subagents())).find(
        (child) => child.id === alphaId,
      )!;
    await (await session.submit('start alpha')).wait();
    const first = await nextDecision();
    const old = await vi.waitFor(
      async () => {
        const child = await alpha();
        expect(child?.turn?.turnId).toBe(first.turnId);
        return child;
      },
      { timeout: 5_000 },
    );
    const oldBatch = await old.turn!.wait({ until: 'manual_tool' });
    if (!('requests' in oldBatch))
      throw new Error('Expected original child request');
    expect(oldBatch.requests).toHaveLength(1);
    expect(oldBatch.requests[0].callId).toBe(first.callId);
    const original = await old.submit(first.reply('original-reply'));
    const originalResult = await original.wait();
    const duplicate = {
      type: 'function_call_output',
      call_id: first.callId,
      output: 'stale-reply',
    } as const;

    const { NativeThread: Thread } = await binding();
    const preflight = Thread.prototype._child_instance;
    const sampled = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    // Delay delivery of the real native snapshot across eviction and reload.
    const lookup = vi
      .spyOn(Thread.prototype, '_child_instance')
      .mockImplementationOnce(async function (this: NativeThread, id) {
        const snapshot = await preflight.call(this, id);
        sampled.resolve();
        await release.promise;
        return snapshot;
      });
    try {
      const pending = old.submit(duplicate);
      await Promise.race([sampled.promise, pending.catch(() => {})]);
      lookup.mockRestore();
      nextRootCall = collaborate(
        'spawn_agent',
        { task_name: 'beta', message: 'Finish.' },
        'spawn-beta',
      );
      await (await session.submit('evict idle alpha')).wait();
      for await (const event of session.events())
        if (
          event.type === 'turn_finished' &&
          event.submissionId.startsWith(`child:${betaId}:`)
        )
          break;
      nextRootCall = collaborate(
        'followup_task',
        { target: old.id, message: 'Ask again.' },
        'wake-alpha',
      );
      await (await session.submit('reload alpha')).wait();
      const replacement = await nextDecision();
      const current = await vi.waitFor(
        async () => {
          const child = await alpha();
          expect(child?.turn?.turnId).toBe(replacement.turnId);
          return child;
        },
        { timeout: 5_000 },
      );
      const replacementBatch = await current.turn!.wait({
        until: 'manual_tool',
      });
      if (!('requests' in replacementBatch))
        throw new Error('Expected replacement child request');
      expect(replacementBatch.turn).toBe(current.turn);
      expect(replacementBatch.requests).toHaveLength(1);
      expect(replacementBatch.requests[0].submissionId).toBe(
        replacement.submissionId,
      );
      expect(await original.wait({ until: 'manual_tool' })).toBe(
        originalResult,
      );
      expect(replacement.callId).toBe(first.callId);
      expect(replacement.submissionId).not.toBe(first.submissionId);
      expect(current.turn!.instanceId).not.toBe(original.instanceId);
      release.resolve();
      await expect(pending).rejects.toBeInstanceOf(Error);
      await expect(old.submit(duplicate)).rejects.toBeInstanceOf(Error);
      const resumed = await current.submit({
        ...duplicate,
        output: 'fresh-reply',
      });
      expect(resumed).toBe(current.turn);
      expect((await resumed.wait()).finalOutput).toBe('fresh acknowledged');
      server.assertExhausted();
    } finally {
      release.resolve();
      lookup.mockRestore();
    }
  } finally {
    await executor.close();
  }
}, 20_000);
