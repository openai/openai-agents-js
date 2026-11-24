import { beforeAll, describe, expect, it } from 'vitest';
import {
  Agent,
  MemorySession,
  Runner,
  setTracingDisabled,
  type AgentInputItem,
  type CallModelInputFilter,
  type ModelRequest,
} from '../src';
import { assistantMessage, ScriptedModel } from '../src/testing';

beforeAll(() => setTracingDisabled(true));

class MutatingModel extends ScriptedModel {
  beforeRequest?: (request: ModelRequest) => void;

  override async getResponse(request: ModelRequest) {
    this.beforeRequest?.(request);
    return super.getResponse(request);
  }

  override getStreamedResponse(request: ModelRequest) {
    this.beforeRequest?.(request);
    return super.getStreamedResponse(request);
  }
}

describe('prepared input capture', () => {
  it.each([
    { stream: false, filter: 'none' },
    { stream: true, filter: 'none' },
    { stream: false, filter: 'default' },
    { stream: true, filter: 'default' },
    { stream: false, filter: 'identity' },
    { stream: true, filter: 'identity' },
  ] as const)(
    'isolates persisted input from model mutation ($stream, $filter)',
    async ({ stream, filter }) => {
      class Items extends Array<AgentInputItem> {}
      const original: AgentInputItem = {
        type: 'message',
        role: 'user',
        content: 'original',
        providerData: { nested: { value: 'original' } },
      };
      const expected = structuredClone(original);
      let retained: AgentInputItem[] | undefined;
      const callModelInputFilter: CallModelInputFilter | undefined =
        filter === 'none'
          ? undefined
          : ({ modelData }) => {
              retained = new Items(...modelData.input);
              return { ...modelData, input: retained };
            };
      if (callModelInputFilter && filter === 'identity') {
        callModelInputFilter.preserveInputIdentity = true;
      }
      const model = new MutatingModel([[assistantMessage('done')]]);
      model.beforeRequest = (request) => {
        expect(Array.isArray(request.input)).toBe(true);
        if (!Array.isArray(request.input))
          throw new Error('Expected input array');
        const item = request.input[0];
        if (item.type !== 'message') throw new Error('Expected message');
        item.content = 'model mutation';
        const nested = item.providerData?.nested;
        if (nested && typeof nested === 'object' && 'value' in nested) {
          nested.value = 'model mutation';
        }
        retained?.splice(0, retained.length);
      };
      const session = new MemorySession();
      const agent = new Agent({ name: 'snapshot', model });
      const runner = new Runner({ tracingDisabled: true });
      if (stream) {
        const result = await runner.run(agent, new Items(original), {
          stream: true,
          session,
          callModelInputFilter,
        });
        for await (const _event of result) {
          // Drain the public stream before inspecting persistence.
        }
        await result.completed;
        expect(result.finalOutput).toBe('done');
      } else {
        const result = await runner.run(agent, new Items(original), {
          session,
          callModelInputFilter,
        });
        expect(result.finalOutput).toBe('done');
      }
      expect((await session.getItems())[0]).toEqual(expected);
      expect(original).toEqual(expected);
      model.assertComplete();
    },
  );

  it('reads indexed input when a caller hook customizes array iteration', async () => {
    const model = new ScriptedModel([[assistantMessage('done')]]);
    const agent = new Agent({ name: 'indexed-snapshot', model });
    const runner = new Runner({ tracingDisabled: true });
    runner.on('agent_start', (_context, _agent, input) => {
      Object.defineProperty(input, Symbol.iterator, {
        configurable: true,
        value: function* () {
          yield { type: 'message', role: 'user', content: 'iterator output' };
        },
      });
    });

    await runner.run(agent, [
      { type: 'message', role: 'user', content: 'indexed input' },
    ]);

    expect(model.calls[0]?.request.input).toMatchObject([
      { content: 'indexed input' },
    ]);
  });

  it('does not persist input or call the model after a filter failure', async () => {
    const model = new MutatingModel([[assistantMessage('unused')]]);
    const session = new MemorySession();
    const agent = new Agent({ name: 'filter-error', model });
    const failure = new Error('filter failed');
    await expect(
      new Runner({ tracingDisabled: true }).run(agent, 'private input', {
        session,
        callModelInputFilter: () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(model.calls).toHaveLength(0);
    expect(await session.getItems()).toEqual([]);
  });
});
