import { describe, it, expect } from 'vitest';
import { computerTool, hostedMcpTool, tool } from '../src/tool';
import { z } from 'zod/v3';
import { Computer } from '../src';
import { RunContext } from '../src/runContext';

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

  it('needsApproval boolean becomes function', async () => {
    const t = tool({
      name: 'appr',
      description: 'appr',
      parameters: z.object({}),
      execute: async () => 'x',
      needsApproval: true,
    });
    const approved = await t.needsApproval(new RunContext(), '', 'id');
    expect(approved).toBe(true);
  });
});
