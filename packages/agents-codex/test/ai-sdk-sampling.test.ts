import { describe, expect, it } from 'vitest';
import {
  AiSdkModel,
  type ModelRequest,
  type AiSdkLanguageModel,
} from '../src/runtime/models';

const request = (): ModelRequest => ({
  body: {
    model: 'sampling',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      },
    ],
  },
  context: null,
  sessionId: 'sampling',
  turnId: 'turn',
  signal: new AbortController().signal,
});
function capturedOptions(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Expected borrowed call options');
  return value as Record<string, unknown>;
}
function strings(value: unknown): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.some((item: unknown) => typeof item !== 'string')
  )
    throw new TypeError('Expected stop sequences');
}
type AdapterOptions = NonNullable<ConstructorParameters<typeof AiSdkModel>[2]>;
function borrowed(
  consume: (options: Record<string, unknown>) => void,
): AiSdkLanguageModel {
  return {
    specificationVersion: 'v3' as const,
    provider: 'sampling',
    modelId: 'sampling',
    doGenerate(options: unknown) {
      consume(capturedOptions(options));
      return {
        content: [{ type: 'text', text: 'ok' }],
        usage: { inputTokens: 2, outputTokens: 1 },
        finishReason: 'stop',
      };
    },
    doStream(options: unknown) {
      consume(capturedOptions(options));
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of [
              { type: 'text-start', id: 'text' },
              { type: 'text-delta', id: 'text', delta: 'ok' },
              { type: 'text-end', id: 'text' },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 2, outputTokens: 1 },
              },
            ])
              controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
}
async function execute(model: AiSdkModel, stream: boolean) {
  if (stream) {
    for await (const _ of model.stream!(request())) {
      /* consume native adapter events */
    }
  } else await model.complete(request());
}

describe('AI SDK sampling configuration', () => {
  it.each([false, true])(
    'captures readonly input and detaches requests (stream=%s)',
    async (stream) => {
      const input = ['DONE', '海豚'];
      const readonlyInput: readonly string[] = input;
      const config = { stream, topK: 7, stopSequences: readonlyInput };
      const received: string[][] = [];
      const model = new AiSdkModel(
        borrowed((options) => {
          expect(options.topK).toBe(7);
          expect(options.stopSequences).toEqual(['DONE', '海豚']);
          const stopSequences = options.stopSequences;
          strings(stopSequences);
          received.push(stopSequences);
          stopSequences.splice(0, 1, 'provider mutation');
        }),
        {},
        config,
      );
      input[0] = 'caller mutation';
      config.topK = 99;
      config.stopSequences = ['replacement'];
      await execute(model, stream);
      await execute(model, stream);
      expect(received[0]).not.toBe(received[1]);
      expect(received[0]).not.toBe(input);
    },
  );

  it.each([false, true])(
    'keeps omitted options absent (stream=%s)',
    async (stream) => {
      const model = new AiSdkModel(
        borrowed((options) => {
          expect(Object.hasOwn(options, 'topK')).toBe(false);
          expect(Object.hasOwn(options, 'stopSequences')).toBe(false);
        }),
        {},
        { stream },
      );
      await execute(model, stream);
    },
  );

  it('accepts empty sequences and leaves finite ranges to the provider', async () => {
    for (const topK of [0, -1, 0.5, 7]) {
      const model = new AiSdkModel(
        borrowed((options) => {
          expect(options.topK).toBe(topK);
          expect(options.stopSequences).toEqual(['']);
        }),
        {},
        { topK, stopSequences: [''] as const },
      );
      await model.complete(request());
    }
    await new AiSdkModel(
      borrowed((options) => {
        expect(options.stopSequences).toEqual([]);
      }),
      {},
      { stopSequences: [] as const },
    ).complete(request());
  });

  it('refuses values outside the declared JSON-safe types before borrowing', () => {
    const model = borrowed(() => {
      throw new Error('must not dispatch');
    });
    for (const topK of [NaN, Infinity, -Infinity, '7', null]) {
      expect(
        () => new AiSdkModel(model, {}, { topK } as unknown as AdapterOptions),
      ).toThrow('finite number');
    }
    for (const stopSequences of [
      null,
      'DONE',
      [1],
      ['DONE', null],
      Array<string>(1),
      {},
    ]) {
      expect(
        () =>
          new AiSdkModel(model, {}, {
            stopSequences,
          } as unknown as AdapterOptions),
      ).toThrow('array of strings');
    }
  });
});
