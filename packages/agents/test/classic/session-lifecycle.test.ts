import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { captureCompletedHistory } from '../../src/migration/history';
import type { AgentInputItem } from '@openai/agents-core/types';
import { Agent, MemorySession, Runner, tool } from '../../src/classic';
import {
  assistantMessage,
  functionCall,
  modelResponse,
  ScriptedModel,
} from '../../src/classic/testing';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function workflow() {
  let effects = 0;
  const model = new ScriptedModel([
    modelResponse([functionCall('effect', {}, { callId: 'effect-1' })]),
    modelResponse([assistantMessage('actual final answer')]),
  ]);
  const effect = tool({
    name: 'effect',
    description: 'Record an effect',
    parameters: z.object({}),
    execute: () => {
      effects++;
      return 'actual effect result';
    },
  });
  const agent = new Agent({ name: 'session-boundary', model, tools: [effect] });
  return {
    model,
    agent,
    effects: () => effects,
    runner: new Runner({ tracingDisabled: true }),
  };
}

describe('classic Session lifecycle failure ordering', () => {
  it('propagates read failure before callback, model, tool or append work', async () => {
    const session = new MemorySession();
    const failure = new Error('history read failed');
    vi.spyOn(session, 'getItems').mockRejectedValue(failure);
    const writes = vi.spyOn(session, 'addItems');
    const callback = vi.fn((history, fresh) => [...history, ...fresh]);
    const run = workflow();
    await expect(
      run.runner.run(run.agent, 'fresh', {
        session,
        sessionInputCallback: callback,
      }),
    ).rejects.toBe(failure);
    expect(callback).not.toHaveBeenCalled();
    expect(run.model.calls).toHaveLength(0);
    expect(run.effects()).toBe(0);
    expect(writes).not.toHaveBeenCalled();
  });

  it.each(['sync', 'async'] as const)(
    'propagates %s callback failure without model, tool or append work',
    async (kind) => {
      const events: string[] = [];
      const failure = new Error('callback failed');
      const session = new MemorySession();
      const read = session.getItems.bind(session);
      vi.spyOn(session, 'getItems').mockImplementation(async () => {
        events.push('read');
        return read();
      });
      const writes = vi.spyOn(session, 'addItems');
      const run = workflow();
      const callback = () => {
        events.push('callback');
        if (kind === 'sync') throw failure;
        return Promise.reject(failure);
      };
      await expect(
        run.runner.run(run.agent, 'fresh', {
          session,
          sessionInputCallback: callback,
        }),
      ).rejects.toBe(failure);
      expect(events).toEqual(['read', 'callback']);
      expect(run.model.calls).toHaveLength(0);
      expect(run.effects()).toBe(0);
      expect(writes).not.toHaveBeenCalled();
    },
  );

  it.each(['read', 'callback'] as const)(
    'joins a pending %s before surfacing its failure after cancellation',
    async (phase) => {
      const pending = gate();
      const started = gate();
      const failure = new Error(`${phase} failed after cancellation`);
      const controller = new AbortController();
      const session = new MemorySession();
      const run = workflow();
      const events: string[] = [];
      vi.spyOn(session, 'getItems').mockImplementation(async () => {
        events.push('read');
        if (phase === 'read') {
          started.release();
          await pending.promise;
          throw failure;
        }
        return [];
      });
      const writes = vi.spyOn(session, 'addItems');
      const operation = run.runner.run(run.agent, 'fresh', {
        session,
        signal: controller.signal,
        sessionInputCallback: async () => {
          events.push('callback');
          started.release();
          await pending.promise;
          throw failure;
        },
      });
      // Observe rejection immediately, without leaving an unhandled rejected promise.
      const outcome = operation.catch((error: unknown) => error);
      await started.promise;
      controller.abort(new Error('cancel requested'));
      let settled = false;
      void outcome.then(() => {
        settled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const completedBeforeRelease = settled;
      pending.release();
      const error = await outcome;
      expect(completedBeforeRelease).toBe(false);
      expect(error).toBe(failure);
      expect(events).toEqual(
        phase === 'read' ? ['read'] : ['read', 'callback'],
      );
      expect(run.model.calls).toHaveLength(0);
      expect(run.effects()).toBe(0);
      expect(writes).not.toHaveBeenCalled();
    },
  );

  it.each([
    'success',
    'success-after-cancel',
    'reject-before-commit',
    'reject-after-commit',
  ] as const)('awaits actual completed-item append: %s', async (mode) => {
    const pending = gate();
    const started = gate();
    const session = new MemorySession();
    const append = session.addItems.bind(session);
    const failure = new Error('append failed');
    const controller = new AbortController();
    const run = workflow();
    let batch: AgentInputItem[] = [];
    const writes = vi
      .spyOn(session, 'addItems')
      .mockImplementation(async (items) => {
        batch = structuredClone(items);
        started.release();
        await pending.promise;
        if (mode === 'reject-before-commit') throw failure;
        await append(items);
        if (mode === 'reject-after-commit') throw failure;
      });
    const operation = run.runner.run(run.agent, 'fresh', {
      session,
      signal: controller.signal,
    });
    const outcome = operation.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    await started.promise;
    expect(run.effects()).toBe(1);
    expect(run.model.calls).toHaveLength(2);
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    if (mode !== 'success') controller.abort(new Error('cancel during append'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const completedBeforeRelease = settled;
    pending.release();
    const final = await outcome;
    expect(completedBeforeRelease).toBe(false);
    expect(batch.map((item) => item.type)).toEqual([
      'message',
      'function_call',
      'function_call_result',
      'message',
    ]);
    expect(batch[1]).toMatchObject({
      callId: 'effect-1',
      name: 'effect',
    });
    expect(batch[2]).toMatchObject({
      callId: 'effect-1',
      name: 'effect',
      status: 'completed',
      output: { type: 'text', text: 'actual effect result' },
    });
    expect(batch[3]).toEqual(assistantMessage('actual final answer'));
    expect(captureCompletedHistory(batch)).toEqual(batch);

    if (mode === 'success' || mode === 'success-after-cancel') {
      expect(final).toHaveProperty('result.finalOutput', 'actual final answer');
    } else {
      expect(final).toEqual({ error: failure });
    }
    expect(writes).toHaveBeenCalledTimes(1);
    expect(run.effects()).toBe(1);
    expect((await session.getItems()).length).toBe(
      mode === 'reject-before-commit' ? 0 : 4,
    );
  });
});
