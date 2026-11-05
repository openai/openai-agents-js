import { describe, expect, it, vi } from 'vitest';
import { Agent, RunContext } from '@openai/agents-core';
import { resolveInstructions } from '../../src/migration/instructions';

describe('migration instruction callback boundary', () => {
  it('preserves default and empty instructions', async () => {
    const context = new RunContext(undefined);
    const signal = new AbortController().signal;
    for (const instructions of [undefined, '']) {
      const agent = new Agent({ name: 'Instructions', instructions });
      expect(await resolveInstructions(agent, context, signal)).toBe('');
    }
  });

  it.each([false, true])(
    'uses original Agent/context and observes context changes (async=%s)',
    async (asynchronous) => {
      const context = new RunContext({ tenant: 'first' });
      const received: unknown[][] = [];
      const agent = new Agent<{ tenant: string }>({
        name: 'Instructions',
        instructions: (actualContext, actualAgent) => {
          received.push([actualContext, actualAgent]);
          const text = `Tenant ${actualContext.context.tenant}`;
          return asynchronous ? Promise.resolve(text) : text;
        },
      });
      const signal = new AbortController().signal;
      expect(await resolveInstructions(agent, context, signal)).toBe(
        'Tenant first',
      );
      context.context.tenant = 'second';
      expect(await resolveInstructions(agent, context, signal)).toBe(
        'Tenant second',
      );
      expect(received).toHaveLength(2);
      for (const [actualContext, actualAgent] of received) {
        expect(actualContext).toBe(context);
        expect(actualAgent).toBe(agent);
      }
    },
  );

  it('does not enter a callback after cancellation', async () => {
    const instructions = vi.fn(() => 'Late instructions');
    const agent = new Agent({ name: 'Instructions', instructions });
    const controller = new AbortController();
    const reason = new Error('Cancelled');
    controller.abort(reason);
    await expect(
      resolveInstructions(agent, new RunContext(undefined), controller.signal),
    ).rejects.toBe(reason);
    expect(instructions).not.toHaveBeenCalled();
  });

  it('joins an entered callback and rejects its late result after cancellation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let cleaned = false;
    const agent = new Agent({
      name: 'Instructions',
      instructions: async () => {
        try {
          await gate;
          return 'Late instructions';
        } finally {
          cleaned = true;
        }
      },
    });
    const controller = new AbortController();
    let settled = false;
    const pending = resolveInstructions(
      agent,
      new RunContext(undefined),
      controller.signal,
    );
    const observation = pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const reason = new Error('Cancelled');
    try {
      controller.abort(reason);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(cleaned).toBe(false);
    } finally {
      release();
      await observation;
    }
    await expect(pending).rejects.toBe(reason);
    expect(cleaned).toBe(true);
  });

  it('rejects an invalid callback result at this boundary', async () => {
    const agent = new Agent({
      name: 'Instructions',
      instructions: () => 42 as unknown as string,
    });
    await expect(
      resolveInstructions(
        agent,
        new RunContext(undefined),
        new AbortController().signal,
      ),
    ).rejects.toThrow('Migration instructions must be a string or undefined');
  });
});
