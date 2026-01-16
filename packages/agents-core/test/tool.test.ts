import { describe, it, expect, vi } from 'vitest';
import {
  applyPatchTool,
  computerTool,
  hostedMcpTool,
  shellTool,
  tool,
  resolveComputer,
  disposeResolvedComputers,
} from '../src/tool';
import { z } from 'zod';
import { Computer } from '../src';
import { Agent } from '../src/agent';
import { RunContext } from '../src/runContext';
import { FakeEditor, FakeShell } from './stubs';

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
    expect(t.shell).toBe(shell);
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
});
