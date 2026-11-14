import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { invokeFunctionTool, tool } from '../src/runtime/tools';

it.each([undefined, 1])(
  'keeps body-entry admission failures outside errorFunction (timeout %s)',
  async (callbackTimeout) => {
    const failure = new Error('Realtime body-entry admission retired');
    const execute = vi.fn(() => 'body');
    const errorFunction = vi.fn(() => 'formatted');
    const selected = tool({
      name: 'lookup',
      parameters: z.object({}),
      callbackTimeout,
      execute,
      errorFunction,
    });
    const context = {
      context: undefined,
      submission: {
        sessionId: 's',
        childId: 'c',
        instanceId: '1',
        turnId: 't',
        submissionId: 'r',
      },
      threadId: 's',
      turnId: 't',
      callId: 'call',
      signal: new AbortController().signal,
    };
    await expect(
      invokeFunctionTool(
        selected,
        {},
        context,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(execute).not.toHaveBeenCalled();
    expect(errorFunction).not.toHaveBeenCalled();
  },
);

it.each([undefined, 1])(
  'has been refusing tool effects after synchronous body-entry cancellation (timeout %s)',
  async (callbackTimeout) => {
    const controller = new AbortController();
    const failure = new Error('Start listener cancelled before tool effects');
    const execute = vi.fn(() => 'unexpected effect');
    const errorFunction = vi.fn(() => 'formatted');
    const entered = vi.fn(() => {
      controller.abort(failure);
    });
    const selected = tool({
      name: 'lookup',
      parameters: z.object({}),
      callbackTimeout,
      execute,
      errorFunction,
    });
    const context = {
      context: undefined,
      submission: {
        sessionId: 's',
        childId: 'c',
        instanceId: '1',
        turnId: 't',
        submissionId: 'r',
      },
      threadId: 's',
      turnId: 't',
      callId: 'call',
      signal: controller.signal,
    };
    await expect(
      invokeFunctionTool(
        selected,
        {},
        context,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        entered,
      ),
    ).rejects.toBe(failure);
    expect(entered).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(errorFunction).not.toHaveBeenCalled();
  },
);
