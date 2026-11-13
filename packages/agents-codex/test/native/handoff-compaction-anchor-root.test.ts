import { afterEach, expect, it } from 'vitest';
import { Agent, NativeProvider, type SessionState } from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it.each([false, true])(
  'retires a prepared handoff view when native compaction removes its anchor (cold=%s)',
  async (cold) => {
    const requests = new ModelServer([
      [call('transfer_to_destination', {}, { callId: 'accepted-transfer' })],
      [message('destination reached')],
      [message('continued from compaction')],
    ]);
    const config = await requests.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-retired-handoff-anchor',
      supportsWebsockets: false,
    });
    let compacted = 0;
    const destination = new Agent({
      name: 'destination',
      instructions: 'Destination authority.',
      beforeCompact: () => {
        compacted++;
        return 'canonical compacted replacement';
      },
    });
    const source = new Agent({
      name: 'source',
      model: 'gpt-5.5',
      provider,
      handoffs: [destination],
      instructions: 'Transfer to the destination.',
      prepareHandoffInput: (value) => ({
        ...value,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'old handoff projection' }],
          },
        ],
        previous: [],
        generated: [],
      }),
    });
    let state: SessionState;
    {
      await using session = await source.session();
      expect(
        (await (await session.submit('source input')).wait()).finalOutput,
      ).toBe('destination reached');
      await session.compact();
      expect(compacted).toBe(1);
      expect(requests.requests).toHaveLength(2);
      state = await session.saveState();
      if (!cold)
        expect(
          (await (await session.submit('continue')).wait()).finalOutput,
        ).toBe('continued from compaction');
    }
    if (cold) {
      await using restored = await source.session({ state });
      expect(
        (await (await restored.submit('continue')).wait()).finalOutput,
      ).toBe('continued from compaction');
    }
    const input = JSON.stringify(requests.requests[2]?.input);
    expect(input).toContain('canonical compacted replacement');
    expect(input).not.toContain('old handoff projection');
    requests.assertExhausted();
  },
  30_000,
);
