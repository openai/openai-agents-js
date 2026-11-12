import { describe, expect, it } from 'vitest';
import { Agent, ConversationsHistory, ConversationsWriteError } from '../src';
import {
  conversationMessage as message,
  conversationsClientFixture as fixture,
} from './fixtures/conversations';

describe('Conversations history HTTP ownership', () => {
  it('paginates existing items and retains exact tool identities', async () => {
    const { client, state } = fixture();
    state.items = [
      message(0),
      message(1),
      message(2),
      {
        type: 'function_call',
        id: 'fc_original',
        call_id: 'original-call',
        name: 'echo',
        arguments: '{}',
        status: 'completed',
        future: { retained: true },
      },
      {
        type: 'function_call_output',
        id: 'fco_original',
        call_id: 'original-call',
        output: 'exact receipt',
        status: 'completed',
      },
    ];
    const history = new ConversationsHistory(client, {
      conversationId: 'conv_existing',
    });
    expect(await history.getItems()).toEqual(state.items);
    expect(await history.getItems(3)).toEqual(state.items.slice(-3));
    const count = state.requests.length;
    expect(await history.getItems(0)).toEqual([]);
    expect(state.requests).toHaveLength(count);
    expect(state.creates).toBe(0);
    expect(client.maxRetries).toBe(3);
  });

  it('creates lazily, chunks append, pops, clears and creates a new identity', async () => {
    const { client, state } = fixture();
    const history = new ConversationsHistory(client);
    await history.addItems([]);
    expect(state.requests).toHaveLength(0);
    await history.addItems(Array.from({ length: 41 }, (_, i) => message(i)));
    expect(state.batches.map((batch) => batch.length)).toEqual([20, 20, 1]);
    expect(history.conversationId).toBe('conv_1');
    expect(await history.popItem()).toEqual(message(40));
    expect(await history.getItems(1)).toEqual([message(39)]);
    await history.clear();
    expect(history.conversationId).toBeUndefined();
    expect(state.items).toEqual([]);
    expect(await history.getConversationId()).toBe('conv_2');
    expect(client.maxRetries).toBe(3);
  });

  it('keeps an acknowledged prefix without retrying an uncertain chunk', async () => {
    const { client, state } = fixture();
    const history = new ConversationsHistory(client, {
      conversationId: 'conv_existing',
    });
    state.failBatch = 2;
    const items = Array.from({ length: 41 }, (_, i) => message(i));
    const error = await history.addItems(items).catch((cause) => cause);
    expect(error).toBeInstanceOf(ConversationsWriteError);
    expect(error.acknowledged).toBe(20);
    expect(error.items).toEqual(items);
    expect(state.batches).toHaveLength(2);
    expect(await history.getItems()).toEqual(items.slice(0, 20));
    expect(client.maxRetries).toBe(3);
  });
});

it('rejects competing history options before opening a native Session', async () => {
  const { client, state } = fixture();
  const history = new ConversationsHistory(client);
  const agent = new Agent({ instructions: 'Answer briefly.' });
  expect(() => history.run(agent, 'ignored', { initialMessages: [] })).toThrow(
    'fresh native Session history owner',
  );
  expect(state.requests).toEqual([]);
  expect(state.creates).toBe(0);
});
