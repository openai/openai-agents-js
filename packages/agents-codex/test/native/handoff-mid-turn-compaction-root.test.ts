import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, tool } from '../../src';
import { binding } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it('prepares a handoff from the admitted replacement after mid-turn compaction', async () => {
  const native = await binding();
  const create = native.create_engine;
  const restore = vi
    .spyOn(native, 'create_engine')
    .mockImplementation((config, ...args) =>
      create(
        JSON.stringify({
          ...JSON.parse(config),
          model_context_window: 200000,
          model_auto_compact_token_limit: 10000,
        }),
        ...args,
      ),
    );
  const effects = vi.fn(() => 'once-only reserved tool result');
  const requests = new ModelServer(
    [
      [call('reserve', {}, { callId: 'effect-before-compaction' })],
      [message('canonical compaction summary')],
      [
        call(
          'transfer_to_destination',
          {},
          { callId: 'handoff-after-compaction' },
        ),
      ],
      [message('destination finished')],
    ],
    ['{"input_tokens":12000,"output_tokens":1,"total_tokens":12001}'],
  );
  try {
    const config = await requests.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-mid-turn-handoff',
      supportsWebsockets: false,
    });
    const destination = new Agent({
      name: 'destination',
      instructions: 'Use projected history.',
    });
    const prepare = vi.fn((value) => {
      expect(JSON.stringify(value.input)).toContain(
        'canonical compaction summary',
      );
      expect(value.previous).toEqual([]);
      expect(JSON.stringify(value.generated)).toContain(
        'handoff-after-compaction',
      );
      return {
        ...value,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'replacement view' }],
          },
        ],
        previous: [],
        generated: [],
      };
    });
    await using session = await new Agent({
      name: 'source',
      instructions: 'Reserve once and transfer.',
      model: 'gpt-5.5',
      provider,
      tools: [
        tool({ name: 'reserve', parameters: z.object({}), execute: effects }),
      ],
      handoffs: [destination],
      prepareHandoffInput: prepare,
    }).session();
    expect((await (await session.submit('start')).wait()).finalOutput).toBe(
      'destination finished',
    );
    expect(effects).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(requests.requests[2]?.input)).toContain(
      'canonical compaction summary',
    );
    expect(JSON.stringify(requests.requests[3]?.input)).toContain(
      'replacement view',
    );
    expect(JSON.stringify(requests.requests[3]?.input)).not.toContain(
      'once-only reserved tool result',
    );
    requests.assertExhausted();
  } finally {
    restore.mockRestore();
  }
}, 30_000);
