import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  invokeFunctionTool,
  managedApproval,
  tool,
} from '../src/runtime/tools';

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

it.each([null, 7, [], '7'])(
  'preserves non-object original JSON: %j',
  async (original) => {
    const format = vi.fn((_context, _error, args) => {
      expect(args).toEqual(original);
      return '';
    });
    const execute = vi.fn();
    const selected = tool({
      name: 'lookup',
      parameters: z.object({ key: z.string() }),
      inputErrorFunction: format,
      execute,
    });
    expect(
      await invokeFunctionTool(selected, original, context, vi.fn()),
    ).toEqual({
      success: false,
      contentItems: [{ type: 'inputText', text: '' }],
    });
    expect(format).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  },
);

it('snapshots original input before a mutating validator and detaches the handler copy', async () => {
  const raw = { key: 'original' };
  const selected = tool({
    name: 'lookup',
    parameters: z.object({
      key: z.string().refine(() => {
        raw.key = 'validator';
        return false;
      }),
    }),
    inputErrorFunction: (_context, _error, original) => {
      expect(original).toEqual({ key: 'original' });
      (original as { key: string }).key = 'formatter';
      return 'retry';
    },
    execute: vi.fn(),
  });
  await invokeFunctionTool(selected, raw, context, vi.fn());
  expect(raw).toEqual({ key: 'validator' });
});

it('rechecks authority after a validator revokes admission', async () => {
  let live = true;
  const format = vi.fn(() => 'retry');
  const selected = tool({
    name: 'lookup',
    parameters: z.object({
      key: z.string().refine(() => {
        live = false;
        return false;
      }),
    }),
    inputErrorFunction: format,
    execute: vi.fn(),
  });
  await expect(
    invokeFunctionTool(selected, { key: 'value' }, context, vi.fn(), () => {
      if (!live) throw new Error('expired');
    }),
  ).rejects.toThrow('expired');
  expect(format).not.toHaveBeenCalled();
});

it('rejects publication after cancellation during an awaited formatter', async () => {
  const controller = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const selected = tool({
    name: 'lookup',
    parameters: z.object({ key: z.string() }),
    inputErrorFunction: async () => {
      entered();
      await gate;
      return 'late';
    },
    execute: vi.fn(),
  });
  const result = invokeFunctionTool(
    selected,
    { key: 7 },
    { ...context, signal: controller.signal },
    vi.fn(),
  );
  await started;
  const cancelled = new Error('cancelled');
  controller.abort(cancelled);
  release();
  await expect(result).rejects.toBe(cancelled);
});

it('keeps replacement, restored approval, and output validation outside recovery', async () => {
  const format = vi.fn(() => 'retry');
  const selected = tool({
    name: 'lookup',
    parameters: z.object({ key: z.string() }),
    result: z.string(),
    inputErrorFunction: format,
    execute: () => 42 as unknown as string,
  });
  await expect(
    invokeFunctionTool(
      selected,
      { key: 'valid' },
      context,
      vi.fn(),
      undefined,
      { key: 7 },
    ),
  ).rejects.toBeInstanceOf(z.ZodError);
  await expect(
    invokeFunctionTool(selected, { key: 'valid' }, context, vi.fn()),
  ).rejects.toThrow('Tool result failed validation');
  const approval = managedApproval(
    tool({
      name: 'approved',
      parameters: z.object({ key: z.string() }),
      needsApproval: true,
      inputErrorFunction: format,
      execute: () => '',
    }),
  )!;
  expect(() => approval.parseInput({ key: 7 })).toThrow(z.ZodError);
  await expect(
    approval.prepare({ key: 7 }, context, () => {}, true),
  ).rejects.toBeInstanceOf(z.ZodError);
  expect(format).not.toHaveBeenCalled();
});

it('preserves arbitrary validator and formatter errors', async () => {
  const failure = new Error('validator failure');
  const format = vi.fn(() => 'retry');
  const selected = tool({
    name: 'lookup',
    parameters: z.object({
      key: z.string().refine(() => {
        throw failure;
      }),
    }),
    inputErrorFunction: format,
    execute: vi.fn(),
  });
  await expect(
    invokeFunctionTool(selected, { key: 'value' }, context, vi.fn()),
  ).rejects.toBe(failure);
  expect(format).not.toHaveBeenCalled();
  const badFormatter = tool({
    name: 'lookup',
    parameters: z.object({ key: z.string() }),
    inputErrorFunction: () => {
      throw failure;
    },
    execute: vi.fn(),
  });
  await expect(
    invokeFunctionTool(badFormatter, { key: 7 }, context, vi.fn()),
  ).rejects.toBe(failure);
});

it('preserves untouched managed input through validator and formatter mutation', async () => {
  const raw = { payload: { key: 7 } };
  const selected = tool({
    name: 'lookup',
    needsApproval: true,
    parameters: z.object({
      payload: z.object({ key: z.number() }).superRefine((value, issue) => {
        value.key = 999;
        issue.addIssue({ code: 'custom', message: 'Invalid nested value' });
      }),
    }),
    inputErrorFunction: (_context, _error, original) => {
      expect(original).toEqual({ payload: { key: 7 } });
      (original as typeof raw).payload.key = 33;
      return 'retry';
    },
    execute: vi.fn(),
  });
  expect(
    await managedApproval(selected)!.prepareOriginalInput!(
      raw,
      context,
      vi.fn(),
    ),
  ).toEqual({ failure: 'retry' });
  expect(raw).toEqual({ payload: { key: 7 } });
});
