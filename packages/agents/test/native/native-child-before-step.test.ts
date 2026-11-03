import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeError,
  NativeProvider,
  Turn,
  tool,
  toolRef,
  type ChildBeforeStepContext,
  type ToolContext,
} from '@openai/agents';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

function threadId(request: JsonObject): string {
  const metadata = request.client_metadata as Record<string, string>;
  return String(JSON.parse(metadata['x-codex-turn-metadata']).thread_id);
}

function toolNames(request: { tools?: unknown; input?: unknown }): string[] {
  const names: string[] = [];
  function visit(entries: unknown) {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (entry.type === 'namespace') visit(entry.tools);
      else if (entry.type === 'function' || entry.type === 'custom')
        names.push(entry.name);
    }
  }
  visit(request.tools);
  if (Array.isArray(request.input))
    for (const item of request.input)
      if (item.type === 'additional_tools') visit(item.tools);
  return names;
}

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-child-selection',
    supportsWebsockets: false,
  });
}

it.each([false, true])(
  'keeps overlapping child tool plans independent and joins a held selector (cancel one: %s)',
  async (cancelOne) => {
    const context = { receipt: 'accepted' };
    const effects: Array<{ name: string; child: Turn<unknown> }> = [];
    const laterRelease = Promise.withResolvers<void>();
    let cancelTargetId: string | undefined;
    let laterHeld: ChildBeforeStepContext<typeof context> | undefined;
    const owners = new Map<
      string,
      {
        callbacks: ChildBeforeStepContext<typeof context>[];
        selected: typeof first;
        release: ReturnType<typeof Promise.withResolvers<void>>;
        pending: Set<ChildBeforeStepContext<typeof context>>;
      }
    >();
    function selectedTool(name: string) {
      return tool({
        name,
        parameters: z.object({}),
        execute(_, ctx: ToolContext<typeof context>) {
          expect(ctx.context).toBe(context);
          if (!(ctx.submission instanceof Turn))
            throw new Error('Expected the public child Turn');
          effects.push({ name, child: ctx.submission });
          return context.receipt;
        },
      });
    }
    const first = selectedTool('first');
    const second = selectedTool('second');
    const native = new NativeAgents<typeof context>({
      maxChildren: 2,
      async beforeStep(callback) {
        expect(callback.context).toBe(context);
        const id = callback.child.childId;
        let owner = owners.get(id);
        if (!owner) {
          owner = {
            callbacks: [],
            selected: owners.size === 0 ? first : second,
            release: Promise.withResolvers<void>(),
            pending: new Set(),
          };
          owners.set(id, owner);
        }
        expect(callback.stepIndex).toBe(owner.callbacks.length);
        if (owner.callbacks.length) {
          expect(callback.child).toEqual(owner.callbacks[0].child);
          expect(callback.submission).toBe(owner.callbacks[0].submission);
        }
        owner.callbacks.push(callback);
        owner.pending.add(callback);
        try {
          // Native preparations may retire before sampling. Keep this child's
          // selected leaf until its actual public tool callback has executed.
          if (effects.some((effect) => effect.child.childId === id)) {
            if (cancelOne && id === cancelTargetId) {
              laterHeld = callback;
              await laterRelease.promise;
            }
            return [];
          }
          await owner.release.promise;
          return [owner.selected];
        } finally {
          owner.pending.delete(callback);
        }
      },
    });
    let rootId: string | undefined;
    let rootRequests = 0;
    const childRequests = new Map<string, JsonObject[]>();
    const reply = (request: JsonObject) => {
      const id = threadId(request);
      rootId ??= id;
      if (id === rootId) {
        rootRequests++;
        if (rootRequests === 1) {
          expect(toolNames(request)).toContain('spawn_agent');
          expect(toolNames(request)).not.toContain('first');
          expect(toolNames(request)).not.toContain('second');
          return ['alpha', 'beta'].map((name) =>
            call(
              'spawn_agent',
              { task_name: name, message: 'Use your selected tool.' },
              { namespace: 'collaboration', callId: `spawn-${name}` },
            ),
          );
        }
        expect(toolNames(request)).toEqual([]);
        return [message('root complete')];
      }
      const requests = childRequests.get(id) ?? [];
      childRequests.set(id, requests);
      requests.push(request);
      if (requests.length === 1) {
        const selected = owners.get(id)!.selected;
        expect(toolNames(request)).toEqual([selected.name]);
        return [call(selected.name, {}, { callId: 'same-child-call-id' })];
      }
      expect(toolNames(request)).toEqual([]);
      return [message(`child complete ${id}`)];
    };
    const server = new ModelServer(
      Array.from({ length: cancelOne ? 5 : 6 }, () => reply),
    );
    const executor = await startPublicExecutor();
    try {
      await using provider = await providerFor(server);
      await using session = await new Agent<typeof context>({
        instructions: 'Delegate to both children.',
        model: 'gpt-5.5',
        provider,
        tools: [first, second, native],
      }).session({
        context,
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
      });
      try {
        const root = await session.submit('Start both children.', {
          beforeStep: ({ stepIndex }) =>
            stepIndex === 0 ? [toolRef('spawn_agent', 'collaboration')] : [],
        });
        await vi.waitFor(() => expect(owners.size).toBe(2), {
          timeout: 10_000,
        });
        expect((await root.wait()).finalOutput).toBe('root complete');
        const children = await Array.fromAsync(session.subagents());
        expect(children).toHaveLength(2);
        expect(childRequests.size).toBe(0);
        expect(effects).toEqual([]);
        for (const child of children) {
          const owner = owners.get(child.id)!;
          expect(owner.pending.size).toBeGreaterThan(0);
          const callback = owner.callbacks[0];
          expect(callback.submission).toBe(child.turn);
          expect(callback.child).toEqual({
            sessionId: session.id,
            childId: child.id,
            instanceId: child.turn!.instanceId,
            turnId: child.turn!.turnId,
            submissionId: child.turn!.submissionId,
          });
          expect(callback.stepIndex).toBe(0);
        }
        const [selected, peer] = children;
        const selectedOwner = owners.get(selected.id)!;
        const peerOwner = owners.get(peer.id)!;
        expect(selectedOwner.selected).not.toBe(peerOwner.selected);
        if (cancelOne) {
          cancelTargetId = selected.id;
          selectedOwner.release.resolve();
          await vi.waitFor(() => expect(laterHeld).toBeDefined(), {
            timeout: 10_000,
          });
          expect(laterHeld!.submission).toBe(selected.turn);
          expect(laterHeld!.stepIndex).toBeGreaterThan(0);
          expect(effects).toHaveLength(1);
          expect(effects[0].child).toBe(selected.turn);
          expect(childRequests.get(selected.id)).toHaveLength(1);
          expect(peerOwner.pending.size).toBeGreaterThan(0);
          expect(childRequests.has(peer.id)).toBe(false);
          let settled = false;
          const cancelled = selected.turn!.wait().then(
            () => {
              settled = true;
              throw new Error('Cancelled child completed successfully');
            },
            (error: unknown) => {
              settled = true;
              return error;
            },
          );
          let cancellationFinished = false;
          const cancellation = selected
            .tryCancel(selected.turn!)
            .then((value) => {
              cancellationFinished = true;
              return value;
            });
          await vi.waitFor(() => expect(laterHeld!.signal.aborted).toBe(true));
          await setImmediate();
          expect(settled).toBe(false);
          expect(cancellationFinished).toBe(false);
          expect(selectedOwner.pending.has(laterHeld!)).toBe(true);
          expect(peerOwner.pending.size).toBeGreaterThan(0);
          expect(effects).toHaveLength(1);
          laterRelease.resolve();
          expect(await cancellation).toBe(true);
          expect(await cancelled).toBeInstanceOf(NativeError);
          expect(selectedOwner.pending.size).toBe(0);
          expect(childRequests.get(selected.id)).toHaveLength(1);
          expect(effects).toHaveLength(1);
        } else {
          selectedOwner.release.resolve();
          expect((await selected.turn!.wait()).finalOutput).toBe(
            `child complete ${selected.id}`,
          );
        }
        expect(peerOwner.pending.size).toBeGreaterThan(0);
        expect(childRequests.has(peer.id)).toBe(false);
        peerOwner.release.resolve();
        expect((await peer.turn!.wait()).finalOutput).toBe(
          `child complete ${peer.id}`,
        );
        expect(effects).toHaveLength(2);
        for (const effect of effects) {
          const owner = owners.get(effect.child.childId!)!;
          expect(effect.name).toBe(owner.selected.name);
          expect(effect.child).toBe(owner.callbacks[0].submission);
          expect(effect.child).toMatchObject(owner.callbacks[0].child);
          expect(childRequests.get(effect.child.childId!)).toHaveLength(
            cancelOne && effect.child.childId === selected.id ? 1 : 2,
          );
          expect(owner.callbacks.at(-1)!.stepIndex).toBeGreaterThan(0);
          expect(owner.pending.size).toBe(0);
        }
        server.assertExhausted();
      } finally {
        for (const owner of owners.values()) owner.release.resolve();
        laterRelease.resolve();
      }
    } finally {
      await executor.close();
    }
  },
  30_000,
);

it('uses child defaults for undefined and removes them for an explicit empty selection', async () => {
  let invoked = false;
  const callbacks: ChildBeforeStepContext[] = [];
  const lookup = tool({
    name: 'lookup',
    parameters: z.object({}),
    execute() {
      invoked = true;
      return 'lookup accepted';
    },
  });
  const native = new NativeAgents({
    maxChildren: 1,
    beforeStep(callback) {
      callbacks.push(callback);
      return invoked ? [] : undefined;
    },
  });
  let rootId: string | undefined;
  let rootRequests = 0;
  let childRequests = 0;
  const reply = (request: JsonObject) => {
    const id = threadId(request);
    rootId ??= id;
    if (id === rootId)
      return ++rootRequests === 1
        ? [
            call(
              'spawn_agent',
              { task_name: 'alpha', message: 'Look up the record.' },
              { namespace: 'collaboration', callId: 'spawn-alpha' },
            ),
          ]
        : [message('root complete')];
    if (++childRequests === 1) {
      expect(toolNames(request)).toContain('lookup');
      return [call('lookup', {}, { callId: 'child-lookup' })];
    }
    expect(toolNames(request)).toEqual([]);
    return [message('child complete')];
  };
  const server = new ModelServer(Array.from({ length: 4 }, () => reply));
  const executor = await startPublicExecutor();
  try {
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Delegate.',
      model: 'gpt-5.5',
      provider,
      tools: [lookup, native],
    }).session({
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
      }),
    });
    expect(
      (await (await session.submit('Start a child.')).wait()).finalOutput,
    ).toBe('root complete');
    const [child] = await Array.fromAsync(session.subagents());
    expect((await child.turn!.wait()).finalOutput).toBe('child complete');
    expect(invoked).toBe(true);
    expect(callbacks.map((callback) => callback.stepIndex)).toEqual(
      callbacks.map((_, index) => index),
    );
    expect(callbacks.length).toBeGreaterThan(1);
    for (const callback of callbacks) {
      expect(callback.submission).toBe(child.turn);
      expect(callback.child).toEqual(callbacks[0].child);
    }
    server.assertExhausted();
  } finally {
    await executor.close();
  }
}, 30_000);
