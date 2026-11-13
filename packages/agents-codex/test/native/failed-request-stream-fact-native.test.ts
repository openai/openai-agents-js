import { afterEach, expect, it } from 'vitest';
import {
  Agent,
  NativeProvider,
  type NativeModel,
  type RetryContext,
} from '../../src';
import { ModelServer } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it.each([false, true])(
  'retains failed application request mode across an asynchronous producer factory (stream=%s)',
  async (stream) => {
    const error = new Error('Producer failed before a response.');
    const observed: RetryContext[] = [];
    const adviceModes: (boolean | undefined)[] = [];
    const fail = async () => {
      await Promise.resolve();
      if (stream) delete backend.stream;
      else backend.stream = fail;
      throw error;
    };
    const backend: NativeModel = {
      complete: fail,
      ...(stream ? { stream: fail } : {}),
      getRetryAdvice(context) {
        adviceModes.push(context.stream);
        return {};
      },
    };
    await using provider = new NativeProvider({ modelBackend: backend });
    const agent = new Agent({
      model: 'fixture',
      instructions: 'Respond.',
      provider,
      modelSettings: {
        retry: {
          maxRetries: 1,
          policy(context) {
            observed.push(context);
            return { retry: false };
          },
        },
      },
    });
    await expect(agent.run('Begin.')).rejects.toBe(error);
    expect(observed).toMatchObject([{ stream, error }]);
    expect(adviceModes).toEqual([stream]);
  },
);

it.each([false, true])(
  'reports failed direct HTTP request mode from the actual provider route (stream=%s)',
  async (stream) => {
    const server = new ModelServer([
      {
        status: 503,
        body: JSON.stringify({
          error: { message: 'Synthetic provider failure.' },
        }),
      },
    ]);
    const config = await server.config();
    const observed: RetryContext[] = [];
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic',
      supportsWebsockets: false,
      responseMode: stream ? 'streaming' : 'buffered',
      requestMaxRetries: 0,
      streamMaxRetries: 0,
    });
    const agent = new Agent({
      model: 'gpt-5.5',
      instructions: 'Respond.',
      provider,
      modelSettings: {
        retry: {
          maxRetries: 1,
          policy(context) {
            observed.push(context);
            return { retry: false };
          },
        },
      },
    });
    await expect(agent.run('Begin.')).rejects.toThrow();
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0].stream ?? false).toBe(stream);
    expect(observed).toMatchObject([
      { stream, transport: stream ? 'responses_sse' : 'responses_json' },
    ]);
  },
);
