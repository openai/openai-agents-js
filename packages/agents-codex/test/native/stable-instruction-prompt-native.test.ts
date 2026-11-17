import OpenAI from 'openai';
import { afterEach, expect, it } from 'vitest';
import {
  Agent,
  NativeProvider,
  parseSessionState,
  ResponsesModel,
  type SessionState,
} from '../../src';
import { ModelServer, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it.each([false, true])(
  'keeps fresh and restored instruction text stable while retaining receipt identities and cache affinity (borrowed=%s)',
  async (borrowed) => {
    const server = new ModelServer(
      Array.from({ length: 3 }, () => [message('Accepted.')]),
    );
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-stable-instructions',
      supportsWebsockets: false,
      ...(borrowed
        ? {
            modelBackend: new ResponsesModel(
              new OpenAI({
                baseURL: (
                  config['model_providers.fixture'] as { base_url: string }
                ).base_url,
                apiKey: 'synthetic-stable-instructions',
                maxRetries: 0,
              }),
              'gpt-6.1-sol',
              { promptCacheKey: 'synthetic-stable-prompt', stream: true },
            ),
          }
        : {}),
    });
    const instructions =
      'Answer consistently.\nNative instruction revision: caller text';
    const agent = new Agent({ model: 'gpt-6.1-sol', instructions, provider });
    const states: SessionState[] = [];
    for (let index = 0; index < 2; index++) {
      await using session = await agent.session();
      expect(
        (await (await session.submit('Identical input')).wait()).finalOutput,
      ).toBe('Accepted.');
      states.push(await session.saveState());
    }
    {
      await using restored = await agent.session({
        state: parseSessionState(JSON.stringify(states[0])),
      });
      expect(
        (await (await restored.submit('Follow-up input')).wait()).finalOutput,
      ).toBe('Accepted.');
    }
    const expected = `<application_instructions>The following application instructions replace all earlier application instructions. An empty value clears them.\n${instructions}</application_instructions>`;
    const receiptIds = states.map((state) =>
      state.history.flatMap((row) => {
        const item = row.payload as { id?: string };
        return row.type === 'response_item' &&
          item.id?.startsWith('msg_sdk_application_')
          ? [item.id]
          : [];
      }),
    );
    expect(receiptIds[0].length).toBeGreaterThan(0);
    expect(receiptIds[1]).not.toEqual(receiptIds[0]);
    for (const state of states)
      expect(JSON.stringify(state)).toContain(
        'Native instruction revision: msg_sdk_application_',
      );
    for (const request of server.requests) {
      const input = request.input as {
        id?: string;
        role?: string;
        content?: { type: string; text?: string }[];
      }[];
      const text = input
        .filter((item) => item.role === 'developer')
        .flatMap((item) => item.content ?? [])
        .filter(
          (part) =>
            part.type === 'input_text' &&
            part.text?.includes('<application_instructions>'),
        )
        .map((part) => part.text);
      expect(text).toEqual([expected]);
    }
    const requestReceiptIds = server.requests.map((request) =>
      (request.input as { id?: string }[]).flatMap((item) =>
        item.id?.startsWith('msg_sdk_application_') ? [item.id] : [],
      ),
    );
    expect(requestReceiptIds).toEqual([
      receiptIds[0],
      receiptIds[1],
      receiptIds[0],
    ]);
    const freshInput = server.requests
      .slice(0, 2)
      .map((request) =>
        (request.input as { role?: string; content?: unknown }[]).map(
          ({ role, content }) => ({ role, content }),
        ),
      );
    expect(freshInput[0]).toEqual(freshInput[1]);
    expect(freshInput[0].at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'input_text', text: 'Identical input' }],
    });
    expect(server.requests[0].instructions).toEqual(
      server.requests[1].instructions,
    );
    const keys = server.requests.map((request) => request.prompt_cache_key);
    expect(keys[0]).toEqual(expect.any(String));
    expect(keys[0]).not.toBe('');
    if (borrowed)
      expect(keys).toEqual(Array(3).fill('synthetic-stable-prompt'));
    else {
      expect(keys[1]).toEqual(expect.any(String));
      expect(keys[1]).not.toBe(keys[0]);
      expect(keys[2]).toBe(keys[0]);
    }
    server.assertExhausted();
  },
  30_000,
);

it.each(['gpt-6.1-sol', 'gpt-5.5'])(
  'omits new CLI collaboration instructions before and after restore (%s)',
  async (model) => {
    const server = new ModelServer([
      [message('Saved.')],
      [message('Restored.')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-collaboration-instructions',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      model,
      instructions: 'Application instructions.',
      provider,
    });
    let state: SessionState;
    {
      await using source = await agent.session();
      expect(
        (await (await source.submit('Save a turn.')).wait()).finalOutput,
      ).toBe('Saved.');
      state = await source.saveState();
    }
    {
      await using restored = await agent.session({ state });
      expect(
        (await (await restored.submit('Continue a turn.')).wait()).finalOutput,
      ).toBe('Restored.');
    }
    for (const request of server.requests) {
      expect(JSON.stringify(request.input)).not.toContain(
        '<collaboration_mode>',
      );
      expect(JSON.stringify(request.input)).toContain(
        'Application instructions.',
      );
    }
    server.assertExhausted();
  },
  30_000,
);

it('preserves caller-authored collaboration text on fresh and restored model requests', async () => {
  const server = new ModelServer([[message('Saved.')], [message('Restored.')]]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-caller-collaboration',
    supportsWebsockets: false,
  });
  const instructions =
    '<collaboration_mode>Caller-owned instructions.</collaboration_mode>';
  const agent = new Agent({ model: 'gpt-6.1-sol', instructions, provider });
  let state: SessionState;
  {
    await using source = await agent.session();
    expect((await (await source.submit('Save.')).wait()).finalOutput).toBe(
      'Saved.',
    );
    state = await source.saveState();
  }
  {
    await using restored = await agent.session({ state });
    expect(
      (await (await restored.submit('Continue.')).wait()).finalOutput,
    ).toBe('Restored.');
  }
  for (const request of server.requests)
    expect(JSON.stringify(request.input)).toContain(instructions);
  server.assertExhausted();
}, 30_000);
