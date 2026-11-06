import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Agent,
  MemorySession,
  setTracingDisabled,
  tool,
} from '@openai/agents-core';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponder,
  modelResponse,
} from '@openai/agents-core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent as NativeAgent,
  NativeProvider,
  fileSessionStore,
  localStorage,
  parseSessionState,
} from '../../src';
import { MigrationCleanupError, SDKRunner } from '../../src/migration';
import { jsonObject } from '../../src/runtime/binding';
import { migrationTool } from '../../src/runtime/tools';
import { ModelServer, call, message } from './fixtures/model-server';

setTracingDisabled(true);
afterEach(() => ModelServer.closeAll());

it.each(['checkpoint', 'local', 'canonical'] as const)(
  'reopens %s native history with the current selected Model and callback',
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), 'migration-native-persistence-'));
    const effects: string[] = [];
    const currentName = mode === 'checkpoint' ? 'effect' : 'current_effect';
    const agent = (
      model: ScriptedModel | string,
      binding: string,
      name: string,
    ) =>
      new Agent({
        name: 'persisted',
        instructions: 'Use supplied tools.',
        model,
        tools: [
          tool({
            name,
            description: 'Record a value',
            parameters: z.object({ value: z.string() }),
            execute: ({ value }) => {
              effects.push(`${binding}:${value}`);
              return value;
            },
          }),
        ],
      });
    try {
      const storage =
        mode === 'local'
          ? localStorage(dir)
          : mode === 'canonical'
            ? fileSessionStore(dir)
            : undefined;
      const first = await SDKRunner.run(
        agent(
          new ScriptedModel([
            modelResponse([
              assistantMessage('Recording', { phase: 'commentary' }),
              functionCall('effect', { value: 'old' }, { callId: 'old-id' }),
            ]),
            modelResponse([
              assistantMessage('old completion', { phase: 'final_answer' }),
            ]),
          ]),
          'original',
          'effect',
        ),
        'original request',
        {
          context: undefined,
          ...(storage ? { storage } : { returnState: true }),
        },
      );
      const next = new ScriptedModel([
        modelResponder(({ request }) => {
          expect(request.tools).toEqual([
            expect.objectContaining({ name: currentName, strict: true }),
          ]);
          expect(request.input).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: 'function_call',
                callId: 'old-id',
                name: 'effect',
              }),
              expect.objectContaining({
                type: 'function_call_result',
                callId: 'old-id',
                output: 'old',
              }),
              expect.objectContaining({
                type: 'message',
                role: 'assistant',
                phase: 'commentary',
              }),
              expect.objectContaining({
                type: 'message',
                role: 'assistant',
                phase: 'final_answer',
              }),
            ]),
          );
          expect(JSON.stringify(request.input)).toContain('old completion');
          expect(JSON.stringify(request.input)).toContain('new request');
          return [
            functionCall(currentName, { value: 'new' }, { callId: 'new-id' }),
          ];
        }),
        modelResponse([assistantMessage('new completion')]),
      ]);
      const getModel = vi.fn(() => next);
      const resumed = await SDKRunner.run(
        agent('current-model', 'current', currentName),
        'new request',
        {
          context: undefined,
          modelProvider: { getModel },
          ...(storage
            ? { storage, resume: first.native.sessionId }
            : {
                state: parseSessionState(JSON.stringify(first.state)),
                returnState: true,
              }),
        },
      );
      expect(resumed.native.sessionId).toBe(first.native.sessionId);
      expect(resumed.native.turnId).not.toBe(first.native.turnId);
      expect(resumed.finalOutput).toBe('new completion');
      if (!storage)
        expect(resumed.state).toMatchObject({
          source_session_id: first.native.sessionId,
        });
      expect(getModel).toHaveBeenCalledExactlyOnceWith('current-model');
      expect(JSON.stringify(resumed.history)).not.toContain('old-id');
      expect(effects).toEqual(['original:old', 'current:new']);
      next.assertComplete();

      if (storage) {
        const provider = new NativeProvider({
          apiKey: 'synthetic-readback',
          supportsWebsockets: false,
        });
        try {
          const session = await new NativeAgent({
            provider,
            instructions: 'Use supplied tools.',
          }).session({
            storage,
            resume: first.native.sessionId,
          });
          try {
            expect(await Array.fromAsync(session.turns())).toEqual([
              expect.objectContaining({ id: first.native.turnId }),
              expect.objectContaining({ id: resumed.native.turnId }),
            ]);
            expect(await Array.fromAsync(session.items())).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  type: 'function_call_output',
                  callId: 'old-id',
                  turnId: first.native.turnId,
                }),
                expect.objectContaining({
                  type: 'function_call_output',
                  callId: 'new-id',
                  turnId: resumed.native.turnId,
                }),
              ]),
            );
          } finally {
            await session.close();
          }
        } finally {
          await provider.close();
        }
      }
      if (mode === 'local') {
        const retiredCall = new ScriptedModel([
          modelResponse([
            functionCall(
              'effect',
              { value: 'retired' },
              { callId: 'retired-id' },
            ),
          ]),
        ]);
        await expect(
          SDKRunner.run(
            agent(retiredCall, 'current', currentName),
            'Try a retired tool',
            {
              context: undefined,
              storage,
              resume: first.native.sessionId,
            },
          ),
        ).rejects.toThrow(
          'does not support incomplete or non-text/function output',
        );
        expect(effects).toEqual(['original:old', 'current:new']);
        retiredCall.assertComplete();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it('rejects Classic and native state together before opening storage', async () => {
  const model = new ScriptedModel([]);
  const acquire = vi.fn();
  await expect(
    SDKRunner.run(new Agent({ name: 'dual storage', model }), 'new input', {
      context: undefined,
      session: new MemorySession(),
      storage: { acquire, read: vi.fn(), commit: vi.fn(), release: vi.fn() },
    }),
  ).rejects.toThrow('requires one persistence source');
  expect(acquire).not.toHaveBeenCalled();
  expect(model.calls).toEqual([]);
});

it('rejects a recorded call ID hidden from the restored Model by compaction', async () => {
  const callId = 'effect-before-compaction';
  const server = new ModelServer([
    [call('effect', {}, { callId })],
    [message('Old completion')],
  ]);
  const config = await server.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-compaction-source',
    supportsWebsockets: false,
  });
  const execute = vi.fn(() => 'current effect');
  const description = 'Record an effect.';
  const instructions = 'Use the effect tool.';
  const currentTool = tool({
    name: 'effect',
    description,
    parameters: z.object({}),
    execute,
  });
  try {
    const sourceEffect = vi.fn(async () => 'original effect');
    const source = await new NativeAgent({
      provider,
      model: 'agents-sdk-model',
      instructions,
      tools: [
        migrationTool(
          {
            name: 'effect',
            description,
            parameters: jsonObject.parse(currentTool.parameters),
          },
          sourceEffect,
          () => {},
        ),
      ],
    }).session();
    const state = await (async () => {
      try {
        await (await source.submit('Original request')).wait();
        await source.compact({ summary: 'Keep only the summary.' });
        expect(await Array.fromAsync(source.items())).toContainEqual(
          expect.objectContaining({ type: 'function_call', callId }),
        );
        return await source.saveState();
      } finally {
        await source.close();
      }
    })();
    const model = new ScriptedModel([
      modelResponder(({ request }) => {
        expect(JSON.stringify(request.input)).toContain(
          'Keep only the summary.',
        );
        expect(JSON.stringify(request.input)).not.toContain(callId);
        return [functionCall('effect', {}, { callId })];
      }),
    ]);
    await expect(
      SDKRunner.run(
        new Agent({
          name: 'compacted',
          instructions,
          model,
          tools: [currentTool],
        }),
        'New request',
        { context: undefined, state },
      ),
    ).rejects.toThrow('requires fresh native function call IDs');
    expect(sourceEffect).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    model.assertComplete();
    server.assertExhausted();
  } finally {
    await provider.close();
  }
});

it('keeps the original Model and writer while a local approval is held', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'migration-local-approval-'));
  const signal = new AbortController();
  const storage = localStorage(dir);
  const execute = vi.fn(() => 'approved effect');
  const original = new ScriptedModel([
    modelResponse([functionCall('effect', {}, { callId: 'held-call' })]),
    modelResponder(({ request }) => {
      expect(request.input).toContainEqual(
        expect.objectContaining({
          type: 'function_call_result',
          callId: 'held-call',
          output: 'approved effect',
        }),
      );
      return [assistantMessage('Original Model completed')];
    }),
  ]);
  const agent = new Agent({
    name: 'held',
    model: original,
    tools: [
      tool({
        name: 'effect',
        description: 'Record an approved effect.',
        parameters: z.object({}),
        needsApproval: true,
        execute,
      }),
    ],
  });
  try {
    const held = await SDKRunner.run(agent, 'Approve one effect', {
      approvals: 'manual',
      context: undefined,
      storage,
      signal: signal.signal,
    });
    if (!('status' in held)) throw new Error('Expected a held approval');
    try {
      expect(execute).not.toHaveBeenCalled();
      expect(held).not.toHaveProperty('state');
      const replacement = new ScriptedModel([
        modelResponse([assistantMessage('New Model completed')]),
      ]);
      agent.model = replacement;
      const reopening = {
        context: undefined,
        storage,
        resume: held.native.sessionId,
      };
      const current = new Agent({ name: 'current', model: replacement });
      await expect(
        SDKRunner.run(current, 'Competing turn', reopening),
      ).rejects.toThrow(/(?:lock|writer|in use)/i);
      expect(replacement.calls).toHaveLength(0);
      held.approve(held.interruptions[0]!);
      const completed = await held.continue();
      expect(completed.native).toMatchObject({
        sessionId: held.native.sessionId,
        turnId: held.native.turnId,
      });
      expect(completed.finalOutput).toBe('Original Model completed');
      expect(execute).toHaveBeenCalledOnce();
      original.assertComplete();
      const reopened = await SDKRunner.run(current, 'Next turn', reopening);
      expect(reopened.finalOutput).toBe('New Model completed');
      expect(reopened.native.sessionId).toBe(held.native.sessionId);
      expect(execute).toHaveBeenCalledOnce();
      replacement.assertComplete();
    } finally {
      signal.abort();
      await held.completed.catch(() => {});
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

it('fences tool dispatch when the canonical store rejects its intent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'migration-canonical-failure-'));
  const store = fileSessionStore(dir);
  const callId = 'uncommitted-intent';
  const release = vi.fn(store.release.bind(store));
  const failIntent = vi.fn(() => {
    throw new Error('Synthetic canonical commit failure');
  });
  const storage = {
    acquire: store.acquire.bind(store),
    read: store.read.bind(store),
    release,
    async commit(...args: Parameters<typeof store.commit>) {
      if (args[4].includes(callId)) failIntent();
      await store.commit(...args);
    },
  };
  const execute = vi.fn(() => 'unexpected effect');
  const model = new ScriptedModel([
    modelResponse([functionCall('effect', {}, { callId })]),
  ]);
  const agent = new Agent({
    name: 'canonical failure',
    model,
    tools: [
      tool({
        name: 'effect',
        description: 'Record an effect.',
        parameters: z.object({}),
        execute,
      }),
    ],
  });
  try {
    await expect(
      SDKRunner.run(agent, 'Record an effect', { context: undefined, storage }),
    ).rejects.toMatchObject({
      name: MigrationCleanupError.name,
      errors: expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/canonical storage/i),
        }),
      ]),
    });
    expect(failIntent).toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    model.assertComplete();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
