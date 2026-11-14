import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  AiSdkModel,
  NativeProvider,
  tool,
  toolRef,
  parseSessionState,
} from '../../src';

it.each([false, true])(
  'routes equal function names in separate namespaces through native AI SDK turns stream=%s',
  async (stream) => {
    const requests: any[] = [];
    const effects: string[] = [];
    const backend = new AiSdkModel(
      {
        specificationVersion: 'v3',
        provider: 'fixture.namespaces',
        modelId: 'fixture',
        doGenerate(request) {
          requests.push(request);
          return requests.length === 1
            ? {
                content: ['crm', 'inventory'].map((namespace) => ({
                  type: 'tool-call',
                  toolCallId: namespace,
                  toolName: namespace + '.lookup',
                  input: '{}',
                })),
                finishReason: 'tool-calls',
              }
            : {
                content: [{ type: 'text', text: 'Done.' }],
                finishReason: 'stop',
              };
        },
        doStream(request) {
          const result = this.doGenerate(request);
          return {
            stream: new ReadableStream({
              start(controller) {
                for (const part of result.content)
                  controller.enqueue(
                    part.type === 'text'
                      ? { type: 'text-delta', id: 'answer', delta: part.text }
                      : part,
                  );
                controller.enqueue({
                  type: 'finish',
                  finishReason: result.finishReason,
                });
                controller.close();
              },
            }),
          };
        },
      },
      {},
      { stream },
    );
    await using provider = new NativeProvider({ modelBackend: backend });
    const agent = new Agent({
      instructions: 'Use both lookups.',
      model: 'fixture',
      provider,
      tools: ['crm', 'inventory'].map((namespace) =>
        tool({
          name: 'lookup',
          namespace,
          parameters: z.object({}),
          execute() {
            effects.push(namespace);
            return namespace;
          },
        }),
      ),
    });
    await using session = await agent.session();
    expect((await (await session.submit('Look up.')).wait()).finalOutput).toBe(
      'Done.',
    );
    const saved = JSON.stringify(await session.saveState());
    await session.close();
    await using restored = await agent.session({
      state: parseSessionState(saved),
    });
    expect(
      (await (await restored.submit('Continue.')).wait()).finalOutput,
    ).toBe('Done.');
    expect(requests[0].tools.map((entry: any) => entry.name)).toEqual([
      'crm.lookup',
      'inventory.lookup',
    ]);
    expect(effects.sort()).toEqual(['crm', 'inventory']);
    const calls = requests[1].prompt
      .filter((row: any) => row.role === 'assistant')
      .flatMap((row: any) => row.content)
      .filter((part: any) => part.type === 'tool-call');
    expect(calls.map((part: any) => part.toolName)).toEqual([
      'crm.lookup',
      'inventory.lookup',
    ]);
    const replay = requests[2].prompt.flatMap((row: any) =>
      Array.isArray(row.content) ? row.content : [],
    );
    for (const type of ['tool-call', 'tool-result'])
      expect(
        replay
          .filter((part: any) => part.type === type)
          .map((part: any) => part.toolName),
      ).toEqual(['crm.lookup', 'inventory.lookup']);
  },
);

it('selects a captured namespaced tool and rejects ambiguous qualified declarations before model invocation', async () => {
  const requests: any[] = [];
  const model = new AiSdkModel({
    specificationVersion: 'v3',
    provider: 'fixture.namespaces',
    modelId: 'fixture',
    doGenerate(request) {
      requests.push(request);
      return {
        content: [{ type: 'text', text: 'Done.' }],
        finishReason: 'stop',
      };
    },
  });
  await using provider = new NativeProvider({ modelBackend: model });
  const lookup = tool({
    name: 'lookup',
    namespace: 'crm',
    parameters: z.object({}),
    execute: () => 'crm',
  });
  await new Agent({
    instructions: 'Answer.',
    model: 'fixture',
    provider,
    tools: [lookup],
    modelSettings: { toolChoice: toolRef('lookup', 'crm') },
  }).run('Select.');
  expect(requests[0].toolChoice).toEqual({ type: 'required' });
  expect(requests[0].tools.map((entry: any) => entry.name)).toEqual([
    'crm.lookup',
  ]);
  requests.length = 0;
  const literal = tool({
    name: 'crm.lookup',
    parameters: z.object({}),
    execute: () => 'wrong',
  });
  await expect(
    new Agent({
      instructions: 'Answer.',
      model: 'fixture',
      provider,
      tools: [lookup, literal],
    }).run('Ambiguous.'),
  ).rejects.toThrow(/disambiguate qualified/);
  expect(requests).toHaveLength(0);
});

it('uses the captured qualified function identity instead of an untrusted raw namespace', async () => {
  let calls = 0;
  const effects: string[] = [];
  const backend = new AiSdkModel({
    specificationVersion: 'v3',
    provider: 'openai.responses',
    modelId: 'fixture',
    doGenerate() {
      if (++calls !== 1)
        return {
          content: [{ type: 'text', text: 'Done.' }],
          finishReason: 'stop',
        };
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: 'current',
            toolName: 'crm.lookup',
            input: '{}',
          },
        ],
        finishReason: 'tool-calls',
        response: {
          body: {
            id: 'fixture',
            status: 'completed',
            output: [
              {
                type: 'function_call',
                call_id: 'current',
                name: 'crm.lookup',
                namespace: 'inventory',
                arguments: '{}',
              },
            ],
          },
        },
      };
    },
  });
  await using provider = new NativeProvider({ modelBackend: backend });
  const result = await new Agent({
    model: 'fixture',
    instructions: 'Look up.',
    provider,
    tools: ['crm', 'inventory'].map((namespace) =>
      tool({
        name: 'lookup',
        namespace,
        parameters: z.object({}),
        execute() {
          effects.push(namespace);
          return namespace;
        },
      }),
    ),
  }).run('Lookup.');
  expect(result.finalOutput).toBe('Done.');
  expect(effects).toEqual(['crm']);
});

it.each(['crm.missing', 'lookup'])(
  'rejects an unoffered alias %s before any native tool effect',
  async (alias) => {
    let effects = 0;
    const model = new AiSdkModel({
      specificationVersion: 'v3',
      provider: 'fixture.namespaces',
      modelId: 'fixture',
      doGenerate() {
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'unknown',
              toolName: alias,
              input: '{}',
            },
          ],
          finishReason: 'tool-calls',
        };
      },
    });
    await using provider = new NativeProvider({ modelBackend: model });
    await expect(
      new Agent({
        model: 'fixture',
        instructions: 'Look up.',
        provider,
        tools: [
          tool({
            name: 'lookup',
            namespace: 'crm',
            parameters: z.object({}),
            execute() {
              effects++;
              return 'wrong';
            },
          }),
        ],
      }).run('Unknown.'),
    ).rejects.toThrow(/unoffered qualified/);
    expect(effects).toBe(0);
  },
);
