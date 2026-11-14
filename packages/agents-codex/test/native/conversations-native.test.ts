import { Session } from '../../src/runtime/session';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  ConversationsHistory,
  NativeProvider,
  InteractionRequired,
  RunCleanupError,
  ToolOutput,
  tool,
} from '../../src';
import {
  conversationMessage,
  conversationsClientFixture,
} from '../fixtures/conversations';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it('reopens native runs from ordered provider history without wire lineage', async () => {
  const { client, state } = conversationsClientFixture();
  const imageUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  state.items = [
    {
      ...conversationMessage(0),
      content: [
        { type: 'input_text', text: '0' },
        { type: 'input_image', image_url: imageUrl, detail: 'auto' },
      ],
    },
  ];
  const history = new ConversationsHistory(client, {
    conversationId: 'conv_existing',
  });
  const server = new ModelServer([
    [message('first answer')],
    [message('second answer')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-conversations',
    supportsWebsockets: false,
  });
  const agent = new Agent({ provider, instructions: 'Answer the caller.' });
  expect((await history.run(agent, 'first question')).finalOutput).toBe(
    'first answer',
  );
  expect((await history.run(agent, 'second question')).finalOutput).toBe(
    'second answer',
  );
  expect(state.items).toHaveLength(5);
  expect(state.creates).toBe(0);
  expect(server.requests).toHaveLength(2);
  expect(JSON.stringify(server.requests[0])).toContain(imageUrl);
  const second = JSON.stringify(server.requests[1]);
  expect(second).toContain(imageUrl);
  expect(second).toContain('first question');
  expect(second).toContain('first answer');
  expect(second).toContain('second question');
  for (const request of server.requests) {
    expect(request).not.toHaveProperty('conversation');
    expect(request).not.toHaveProperty('previous_response_id');
  }
});

it('retains native tool call and receipt identities across a later run', async () => {
  const { client, state } = conversationsClientFixture();
  const history = new ConversationsHistory(client);
  const server = new ModelServer([
    [call('lookup', {}, { callId: 'original-tool-call' })],
    [message('first answer')],
    [message('later answer')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-conversations',
    supportsWebsockets: false,
  });
  let effects = 0;
  const lifecycle: string[] = [];
  const agent = new Agent({
    provider,
    onToolLifecycle: (event) => {
      lifecycle.push(event.kind);
    },
    instructions: 'Use lookup once, then answer.',
    tools: [
      tool({
        name: 'lookup',
        parameters: z.object({}),
        execute: () => {
          expect(lifecycle).toEqual(['start']);
          effects++;
          return new ToolOutput(
            [{ type: 'inputText', text: 'exact native receipt' }],
            true,
            { privateMarker: 'conversations-private-value' },
          );
        },
      }),
    ],
  });
  expect((await history.run(agent, 'first question')).finalOutput).toBe(
    'first answer',
  );
  expect((await history.run(agent, 'later question')).finalOutput).toBe(
    'later answer',
  );
  expect(effects).toBe(1);
  expect(lifecycle).toEqual(['start', 'end']);
  expect(
    state.items.filter((item) => item.type === 'function_call'),
  ).toMatchObject([
    { call_id: 'original-tool-call', name: 'lookup', arguments: '{}' },
  ]);
  expect(
    state.items.filter((item) => item.type === 'function_call_output'),
  ).toMatchObject([{ call_id: 'original-tool-call' }]);
  expect(JSON.stringify(server.requests[2])).toContain('exact native receipt');
  expect(JSON.stringify(state.items)).not.toContain(
    'conversations-private-value',
  );
  expect(JSON.stringify(server.requests)).not.toContain(
    'conversations-private-value',
  );
});

it('preserves accepted tool receipts after model failure without rerunning effects', async () => {
  const { client, state } = conversationsClientFixture();
  const history = new ConversationsHistory(client);
  const server = new ModelServer([
    [call('lookup', {}, { callId: 'settled-before-failure' })],
    {
      status: 400,
      body: JSON.stringify({ error: { message: 'synthetic model failure' } }),
    },
    [message('recovered answer')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-conversations',
    supportsWebsockets: false,
  });
  let effects = 0;
  const agent = new Agent({
    provider,
    instructions: 'Use lookup once, then answer.',
    tools: [
      tool({
        name: 'lookup',
        parameters: z.object({}),
        execute: () => {
          effects++;
          return 'settled before failure';
        },
      }),
    ],
  });
  const failure = await history
    .run(agent, 'first question')
    .catch((error) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(server.requests).toHaveLength(2);
  expect(
    state.items.filter((item) => item.type === 'function_call_output'),
  ).toMatchObject([{ call_id: 'settled-before-failure' }]);
  expect(
    (await history.run(agent, 'continue from the saved receipt')).finalOutput,
  ).toBe('recovered answer');
  expect(effects).toBe(1);
  expect(JSON.stringify(server.requests[2])).toContain(
    'settled before failure',
  );
});

it('captures structured input before waiting behind queued history work', async () => {
  const { client, state } = conversationsClientFixture();
  const history = new ConversationsHistory(client);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  state.beforeCreate = async () => {
    entered.resolve();
    await release.promise;
  };
  const first = history.getConversationId();
  await entered.promise;
  const server = new ModelServer([[message('captured answer')]]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-conversations',
    supportsWebsockets: false,
  });
  const agent = new Agent({ provider, instructions: 'Answer briefly.' });
  const input = {
    role: 'user' as const,
    content: [{ type: 'input_text' as const, text: 'captured before queue' }],
  };
  const pending = history.run(agent, input);
  input.content[0].text = 'caller mutation after queue';
  release.resolve();
  await first;
  expect((await pending).finalOutput).toBe('captured answer');
  expect(JSON.stringify(server.requests)).toContain('captured before queue');
  expect(JSON.stringify(server.requests)).not.toContain(
    'caller mutation after queue',
  );
  expect(JSON.stringify(state.items)).toContain('captured before queue');
});

it('fails unattended approvals without executing or holding the history queue', async () => {
  const { client } = conversationsClientFixture();
  const history = new ConversationsHistory(client);
  const server = new ModelServer([
    [call('approval_only', {}, { callId: 'unattended-approval' })],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-conversations',
    supportsWebsockets: false,
  });
  let effects = 0;
  const agent = new Agent({
    provider,
    instructions: 'Call the tool.',
    tools: [
      tool({
        name: 'approval_only',
        parameters: z.object({}),
        needsApproval: true,
        execute: () => {
          effects++;
          return 'must not execute';
        },
      }),
    ],
  });
  const failure = await history
    .run(agent, 'needs approval')
    .catch((error) => error);
  expect(
    failure instanceof InteractionRequired ||
      failure.cause instanceof InteractionRequired,
  ).toBe(true);
  expect(effects).toBe(0);
  expect(server.requests).toHaveLength(1);
  await expect(history.getItems()).resolves.toBeInstanceOf(Array);
});

it('retains completed output and retryable cleanup without repeating remote work', async () => {
  const { client, state } = conversationsClientFixture();
  const history = new ConversationsHistory(client);
  const server = new ModelServer([[message('already committed')]]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-conversations',
    supportsWebsockets: false,
  });
  const agent = new Agent({ provider, instructions: 'Answer briefly.' });
  const close = Session.prototype.close;
  let fail = true;
  const spy = vi.spyOn(Session.prototype, 'close').mockImplementation(function (
    this: Session,
    ...args
  ) {
    if (fail) {
      fail = false;
      return Promise.reject(new Error('retryable cleanup'));
    }
    return Reflect.apply(close, this, args);
  });
  let failure: RunCleanupError | undefined;
  try {
    const caught = await history
      .run(agent, 'one request')
      .catch((error) => error);
    expect(caught).toBeInstanceOf(RunCleanupError);
    failure = caught;
    expect(failure!.result?.finalOutput).toBe('already committed');
    expect(state.items).toHaveLength(2);
    await expect(provider.close()).rejects.toThrow('open or opening');
    await failure!.cleanup.close();
    expect(server.requests).toHaveLength(1);
    expect(state.batches).toHaveLength(1);
  } finally {
    spy.mockRestore();
    await failure?.cleanup.close();
  }
});
