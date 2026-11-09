import { tool as classicTool } from '@openai/agents/classic';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent } from '../src/runtime/public-agent';
import { NativeProvider } from '../src/runtime/provider';
import { manualTool } from '../src/runtime/manual';
import {
  createNamespacedFunctionTool,
  tool as functionTool,
  ToolOutput,
  type FunctionTool,
  type Tool,
} from '../src/runtime/tools';

// These host-only checks stop at provider acquisition. Keep only the native
// declaration preflight validators; the native suite covers their implementation.
vi.mock('../src/runtime/binding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/runtime/binding')>()),
  binding: async () => ({
    _validate_python_tool_declarations: () => undefined,
    _validate_application_instructions: () => undefined,
  }),
}));

const nativeLoad = vi.hoisted(() => vi.fn());
vi.mock('../native/index.js', () => {
  nativeLoad();
  throw new Error('Host-only boundary test attempted to load the native addon');
});
afterEach(() => {
  expect(nativeLoad).not.toHaveBeenCalled();
});

function openingProbe() {
  const provider = new NativeProvider({ apiKey: 'synthetic-test-key' });
  const acquire = vi.spyOn(provider, '_acquire').mockImplementation(() => {
    throw new Error('provider opening reached');
  });
  return { provider, acquire };
}

describe('native and Classic tool boundaries', () => {
  it('rejects a Classic tool before opening provider resources', async () => {
    const { provider, acquire } = openingProbe();
    const execute = vi.fn(() => 'legacy output');
    const legacy = classicTool({
      name: 'legacy',
      description: 'A retained Classic tool.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      execute,
    });
    const agent = new Agent({
      instructions: 'Use native declarations.',
      provider,
      tools: [legacy as unknown as FunctionTool],
    });

    await expect(agent.session()).rejects.toThrow('Native function tools');
    expect(acquire).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    [
      'native',
      () =>
        functionTool({
          name: 'native',
          description: 'A native function.',
          parameters: z.object({}),
          execute: () => 'native output',
        }),
    ],
    [
      'captured native',
      () => ({
        ...functionTool({
          name: 'captured',
          description: 'A copied native declaration.',
          parameters: z.object({}),
          execute: () => 'native output',
        }),
      }),
    ],
    [
      'manual',
      () =>
        manualTool({
          name: 'manual',
          description: 'A manual declaration.',
          parameters: z.object({}),
          result: z.string(),
        }),
    ],
    [
      'borrowed MCP',
      () =>
        createNamespacedFunctionTool({
          namespace: { name: 'borrowed' },
          name: 'mcp',
          description: 'A borrowed MCP declaration.',
          parameters: { type: 'object', properties: {} },
          execute: async () => new ToolOutput([]),
        }),
    ],
  ] satisfies [string, () => Tool][])(
    'preserves opening for %s declarations',
    async (_name, declaration) => {
      const { provider, acquire } = openingProbe();
      const agent = new Agent({
        instructions: 'Use native declarations.',
        provider,
        tools: [declaration()],
      });

      await expect(agent.session()).rejects.toThrow('provider opening reached');
      expect(acquire).toHaveBeenCalledOnce();
    },
  );
});
