import { beforeAll, describe, expect, it } from 'vitest';
import { Agent, Runner, setTracingDisabled, tool } from '../../src';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
} from '../../src/testing';
import type { AgentInputItem } from '../../src/types';
import type {
  AssistantMessageItem,
  OutputText,
} from '../../src/types/protocol';
import type { StreamedRunResult } from '../../src/result';

beforeAll(() => setTracingDisabled(true));

describe('captured input copies', () => {
  it.each(['accessor', 'proxy'])(
    'preserves public own-map %s behavior',
    async (mode) => {
      let reads = 0;
      const runner = new Runner();
      runner.on('agent_start', (_context, _agent, items) => {
        Object.defineProperty(items!, 'map', {
          configurable: true,
          get: () =>
            function (
              this: AgentInputItem[],
              callback: (item: AgentInputItem) => AgentInputItem,
            ) {
              const output = Array.prototype.map.call(
                this,
                callback,
              ) as AgentInputItem[];
              const first = output[0];
              if (
                !first ||
                typeof first !== 'object' ||
                first === this[0] ||
                !('role' in first) ||
                first.role !== 'user' ||
                !('content' in first) ||
                first.content !== 'before'
              )
                return output;
              if (mode === 'proxy') output[0] = new Proxy(output[0], {});
              else
                Object.defineProperty(output[0], 'content', {
                  enumerable: true,
                  get: () => `read-${++reads}`,
                });
              return output;
            },
        });
      });
      const model = new ScriptedModel([[assistantMessage('done')]]);
      const result = await runner.run(
        new Agent({ name: 'own-map', model }),
        [{ role: 'user', content: 'before' }],
        { stream: true },
      );
      if (mode === 'proxy') {
        const rejection = expect(result.completed).rejects.toMatchObject({
          name: 'DataCloneError',
        });
        await expect(async () => {
          for await (const _event of result) {
            /* Drain failure. */
          }
        }).rejects.toMatchObject({ name: 'DataCloneError' });
        await rejection;
        expect(model.calls).toHaveLength(0);
      } else {
        for await (const _event of result) {
          /* Drain the public stream. */
        }
        await result.completed;
        expect(
          result.state._currentTurnSessionHistoryTransactionInputItems,
        ).toEqual([{ role: 'user', content: 'read-1' }]);
        expect(result.finalOutput).toBe('done');
      }
    },
  );

  it('isolates retained owned text and preserves multipart fallback on filtered turns', async () => {
    const single = assistantMessage('single');
    const multiple = assistantMessage('first', {
      providerData: { retained: new Map([['value', 'original']]) },
    });
    multiple.content.push({ type: 'output_text', text: 'second' });
    const injected = (turn: number): AgentInputItem => ({
      role: 'user',
      content: [{ type: 'input_text', text: `injected-${turn}` }],
    });
    const model = new ScriptedModel([
      [functionCall('next', {}, { callId: 'next-call' })],
      [assistantMessage('done')],
    ]);
    let published: AgentInputItem[] | undefined;
    const next = tool({
      name: 'next',
      description: 'Continue.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      execute: async () => {
        published =
          result.state._currentTurnSessionHistoryTransactionInputItems;
        const saved = published!.find(
          (item) => 'role' in item && item.role === 'assistant',
        ) as AssistantMessageItem;
        (saved.content[0] as OutputText).text = 'public edit';
        const rich = published!.find(
          (item) => item.providerData?.retained instanceof Map,
        )!;
        rich.providerData!.retained.set('value', 'public edit');
        return 'next';
      },
    });
    let turn = 0;
    const result: StreamedRunResult<any, any> = await new Runner().run(
      new Agent({ name: 'filtered-copies', model, tools: [next] }),
      [single, multiple],
      {
        stream: true,
        callModelInputFilter: ({ modelData }) => ({
          input:
            turn++ === 0
              ? [...modelData.input, injected(1)]
              : modelData.input.filter(
                  (item) => !('role' in item) || item.role !== 'assistant',
                ),
        }),
      },
    );
    for await (const _event of result) {
      /* Drain the public stream. */
    }
    await result.completed;
    expect((published![0] as AssistantMessageItem).content).toEqual([
      { type: 'output_text', text: 'public edit' },
    ]);
    const saved = result.state._currentTurnSessionHistoryTransactionInputItems;
    expect(saved).toContainEqual(single);
    expect(saved).toContainEqual(multiple);
    expect(published).toContainEqual(injected(1));
  });
});
