import { markAsUncloneable } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';

import { Agent } from '../../src/agent';
import type { Model, ModelRequest } from '../../src/model';
import { Runner } from '../../src/run';
import { assistantMessage, ScriptedModel } from '../../src/testing';
import type { AgentInputItem } from '../../src/types';
import type { AssistantMessageItem } from '../../src/types/protocol';

function input(generic = false): AgentInputItem[] {
  return [
    { role: 'user', content: 'prompt' },
    {
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'prior' }],
      ...(generic ? { providerData: { label: 'generic fallback' } } : {}),
    },
  ];
}

function text(items: AgentInputItem[]) {
  const part = (items[1] as AssistantMessageItem).content[0];
  if (part.type !== 'output_text') throw new Error('Expected text fixture');
  return part;
}

async function complete(
  agent: Agent,
  items: AgentInputItem[],
  stream: boolean,
) {
  const runner = new Runner({ tracingDisabled: true });
  if (!stream) return runner.run(agent, items);
  const result = await runner.run(agent, items, { stream: true });
  for await (const _event of result) {
    /* Drain the actual runner stream. */
  }
  await result.completed;
  return result;
}

describe.each([false, true])('Runner isolation (stream=%s)', (stream) => {
  it.each([false, true])(
    'separates caller, request and held saved state (generic=%s)',
    async (generic) => {
      const caller = input(generic);
      const scripted = new ScriptedModel([[assistantMessage('done')]]);
      let requestInput: AgentInputItem[] | undefined;
      // The public fixture records frozen snapshots. This adapter edits the real
      // model request before delegating response generation to that fixture.
      function editRequest(request: ModelRequest) {
        if (!Array.isArray(request.input))
          throw new Error('Expected input list');
        requestInput = request.input;
        text(caller).text = 'caller edit';
        text(requestInput).text = 'model edit';
      }
      const model: Model = {
        getResponse(request) {
          editRequest(request);
          return scripted.getResponse(request);
        },
        getStreamedResponse(request) {
          editRequest(request);
          return scripted.getStreamedResponse(request);
        },
      };
      const result = await complete(
        new Agent({ name: 'Isolation', model }),
        caller,
        stream,
      );
      expect(result.finalOutput).toBe('done');
      scripted.assertComplete();
      expect(requestInput).toBeDefined();
      const request = requestInput!;
      const original = result.input as AgentInputItem[];
      const saved =
        result.state._currentTurnSessionHistoryTransactionInputItems!;
      expect(text(caller).text).toBe('caller edit');
      expect(text(request).text).toBe('model edit');
      expect(text(original).text).toBe('prior');
      expect(text(saved).text).toBe('prior');
      expect(saved).not.toBe(original);

      text(saved).text = 'saved edit';
      text(caller).text = 'later caller edit';
      text(request).text = 'later model edit';
      expect(text(saved).text).toBe('saved edit');
      expect(text(original).text).toBe('prior');
      expect(text(caller).text).toBe('later caller edit');
      expect(text(request).text).toBe('later model edit');

      const replacement = input();
      result.state._currentTurnSessionHistoryTransactionInputItems =
        replacement;
      expect(result.state._currentTurnSessionHistoryTransactionInputItems).toBe(
        replacement,
      );
      expect(text(saved).text).toBe('saved edit');
      expect(text(original).text).toBe('prior');
    },
  );

  it('accepts assignment before the first saved-state read', async () => {
    const model = new ScriptedModel([[assistantMessage('done')]]);
    const result = await complete(
      new Agent({ name: 'Assignment', model }),
      input(),
      stream,
    );
    const replacement = input();
    result.state._currentTurnSessionHistoryTransactionInputItems = replacement;
    expect(result.state._currentTurnSessionHistoryTransactionInputItems).toBe(
      replacement,
    );
    expect(
      Object.getOwnPropertyDescriptor(
        result.state,
        '_currentTurnSessionHistoryTransactionInputItems',
      ),
    ).toMatchObject({
      value: replacement,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    model.assertComplete();
  });

  it('preserves whole-input aliases while detaching caller objects', async () => {
    const message: AgentInputItem = { role: 'user', content: 'shared' };
    const model = new ScriptedModel([[assistantMessage('done')]]);
    const result = await complete(
      new Agent({ name: 'Aliases', model }),
      [message, message],
      stream,
    );
    const original = result.input as AgentInputItem[];
    expect(original[0]).toBe(original[1]);
    expect(original[0]).not.toBe(message);
    model.assertComplete();
  });

  it('keeps a shared child only inside the original input graph', async () => {
    const part = { type: 'output_text' as const, text: 'shared' };
    const history: AgentInputItem[] = [
      { role: 'assistant', status: 'completed', content: [part] },
      { role: 'assistant', status: 'completed', content: [part] },
    ];
    const model = new ScriptedModel([[assistantMessage('done')]]);
    const result = await complete(
      new Agent({ name: 'Shared child', model }),
      history,
      stream,
    );
    const [first, second] = result.input as AssistantMessageItem[];
    expect(first).not.toBe(second);
    expect(first.content[0]).toBe(second.content[0]);
    expect(first.content[0]).not.toBe(part);
    const saved = result.state
      ._currentTurnSessionHistoryTransactionInputItems as AssistantMessageItem[];
    expect(saved[0].content[0]).not.toBe(saved[1].content[0]);
    expect(saved[1].content[0]).not.toBe(first.content[0]);
  });

  it('rejects a genuinely uncloneable message before model entry', async () => {
    const message: AgentInputItem = { role: 'user', content: 'marked' };
    markAsUncloneable(message);
    const model = new ScriptedModel([[assistantMessage('unexpected')]]);
    await expect(
      complete(new Agent({ name: 'Marked', model }), [message], stream),
    ).rejects.toMatchObject({ name: 'DataCloneError' });
    expect(model.calls).toHaveLength(0);
  });
});
