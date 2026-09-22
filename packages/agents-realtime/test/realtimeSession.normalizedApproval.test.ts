import { describe, expect, it, vi } from 'vitest';
import {
  tool,
  UserError,
  type FunctionTool,
  type StandardSchemaWithJSON,
} from '@openai/agents-core';
import { z } from 'zod';
import { z as z4 } from 'zod/v4';
import { RealtimeAgent } from '../src/realtimeAgent';
import { RealtimeSession } from '../src/realtimeSession';
import { ScriptedRealtimeTransport } from '../src/testing';
import { waitForEvent } from './realtimeSessionTestUtils';
import logger from '../src/logger';

async function startSession(functionTool: FunctionTool<any, any, any>) {
  const transport = new ScriptedRealtimeTransport();
  const session = new RealtimeSession(
    new RealtimeAgent({ name: 'Approval', tools: [functionTool] }),
    { transport, tracingDisabled: true },
  );
  await session.connect({ apiKey: 'test' });
  await transport.expectCall('connect');
  return { session, transport };
}

const call = {
  type: 'function_call' as const,
  name: 'normalized',
  callId: 'normalized-call',
  arguments: '{}',
  responseId: 'response',
};

describe('Realtime normalized approval input', () => {
  it.each(['automatic', 'manual'] as const)(
    'snapshots application-owned input before an async %s policy',
    async (decision) => {
      const source = { amount: 1 };
      let entered!: () => void;
      let release!: () => void;
      const policyEntered = new Promise<void>((resolve) => (entered = resolve));
      const policyGate = new Promise<void>((resolve) => (release = resolve));
      const parameters: StandardSchemaWithJSON<object, { amount: number }> = {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: () => ({ value: source }),
          jsonSchema: {
            input: () => ({
              type: 'object',
              properties: {},
              additionalProperties: false,
            }),
            output: () => ({ type: 'object' }),
          },
        },
      };
      const needsApproval = vi.fn(
        async (_context, input: { amount: number }) => {
          expect(input.amount).toBe(1);
          entered();
          await policyGate;
          expect(input.amount).toBe(1);
          return decision === 'manual';
        },
      );
      const execute = vi.fn(async (input: { amount: number }) => {
        expect(input).toEqual({ amount: 1 });
        expect(input).not.toBe(source);
        return 'executed';
      });
      const { session, transport } = await startSession(
        tool({
          name: call.name,
          description: 'Snapshot shared normalized input.',
          parameters,
          needsApproval,
          execute,
        }),
      );
      const approval =
        decision === 'manual'
          ? waitForEvent<any[]>(session, 'tool_approval_requested')
          : undefined;
      transport.emit('function_call', call);
      await policyEntered;
      source.amount = 999;
      release();
      if (approval) {
        const [, , payload] = await approval;
        await session.approve(payload.approvalItem);
      }
      expect(
        (await transport.expectCall('sendFunctionCallOutput')).output,
      ).toBe('executed');
      expect(needsApproval).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
      session.close();
      await transport.expectCall('close');
      transport.assertComplete();
    },
  );

  it.each([
    {
      label: 'Zod 3',
      parameters: z.object({ cc: z.array(z.string()).optional() }),
    },
    {
      label: 'Zod 4',
      parameters: z4.object({ cc: z4.array(z4.string()).optional() }),
    },
    {
      label: 'strict JSON',
      parameters: {
        type: 'object' as const,
        properties: {
          cc: { type: 'array' as const, items: { type: 'string' as const } },
        },
        required: [],
        additionalProperties: false,
      },
    },
  ])('normalizes optional null for $label', async ({ parameters }) => {
    const needsApproval = vi.fn(async (_context, input) => {
      expect(input).toEqual({});
      return false;
    });
    const execute = vi.fn(async (input) => {
      expect(input).toEqual({});
      return 'normalized';
    });
    const { session, transport } = await startSession(
      tool<any>({
        name: call.name,
        description: 'Normalize optional input.',
        parameters,
        needsApproval,
        execute,
      }),
    );
    transport.emit('function_call', { ...call, arguments: '{"cc":null}' });
    expect((await transport.expectCall('sendFunctionCallOutput')).output).toBe(
      'normalized',
    );
    expect(needsApproval).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    session.close();
    await transport.expectCall('close');
    transport.assertComplete();
  });

  it.each(['automatic', 'approve', 'reject'] as const)(
    'retains one normalized snapshot on %s',
    async (decision) => {
      let count = 0;
      const transform = vi.fn(({ value }: { value: number }) => ({
        nested: { value: value + ++count },
      }));
      const needsApproval = vi.fn(async (_context, input) => {
        expect(input).toEqual({ nested: { value: 8 } });
        input.nested.value = 99;
        return decision !== 'automatic';
      });
      const execute = vi.fn(async (input) => {
        expect(input).toEqual({ nested: { value: 8 } });
        return 'executed';
      });
      const { session, transport } = await startSession(
        tool({
          name: call.name,
          description: 'Normalize once.',
          parameters: z
            .object({ value: z.number().default(7) })
            .transform(transform),
          needsApproval,
          execute,
        }),
      );
      const approval =
        decision === 'automatic'
          ? undefined
          : waitForEvent<any[]>(session, 'tool_approval_requested');
      transport.emit('function_call', call);
      if (approval) {
        const [, , payload] = await approval;
        expect(execute).not.toHaveBeenCalled();
        // Repeated delivery cannot replace the retained invocation.
        transport.emit('function_call', call);
        await session[decision === 'approve' ? 'approve' : 'reject'](
          payload.approvalItem,
        );
      }
      const output = await transport.expectCall('sendFunctionCallOutput');
      expect(output.output).toBe(
        decision === 'reject' ? 'Tool execution was not approved.' : 'executed',
      );
      expect(transform).toHaveBeenCalledTimes(1);
      expect(needsApproval).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(decision === 'reject' ? 0 : 1);
      session.close();
      await transport.expectCall('close');
      transport.assertComplete();
    },
  );

  it.each(['Zod', 'Standard Schema'] as const)(
    'requires manual approval for invalid %s input and preserves the decision outcome',
    async (schema) => {
      for (const decision of ['approve', 'reject'] as const) {
        const validate = vi.fn(() => ({
          issues: [{ message: 'value must be a string' }],
        }));
        const standard: StandardSchemaWithJSON<
          { value: string },
          { value: string }
        > = {
          '~standard': {
            version: 1,
            vendor: 'test',
            validate,
            jsonSchema: {
              input: () => ({
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
                additionalProperties: false,
              }),
              output: () => ({ type: 'object' }),
            },
          },
        };
        const needsApproval = vi.fn(
          async (_context, input: { value: string }) =>
            input.value !== 'automatic',
        );
        const execute = vi.fn(async () => 'executed');
        const errorFunction = vi.fn(() => 'Please provide a string value.');
        const { session, transport } = await startSession(
          tool({
            name: call.name,
            description: 'Reject schema-invalid input before a typed policy.',
            parameters:
              schema === 'Zod' ? z.object({ value: z.string() }) : standard,
            needsApproval,
            execute,
            errorFunction,
          }),
        );
        try {
          const approval = waitForEvent<any[]>(
            session,
            'tool_approval_requested',
          );
          transport.emit('function_call', {
            ...call,
            arguments: '{"value":123}',
          });
          const [, , payload] = await approval;
          expect(needsApproval).not.toHaveBeenCalled();
          expect(errorFunction).not.toHaveBeenCalled();
          expect(execute).not.toHaveBeenCalled();
          await session[decision](payload.approvalItem);
          expect(
            (await transport.expectCall('sendFunctionCallOutput')).output,
          ).toBe(
            decision === 'approve'
              ? 'Please provide a string value.'
              : 'Tool execution was not approved.',
          );
          expect(needsApproval).not.toHaveBeenCalled();
          expect(execute).not.toHaveBeenCalled();
          expect(errorFunction).toHaveBeenCalledTimes(
            decision === 'approve' ? 1 : 0,
          );
          if (schema === 'Standard Schema') {
            expect(validate).toHaveBeenCalledTimes(1);
          }
        } finally {
          session.close();
          await transport.expectCall('close');
          transport.assertComplete();
        }
      }
    },
  );

  it('surfaces unsupported async validation before approval or tool callbacks', async () => {
    const validate = vi.fn(async () => ({ value: {} }));
    const parameters: StandardSchemaWithJSON<object> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate,
        jsonSchema: {
          input: () => ({
            type: 'object',
            properties: {},
            additionalProperties: false,
          }),
          output: () => ({ type: 'object' }),
        },
      },
    };
    const needsApproval = vi.fn(async () => false);
    const execute = vi.fn(async () => 'executed');
    const errorFunction = vi.fn(() => 'fallback');
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const { session, transport } = await startSession(
      tool({
        name: call.name,
        description: 'Reject async validation.',
        parameters,
        needsApproval,
        execute,
        errorFunction,
      }),
    );
    try {
      const outcome = new Promise<{ type: string; error?: unknown }>(
        (resolve) => {
          session.once('error', (event) =>
            resolve({ type: 'error', error: event.error }),
          );
          session.once('tool_approval_requested', () =>
            resolve({ type: 'approval' }),
          );
        },
      );
      transport.emit('function_call', call);
      const event = await outcome;
      expect(event.type).toBe('error');
      expect(event.error).toBeInstanceOf(UserError);
      expect((event.error as Error).message).toContain(
        'Async Standard Schema validation is not supported',
      );
      expect(validate).toHaveBeenCalledTimes(1);
      expect(needsApproval).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(errorFunction).not.toHaveBeenCalled();
    } finally {
      session.close();
      await transport.expectCall('close');
      transport.assertComplete();
      errorLog.mockRestore();
    }
  });

  it('rejects a custom Standard Schema output before requesting approval', async () => {
    class Output {
      constructor(private value: number) {}
      read() {
        return this.value;
      }
    }
    let count = 0;
    const validate = vi.fn(() => ({ value: new Output(++count) }));
    const parameters: StandardSchemaWithJSON<object, Output> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate,
        jsonSchema: {
          input: () => ({
            type: 'object',
            properties: {},
            additionalProperties: false,
          }),
          output: () => ({ type: 'object' }),
        },
      },
    };
    const needsApproval = vi.fn(async () => false);
    const execute = vi.fn(async (input: Output) => String(input.read()));
    const { session, transport } = await startSession(
      tool({
        name: call.name,
        description: 'Validate a custom output.',
        parameters,
        needsApproval,
        execute,
      }),
    );
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const outcome = new Promise<{ type: string; error?: unknown }>(
        (resolve) => {
          session.once('error', (event) =>
            resolve({ type: 'error', error: event.error }),
          );
          session.once('tool_approval_requested', () =>
            resolve({ type: 'approval' }),
          );
        },
      );
      transport.emit('function_call', call);
      const event = await outcome;
      expect(event.type).toBe('error');
      expect(event.error).toBeInstanceOf(UserError);
      expect((event.error as Error).message).toContain(
        'requires copyable plain normalized input',
      );
      expect(needsApproval).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(validate).toHaveBeenCalledTimes(1);
    } finally {
      errorLog.mockRestore();
    }
    session.close();
    await transport.expectCall('close');
    transport.assertComplete();
  });

  it('discards a pending normalized snapshot across reconnect', async () => {
    const transform = vi.fn(({ value }) => ({ value: value + 1 }));
    const execute = vi.fn(async () => 'executed');
    const { session, transport } = await startSession(
      tool({
        name: call.name,
        description: 'Keep connection ownership.',
        parameters: z
          .object({ value: z.number().default(7) })
          .transform(transform),
        needsApproval: async () => true,
        execute,
      }),
    );
    const approval = waitForEvent<any[]>(session, 'tool_approval_requested');
    transport.emit('function_call', call);
    const [, , payload] = await approval;
    session.close();
    await transport.expectCall('close');
    await session.connect({ apiKey: 'test' });
    await transport.expectCall('connect');
    await expect(session.approve(payload.approvalItem)).rejects.toThrow();
    expect(transform).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    session.close();
    await transport.expectCall('close');
    transport.assertComplete();
  });
});
