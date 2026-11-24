import { describe, expect, it, vi } from 'vitest';
import type { Model, ModelResponse } from '../../src/model';
import type {
  StreamEvent,
  StreamEventResponseCompleted,
} from '../../src/types/protocol';

const names = [
  'entries',
  'map',
  'filter',
  'flatMap',
  'every',
  'constructor',
] as const;

describe('positional matching startup methods', () => {
  it.each(names)(
    'declines a pre-import %s wrapper without invoking it',
    async (name) => {
      const previous = Object.getOwnPropertyDescriptor(Array.prototype, name)!;
      let calls = 0;
      let inventoryCalls = 0;
      const wrapper = function (this: unknown, ...args: unknown[]) {
        calls++;
        if (
          name === 'map' &&
          Array.isArray(this) &&
          this.length === 6 &&
          this[0] === 'entries' &&
          this[5] === 'constructor'
        )
          inventoryCalls++;
        return Reflect.apply(previous.value, this, args);
      };
      let conversionReads = 0;
      Object.defineProperty(wrapper, 'toString', {
        get() {
          conversionReads++;
          throw new Error('User conversion hook');
        },
      });
      vi.resetModules();
      try {
        Object.defineProperty(Array.prototype, name, {
          ...previous,
          value: wrapper,
        });
        const { canMatchInputItemsByPosition } =
          await import('../../src/shims/inputTreeEquality-node');
        expect(inventoryCalls).toBe(0);
        const before = calls;
        expect(
          canMatchInputItemsByPosition(
            [{ role: 'user', content: 'hello' }],
            [{ role: 'user', content: 'hello' }],
          ),
        ).toBe(false);
        expect(calls).toBe(before);
        expect(conversionReads).toBe(0);
      } finally {
        Object.defineProperty(Array.prototype, name, previous);
        vi.resetModules();
      }
    },
  );

  it('retains post-import invalidation and restoration', async () => {
    vi.resetModules();
    const { canMatchInputItemsByPosition } =
      await import('../../src/shims/inputTreeEquality-node');
    const previous = Object.getOwnPropertyDescriptor(
      Array.prototype,
      'entries',
    )!;
    const input = [{ role: 'user', content: 'hello' }];
    expect(canMatchInputItemsByPosition(input, structuredClone(input))).toBe(
      true,
    );
    try {
      Object.defineProperty(Array.prototype, 'entries', {
        ...previous,
        value: function () {
          throw new Error('Post-import wrapper invoked');
        },
      });
      expect(canMatchInputItemsByPosition(input, structuredClone(input))).toBe(
        false,
      );
    } finally {
      Object.defineProperty(Array.prototype, 'entries', previous);
    }
    expect(canMatchInputItemsByPosition(input, structuredClone(input))).toBe(
      true,
    );
    vi.resetModules();
  });

  it('declines an accessor without reading it during the guard', async () => {
    const previous = Object.getOwnPropertyDescriptor(
      Array.prototype,
      'entries',
    )!;
    let reads = 0;
    vi.resetModules();
    try {
      Object.defineProperty(Array.prototype, 'entries', {
        configurable: true,
        get() {
          reads++;
          return previous.value;
        },
      });
      const { canMatchInputItemsByPosition } =
        await import('../../src/shims/inputTreeEquality-node');
      const before = reads;
      expect(canMatchInputItemsByPosition([], [])).toBe(false);
      expect(reads).toBe(before);
    } finally {
      Object.defineProperty(Array.prototype, 'entries', previous);
      vi.resetModules();
    }
  });

  it.each([
    { stream: false, action: 'edit' },
    { stream: true, action: 'edit' },
    { stream: false, action: 'throw' },
    { stream: true, action: 'throw' },
  ])(
    'preserves public pre-import entry observations ($stream, $action)',
    async ({ stream, action }) => {
      const previous = Object.getOwnPropertyDescriptor(
        Array.prototype,
        'entries',
      )!;
      let armed = false;
      const counts = new WeakMap<object, number>();
      const requests: unknown[][] = [];
      vi.resetModules();
      try {
        Object.defineProperty(Array.prototype, 'entries', {
          ...previous,
          value: function (
            this: Array<{ role?: string; content?: unknown }>,
            ...args: unknown[]
          ) {
            if (
              armed &&
              this.length === 1 &&
              this[0]?.role === 'user' &&
              this[0].content === 'portable-preimport-marker'
            ) {
              const count = (counts.get(this) ?? 0) + 1;
              counts.set(this, count);
              if (count === 3) {
                if (action === 'throw')
                  throw new Error('ownership wrapper third traversal');
                this[0].content = 'entries edit';
              }
            }
            return Reflect.apply(previous.value, this, args);
          },
        });
        const sdk = await import('../../src/index');
        sdk.setTracingDisabled(true);
        const output: StreamEventResponseCompleted['response']['output'] = [
          {
            type: 'message',
            id: 'final',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ];
        const response: ModelResponse = {
          responseId: 'r',
          usage: new sdk.Usage(),
          output,
        };
        const model: Model = {
          async getResponse(request) {
            requests.push(
              typeof request.input === 'string'
                ? [request.input]
                : request.input.map(
                    (item) => (item as { content?: unknown }).content,
                  ),
            );
            return response;
          },
          async *getStreamedResponse(request): AsyncGenerator<StreamEvent> {
            await this.getResponse(request);
            yield { type: 'response_started' };
            yield {
              type: 'response_done',
              response: { ...response, output, id: 'r' },
            };
          },
        };
        const agent = new sdk.Agent({ name: 'startup wrapper', model });
        agent.on('agent_start', () => {
          armed = true;
        });
        const source = [
          { role: 'user' as const, content: 'portable-preimport-marker' },
        ];
        const runner = new sdk.Runner({ tracingDisabled: true });
        let finalOutput: unknown;
        let failure: unknown;
        try {
          if (stream) {
            const result = await runner.run(agent, source, { stream: true });
            for await (const event of result) {
              void event;
            }
            await result.completed;
            finalOutput = result.finalOutput;
          } else {
            const result = await runner.run(agent, source, { stream: false });
            finalOutput = result.finalOutput;
          }
        } catch (error) {
          failure = error;
        }
        if (action === 'throw') {
          expect(failure).toBeInstanceOf(Error);
          expect((failure as Error).message).toBe(
            'ownership wrapper third traversal',
          );
          expect(requests).toEqual([]);
        } else {
          expect(failure).toBeUndefined();
          expect(requests).toEqual([['entries edit']]);
          expect(finalOutput).toBe('ok');
        }
      } finally {
        Object.defineProperty(Array.prototype, 'entries', previous);
        vi.resetModules();
      }
    },
  );
});
