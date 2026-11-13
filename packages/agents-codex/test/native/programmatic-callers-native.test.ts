import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  hostedTool,
  tool,
  codeInterpreter,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());
const program = {
  type: 'program',
  id: 'program_item',
  call_id: 'parent',
  code: 'lookup()',
};
const completed = {
  type: 'program_output',
  id: 'program_output_item',
  call_id: 'parent',
  status: 'completed',
  result: 'done',
};
const invocation = {
  type: 'function_call',
  id: 'fc_lookup',
  call_id: 'call_lookup',
  name: 'lookup',
  arguments: '{}',
  caller: { type: 'program', caller_id: 'parent' },
};

it.each([
  'positive',
  'positive-namespaced',
  'default-direct',
  'no-permission',
  'no-parent',
  'empty-parent',
  'closed-parent',
  'duplicate-parent',
  'no-builtin',
  'programmatic-only-direct',
  'code-only',
] as const)(
  'admits provider callers through the selected native owner: %s',
  async (scenario) => {
    const effects: string[] = [];
    const namespaced = scenario === 'positive-namespaced';
    const positive =
      scenario === 'positive' || namespaced || scenario === 'default-direct';
    const defaultDirect = scenario === 'default-direct';
    const declared = scenario !== 'no-builtin';
    const allowedCallers =
      scenario === 'no-permission' || defaultDirect
        ? undefined
        : scenario === 'code-only'
          ? (['code'] as const)
          : (['programmatic'] as const);
    const items: JsonObject[] = scenario === 'no-parent' ? [] : [program];
    if (scenario === 'closed-parent') items.push(completed);
    if (scenario === 'duplicate-parent') items.push({ ...program });
    const call: JsonObject = { ...invocation };
    if (namespaced) call.namespace = 'billing';
    if (defaultDirect || scenario === 'programmatic-only-direct')
      delete call.caller;
    if (scenario === 'empty-parent')
      call.caller = { type: 'program', caller_id: '' };
    const server = new ModelServer([[...items, call], [message('done')]]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-programmatic',
      supportsWebsockets: false,
      requestMaxRetries: 0,
      streamMaxRetries: 0,
    });
    const lookup = tool({
      name: 'lookup',
      ...(namespaced ? { namespace: 'billing' } : {}),
      description: 'Return a synthetic value.',
      parameters: z.object({}),
      allowedCallers,
      execute: async () => {
        effects.push('selected');
        return 'ok';
      },
    });
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Use the selected tool.',
      modelSettings: { store: false },
      tools: declared
        ? [
            lookup,
            ...(scenario === 'no-permission' || defaultDirect
              ? [
                  codeInterpreter({
                    container: 'cntr_fixture',
                    allowedCallers: ['programmatic'],
                  }),
                ]
              : []),
            hostedTool({ type: 'programmatic_tool_calling' }),
          ]
        : [lookup],
    });
    if (positive) {
      expect((await agent.run('Call the tool.')).finalOutput).toBe('done');
      expect(effects).toEqual(['selected']);
      expect(server.requests).toHaveLength(2);
      const specs = server.requests[0]?.tools as Record<string, unknown>[];
      if (namespaced)
        expect(
          specs.some(
            (spec) => spec.type === 'namespace' && spec.name === 'billing',
          ),
        ).toBe(true);
      const functions = specs.flatMap((spec) =>
        spec.type === 'namespace'
          ? (spec.tools as Record<string, unknown>[])
          : [spec],
      );
      const declaration = functions.find((spec) => spec.name === 'lookup');
      expect(declaration?.allowed_callers).toEqual(
        defaultDirect ? undefined : ['programmatic'],
      );
      if (!defaultDirect) {
        const replay = server.requests[1]!.input as Record<string, unknown>[];
        expect(
          replay.find(
            (item) =>
              item.type === 'function_call' && item.call_id === 'call_lookup',
          )?.caller,
        ).toEqual(invocation.caller);
      }
      server.assertExhausted();
    } else {
      await expect(agent.run('Call the tool.')).rejects.toThrow();
      expect(effects).toEqual([]);
    }
  },
  20_000,
);

it.each([true, false])(
  'uses the selected handoff tool owner for programmatic permission: %s',
  async (permitted) => {
    const effects: string[] = [];
    const server = new ModelServer([
      [
        {
          type: 'function_call',
          id: 'fc_handoff',
          call_id: 'call_handoff',
          name: 'transfer_to_b',
          arguments: '{}',
        },
      ],
      [program, invocation],
      [message('done')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-selected-owner',
      supportsWebsockets: false,
      requestMaxRetries: 0,
      streamMaxRetries: 0,
    });
    const lookup = (owner: string, allow: boolean) =>
      tool({
        name: 'lookup',
        description: 'Return a synthetic value.',
        parameters: z.object({}),
        allowedCallers: allow ? ['programmatic'] : undefined,
        execute: async () => {
          effects.push(owner);
          return 'ok';
        },
      });
    const companion = () => [
      codeInterpreter({
        container: 'cntr_fixture',
        allowedCallers: ['programmatic'],
      }),
      hostedTool({ type: 'programmatic_tool_calling' }),
    ];
    const b = new Agent({
      name: 'b',
      provider,
      model: 'gpt-5.5',
      instructions: 'Use the selected tool.',
      modelSettings: { store: false },
      tools: [lookup('b', permitted), ...companion()],
    });
    const a = new Agent({
      name: 'a',
      provider,
      model: 'gpt-5.5',
      instructions: 'Hand off to b.',
      tools: [lookup('a', true), ...companion()],
      handoffs: [b],
    });
    if (permitted) {
      expect((await a.run('Use b.')).finalOutput).toBe('done');
      expect(effects).toEqual(['b']);
      server.assertExhausted();
    } else {
      await expect(a.run('Use b.')).rejects.toThrow();
      expect(effects).toEqual([]);
    }
  },
  20_000,
);
