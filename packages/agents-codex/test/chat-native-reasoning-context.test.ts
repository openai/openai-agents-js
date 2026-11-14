import { expect, it, vi } from 'vitest';
import {
  ChatCompletionsModel,
  markNativeReasoningContext,
  type ModelRequest,
} from '../src/runtime/models';

function request(reasoning: ModelRequest['body']): ModelRequest {
  return {
    body: { model: 'native-model', input: [], reasoning },
    context: undefined,
    sessionId: 'session',
    turnId: 'turn',
    signal: new AbortController().signal,
  };
}

it.each([false, true])(
  'preserves a captured native reasoning context with streaming=%s',
  async (stream) => {
    const create = vi.fn(async (_body: unknown) =>
      stream
        ? (async function* () {
            yield {
              id: 'chat-response',
              choices: [
                { index: 0, delta: { content: 'ok' }, finish_reason: 'stop' },
              ],
            };
          })()
        : {
            id: 'chat-response',
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          },
    );
    const model = new ChatCompletionsModel(
      { chat: { completions: { create } } },
      'borrowed-model',
      { stream },
    );
    const native = request({ context: 'all_turns', effort: 'medium' });
    const original = JSON.stringify(native.body);
    markNativeReasoningContext(native, true);
    if (stream) await Array.fromAsync(model.stream!(native));
    else await model.complete(native);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0]).toMatchObject({
      model: 'borrowed-model',
      reasoning_effort: 'medium',
    });
    expect(create.mock.calls[0][0]).not.toHaveProperty('reasoning');
    expect(create.mock.calls[0][0]).not.toHaveProperty(
      'native_reasoning_context',
    );
    expect(JSON.stringify(native.body)).toBe(original);
  },
);

it.each([
  [undefined, { context: 'all_turns' }],
  [false, { context: 'all_turns' }],
  [true, { context: 'current_turn' }],
  [true, { context: 'auto' }],
  [true, { context: null }],
  [true, { context: 'all_turns', mode: 'pro' }],
  [true, { context: 'all_turns', vendor: { budget: 123 } }],
] as const)(
  'rejects unsupported reasoning before client dispatch (marker=%s, reasoning=%j)',
  async (marker, reasoning) => {
    const create = vi.fn();
    const model = new ChatCompletionsModel({
      chat: { completions: { create } },
    });
    const native = request(reasoning);
    markNativeReasoningContext(native, marker);
    await expect(model.complete(native)).rejects.toThrow(
      'Extended reasoning options require a Responses model',
    );
    expect(create).not.toHaveBeenCalled();
  },
);

it('keeps captured provenance on its exact request rather than copied body fields', async () => {
  const create = vi.fn();
  const model = new ChatCompletionsModel({ chat: { completions: { create } } });
  const native = request({ context: 'all_turns' });
  markNativeReasoningContext(native, true);
  const copied = { ...native, native_reasoning_context: true };
  await expect(model.complete(copied)).rejects.toThrow('Extended reasoning');
  expect(create).not.toHaveBeenCalled();
});

it('rejects malformed private provenance before model dispatch', () => {
  expect(() => markNativeReasoningContext(request({}), 'true')).toThrow(
    'Invalid native reasoning context provenance',
  );
});
