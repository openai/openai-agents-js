import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  realtimeHandoff,
  tool,
  toolRef,
  toolSearch,
  TurnAborted,
} from '../../src';
import type { JsonObject, JsonValue } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it.each(['fixture', 'gpt-5.5'])(
  'keeps discovered callback slots separate from profile handoff slots (%s)',
  async (modelName) => {
    const model = new ModelServer([
      [search('search_slots', {})],
      [call('discovered_second', {}, { callId: 'second_slot' })],
      [message('Discovered callback completed.')],
    ]);
    await using provider = await providerFor(model);
    const effects: string[] = [];
    const discovery = toolSearch({
      execution: 'client',
      execute: () =>
        ['first', 'second'].map((name) =>
          tool({
            name: `discovered_${name}`,
            parameters: z.object({}),
            execute: () => {
              effects.push(name);
              return name;
            },
          }),
        ),
    });
    const target = new Agent({
      name: 'handoff_target',
      provider,
      instructions: 'Receive handoffs.',
      tools: [discovery],
    });
    await using session = await new Agent({
      name: 'source',
      instructions: 'Discover and execute tools.',
      provider,
      model: modelName,
      tools: [discovery],
      handoffs: [
        realtimeHandoff(target, {
          name: 'transfer_to_target',
          onHandoff: () => {
            effects.push('handoff');
          },
        }),
      ],
    }).session();
    const completed = await (
      await session.submit('Use the second discovered tool.')
    ).wait();
    expect(completed.finalOutput).toBe('Discovered callback completed.');
    expect(effects).toEqual(['second']);
    expect(model.requests[2].input).toContainEqual(
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'second_slot',
        output: 'second',
      }),
    );
    model.assertExhausted();
  },
  30_000,
);

it('finishes directly from an admitted discovered terminal callback', async () => {
  const model = new ModelServer([
    [search('search_terminal', {})],
    [call('discovered_finish', {}, { callId: 'finish_discovered' })],
    [message('Unexpected model continuation.')],
  ]);
  await using provider = await providerFor(model);
  let executions = 0;
  await using session = await new Agent({
    instructions: 'Finish using a discovered tool.',
    provider,
    model: 'gpt-5.5',
    tools: [
      toolSearch({
        execution: 'client',
        execute: () =>
          tool({
            name: 'discovered_finish',
            parameters: z.object({}),
            finishTurn: true,
            execute: () => {
              executions++;
              return 'Discovered terminal result.';
            },
          }),
      }),
    ],
  }).session();
  const completed = await (
    await session.submit('Finish with the discovered tool.')
  ).wait();
  expect(completed.finalOutput).toBe('Discovered terminal result.');
  expect(executions).toBe(1);
  expect(model.requests).toHaveLength(2);
}, 30_000);

function search(callId: string, argumentsValue: JsonValue): JsonObject {
  return {
    type: 'tool_search_call',
    id: `item_${callId}`,
    call_id: callId,
    execution: 'client',
    status: 'completed',
    arguments: argumentsValue,
  };
}
async function providerFor(model: ModelServer): Promise<NativeProvider> {
  const config = await model.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as JsonObject)
      .base_url as string,
    apiKey: 'synthetic-client-tool-search',
    supportsWebsockets: false,
  });
}
function outputFor(
  model: ModelServer,
  request: number,
  callId: string,
): JsonObject {
  const output = (model.requests[request].input as JsonObject[]).find(
    (item) => item.type === 'tool_search_output' && item.call_id === callId,
  );
  expect(output).toBeDefined();
  expect(model.requests[request].input).not.toContainEqual(
    expect.objectContaining({ type: 'function_call_output', call_id: callId }),
  );
  return output!;
}

it('loads default client paths and executes the captured deferred tool', async () => {
  const model = new ModelServer([
    [search('search_default', { paths: ['lookup', 'missing'] })],
    [call('lookup', { account: 'blue' }, { callId: 'lookup_default' })],
    [message('Account loaded.')],
  ]);
  await using provider = await providerFor(model);
  const effects: string[] = [];
  await using session = await new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Find account tools.',
    tools: [
      toolSearch({ execution: 'client' }),
      tool({
        name: 'lookup',
        parameters: z.object({ account: z.string() }),
        deferLoading: true,
        execute({ account }) {
          effects.push(account);
          return 'active';
        },
      }),
    ],
  }).session();
  expect(
    (await (await session.submit('Find account blue.')).wait()).finalOutput,
  ).toBe('Account loaded.');
  expect(effects).toEqual(['blue']);
  expect(model.requests[0].tools).toContainEqual({
    type: 'tool_search',
    execution: 'client',
  });
  expect(outputFor(model, 1, 'search_default').tools).toContainEqual(
    expect.objectContaining({
      type: 'namespace',
      name: 'functions',
      tools: [expect.objectContaining({ type: 'function', name: 'lookup' })],
    }),
  );
  expect(model.requests[2].input).toContainEqual(
    expect.objectContaining({
      type: 'function_call_output',
      call_id: 'lookup_default',
      output: 'active',
    }),
  );
  model.assertExhausted();
}, 30_000);

it('preserves raw client arguments and original identities while admitting callback tools across follow-up requests', async () => {
  const raw = { department: 'support', tags: ['billing'] };
  const model = new ModelServer([
    [search('search_new', raw)],
    [call('discovered_lookup', { account: 'blue' }, { callId: 'lookup_new' })],
    [search('search_again', raw)],
    [
      call(
        'discovered_lookup',
        { account: 'green' },
        { callId: 'lookup_again' },
      ),
    ],
    [message('Both accounts loaded.')],
  ]);
  await using provider = await providerFor(model);
  const effects: string[] = [];
  const known = tool({
    name: 'known_lookup',
    parameters: z.object({}),
    deferLoading: true,
    execute: () => 'known',
  });
  const discovered = tool({
    name: 'discovered_lookup',
    parameters: z.object({ account: z.string() }),
    execute({ account }) {
      effects.push(account);
      return `loaded:${account}`;
    },
  });
  let searches = 0;
  const agent = new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Use support tools.',
    tools: [
      known,
      toolSearch({
        execution: 'client',
        description: 'Select department tools.',
        parameters: {
          type: 'object',
          properties: {
            department: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
        execute({ agent: original, availableTools, toolCall, runContext }) {
          expect(original).toBe(agent);
          expect(toolCall.arguments).toEqual(raw);
          expect(toolCall.call_id).toBe(runContext.callId);
          expect(availableTools).toContain(known);
          searches++;
          if (searches === 1) return discovered;
          expect(availableTools).toContain(discovered);
          return toolRef('discovered_lookup');
        },
      }),
    ],
  });
  await using session = await agent.session();
  expect(
    (await (await session.submit('Load both accounts.')).wait()).finalOutput,
  ).toBe('Both accounts loaded.');
  expect(searches).toBe(2);
  expect(effects).toEqual(['blue', 'green']);
  for (const [request, callId] of [
    [1, 'search_new'],
    [3, 'search_again'],
  ] as const) {
    expect(outputFor(model, request, callId).tools).toContainEqual(
      expect.objectContaining({
        type: 'namespace',
        name: 'functions',
        tools: [
          expect.objectContaining({
            type: 'function',
            name: 'discovered_lookup',
          }),
        ],
      }),
    );
  }
  model.assertExhausted();
}, 30_000);

it.each(['unknown reference', 'same-key replacement'] as const)(
  'rejects %s without executing a tool',
  async (kind) => {
    const call = [search('search_rejected', { department: 'support' })];
    const recover = kind === 'unknown reference';
    const model = new ModelServer(
      recover ? [call, [message('Selection rejected.')]] : [call],
    );
    await using provider = await providerFor(model);
    const effects: string[] = [];
    const original = tool({
      name: 'lookup',
      parameters: z.object({}),
      deferLoading: true,
      execute() {
        effects.push('original');
        return 'original';
      },
    });
    const replacement = tool({
      name: 'lookup',
      parameters: z.object({}),
      execute() {
        effects.push('replacement');
        return 'replacement';
      },
    });
    await using session = await new Agent({
      provider,
      model: 'fixture-client-tool-search',
      instructions: 'Select tools.',
      tools: [
        original,
        toolSearch({
          execution: 'client',
          execute: () =>
            kind === 'unknown reference' ? toolRef('unavailable') : replacement,
        }),
      ],
    }).session();
    const result = (await session.submit('Select a tool.')).wait();
    if (recover) {
      expect((await result).finalOutput).toBe('Selection rejected.');
      expect(outputFor(model, 1, 'search_rejected').tools).toEqual([]);
    } else {
      await expect(result).rejects.toThrow(
        'Client tool search cannot replace a captured tool',
      );
      expect(model.requests).toHaveLength(1);
    }
    expect(effects).toEqual([]);
    model.assertExhausted();
  },
  30_000,
);

it('joins a cancelled client callback before returning without admitting its discovered tool', async () => {
  const model = new ModelServer([
    [search('search_cancelled', { paths: ['lookup'] })],
    [message('Next turn.')],
  ]);
  await using provider = await providerFor(model);
  let entered!: () => void;
  const entry = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let cleaned = false;
  const discovered = tool({
    name: 'cancelled_lookup',
    parameters: z.object({}),
    execute: () => 'must not run',
  });
  await using session = await new Agent({
    provider,
    model: 'fixture-client-tool-search',
    instructions: 'Select tools.',
    tools: [
      toolSearch({
        execution: 'client',
        async execute({ runContext }) {
          entered();
          try {
            await new Promise<void>((resolve) => {
              if (runContext.signal.aborted) resolve();
              else
                runContext.signal.addEventListener('abort', () => resolve(), {
                  once: true,
                });
            });
            return discovered;
          } finally {
            cleaned = true;
          }
        },
      }),
    ],
  }).session();
  const turn = await session.submit('Select tools.');
  const result = turn.wait();
  void result.catch(() => {});
  await entry;
  await turn.cancel({ mode: 'force' });
  await expect(result).rejects.toBeInstanceOf(TurnAborted);
  expect(cleaned).toBe(true);
  expect(
    (await (await session.submit('Continue without cancelled tools.')).wait())
      .finalOutput,
  ).toBe('Next turn.');
  const specs = model.requests[1].tools as JsonObject[];
  expect(specs).not.toContainEqual(
    expect.objectContaining({ name: 'cancelled_lookup' }),
  );
  model.assertExhausted();
}, 30_000);
