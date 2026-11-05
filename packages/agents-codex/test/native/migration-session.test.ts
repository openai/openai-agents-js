import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { AgentInputItem } from '@openai/agents-core/types';
import { z } from 'zod';
import {
  Agent,
  MemorySession,
  OutputGuardrailTripwireTriggered,
  Runner,
  tool,
  setTracingDisabled,
} from '@openai/agents-core';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponse,
  modelResponder,
  modelStreamResponder,
} from '@openai/agents-core/testing';
import { SDKRunner } from '../../src/migration';
setTracingDisabled(true);

describe('completed classic Session on the native adapter', () => {
  it('preserves the structured output contract while storing actual message history', async () => {
    const store = new MemorySession();
    await store.addItems([
      { type: 'message', role: 'user', content: 'old input' },
      assistantMessage('old completion'),
    ]);
    const retained = await store.getItems();
    const actualOutput = assistantMessage('{"answer":"checked"}', {
      id: 'structured-session-output',
    });
    const model = new ScriptedModel([
      modelResponder((call) => {
        expect(call.request.input).toEqual([
          ...retained,
          { type: 'message', role: 'user', content: 'next input' },
        ]);
        expect(call.request.outputType).toMatchObject({
          type: 'json_schema',
          schema: { type: 'object' },
        });
        return [actualOutput];
      }),
    ]);
    const result = await SDKRunner.run(
      new Agent({
        name: 'structured Session consumer',
        model,
        outputType: z.object({ answer: z.string() }),
      }),
      'next input',
      { context: undefined, session: store },
    );
    expect(result.finalOutput).toEqual({ answer: 'checked' });
    expect(result.newItems).toHaveLength(1);
    expect((await store.getItems()).at(-1)).toEqual(actualOutput);
    expect(await store.getItems()).toEqual(result.toInputList());
  });

  it('loads Session history for streaming and stores only the actual completed delta', async () => {
    const store = new MemorySession();
    await store.addItems([
      { type: 'message', role: 'user', content: 'retained user' },
      assistantMessage('retained answer'),
    ]);
    const retained = await store.getItems();
    const execute = vi.fn(() => 'stream effect');
    const model = new ScriptedModel([
      modelStreamResponder(async function* (call) {
        expect(call.request.input).toEqual([
          ...retained,
          { type: 'message', role: 'user', content: 'new streamed user' },
        ]);
        yield {
          type: 'response_done',
          response: {
            id: 'stream-call-response',
            output: [functionCall('effect', {}, { callId: 'stream-call' })],
            usage: {
              requests: 1,
              inputTokens: 2,
              outputTokens: 1,
              totalTokens: 3,
            },
          },
        };
      }),
      modelStreamResponder(async function* () {
        yield {
          type: 'response_done',
          response: {
            id: 'stream-final-response',
            output: [assistantMessage('stream complete')],
            usage: {
              requests: 1,
              inputTokens: 2,
              outputTokens: 1,
              totalTokens: 3,
            },
          },
        };
      }),
    ]);
    const live = await SDKRunner.stream(
      new Agent({
        name: 'streaming Session consumer',
        model,
        tools: [
          tool({
            name: 'effect',
            description: 'Record',
            parameters: z.object({}),
            execute,
          }),
        ],
      }),
      'new streamed user',
      { context: undefined, session: store },
    );
    const result = await live.completed;
    expect(result.finalOutput).toBe('stream complete');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.newItems).toHaveLength(3);
    expect(result.history).toEqual(result.toInputList());
    expect(await store.getItems()).toEqual(result.toInputList());
    expect((await store.getItems()).slice(0, retained.length)).toEqual(
      retained,
    );
  });

  it('loads retained pairs without replay and saves actual generated items for a fresh Runner', async () => {
    const effects: string[] = [];
    const effect = tool({
      name: 'effect',
      description: 'Record a value',
      parameters: z.object({ value: z.string() }),
      execute: ({ value }) => {
        effects.push(value);
        return value;
      },
    });
    const store = new MemorySession();
    await new Runner({ tracingDisabled: true }).run(
      new Agent({
        name: 'classic',
        model: new ScriptedModel([
          modelResponse([
            functionCall('effect', { value: 'old' }, { callId: 'old-call' }),
          ]),
          modelResponse([assistantMessage('old complete')]),
        ]),
        tools: [effect],
      }),
      'old user',
      { session: store },
    );
    const old = await store.getItems();
    expect(old).toHaveLength(4);
    const next = new ScriptedModel([
      modelResponder((call) => {
        expect(call.request.input).toEqual([
          ...old,
          { type: 'message', role: 'user', content: 'new user' },
        ]);
        return [
          functionCall('effect', { value: 'new' }, { callId: 'new-call' }),
        ];
      }),
      modelResponse([assistantMessage('new complete')]),
    ]);
    const result = await SDKRunner.run(
      new Agent({
        name: 'native',
        instructions: 'Use supplied tools.',
        model: next,
        tools: [effect],
      }),
      'new user',
      { context: {}, session: store },
    );
    expect(result.finalOutput).toBe('new complete');
    expect(result.input).toEqual([
      ...old,
      { type: 'message', role: 'user', content: 'new user' },
    ]);
    expect(result.history).toEqual([
      ...old,
      { type: 'message', role: 'user', content: 'new user' },
      ...result.newItems.map((item) => item.rawItem),
    ]);
    expect(result.toInputList()).toEqual(result.history);
    expect(result.newItems).toHaveLength(3);
    const exported = result.history;
    exported.length = 0;
    expect(result.history).toHaveLength(8);
    expect(effects).toEqual(['old', 'new']);
    const stored = await store.getItems();
    expect(stored).toHaveLength(8);
    expect(stored.slice(0, 4)).toEqual(old);
    expect(stored.slice(5)).toEqual(
      result.newItems.map((item) => item.rawItem),
    );
    const resumed = new ScriptedModel([
      modelResponder((call) => {
        expect(call.request.input).toEqual([
          ...stored,
          { type: 'message', role: 'user', content: 'again' },
        ]);
        return [assistantMessage('continued')];
      }),
    ]);
    await SDKRunner.run(
      new Agent({
        name: 'fresh',
        instructions: 'Continue.',
        model: resumed,
        tools: [effect],
      }),
      'again',
      { context: {}, session: store },
    );
    expect(await store.getItems()).toHaveLength(10);
    expect(effects).toEqual(['old', 'new']);
  });

  it('applies the callback before selected Model work and stores its fresh input', async () => {
    const store = new MemorySession({
      initialItems: [
        { type: 'message', role: 'user', content: 'stored secret' },
      ],
    });
    const model = new ScriptedModel([
      modelResponder((call) => {
        expect(call.request.input).toEqual([
          { type: 'message', role: 'user', content: 'rewritten history' },
          { type: 'message', role: 'user', content: 'redacted' },
        ]);
        return [assistantMessage('done')];
      }),
    ]);
    await SDKRunner.run(
      new Agent({ name: 'callback', instructions: 'Continue.', model }),
      'private',
      {
        context: {},
        session: store,
        sessionInputCallback: (history, fresh) => {
          expect(fresh).toEqual([
            { type: 'message', role: 'user', content: 'private' },
          ]);
          if (history[0].type === 'message')
            history[0].content = 'rewritten history';
          return [
            ...history,
            { type: 'message', role: 'user', content: 'redacted' },
          ];
        },
      },
    );
    const stored = await store.getItems();
    expect(stored).toHaveLength(3);
    expect(stored[0]).toMatchObject({ content: 'stored secret' });
    expect(stored[1]).toMatchObject({ content: 'redacted' });
  });

  it('rejects pending history before provider or callback effects', async () => {
    const store = new MemorySession({
      initialItems: [functionCall('effect', {}, { callId: 'pending' })],
    });
    const getModel = vi.fn(() => new ScriptedModel([]));
    const callback = vi.fn((history, fresh) => [...history, ...fresh]);
    await expect(
      SDKRunner.run(
        new Agent({
          name: 'rejected',
          instructions: 'Continue.',
          model: 'selected',
        }),
        'fresh',
        {
          context: {},
          session: store,
          sessionInputCallback: callback,
          modelProvider: { getModel },
        },
      ),
    ).rejects.toThrow('MIG.8');
    expect(getModel).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });
  it('rejects a callback-rewritten historical call ID before another tool effect', async () => {
    const effects = vi.fn(() => 'unexpected');
    const store = new MemorySession({
      initialItems: [
        functionCall('effect', {}, { callId: 'old' }),
        {
          type: 'function_call_result',
          callId: 'old',
          name: 'effect',
          status: 'completed',
          output: 'already done',
        },
      ],
    });
    const model = new ScriptedModel([
      modelResponse([functionCall('effect', {}, { callId: 'rewritten' })]),
    ]);
    await expect(
      SDKRunner.run(
        new Agent({
          name: 'replay',
          instructions: 'Continue.',
          model,
          tools: [
            tool({
              name: 'effect',
              description: 'Record an effect',
              parameters: z.object({}),
              execute: effects,
            }),
          ],
        }),
        'fresh',
        {
          context: {},
          session: store,
          sessionInputCallback: (history, fresh) => {
            for (const item of history)
              if (
                item.type === 'function_call' ||
                item.type === 'function_call_result'
              )
                item.callId = 'rewritten';
            return [...history, ...fresh];
          },
        },
      ),
    ).rejects.toThrow('existing function call');
    expect(effects).not.toHaveBeenCalled();
    expect((await store.getItems())[0]).toMatchObject({ callId: 'old' });
  });

  it.each([false, true])(
    'joins a cancelled failing append after actual effects (committed=%s)',
    async (committed) => {
      const controller = new AbortController();
      const store = new MemorySession();
      const append = store.addItems.bind(store);
      let entered!: () => void;
      const writing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const failure = new Error('store unavailable after effects');
      const write = vi
        .spyOn(store, 'addItems')
        .mockImplementation(async (items) => {
          if (committed) await append(items);
          entered();
          await gate;
          throw failure;
        });
      const effect = vi.fn(() => 'actual reply');
      const model = new ScriptedModel([
        modelResponse([functionCall('effect', {}, { callId: 'effect-once' })]),
        modelResponse([assistantMessage('done')]),
      ]);
      let settled = false;
      const running = SDKRunner.run(
        new Agent({
          name: 'append',
          instructions: 'Continue.',
          model,
          tools: [
            tool({
              name: 'effect',
              description: 'Apply an effect',
              parameters: z.object({}),
              execute: effect,
            }),
          ],
        }),
        'fresh',
        { context: {}, session: store, signal: controller.signal },
      ).then(
        (value) => {
          settled = true;
          return value;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      await writing;
      expect(effect).toHaveBeenCalledTimes(1);
      controller.abort(new Error('caller cancelled while writing'));
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      release();
      expect(await running).toBe(failure);
      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0][0].map((item) => item.type)).toEqual([
        'message',
        'function_call',
        'function_call_result',
        'message',
      ]);
      expect(await store.getItems()).toHaveLength(committed ? 4 : 0);
    },
  );
  it('retains completed pairs across application process restart and isolates Session stores', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'migration-session-'));
    const path = join(directory, 'history.json');
    const isolated = join(directory, 'isolated.json');
    const effects = join(directory, 'effects.txt');
    const fixture = fileURLToPath(
      new URL('./fixtures/session-process.mjs', import.meta.url),
    );
    const execute = promisify(execFile);
    const run = async (phase: string, store = path) => {
      const { stdout } = await execute(
        process.execPath,
        [fixture, phase, store, effects],
        { timeout: 60_000 },
      );
      return JSON.parse(stdout.trim().split('\n').at(-1)!);
    };
    try {
      const classic = await run('classic');
      const native = await run('native');
      const restarted = await run('restarted');
      expect(new Set([classic.pid, native.pid, restarted.pid]).size).toBe(3);
      expect([classic.stored, native.stored, restarted.stored]).toEqual([
        4, 8, 10,
      ]);
      expect(native.newItems).toBe(3);
      const before = await readFile(path, 'utf8');
      expect((await run('isolated', isolated)).stored).toBe(2);
      expect(await readFile(path, 'utf8')).toBe(before);
      expect((await readFile(effects, 'utf8')).trim().split('\n')).toEqual([
        'old',
        'new',
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);
  it.each(['read', 'callback'] as const)(
    'preserves eventual %s failure after caller cancellation before provider work',
    async (phase) => {
      const controller = new AbortController();
      const store = new MemorySession();
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const failure = new Error(`${phase} failed`);
      const fail = async () => {
        entered();
        await gate;
        throw failure;
      };
      if (phase === 'read')
        vi.spyOn(store, 'getItems').mockImplementation(fail);
      const callback = vi.fn(
        phase === 'callback'
          ? fail
          : (history: AgentInputItem[], fresh: AgentInputItem[]) => [
              ...history,
              ...fresh,
            ],
      );
      const provider = { getModel: vi.fn(() => new ScriptedModel([])) };
      const write = vi.spyOn(store, 'addItems');
      let settled = false;
      const running = SDKRunner.run(
        new Agent({
          name: 'failure',
          instructions: 'Continue.',
          model: 'selected',
        }),
        'fresh',
        {
          context: {},
          session: store,
          sessionInputCallback: callback,
          modelProvider: provider,
          signal: controller.signal,
        },
      ).then(
        (value) => {
          settled = true;
          return value;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      await waiting;
      controller.abort(new Error('cancelled during preparation'));
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      release();
      expect(await running).toBe(failure);
      expect(callback).toHaveBeenCalledTimes(phase === 'callback' ? 1 : 0);
      expect(provider.getModel).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    },
  );
  it.each([false, true])(
    'does not mutate borrowed retained items on callback rejection (async=%s)',
    async (asynchronous) => {
      const retained = [
        {
          type: 'message' as const,
          role: 'user' as const,
          content: 'retained original',
        },
      ];
      const store = new MemorySession();
      vi.spyOn(store, 'getItems').mockResolvedValue(retained);
      const writes = vi.spyOn(store, 'addItems');
      const provider = { getModel: vi.fn(() => new ScriptedModel([])) };
      const failure = new Error('callback rejected after rewrite');
      const callback = (history: AgentInputItem[]) => {
        const old = history[0];
        if (old.type === 'message') old.content = 'rewrite for Model only';
        if (asynchronous) return Promise.reject(failure);
        throw failure;
      };
      await expect(
        SDKRunner.run(
          new Agent({
            name: 'borrowed',
            instructions: 'Continue.',
            model: 'selected',
          }),
          'fresh',
          {
            context: {},
            session: store,
            modelProvider: provider,
            sessionInputCallback: callback,
          },
        ),
      ).rejects.toBe(failure);
      expect(retained[0].content).toBe('retained original');
      expect(writes).not.toHaveBeenCalled();
      expect(provider.getModel).not.toHaveBeenCalled();
    },
  );

  it('does not append guard-blocked output after an actual tool effect', async () => {
    const store = new MemorySession();
    const writes = vi.spyOn(store, 'addItems');
    const effect = vi.fn(() => 'accepted reply');
    const model = new ScriptedModel([
      modelResponse([functionCall('effect', {}, { callId: 'before-guard' })]),
      modelResponse([assistantMessage('blocked final')]),
    ]);
    await expect(
      SDKRunner.run(
        new Agent({
          name: 'guarded store',
          instructions: 'Continue.',
          model,
          tools: [
            tool({
              name: 'effect',
              description: 'Apply an effect',
              parameters: z.object({}),
              execute: effect,
            }),
          ],
        }),
        'fresh',
        {
          context: {},
          session: store,
          outputGuardrails: [
            {
              name: 'block final',
              execute: async () => ({
                tripwireTriggered: true,
                outputInfo: 'blocked',
              }),
            },
          ],
        },
      ),
    ).rejects.toBeInstanceOf(OutputGuardrailTripwireTriggered);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(writes).not.toHaveBeenCalled();
    expect(await store.getItems()).toEqual([]);
  });
});
