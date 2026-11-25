import { beforeAll, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Runner,
  StreamedRunResult,
  setTracingDisabled,
  tool,
} from '../../src';
import type { ModelRequest } from '../../src/model';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponder,
} from '../../src/testing';

beforeAll(() => setTracingDisabled(true));
const runner = new Runner({ tracingDisabled: true });

const message = () => ({
  role: 'user' as const,
  content: 'before',
  providerData: { value: new Map([['key', 'before']]), date: new Date(0) },
});
const turnTool = (name: string, needsApproval = false) =>
  tool({
    name,
    description: 'Finish one turn.',
    parameters: z.object({}),
    needsApproval,
    execute: () => 'done',
  });

async function run(
  agent: Agent<any, any>,
  input: Parameters<Runner['run']>[1],
  stream: boolean,
) {
  const result = await (stream
    ? runner.run(agent, input, { stream: true })
    : runner.run(agent, input));
  if (result instanceof StreamedRunResult) {
    for await (const _ of result) {
      // Drain the stream before inspecting the final state.
    }
    await result.completed;
  }
  return result;
}

// ScriptedModel freezes recorded requests; these overrides exercise live provider mutations.
class MutatingModel extends ScriptedModel {
  mutate(request: ModelRequest) {
    const item = (request.input as ReturnType<typeof message>[])[0];
    item.content = 'provider-edit';
    item.providerData.value.set('key', 'provider-edit');
    item.providerData.date.setTime(1);
  }
  override getResponse(request: ModelRequest) {
    this.mutate(request);
    return super.getResponse(request);
  }
  override getStreamedResponse(request: ModelRequest) {
    this.mutate(request);
    return super.getStreamedResponse(request);
  }
}

for (const stream of [false, true]) {
  it(`keeps provider mutations out of current input (stream=${stream})`, async () => {
    const original = message();
    const model = new MutatingModel([[assistantMessage('ok')]]);
    const agent = new Agent({ name: 'Mutation boundary', model });
    const result = await run(agent, [original], stream);
    const saved = result.state
      ._currentTurnSessionHistoryTransactionInputItems![0] as typeof original;
    expect(saved).toEqual(original);
    expect(saved.providerData.value).toBeInstanceOf(Map);
    expect(saved.providerData.date).toBeInstanceOf(Date);
    expect(original).toEqual(message());
  });

  it(`admits prepared input when instructions clear pending input (stream=${stream})`, async () => {
    let clearPending: (() => void) | undefined = undefined;
    const model = new ScriptedModel([
      [functionCall('step', {}, { callId: 'call' })],
      [assistantMessage('ok')],
    ]);
    const agent = new Agent({
      name: 'Pending',
      model,
      tools: [turnTool('step', true)],
      instructions() {
        clearPending?.();
        return '';
      },
    });
    const first = await run(agent, 'start', stream);
    const state = first.state;
    state.addInput('pending');
    state.approve(first.interruptions[0]);
    clearPending = () => state.clearPendingInput();
    const result = await run(agent, state, stream);
    const pending = expect.objectContaining({ content: 'pending' });
    expect(model.lastCall!.request.input).toContainEqual(pending);
    expect(result.history).toContainEqual(pending);
    expect(state.pendingInput).toEqual([]);
    expect(result.finalOutput).toBe('ok');
  });
}

it.each([false, true])(
  'keeps an older owner independent from public snapshots (map observed: %s)',
  async (observeMap) => {
    const observe = () => vi.spyOn(Array.prototype, 'map');
    let observer: ReturnType<typeof observe> | undefined;
    let result: StreamedRunResult<any, any>;
    const original = message();
    const model = new ScriptedModel(
      [0, 1].map((index) =>
        modelResponder(() => {
          const saved = result.state
            ._currentTurnSessionHistoryTransactionInputItems![0] as typeof original;
          expect(saved).toEqual(original);
          if (index === 0) {
            if (observer) {
              // A map wrapper can retain every returned array, including clones.
              for (const call of observer.mock.results) {
                if (call.type !== 'return' || !Array.isArray(call.value))
                  continue;
                const item = call.value[0] as typeof original | undefined;
                if (
                  item?.content === 'before' &&
                  item.providerData?.value instanceof Map
                ) {
                  item.providerData.value.set('key', 'retained-edit');
                }
              }
              observer.mockRestore();
              observer = undefined;
            }
            saved.content = 'public-state-edit';
            saved.providerData.value.set('key', 'public-state-edit');
            saved.providerData.date.setTime(1);
          }
          return index === 0
            ? [functionCall('noop', {}, { callId: 'call' })]
            : [assistantMessage('ok')];
        }),
      ),
    );
    const agent = new Agent({
      name: 'Older owner',
      model,
      tools: [turnTool('noop')],
    });
    if (observeMap)
      agent.on('agent_start', () => {
        observer ??= observe();
      });
    try {
      result = await runner.run(agent, [original], {
        stream: true,
        previousResponseId: 'prior',
      });
      for await (const _ of result) {
        // Drain both turns before checking the recorded calls.
      }
      await result.completed;
      expect(model.calls).toHaveLength(2);
    } finally {
      observer?.mockRestore();
    }
  },
);
