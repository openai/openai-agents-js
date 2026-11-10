import { afterEach, expect, it } from 'vitest';
import { Agent, NativeProvider, computerTool, type Computer } from '../../src';
import { ModelServer, message } from './fixtures/model-server';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
afterEach(() => ModelServer.closeAll());

nativeIt.each(['error', 'undefined', 'lease-failure'] as const)(
  'releases the native provider after Computer disposal failure: %s',
  async (mode) => {
    const problem =
      mode === 'undefined'
        ? undefined
        : new Error('synthetic Computer disposal failure');
    const secondary = new Error('synthetic lease release failure');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const disposed: Computer[] = [];
    const driver: Computer = {
      screenshot: () => 'aA==',
      click() {},
      doubleClick() {},
      scroll() {},
      type() {},
      wait() {},
      move() {},
      keypress() {},
      drag() {},
    };
    const server = new ModelServer([
      [
        {
          type: 'computer_call',
          id: 'cu_dispose',
          call_id: 'dispose',
          status: 'completed',
          actions: [{ type: 'screenshot' }],
        },
      ],
      [message('done')],
    ]);
    const config = await server.config();
    const provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic',
      supportsWebsockets: false,
    });
    const session = await new Agent({
      instructions: 'Use computer.',
      model: 'gpt-5',
      provider,
      tools: [
        computerTool({
          computer: {
            create: () => driver,
            async dispose(value) {
              disposed.push(value);
              entered.resolve();
              await release.promise;
              throw problem;
            },
          },
        }),
      ],
    }).session();
    try {
      const turn = await session.submit('Screenshot.');
      expect((await turn.wait()).finalOutput).toBe('done');
      const internal = session as unknown as {
        options: { onClose: () => Promise<void> };
      };
      const releaseLease = internal.options.onClose;
      let attempts = 0;
      if (mode === 'lease-failure')
        internal.options.onClose = async () => {
          if (++attempts === 1) throw secondary;
          await releaseLease();
        };
      const closing = session.close();
      const outcome = closing.then(
        () => ({ success: true }),
        (error: unknown) => ({ error }),
      );
      await entered.promise;
      expect(session.close()).toBe(closing);
      await expect(provider.close()).rejects.toThrow('open or opening');
      release.resolve();
      const result = await outcome;
      expect(result).toHaveProperty('error');
      const error = (result as { error: unknown }).error;
      if (mode === 'error') expect(error).toBe(problem);
      else if (mode === 'undefined') {
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors).toEqual([undefined]);
      } else {
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).cause).toBe(problem);
        expect((error as AggregateError).errors).toEqual([problem, secondary]);
        expect(attempts).toBe(1);
        await session.close();
        expect(attempts).toBe(2);
      }
      await provider.close();
      expect(disposed).toEqual([driver]);
    } finally {
      release.resolve();
      await session.close();
      await provider.close();
    }
  },
  30000,
);
