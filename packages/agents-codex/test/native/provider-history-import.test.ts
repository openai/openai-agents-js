import { afterEach, expect, it } from 'vitest';
import { Agent, NativeProvider } from '../../src';
import { ModelServer, message } from './fixtures/model-server';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
afterEach(() => ModelServer.closeAll());

nativeIt(
  'replays portable content from imported provider items with repeated placeholder IDs',
  async () => {
    const server = new ModelServer([[message('Continued.')]]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-provider-history-key',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Respond.',
    });
    const items = [
      {
        type: 'message',
        role: 'assistant',
        id: '__fake_id__',
        content: [
          {
            type: 'output_text',
            text: 'Portable earlier reply.',
            annotations: [],
          },
        ],
        provider_data: { private_vendor_payload: 'SYNTHETIC_FOREIGN_METADATA' },
      },
      {
        type: 'message',
        role: 'assistant',
        id: '__fake_id__',
        content: [
          {
            type: 'output_text',
            text: 'Second portable reply.',
            annotations: [],
          },
        ],
      },
      {
        type: 'reasoning',
        id: '__fake_id__',
        summary: [
          { type: 'summary_text', text: 'SYNTHETIC_FOREIGN_REASONING' },
        ],
        encrypted_content: 'synthetic-foreign-provider-state',
        provider_data: {
          thinking_blocks: [
            {
              type: 'thinking',
              thinking: 'SYNTHETIC_FOREIGN_REASONING',
              signature: 'synthetic-foreign-provider-state',
            },
          ],
        },
      },
      {
        type: 'reasoning',
        id: 'rs_portable',
        summary: [{ type: 'summary_text', text: 'Portable provider summary.' }],
        encrypted_content: 'synthetic-current-provider-state',
        provider_data: {
          type: 'reasoning',
          id: 'rs_portable',
          encrypted_content: 'synthetic-current-provider-state',
          fixture_note: 'SYNTHETIC_CURRENT_PROVIDER_METADATA',
        },
      },
    ];

    await using session = await agent.session();
    const before = await session.historySnapshot();
    await session.transactHistory({
      expectedRevision: before.revision,
      keep: 0,
      items,
    });
    const stored = await session.historySnapshot();
    expect(stored.items).toEqual(expect.arrayContaining(items));
    await (await session.submit('Continue.')).wait();
    const input = JSON.stringify(server.requests[0]!.input);
    expect({
      portableText:
        input.includes('Portable earlier reply.') &&
        input.includes('Second portable reply.'),
      fakeId: input.includes('__fake_id__'),
      foreignItemMetadata: input.includes('SYNTHETIC_FOREIGN_METADATA'),
      foreignReasoning: input.includes('SYNTHETIC_FOREIGN_REASONING'),
      foreignEncryptedState: input.includes('synthetic-foreign-provider-state'),
      portableReasoning: input.includes('Portable provider summary.'),
      portableEncryptedState: input.includes(
        'synthetic-current-provider-state',
      ),
      portableItemMetadata: input.includes(
        'SYNTHETIC_CURRENT_PROVIDER_METADATA',
      ),
    }).toEqual({
      portableText: true,
      fakeId: false,
      foreignItemMetadata: false,
      foreignReasoning: false,
      foreignEncryptedState: false,
      portableReasoning: true,
      portableEncryptedState: true,
      portableItemMetadata: false,
    });
  },
  20_000,
);
