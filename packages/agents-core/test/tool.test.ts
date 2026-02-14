import { describe, it, expect, vi } from 'vitest';
import {
  applyPatchTool,
  computerTool,
  hostedMcpTool,
  invokeFunctionTool,
  shellTool,
  tool,
  resolveComputer,
  disposeResolvedComputers,
} from '../src/tool';
import type { ShellTool } from '../src/tool';
import { z } from 'zod';
import { Computer } from '../src';
import { Agent } from '../src/agent';
import { RunContext } from '../src/runContext';
import { FakeEditor, FakeShell } from './stubs';
import { ToolTimeoutError } from '../src/errors';

interface Bar {
  bar: string;
}

describe('Tool', () => {
  it('create a tool with zod definition', () => {
    const t = tool({
      name: 'test',
      description: 'test',
      parameters: z.object({
        foo: z.string(),
      }),
      execute: async ({ foo }): Promise<Bar> => {
        expect(typeof foo).toBe('string');
        return { bar: `foo: ${foo}` };
      },
    });
    expect(Object.keys(t.parameters.properties).length).toEqual(1);
    expect(t.parameters.required.length).toEqual(1);
  });

  it('computerTool', () => {
    const t = computerTool({
      computer: {} as Computer,
    });
    expect(t).toBeDefined();
    expect(t.type).toBe('computer');
    expect(t.name).toBe('computer_use_preview');
  });

  it('computerTool initializes computer per run context when an initializer is provided', async () => {
    const initializer = vi.fn(
      async (): Promise<Computer> => ({
        environment: 'mac' as const,
        dimensions: [1, 1],
        screenshot: async () => 'img',
        click: async () => {},
        doubleClick: async () => {},
        drag: async () => {},
        keypress: async () => {},
        move: async () => {},
        scroll: async () => {},
        type: async () => {},
        wait: async () => {},
      }),
    );
    const t = computerTool({ name: 'comp', computer: initializer });

    const ctxA = new RunContext();
    const ctxB = new RunContext();

    const compA1 = await resolveComputer({ tool: t, runContext: ctxA });
    const compA2 = await resolveComputer({ tool: t, runContext: ctxA });
    const compB1 = await resolveComputer({ tool: t, runContext: ctxB });

    expect(initializer).toHaveBeenCalledTimes(2);
    expect(compA1).toBe(compA2);
    expect(compA1).not.toBe(compB1);
    expect(t.computer).toBe(compB1);
  });

  it('resolveComputer reuses provided static instance without invoking initializer logic', async () => {
    const staticComp = {
      environment: 'mac' as const,
      dimensions: [1, 1] as [number, number],
      screenshot: async () => 'img',
      click: async () => {},
      doubleClick: async () => {},
      drag: async () => {},
      keypress: async () => {},
      move: async () => {},
      scroll: async () => {},
      type: async () => {},
      wait: async () => {},
    };
    const initSpy = vi.fn();
    const t = computerTool({ computer: staticComp });
    const ctx = new RunContext();

    const first = await resolveComputer({ tool: t, runContext: ctx });
    const second = await resolveComputer({ tool: t, runContext: ctx });

    expect(first).toBe(staticComp);
    expect(second).toBe(staticComp);
    expect(initSpy).not.toHaveBeenCalled();
  });

  it('supports lifecycle initializers with dispose per run context', async () => {
    let counter = 0;
    const makeComputer = (label: string) =>
      ({
        environment: 'mac' as const,
        dimensions: [1, 1] as [number, number],
        screenshot: async () => 'img',
        click: async () => {},
        doubleClick: async () => {},
        drag: async () => {},
        keypress: async () => {},
        move: async () => {},
        scroll: async () => {},
        type: async () => {},
        wait: async () => {},
        label,
      }) as Computer & { label: string };

    const dispose = vi.fn(async () => {});
    const initializer = vi.fn(async () => {
      counter += 1;
      return makeComputer(`computer-${counter}`);
    });

    const t = computerTool({
      computer: {
        create: initializer,
        dispose,
      },
    });
    const ctx = new RunContext();

    const first = await resolveComputer({ tool: t, runContext: ctx });
    expect(initializer).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();

    await disposeResolvedComputers({ runContext: ctx });

    const second = await resolveComputer({ tool: t, runContext: ctx });
    expect(initializer).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith({ runContext: ctx, computer: first });
    expect(second).not.toBe(first);
  });

  it('shellTool assigns default name', () => {
    const shell = new FakeShell();
    const t = shellTool({ shell });
    expect(t.type).toBe('shell');
    expect(t.name).toBe('shell');
    expect(t.environment.type).toBe('local');
    expect(t.environment).toEqual({ type: 'local' });
    expect(t.shell).toBe(shell);
  });

  it('ShellTool keeps local environment optional for compatibility', () => {
    const legacyTool: ShellTool = {
      type: 'shell',
      name: 'shell',
      shell: new FakeShell(),
      needsApproval: async () => false,
    };
    expect(legacyTool.environment).toBeUndefined();
  });

  it('shellTool supports hosted container environments without local shell', () => {
    const t = shellTool({
      environment: { type: 'container_reference', containerId: 'cont_123' },
    });
    expect(t.environment).toEqual({
      type: 'container_reference',
      containerId: 'cont_123',
    });
    expect(t.shell).toBeUndefined();
  });

  it('shellTool normalizes container_auto options with inline skills', () => {
    const t = shellTool({
      environment: {
        type: 'container_auto',
        fileIds: ['file_123'],
        memoryLimit: '4g',
        networkPolicy: {
          type: 'allowlist',
          allowedDomains: ['example.com'],
          domainSecrets: [
            {
              domain: 'example.com',
              name: 'API_TOKEN',
              value: 'secret',
            },
          ],
        },
        skills: [
          {
            type: 'inline',
            name: 'csv-workbench',
            description: 'Analyze CSV files.',
            source: {
              type: 'base64',
              mediaType: 'application/zip',
              data: 'ZmFrZS16aXA=',
            },
          },
        ],
      },
    });

    expect(t.environment).toEqual({
      type: 'container_auto',
      fileIds: ['file_123'],
      memoryLimit: '4g',
      networkPolicy: {
        type: 'allowlist',
        allowedDomains: ['example.com'],
        domainSecrets: [
          {
            domain: 'example.com',
            name: 'API_TOKEN',
            value: 'secret',
          },
        ],
      },
      skills: [
        {
          type: 'inline',
          name: 'csv-workbench',
          description: 'Analyze CSV files.',
          source: {
            type: 'base64',
            mediaType: 'application/zip',
            data: 'ZmFrZS16aXA=',
          },
        },
      ],
    });
  });

  it('shellTool rejects local mode without a shell implementation', () => {
    expect(() => shellTool({ environment: { type: 'local' } } as any)).toThrow(
      /requires a shell implementation/,
    );
  });

  it('shellTool rejects container_reference without containerId', () => {
    expect(() =>
      shellTool({ environment: { type: 'container_reference' } as any }),
    ).toThrow(/requires a containerId/);
  });

  it('shellTool rejects skill_reference without skillId', () => {
    expect(() =>
      shellTool({
        environment: {
          type: 'container_auto',
          skills: [{ type: 'skill_reference' } as any],
        },
      }),
    ).toThrow(/requires a skillId/);
  });

  it('shellTool rejects inline skill source with unsupported media type', () => {
    expect(() =>
      shellTool({
        environment: {
          type: 'container_auto',
          skills: [
            {
              type: 'inline',
              name: 'bad-inline',
              description: 'invalid skill',
              source: {
                type: 'base64',
                mediaType: 'application/json' as any,
                data: 'eyJmb28iOiJiYXIifQ==',
              },
            },
          ],
        },
      }),
    ).toThrow(/must be application\/zip/);
  });

  it('shellTool rejects inline skill without a source object', () => {
    expect(() =>
      shellTool({
        environment: {
          type: 'container_auto',
          skills: [
            {
              type: 'inline',
              name: 'bad-inline',
              description: 'invalid skill',
            } as any,
          ],
        },
      }),
    ).toThrow(/source is required/);
  });

  it('shellTool rejects shell implementations for hosted environments', () => {
    expect(() =>
      shellTool({
        environment: { type: 'container_reference', containerId: 'cont_123' },
        shell: new FakeShell(),
      } as any),
    ).toThrow(/does not accept a shell implementation/);
  });

  it('shellTool rejects approval hooks for hosted environments', () => {
    expect(() =>
      shellTool({
        environment: { type: 'container_reference', containerId: 'cont_123' },
        needsApproval: true,
      } as any),
    ).toThrow(/does not support needsApproval or onApproval/);

    expect(() =>
      shellTool({
        environment: { type: 'container_reference', containerId: 'cont_123' },
        onApproval: async () => ({ approve: true }),
      } as any),
    ).toThrow(/does not support needsApproval or onApproval/);
  });

  it('shellTool needsApproval boolean becomes function', async () => {
    const shell = new FakeShell();
    const t = shellTool({ shell, needsApproval: true });
    const approved = await t.needsApproval(
      new RunContext(),
      { commands: [] },
      'id',
    );
    expect(approved).toBe(true);
  });

  it('shellTool onApproval is passed through', async () => {
    const shell = new FakeShell();
    const onApproval = vi.fn(async () => ({ approve: true }));
    const t = shellTool({ shell, onApproval });
    expect(t.onApproval).toBe(onApproval);
  });

  it('applyPatchTool assigns default name', () => {
    const editor = new FakeEditor();
    const t = applyPatchTool({ editor });
    expect(t.type).toBe('apply_patch');
    expect(t.name).toBe('apply_patch');
    expect(t.editor).toBe(editor);
  });

  it('applyPatchTool needsApproval boolean becomes function', async () => {
    const editor = new FakeEditor();
    const t = applyPatchTool({ editor, needsApproval: true });
    const approved = await t.needsApproval(
      new RunContext(),
      { type: 'delete_file', path: 'tmp' },
      'id',
    );
    expect(approved).toBe(true);
  });

  it('applyPatchTool onApproval is passed through', async () => {
    const editor = new FakeEditor();
    const onApproval = vi.fn(async () => ({ approve: true }));
    const t = applyPatchTool({ editor, onApproval });
    expect(t.onApproval).toBe(onApproval);
  });
});

describe('create a tool using hostedMcpTool utility', () => {
  it('hostedMcpTool', () => {
    const t = hostedMcpTool({
      serverLabel: 'gitmcp',
      serverUrl: 'https://gitmcp.io/openai/codex',
      requireApproval: 'never',
    });
    expect(t).toBeDefined();
    expect(t.type).toBe('hosted_tool');
    expect(t.name).toBe('hosted_mcp');
    expect(t.providerData.type).toBe('mcp');
    expect(t.providerData.server_label).toBe('gitmcp');
  });

  it('propagates authorization when approval is never required', () => {
    const t = hostedMcpTool({
      serverLabel: 'gitmcp',
      serverUrl: 'https://gitmcp.io/openai/codex',
      authorization: 'secret-token',
      requireApproval: 'never',
    });

    expect(t.providerData.authorization).toBe('secret-token');
  });

  it('propagates authorization when approval is required', () => {
    const t = hostedMcpTool({
      serverLabel: 'gitmcp',
      serverUrl: 'https://gitmcp.io/openai/codex',
      authorization: 'secret-token',
      requireApproval: {
        always: { toolNames: ['tool-name'] },
      },
    });

    expect(t.providerData.authorization).toBe('secret-token');
  });
});

describe('tool.invoke', () => {
  it('parses input and returns result', async () => {
    const t = tool({
      name: 'echo',
      description: 'echo',
      parameters: z.object({ msg: z.string() }),
      execute: async ({ msg }) => `hi ${msg}`,
    });
    const res = await t.invoke(new RunContext(), '{"msg": "there"}');
    expect(res).toBe('hi there');
  });

  it('uses errorFunction on parse error', async () => {
    const t = tool({
      name: 'fail',
      description: 'fail',
      parameters: z.object({ ok: z.string() }),
      execute: async () => 'ok',
      errorFunction: () => 'bad',
    });
    const res = await t.invoke(new RunContext(), 'oops');
    expect(res).toBe('bad');
  });

  it('throws InvalidToolInputError with context on malformed JSON', async () => {
    const t = tool({
      name: 'test',
      description: 'test',
      parameters: z.object({ foo: z.string() }),
      execute: async () => 'ok',
      errorFunction: null, // disable error handling to let the error propagate
    });
    const ctx = new RunContext();
    const malformedInput = '{invalid json}';

    await expect(t.invoke(ctx, malformedInput)).rejects.toMatchObject({
      message: 'Invalid JSON input for tool',
      toolInvocation: {
        runContext: ctx,
        input: malformedInput,
      },
    });
  });

  it('throws InvalidToolInputError with context on Zod validation failure', async () => {
    const t = tool({
      name: 'test',
      description: 'test',
      parameters: z.object({ age: z.number() }),
      execute: async () => 'ok',
      errorFunction: null,
    });
    const ctx = new RunContext();
    const invalidInput = '{"age": "not a number"}';

    await expect(t.invoke(ctx, invalidInput)).rejects.toMatchObject({
      message: 'Invalid JSON input for tool',
      toolInvocation: {
        runContext: ctx,
        input: invalidInput,
      },
    });
  });

  it('errorFunction receives InvalidToolInputError with originalError and toolInvocation', async () => {
    let capturedError: unknown;
    const t = tool({
      name: 'test',
      description: 'test',
      parameters: z.object({ count: z.number() }),
      execute: async () => 'ok',
      errorFunction: (_ctx, error) => {
        capturedError = error;
        return 'handled';
      },
    });
    const ctx = new RunContext();
    const invalidInput = '{"count": "not a number"}';

    const res = await t.invoke(ctx, invalidInput);
    expect(res).toBe('handled');
    expect(capturedError).toMatchObject({
      message: 'Invalid JSON input for tool',
      toolInvocation: {
        runContext: ctx,
        input: invalidInput,
      },
    });
    expect((capturedError as any).originalError).toBeDefined();
  });

  it('needsApproval boolean becomes function', async () => {
    const t = tool({
      name: 'appr',
      description: 'appr',
      parameters: z.object({}),
      execute: async () => 'x',
      needsApproval: true,
    });
    const approved = await t.needsApproval(new RunContext(), {}, 'id');
    expect(approved).toBe(true);
  });

  it('isEnabled boolean becomes function', async () => {
    const t = tool({
      name: 'enabled',
      description: 'enabled',
      parameters: z.object({}),
      execute: async () => 'x',
      isEnabled: false,
    });
    const enabled = await t.isEnabled(
      new RunContext(),
      new Agent({ name: 'Test Agent' }),
    );
    expect(enabled).toBe(false);
  });

  it('supports object argument in isEnabled option', async () => {
    const t = tool({
      name: 'predicate',
      description: 'predicate',
      parameters: z.object({}),
      execute: async () => 'x',
      isEnabled: ({
        runContext,
        agent,
      }: {
        runContext: RunContext<unknown>;
        agent: Agent<any, any>;
      }) => {
        expect(agent.name).toBe('Dynamic Agent');
        return (runContext.context as { feature: boolean }).feature;
      },
    });

    const agent = new Agent<{ feature: boolean }>({ name: 'Dynamic Agent' });
    const enabled = await t.isEnabled(new RunContext({ feature: true }), agent);
    const disabled = await t.isEnabled(
      new RunContext({ feature: false }),
      agent,
    );

    expect(enabled).toBe(true);
    expect(disabled).toBe(false);
  });

  it('returns a default timeout message when timeoutMs is exceeded', async () => {
    const t = tool({
      name: 'slow',
      description: 'slow',
      parameters: z.object({}),
      timeoutMs: 5,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return 'done';
      },
    });

    const result = await invokeFunctionTool({
      tool: t,
      runContext: new RunContext(),
      input: '{}',
    });

    expect(result).toBe("Tool 'slow' timed out after 5ms.");
  });

  it('enforces timeout when invoking FunctionTool directly', async () => {
    const t = tool({
      name: 'direct_slow',
      description: 'slow direct invoke',
      parameters: z.object({}),
      timeoutMs: 5,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return 'done';
      },
    });

    const result = await t.invoke(new RunContext(), '{}');

    expect(result).toBe("Tool 'direct_slow' timed out after 5ms.");
  });

  it('uses timeoutErrorFunction when timeoutBehavior is error_as_result', async () => {
    const timeoutErrorFunction = vi.fn((_ctx, error: ToolTimeoutError) => {
      return `timeout:${error.toolName}:${error.timeoutMs}`;
    });
    const t = tool({
      name: 'slow',
      description: 'slow',
      parameters: z.object({}),
      timeoutMs: 5,
      timeoutErrorFunction,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return 'done';
      },
    });

    const result = await invokeFunctionTool({
      tool: t,
      runContext: new RunContext(),
      input: '{}',
    });

    expect(result).toBe('timeout:slow:5');
    expect(timeoutErrorFunction).toHaveBeenCalledTimes(1);
  });

  it('raises ToolTimeoutError when timeoutBehavior is raise_exception', async () => {
    const t = tool({
      name: 'slow',
      description: 'slow',
      parameters: z.object({}),
      timeoutMs: 5,
      timeoutBehavior: 'raise_exception',
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return 'done';
      },
    });

    await expect(
      invokeFunctionTool({
        tool: t,
        runContext: new RunContext(),
        input: '{}',
      }),
    ).rejects.toBeInstanceOf(ToolTimeoutError);
  });

  it('raises ToolTimeoutError when invoking FunctionTool directly with raise_exception', async () => {
    const t = tool({
      name: 'direct_raise',
      description: 'direct invoke with raise_exception',
      parameters: z.object({}),
      timeoutMs: 5,
      timeoutBehavior: 'raise_exception',
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return 'done';
      },
    });

    await expect(t.invoke(new RunContext(), '{}')).rejects.toBeInstanceOf(
      ToolTimeoutError,
    );
  });

  it('preserves receiver context for custom FunctionTool implementations', async () => {
    const invoke = vi.fn(function (
      this: { marker: string },
      _runContext: RunContext<unknown>,
      _input: string,
      _details?: any,
    ) {
      return this.marker;
    });

    const customTool = {
      type: 'function' as const,
      name: 'custom_receiver_tool',
      description: 'custom tool that relies on receiver context',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      strict: true,
      invoke,
      needsApproval: async () => false,
      timeoutMs: 100,
      timeoutBehavior: 'error_as_result' as const,
      isEnabled: async () => true,
      marker: 'receiver-ok',
    };

    const result = await invokeFunctionTool({
      tool: customTool as any,
      runContext: new RunContext(),
      input: '{}',
    });

    expect(result).toBe('receiver-ok');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('aborts the invocation signal when timeoutMs is exceeded', async () => {
    let abortReason: unknown;
    const t = tool({
      name: 'abortable_slow_tool',
      description: 'slow and abortable',
      parameters: z.object({}),
      timeoutMs: 5,
      execute: async (_args, _context, details) => {
        details?.signal?.addEventListener(
          'abort',
          () => {
            abortReason = details.signal?.reason;
          },
          { once: true },
        );

        await new Promise<void>(() => {
          // Intentionally keep pending to assert timeout-driven cancellation.
        });
        return 'done';
      },
    });

    const result = await invokeFunctionTool({
      tool: t,
      runContext: new RunContext(),
      input: '{}',
      details: {
        toolCall: {
          type: 'function_call',
          name: 'abortable_slow_tool',
          callId: 'call-timeout',
          status: 'completed',
          arguments: '{}',
        },
      },
    });

    expect(result).toBe("Tool 'abortable_slow_tool' timed out after 5ms.");
    expect(abortReason).toBeInstanceOf(ToolTimeoutError);
  });

  it('passes timeout abort signals even when details are omitted', async () => {
    let abortReason: unknown;
    let receivedSignal = false;
    let callIdFromDetails: string | undefined;
    const t = tool({
      name: 'abortable_without_details',
      description: 'slow and abortable without invocation details',
      parameters: z.object({}),
      timeoutMs: 5,
      execute: async (_args, _context, details) => {
        callIdFromDetails = details?.toolCall?.callId;

        if (details?.signal) {
          receivedSignal = true;
          details.signal.addEventListener(
            'abort',
            () => {
              abortReason = details.signal?.reason;
            },
            { once: true },
          );
        }

        await new Promise<void>(() => {
          // Intentionally keep pending to assert timeout-driven cancellation.
        });
        return 'done';
      },
    });

    const result = await invokeFunctionTool({
      tool: t,
      runContext: new RunContext(),
      input: '{}',
    });

    expect(result).toBe(
      "Tool 'abortable_without_details' timed out after 5ms.",
    );
    expect(receivedSignal).toBe(true);
    expect(callIdFromDetails).toBeUndefined();
    expect(abortReason).toBeInstanceOf(ToolTimeoutError);
  });

  it('keeps timeout behavior when tools resolve synchronously on abort', async () => {
    const t = tool({
      name: 'abort_resolving_tool',
      description: 'tool that resolves immediately when aborted',
      parameters: z.object({}),
      timeoutMs: 5,
      execute: async (_args, _context, details) => {
        await new Promise<string>((resolve) => {
          details?.signal?.addEventListener(
            'abort',
            () => {
              resolve('resolved-on-abort');
            },
            { once: true },
          );
        });
        return 'done';
      },
    });

    const result = await invokeFunctionTool({
      tool: t,
      runContext: new RunContext(),
      input: '{}',
      details: {
        toolCall: {
          type: 'function_call',
          name: 'abort_resolving_tool',
          callId: 'call-timeout-abort-resolve',
          status: 'completed',
          arguments: '{}',
        },
      },
    });

    expect(result).toBe("Tool 'abort_resolving_tool' timed out after 5ms.");
  });

  it('treats timeout-triggered abort rejections as timeout outcomes', async () => {
    const timeoutErrorFunction = vi.fn(() => 'timed-out');
    const t = tool({
      name: 'abort_rejecting_tool',
      description: 'tool that rejects on abort',
      parameters: z.object({}),
      timeoutMs: 5,
      timeoutErrorFunction,
      execute: async (_args, _context, details) => {
        await new Promise<never>((_, reject) => {
          details?.signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('tool aborted'));
            },
            { once: true },
          );
        });
        return 'done';
      },
    });

    const result = await invokeFunctionTool({
      tool: t,
      runContext: new RunContext(),
      input: '{}',
      details: {
        toolCall: {
          type: 'function_call',
          name: 'abort_rejecting_tool',
          callId: 'call-timeout-reject',
          status: 'completed',
          arguments: '{}',
        },
      },
    });

    expect(result).toBe('timed-out');
    expect(timeoutErrorFunction).toHaveBeenCalledTimes(1);
  });

  it('does not run errorFunction after timeout handling has already won', async () => {
    const timeoutErrorFunction = vi.fn(() => 'timed-out');
    const errorFunction = vi.fn(() => 'tool-error-result');
    const t = tool({
      name: 'abort_rejecting_tool_without_error_side_effects',
      description: 'tool that rejects on abort after timeout resolves',
      parameters: z.object({}),
      timeoutMs: 5,
      timeoutErrorFunction,
      errorFunction,
      execute: async (_args, _context, details) => {
        await new Promise<never>((_, reject) => {
          details?.signal?.addEventListener(
            'abort',
            () => {
              setTimeout(() => reject(new Error('tool aborted')), 0);
            },
            { once: true },
          );
        });
      },
    });

    const result = await invokeFunctionTool({
      tool: t,
      runContext: new RunContext(),
      input: '{}',
      details: {
        toolCall: {
          type: 'function_call',
          name: 'abort_rejecting_tool_without_error_side_effects',
          callId: 'call-timeout-reject-side-effects',
          status: 'completed',
          arguments: '{}',
        },
      },
    });

    expect(result).toBe('timed-out');
    expect(timeoutErrorFunction).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(errorFunction).not.toHaveBeenCalled();
  });

  it('validates timeoutMs and timeoutErrorFunction options', () => {
    expect(() =>
      tool({
        name: 'bad-timeout',
        description: 'bad-timeout',
        parameters: z.object({}),
        timeoutMs: 0,
        execute: async () => 'ok',
      }),
    ).toThrow(/timeoutMs must be greater than 0/);

    expect(() =>
      tool({
        name: 'bad-timeout-max',
        description: 'bad-timeout-max',
        parameters: z.object({}),
        timeoutMs: 2_147_483_648,
        execute: async () => 'ok',
      }),
    ).toThrow(/timeoutMs must be less than or equal to 2147483647/);

    expect(() =>
      tool({
        name: 'bad-timeout-fn',
        description: 'bad-timeout-fn',
        parameters: z.object({}),
        timeoutErrorFunction: 'not-a-function' as any,
        execute: async () => 'ok',
      }),
    ).toThrow(/timeoutErrorFunction must be a function/);

    expect(() =>
      tool({
        name: 'bad-timeout-behavior',
        description: 'bad-timeout-behavior',
        parameters: z.object({}),
        timeoutBehavior: 'unsupported' as any,
        execute: async () => 'ok',
      }),
    ).toThrow(/timeoutBehavior must be one of/);
  });
});
