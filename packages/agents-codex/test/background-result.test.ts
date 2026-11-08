import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  backgroundResult,
  isBackgroundResult,
  isBackgroundToolResponse,
} from '../src/runtime/background-result';
import { invokeFunctionTool, tool, ToolOutput } from '../src/runtime/tools';

const context = {
  context: undefined,
  submission: {
    sessionId: 'root',
    childId: 'child',
    instanceId: '1',
    turnId: 't',
    submissionId: 's',
  },
  threadId: 'root',
  turnId: 't',
  callId: 'c',
  signal: new AbortController().signal,
};

it('validates background content and publishes only normalized content', async () => {
  const selected = tool({
    name: 'save',
    parameters: z.object({}),
    result: z.string().transform((value) => value.toUpperCase()),
    execute: () => backgroundResult('saved'),
  });
  const result = await invokeFunctionTool(selected, {}, context, vi.fn());
  expect(result).toEqual({
    success: true,
    contentItems: [{ type: 'inputText', text: 'SAVED' }],
  });
  expect(isBackgroundToolResponse(result)).toBe(true);
  expect(isBackgroundToolResponse(structuredClone(result))).toBe(false);
});

it('does not treat returned JSON as background control', async () => {
  const selected = tool({
    name: 'save',
    parameters: z.object({}),
    execute: () => ({ content: 'saved', start_response: false }),
  });
  const result = await invokeFunctionTool(selected, {}, context, vi.fn());
  expect(isBackgroundToolResponse(result)).toBe(false);
  expect(
    isBackgroundResult(JSON.parse(JSON.stringify(backgroundResult('saved')))),
  ).toBe(false);
});

it('lets an after policy preserve or replace background intent', async () => {
  for (const preserve of [true, false]) {
    const selected = tool({
      name: 'save',
      parameters: z.object({}),
      execute: () => backgroundResult('private'),
      after: (output) =>
        preserve
          ? output
          : new ToolOutput([{ type: 'inputText', text: 'public' }]),
    });
    const result = await invokeFunctionTool(selected, {}, context, vi.fn());
    expect(isBackgroundToolResponse(result)).toBe(preserve);
    expect(result.contentItems).toEqual([
      { type: 'inputText', text: preserve ? 'private' : 'public' },
    ]);
  }
});

it('accepts background intent from the final after policy', async () => {
  const selected = tool({
    name: 'save',
    parameters: z.object({}),
    execute: () => 'private',
    after: () =>
      backgroundResult(new ToolOutput([{ type: 'inputText', text: 'public' }])),
  });
  const result = await invokeFunctionTool(selected, {}, context, vi.fn());
  expect(isBackgroundToolResponse(result)).toBe(true);
  expect(result.contentItems).toEqual([{ type: 'inputText', text: 'public' }]);
});

it('does not publish background content when result validation or policy fails', async () => {
  const after = vi.fn((output: ToolOutput) => output);
  const invalid = tool({
    name: 'invalid',
    parameters: z.object({}),
    result: z.number().min(1),
    execute: () => backgroundResult(0),
    after,
  });
  await expect(
    invokeFunctionTool(invalid, {}, context, vi.fn()),
  ).rejects.toThrow('Tool result failed validation');
  expect(after).not.toHaveBeenCalled();
  const failed = tool({
    name: 'failed',
    parameters: z.object({}),
    execute: () => backgroundResult('private'),
    after: () => {
      throw new Error('policy rejected');
    },
  });
  await expect(
    invokeFunctionTool(failed, {}, context, vi.fn()),
  ).rejects.toThrow('policy rejected');
});
