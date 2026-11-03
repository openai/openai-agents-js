import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  RunContext,
  RunToolCallOutputItem,
  tool,
  type FunctionToolResult,
  type ToolUseBehavior,
} from '@openai/agents-core';
import {
  captureFinishBehavior,
  resolveToolFinish,
} from '../../src/migration/finish';

const context = new RunContext({ tenant: 'trusted' });
const agent = new Agent({ name: 'Finish policy' });
const signal = () => new AbortController().signal;
function result(name: string, output: unknown): FunctionToolResult {
  return {
    type: 'function_output',
    tool: tool({
      name,
      description: 'An ordinary function result fixture.',
      parameters: z.object({}),
      execute: () => output,
    }),
    output,
    runItem: new RunToolCallOutputItem(
      {
        type: 'function_call_result',
        name,
        callId: `${name}-call`,
        status: 'completed',
        output: typeof output === 'string' ? output : JSON.stringify(output),
      },
      agent,
      output,
    ),
  };
}

describe('migration tool-finish decision boundary', () => {
  it('copies stop names without invoking a callable during admission', () => {
    const names = ['first'];
    const captured = captureFinishBehavior({ stopAtToolNames: names });
    names.push('second');
    expect(captured).toEqual({ stopAtToolNames: ['first'] });
    const policy = vi.fn();
    expect(captureFinishBehavior(policy)).toBe(policy);
    expect(policy).not.toHaveBeenCalled();
  });

  it.each([
    null,
    'unknown',
    { stopAtToolNames: [1] },
    { stopAtToolNames: new Array<string>(1) },
  ])('rejects invalid policy configuration %j', (behavior) => {
    expect(() =>
      captureFinishBehavior(behavior as unknown as ToolUseBehavior),
    ).toThrow('Migration requires a supported tool-use behavior');
  });

  it('does not invoke policy for an empty result batch', async () => {
    const policy = vi.fn();
    expect(
      await resolveToolFinish(policy, context, [], signal()),
    ).toBeUndefined();
    expect(policy).not.toHaveBeenCalled();
  });

  it('derives the SDK final text from the selected raw value', async () => {
    const raw = { saved: true };
    const selected = await resolveToolFinish(
      'stop_on_first_tool',
      context,
      [result('first', raw), result('second', 'later')],
      signal(),
    );
    expect(JSON.parse(selected!.finalOutput)).toEqual(raw);
  });

  it('does not parse a JSON-looking raw string', async () => {
    const raw = '{"saved":true}';
    expect(
      await resolveToolFinish(
        'stop_on_first_tool',
        context,
        [result('first', raw)],
        signal(),
      ),
    ).toEqual({ finalOutput: raw });
  });

  it('preserves an empty final output for built-in and callable policies', async () => {
    const results = [result('first', '')];
    const expected = { finalOutput: '' };
    expect(
      await resolveToolFinish('stop_on_first_tool', context, results, signal()),
    ).toEqual(expected);
    expect(
      await resolveToolFinish(
        () => ({
          isFinalOutput: true,
          isInterrupted: undefined,
          finalOutput: '',
        }),
        context,
        results,
        signal(),
      ),
    ).toEqual(expected);
  });

  it('selects the first matching issued result rather than stop-name order', async () => {
    expect(
      await resolveToolFinish(
        { stopAtToolNames: ['second', 'first'] },
        context,
        [result('first', 'one'), result('second', 'two')],
        signal(),
      ),
    ).toEqual({ finalOutput: 'one' });
    expect(
      await resolveToolFinish(
        { stopAtToolNames: ['absent'] },
        context,
        [result('first', 'one')],
        signal(),
      ),
    ).toBeUndefined();
  });

  it('preserves original context, results, tools and raw output for callable policy', async () => {
    const raw = { saved: true };
    const results = [result('first', raw)];
    const policy: ToolUseBehavior = async (actualContext, actualResults) => {
      expect(actualContext).toBe(context);
      expect(actualResults).toBe(results);
      expect(actualResults[0]).toBe(results[0]);
      expect(actualResults[0].tool).toBe(results[0].tool);
      expect(actualResults[0].type).toBe('function_output');
      if (actualResults[0].type !== 'function_output')
        throw new Error('Expected output');
      expect(actualResults[0].output).toBe(raw);
      return {
        isFinalOutput: true,
        isInterrupted: undefined,
        finalOutput: 'validated candidate',
      };
    };
    expect(await resolveToolFinish(policy, context, results, signal())).toEqual(
      {
        finalOutput: 'validated candidate',
      },
    );
  });

  it('continues for run_llm_again and a callable nonfinal decision', async () => {
    const results = [result('first', 'one')];
    expect(
      await resolveToolFinish('run_llm_again', context, results, signal()),
    ).toBeUndefined();
    expect(
      await resolveToolFinish(
        async () => ({
          isFinalOutput: false,
          isInterrupted: undefined,
        }),
        context,
        results,
        signal(),
      ),
    ).toBeUndefined();
  });

  it.each([
    { isFinalOutput: 'yes' },
    { isFinalOutput: true, finalOutput: 42 },
    { isFinalOutput: false, isInterrupted: true, interruptions: [] },
  ])('rejects invalid/interrupted callable output %j', async (decision) => {
    const policy = (() => decision) as unknown as ToolUseBehavior;
    await expect(
      resolveToolFinish(policy, context, [result('first', 'one')], signal()),
    ).rejects.toThrow(
      'Migration requires a noninterrupted final-output decision',
    );
  });

  it('does not enter policy after cancellation', async () => {
    const policy = vi.fn();
    const controller = new AbortController();
    const reason = new Error('Caller cancelled');
    controller.abort(reason);
    await expect(
      resolveToolFinish(
        policy,
        context,
        [result('first', 'one')],
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(policy).not.toHaveBeenCalled();
  });

  it('joins an entered policy before rejecting its late result after cancellation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let cleaned = false;
    const policy: ToolUseBehavior = async () => {
      try {
        await gate;
        return {
          isFinalOutput: true,
          isInterrupted: undefined,
          finalOutput: 'late',
        };
      } finally {
        cleaned = true;
      }
    };
    const controller = new AbortController();
    let settled = false;
    const pending = resolveToolFinish(
      policy,
      context,
      [result('first', 'one')],
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
    const reason = new Error('Caller cancelled');
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
});
