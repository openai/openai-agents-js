import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  tool,
  manualTool,
  parseSessionState,
  readSessionInstructions,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'fixture',
  });
}
afterEach(() => ModelServer.closeAll());

describe('Python-aligned Session lifecycle', () => {
  it('guards a callback self-wait after an external observer starts waiting', async () => {
    const release = Promise.withResolvers<void>();
    const server = new ModelServer([
      async () => {
        await release.promise;
        return [call('check', {}, { callId: 'check-1' })];
      },
      [message('done')],
    ]);
    const provider = await providerFor(server);
    let callbackCompleted = false;
    const check = tool({
      name: 'check',
      parameters: z.object({}),
      execute(_args, context) {
        const own = context.submission;
        if (!('wait' in own)) throw new Error('Expected root submission');
        expect(() => own.wait()).toThrow();
        callbackCompleted = true;
        return 'checked';
      },
    });
    const session = await new Agent({
      instructions: 'Use check.',
      model: 'gpt-5',
      provider,
      tools: [check],
    }).session();
    try {
      const turn = await session.submit('begin');
      const external = turn.wait();
      release.resolve();
      expect((await external).finalOutput).toBe('done');
      expect(callbackCompleted).toBe(true);
      expect(await turn.wait()).toBe(await external);
    } finally {
      release.resolve();
      await session.close();
      await provider.close();
    }
    server.assertExhausted();
  });

  it('steers the exact active turn and retains its result after a later turn', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = new ModelServer([
      [call('lookup', {}, { callId: 'lookup-1' })],
      (request) => {
        expect(JSON.stringify(request.input)).toContain('steering detail');
        return [message('first')];
      },
      [message('second')],
    ]);
    const provider = await providerFor(server);
    const lookup = tool({
      name: 'lookup',
      parameters: z.object({}),
      execute: async () => {
        entered.resolve();
        await release.promise;
        return 'found';
      },
    });
    const session = await new Agent({
      instructions: 'Use lookup.',
      model: 'gpt-5',
      provider,
      tools: [lookup],
    }).session();
    try {
      const first = await session.submit('lookup');
      await entered.promise;
      expect(Object.isFrozen(first)).toBe(true);
      expect(await session.submit('steering detail')).toBe(first);
      await expect(session.update({ instructions: 'busy' })).rejects.toThrow();
      release.resolve();
      const result = await first.wait();
      expect(result.finalOutput).toBe('first');
      const second = await session.submit('next');
      expect(second).not.toBe(first);
      expect((await second.wait()).finalOutput).toBe('second');
      expect(await first.wait()).toBe(result);
    } finally {
      release.resolve();
      await session.close();
      await provider.close();
    }
    server.assertExhausted();
  });

  it('publishes idle updates, keeps the opening tool ceiling, and preserves the last result across compaction', async () => {
    const server = new ModelServer([
      (request) => {
        expect(JSON.stringify(request)).toContain('Updated instructions');
        expect(request.tools).toEqual([]);
        expect(request.model).toBe('gpt-5');
        expect(request.reasoning).toMatchObject({ effort: 'low' });
        return [message('remembered')];
      },
      [message('Summary: remembered')],
      [call('lookup', {}, { callId: 'restored-tool' })],
      [message('done')],
    ]);
    const provider = await providerFor(server);
    let called = 0;
    const lookup = tool({
      name: 'lookup',
      parameters: z.object({}),
      execute: () => {
        called++;
        return 'value';
      },
    });
    const extra = tool({
      name: 'extra',
      parameters: z.object({}),
      execute: () => 'never',
    });
    const session = await new Agent({
      instructions: 'Original',
      model: 'gpt-5',
      provider,
      tools: [lookup],
    }).session();
    try {
      await session.update({ instructions: 'Updated instructions' });
      await session.update({
        modelSettings: { reasoningEffort: 'low', serviceTier: null },
      });
      await session.update({ tools: [] });
      await expect(session.update({ tools: [extra] })).rejects.toThrow();
      const first = await (await session.submit('Remember')).wait();
      await session.compact();
      const saved = parseSessionState(
        JSON.stringify(await session.saveState()),
      );
      expect(await readSessionInstructions(saved)).toBe('Updated instructions');
      await expect(
        readSessionInstructions({
          ...saved,
          history: [...saved.history, ...saved.history],
        }),
      ).rejects.toThrow();
      expect(await session.wait()).toBe(first);
      await session.update({ tools: [lookup] });
      expect((await (await session.submit('Lookup')).wait()).finalOutput).toBe(
        'done',
      );
      expect(called).toBe(1);
    } finally {
      await session.close();
      await provider.close();
    }
    server.assertExhausted();
  });

  it('keeps stored message content out of checkpoint inspection and restore errors', async () => {
    const server = new ModelServer([]);
    const provider = await providerFor(server);
    const agent = new Agent({ instructions: 'Read state.', provider });
    const session = await agent.session();
    try {
      const saved = await session.saveState();
      const privateMessage = 'synthetic private checkpoint content';
      const stored = parseSessionState(
        JSON.stringify({
          ...saved,
          history: [
            ...saved.history,
            {
              type: 'response_item',
              payload: {
                type: 'message',
                role: 'user',
                content: privateMessage,
              },
            },
          ],
        }),
      );
      await expect(readSessionInstructions(stored)).rejects.not.toThrow(
        privateMessage,
      );
      await expect(agent.session({ state: stored })).rejects.not.toThrow(
        privateMessage,
      );
    } finally {
      await session.close();
      await provider.close();
    }
    server.assertExhausted();
  });

  it.each([
    { result: z.number(), invalid: 'invalid', wire: '7' },
    { result: z.string(), invalid: 7, wire: 'hello' },
  ])(
    'separates idle snapshots from resumable manual suspension and validates replies before consuming them ($wire)',
    async ({ result, invalid, wire }) => {
      const server = new ModelServer([
        [call('decision', {}, { callId: 'decision-1' })],
        [message('accepted')],
      ]);
      const provider = await providerFor(server);
      const decision = manualTool({
        name: 'decision',
        description: 'Get a decision.',
        parameters: z.object({}),
        result,
      });
      const declaration = {
        instructions: 'Ask decision.',
        model: 'gpt-5',
        provider,
        tools: [decision],
      };
      const agent = new Agent(declaration);
      const session = await agent.session();
      let state;
      try {
        await session.submit('Ask');
        for await (const event of session.events()) {
          if (event.type === 'action_requested') break;
        }
        await expect(session.saveState()).rejects.toThrow();
        state = await session.suspend();
        expect(await session.suspend()).toEqual(state);
      } finally {
        await session.close();
      }
      const structured = new Agent({
        ...declaration,
        outputType: z.object({ answer: z.string() }),
      });
      let dispatched = false;
      await expect(
        structured.run(null, {
          state,
          onInteraction(request) {
            dispatched = true;
            return request.reply(wire);
          },
        }),
      ).rejects.toBeInstanceOf(TypeError);
      expect(dispatched).toBe(false);
      expect(server.requests).toHaveLength(1);
      const restored = await agent.session({ state });
      try {
        let request;
        for await (const event of restored.events()) {
          if (event.type === 'action_requested') {
            request = event;
            break;
          }
        }
        if (!request) throw new Error('No restored request');
        await expect(restored.submit(request.reply(invalid))).rejects.toThrow();
        const turn = await restored.submit({
          type: 'function_call_output',
          call_id: request.callId,
          output: wire,
        });
        expect((await turn.wait()).finalOutput).toBe('accepted');
      } finally {
        await restored.close();
        await provider.close();
      }
      server.assertExhausted();
    },
  );
  it('accepts interruption before cooperative callback cleanup and joins cleanup on close', async () => {
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = new ModelServer([[call('held', {}, { callId: 'held-1' })]]);
    const provider = await providerFor(server);
    const held = tool({
      name: 'held',
      parameters: z.object({}),
      execute: async (_args, { signal }) => {
        signal.addEventListener('abort', () => aborted.resolve(), {
          once: true,
        });
        entered.resolve();
        await release.promise;
        return 'late';
      },
    });
    const session = await new Agent({
      instructions: 'Use held.',
      model: 'gpt-5',
      provider,
      tools: [held],
    }).session();
    try {
      const turn = await session.submit('Begin');
      const failure = turn.wait().catch((error) => error);
      await entered.promise;
      await session.interrupt({ scope: 'all' });
      await aborted.promise;
      let closed = false;
      const closing = session.close().then(() => {
        closed = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
      release.resolve();
      await closing;
      expect(await failure).toBeInstanceOf(Error);
    } finally {
      release.resolve();
      await session.close();
      await provider.close();
    }
    server.assertExhausted();
  });
});
