import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { Agent as ClassicAgent } from '@openai/agents-core';
import { ScriptedModel } from '@openai/agents-core/testing';
import { SDKRunner } from '../../src/migration';
import { localRecoveryRequired } from '../../src/runtime/local-recovery';
import {
  Agent,
  localStorage,
  NativeProvider,
  HttpMCP,
  NativeAgents,
  Environment,
} from '../../src';

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe('local profile declarations and failed-opening lease ownership', () => {
  it('inspects completed and interrupted work without logging tool arguments', () => {
    const call = {
      threadId: 'thread',
      turnId: 'interrupted',
      callId: 'call',
      name: 'lookup',
      namespace: 'reports',
      arguments: '{"account":"private-account"}',
    };
    const error = localRecoveryRequired(
      JSON.stringify({
        calls: [call],
        history: [
          {
            type: 'event_msg',
            payload: { type: 'task_started', turn_id: 'completed' },
          },
          {
            type: 'event_msg',
            payload: { type: 'task_complete', turn_id: 'completed' },
          },
          {
            type: 'event_msg',
            payload: { type: 'task_started', turn_id: 'interrupted' },
          },
          {
            type: 'response_item',
            payload: {
              type: 'function_call',
              call_id: call.callId,
              name: call.name,
              namespace: call.namespace,
              arguments: call.arguments,
            },
          },
        ],
      }),
      call.threadId,
    );
    expect(error.calls).toEqual([call]);
    expect(error.turns.map(({ id, status }) => [id, status])).toEqual([
      ['completed', 'completed'],
      ['interrupted', 'interrupted'],
    ]);
    expect(error.items).toContainEqual(
      expect.objectContaining({
        type: 'function_call',
        callId: call.callId,
        arguments: call.arguments,
      }),
    );
    expect(error.message).not.toContain('private-account');
    expect(inspect(error)).not.toContain('private-account');
    expect(JSON.stringify(error)).not.toContain('private-account');
  });

  it('refuses native LocalStorage substitution for a classic Model before effects', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'classic-native-storage-'));
    try {
      const path = join(parent, 'unopened-profile');
      const model = new ScriptedModel([]);
      const agent = new ClassicAgent({ name: 'Classic', model });
      const options = { context: undefined, storage: localStorage(path) };
      await expect(SDKRunner.run(agent, 'Hello', options)).rejects.toThrow(
        'does not support run option storage',
      );
      expect(model.calls).toHaveLength(0);
      expect(await exists(path)).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('freezes a plain structural descriptor without touching the profile', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'storage-descriptor-'));
    try {
      const path = join(parent, 'missing');
      const storage = localStorage(path);
      expect(storage).toEqual({ path: resolve(path) });
      expect(isAbsolute(storage.path)).toBe(true);
      expect(Object.getPrototypeOf(storage)).toBe(Object.prototype);
      expect(Object.isFrozen(storage)).toBe(true);
      expect(await exists(path)).toBe(false);
      expect(() => localStorage('')).toThrow();
      expect(() => localStorage('bad\0path')).toThrow();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('rejects invalid opening and one-shot aliases before provider acquisition or factories', async () => {
    const provider = new NativeProvider();
    const agent = new Agent({ instructions: 'Answer.', provider });
    const acquire = vi.spyOn(provider, '_acquire');
    await expect(agent.session({ resume: 'id' })).rejects.toThrow(
      'resume requires',
    );
    await expect(
      agent.session({ storage: { path: 'relative' } }),
    ).rejects.toThrow('absolute');
    await expect(
      agent.session({ storage: localStorage('/profile'), state: {} as never }),
    ).rejects.toThrow('Portable');
    const factory = vi.spyOn(agent, 'session');
    for (const key of ['storage', 'resume']) {
      const wider = { [key]: undefined, returnState: false };
      await expect(agent.run('hello', wider)).rejects.toThrow('session-only');
    }
    expect(factory).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    await provider.close();
  });

  it('rejects native authority outside the local managed-tool profile before acquisition', async () => {
    const provider = new NativeProvider();
    const acquire = vi.spyOn(provider, '_acquire');
    const storage = localStorage('/profile');
    const mcp = new HttpMCP({
      name: 'docs',
      url: 'https://example.invalid/mcp',
      tools: ['read'],
    });
    const environment = new Environment({
      url: 'wss://example.invalid',
      cwd: '/remote',
      tools: [],
    });
    for (const agent of [
      new Agent({ instructions: 'Answer.', provider, tools: [mcp] }),
      new Agent({
        instructions: 'Answer.',
        provider,
        programmaticToolCalling: true,
      }),
    ])
      await expect(agent.session({ storage })).rejects.toThrow(
        'Local storage supports',
      );
    await expect(
      new Agent({
        instructions: 'Answer.',
        provider,
        tools: [new NativeAgents()],
      }).session({
        storage,
        environment,
      }),
    ).rejects.toThrow(
      'NativeAgents requires an Environment with all three execution tools',
    );
    expect(acquire).not.toHaveBeenCalled();
    await provider.close();
  });

  it('retains unfinished cleanup and the temporary home until explicit provider retry', async () => {
    const provider = new NativeProvider();
    const lease = provider._acquire();
    const home = await lease.open();
    let ready = false;
    const original = new Error('opening failed');
    lease.retainOpeningCleanup(async () => {
      if (!ready) throw new Error('native shutdown incomplete');
      await lease.release();
    });
    const failure = await lease.failOpening(original).catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.cause).toBe(original);
    expect(failure.errors[0]).toBe(original);
    expect(await exists(home.codex_home)).toBe(true);
    await expect(provider.close()).rejects.toThrow('cleanup failed');
    expect(await exists(home.codex_home)).toBe(true);
    expect(() => provider._acquire()).toThrow('closed');
    ready = true;
    await provider.close();
    expect(await exists(home.codex_home)).toBe(false);
  });

  it('joins all started failed-token attempts even when one fails, and retries only unfinished work', async () => {
    const provider = new NativeProvider();
    const left = provider._acquire();
    const right = provider._acquire();
    const homes = await Promise.all([left.open(), right.open()]);
    let retry = false;
    let block = false;
    const held = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const leftCleanup = vi.fn(async () => {
      if (!retry) throw new Error('left incomplete');
      await left.release();
    });
    const rightCleanup = vi.fn(async () => {
      if (!block) throw new Error('right incomplete');
      entered.resolve();
      await held.promise;
      await right.release();
    });
    left.retainOpeningCleanup(leftCleanup);
    right.retainOpeningCleanup(rightCleanup);
    await Promise.allSettled([
      left.failOpening(new Error('left opening')),
      right.failOpening(new Error('right opening')),
    ]);
    block = true;
    let returned = false;
    const closing = provider.close().finally(() => {
      returned = true;
    });
    const observed = closing.catch((error) => error);
    await entered.promise;
    await Promise.resolve();
    expect(returned).toBe(false);
    expect(await exists(homes[1].codex_home)).toBe(true);
    held.resolve();
    expect(await observed).toBeInstanceOf(AggregateError);
    expect(await exists(homes[1].codex_home)).toBe(false);
    retry = true;
    await provider.close();
    expect(rightCleanup).toHaveBeenCalledTimes(2);
    expect(await exists(homes[0].codex_home)).toBe(false);
  });
});
