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
