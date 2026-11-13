import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  InteractionRequired,
  NativeProvider,
  manualTool,
  parseSessionState,
  type SessionState,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());
it.each(['capture', 'authenticated'] as const)(
  'retains detached authority through an early opening error: %s',
  async (mode) => {
    const server = new ModelServer([
      [call('transfer_to_target', {}, { callId: 'handoff' })],
      [call('confirm', {}, { callId: 'confirmation' })],
      [message('resumed complete')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-opening-authority',
      supportsWebsockets: false,
    });
    const gate = manualTool({
      name: 'confirm',
      description: 'Confirm.',
      parameters: z.object({}),
      result: z.string(),
    });
    const target = new Agent({
      name: 'target',
      instructions: 'Confirm then finish.',
      tools: [gate],
    });
    const source = new Agent({
      name: 'source',
      provider,
      model: 'gpt-5.5',
      instructions: 'Transfer.',
      handoffs: [target],
      prepareHandoffInput: (value) => ({
        ...value,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'trusted prepared context' }],
          },
        ],
        previous: [],
        generated: [],
      }),
    });
    let captured: SessionState | undefined;
    try {
      await source.run('begin');
    } catch (error) {
      if (!(error instanceof InteractionRequired)) throw error;
      captured = error.state;
    }
    if (!captured) throw new Error('Expected the sealed manual checkpoint');
    const serialized = JSON.stringify(captured);
    const state =
      mode === 'capture'
        ? captured
        : parseSessionState(serialized, {
            expectedSha256: createHash('sha256')
              .update(serialized)
              .digest('hex'),
          });
    let published: SessionState | undefined;
    try {
      await source.run(null, { state });
    } catch (error) {
      if (!(error instanceof InteractionRequired)) throw error;
      published = error.state;
    }
    if (!published)
      throw new Error('Expected the early opening-error checkpoint');
    expect(published).not.toBe(state);
    expect(JSON.stringify(published)).toBe(serialized);
    state.history.length = 0;
    expect(JSON.stringify(published)).toBe(serialized);
    expect(server.requests).toHaveLength(2);
    const result = await source.run(null, {
      state: published,
      onInteraction(request) {
        const action = gate.match(request);
        if (!action) throw new Error('Expected confirmation');
        return action.reply('confirmed');
      },
    });
    expect(result.finalOutput).toBe('resumed complete');
    expect(JSON.stringify(server.requests[2]?.input)).toContain(
      'trusted prepared context',
    );
    expect(server.requests).toHaveLength(3);
    server.assertExhausted();
  },
  30_000,
);
