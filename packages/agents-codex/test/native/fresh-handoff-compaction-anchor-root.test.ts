import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, tool } from '../../src';
import { binding } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it('retires a fresh handoff view captured before automatic compaction', async () => {
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
  const server = new ModelServer(
    [
      [call('transfer_to_destination', {}, { callId: 'fresh-transfer' })],
      [call('lookup', {}, { callId: 'destination-effect' })],
      [message('destination after automatic compaction')],
    ],
    [
      '{"input_tokens":10,"output_tokens":1,"total_tokens":11}',
      '{"input_tokens":12000,"output_tokens":1,"total_tokens":12001}',
    ],
  );
  let compacted = 0;
  let effects = 0;
  try {
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-fresh-handoff-anchor',
      supportsWebsockets: false,
    });
    const destination = new Agent({
      name: 'destination',
      instructions: 'Run lookup and answer.',
      tools: [
        tool({
          name: 'lookup',
          parameters: z.object({}),
          execute: () => {
            effects++;
            return 'completed destination tool';
          },
        }),
      ],
      beforeCompact: () => {
        compacted++;
        return 'canonical fresh destination summary';
      },
    });
    const source = new Agent({
      name: 'source',
      instructions: 'Transfer to the destination.',
      model: 'gpt-5.5',
      provider,
      beforeCompact: () => {
        compacted++;
        return 'canonical fresh destination summary';
      },
      handoffs: [destination],
      prepareHandoffInput: (value) => ({
        ...value,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'retired fresh handoff view' },
            ],
          },
        ],
        previous: [],
        generated: [],
      }),
    });
    await using session = await source.session();
    expect(
      (await (await session.submit('source input')).wait()).finalOutput,
    ).toBe('destination after automatic compaction');
    expect(compacted).toBe(1);
    expect(server.requests).toHaveLength(3);
    expect(effects).toBe(1);
    expect(JSON.stringify(server.requests[1]?.input)).toContain(
      'retired fresh handoff view',
    );
    const input = JSON.stringify(server.requests[2]?.input);
    expect(input).toContain('canonical fresh destination summary');
    expect(input).not.toContain('retired fresh handoff view');
    server.assertExhausted();
  } finally {
    restore.mockRestore();
  }
}, 30_000);
