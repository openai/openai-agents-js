import { expect, it } from 'vitest';
import { Agent, NativeProvider } from '../src';
import type { NativeRealtimeAdapter } from '../src/runtime/realtime-adapter';
import { ModelServer, message } from './native/fixtures/model-server';

// The adapter scripts provider frames; actual Session, binding and Core execute.
class Incoming {
  private readonly values: string[] = [];
  private waiting?: (value: IteratorResult<string>) => void;
  private ended = false;
  push(frame: object) {
    const value = JSON.stringify(frame);
    if (this.waiting) {
      const deliver = this.waiting;
      this.waiting = undefined;
      deliver({ done: false, value });
    } else this.values.push(value);
  }
  next(): Promise<IteratorResult<string>> {
    if (this.values.length)
      return Promise.resolve({ done: false, value: this.values.shift()! });
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
  async return(): Promise<IteratorResult<string>> {
    this.ended = true;
    this.waiting?.({ done: true, value: undefined });
    this.waiting = undefined;
    return { done: true, value: undefined };
  }
  [Symbol.asyncIterator]() {
    return this;
  }
}
function merge(current: Record<string, any>, update: Record<string, any>) {
  for (const [key, value] of Object.entries(update)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current[key] &&
      typeof current[key] === 'object' &&
      !Array.isArray(current[key])
    )
      merge(current[key], value);
    else current[key] = structuredClone(value);
  }
}
async function providerFor(model: ModelServer) {
  const config = await model.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-reentrancy',
    supportsWebsockets: false,
  });
}
const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');

nativeIt(
  'rejects adapter connect awaiting its owning Session.close before mutation',
  async () => {
    const model = new ModelServer([[message('usable after blocked connect')]]);
    try {
      await using provider = await providerFor(model);
      const agent = new Agent({
        instructions: 'Answer briefly.',
        model: 'gpt-5.5',
        provider,
      });
      await using session = await agent.session();
      let original: unknown;
      let entered = 0;
      const adapter: NativeRealtimeAdapter = {
        async connect() {
          entered++;
          try {
            await session.close();
          } catch (error) {
            original = error;
            throw error;
          }
          throw new Error('Reentrant close was unexpectedly admitted');
        },
      };
      const failure = await session
        .realtime({ model: 'gpt-realtime', adapter })
        .catch((error) => error);
      expect(entered).toBe(1);
      expect(original).toBeInstanceOf(Error);
      expect(failure).toBe(original);
      expect(await session.getActiveAgent()).toBe(agent);
      const turn = await session.submit('Check caller ownership.');
      expect((await turn.wait()).finalOutput).toBe(
        'usable after blocked connect',
      );
      await session.close();
    } finally {
      await ModelServer.closeAll();
    }
  },
  20000,
);

nativeIt(
  'rejects adapter close awaiting its owning Session.close and permits exact cleanup retry',
  async () => {
    const model = new ModelServer([[message('usable after blocked close')]]);
    try {
      await using provider = await providerFor(model);
      const agent = new Agent({
        instructions: 'Answer briefly.',
        model: 'gpt-5.5',
        provider,
      });
      await using session = await agent.session();
      const incoming = new Incoming();
      const accepted: Record<string, any> = {};
      let attempts = 0;
      let original: unknown;
      const adapter: NativeRealtimeAdapter = {
        async connect(context) {
          accepted.model = context.model;
          return {
            incoming,
            async send(raw) {
              const frame = JSON.parse(raw);
              if (frame.type === 'session.update') {
                merge(accepted, frame.session);
                incoming.push({
                  type: 'session.updated',
                  session: {
                    ...structuredClone(accepted),
                    id: 'guarded-session',
                  },
                });
              } else if (frame.type === 'response.create') {
                incoming.push({
                  type: 'response.created',
                  response: { id: 'empty-response' },
                });
                incoming.push({
                  type: 'response.done',
                  response: { id: 'empty-response', output: [] },
                });
              }
            },
            async close() {
              attempts++;
              if (attempts === 1) {
                try {
                  await session.close();
                } catch (error) {
                  original = error;
                  throw error;
                }
                throw new Error('Reentrant close was unexpectedly admitted');
              }
              await incoming.return();
            },
          };
        },
      };
      const voice = await session.realtime({ model: 'gpt-realtime', adapter });
      const failure = await voice.close().catch((error) => error);
      expect(original).toBeInstanceOf(Error);
      expect(failure).toBe(original);
      await voice.close();
      expect(attempts).toBe(2);
      expect(await session.getActiveAgent()).toBe(agent);
      const turn = await session.submit('Check caller ownership.');
      expect((await turn.wait()).finalOutput).toBe(
        'usable after blocked close',
      );
      await session.close();
    } finally {
      await ModelServer.closeAll();
    }
  },
  20000,
);
