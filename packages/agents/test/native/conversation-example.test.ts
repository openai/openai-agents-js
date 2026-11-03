import { prepareOutput } from '../../src/runtime/output';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, NativeProvider, type Session } from '@openai/agents';
import { runConversation } from '../../examples/conversation';
import {
  ObservationBuffer,
  type ObservationPhase,
} from '../../src/runtime/observation';
import { CODEX_REVISION } from '../../src/runtime/state';

const exec = promisify(execFile);
afterEach(() => vi.restoreAllMocks());

// These doubles test only the example's promise and cleanup ownership, not Core.
function exampleSessions() {
  const buffer = new ObservationBuffer('example-session');
  let phase: ObservationPhase = 'open';
  const reader = buffer.events(
    {},
    {
      includes: (event) =>
        'submissionId' in event && event.submissionId === 'submission-2',
      phase: () => phase,
    },
  );
  const detached = vi.spyOn(reader, 'return');
  const waiting = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<{ finalOutput: string }>();
  const finish = () => {
    phase = 'ended';
    buffer.notify();
  };
  void answer.promise.then(finish, finish);
  const calls: string[] = [];
  let submissions = 0;
  const submit = vi.fn(async () => {
    const ordinal = ++submissions;
    return {
      submissionId: `submission-${ordinal}`,
      wait: () => {
        if (ordinal === 1)
          return Promise.resolve({
            finalOutput: 'You prefer vegetarian meals.',
          });
        return answer.promise;
      },
      events: () => {
        waiting.resolve();
        return reader;
      },
    };
  });
  const saveState = vi.fn(async () => ({
    kind: 'idle',
    network_policy_digest: null,
    output_context: prepareOutput(undefined).identity,
    native: {
      format_version: 2,
      codex_revision: CODEX_REVISION,
      source_session_id: 'example-session',
      history: [],
      root_metadata: {},
    },
  }));
  const session = {
    [Symbol.asyncDispose](): Promise<void> {
      return this.close();
    },
    submit,
    async *items() {
      yield { type: 'message', role: 'user', turnId: 'recorded-first' };
    },
    async *turns() {
      yield { id: 'recorded-first', status: 'completed' };
    },
    saveState,
    close: vi.fn(async () => {
      calls.push('session.close');
      answer.resolve({ finalOutput: 'You prefer vegetarian meals.' });
    }),
  };
  const restored = {
    [Symbol.asyncDispose](): Promise<void> {
      return this.close();
    },
    submit: vi.fn(async () => ({
      wait: async () => ({ finalOutput: 'You prefer vegetarian meals.' }),
    })),
    close: vi.fn(async () => {
      calls.push('restored.close');
    }),
  };
  const opening = vi
    .spyOn(Agent.prototype, 'session')
    .mockResolvedValueOnce(session as unknown as Session)
    .mockImplementationOnce(async () => {
      calls.push('restore.open');
      return restored as unknown as Session;
    });
  const closed = vi
    .spyOn(NativeProvider.prototype, 'close')
    .mockImplementation(async () => {
      calls.push('provider.close');
    });
  return {
    buffer,
    waiting,
    answer,
    detached,
    calls,
    submit,
    saveState,
    session,
    restored,
    opening,
    closed,
  };
}

function suppressedFailure(error: unknown) {
  // TypeScript can supply a fallback when the native constructor is absent.
  expect(error).toHaveProperty('name', 'SuppressedError');
  expect(error).toHaveProperty('error');
  expect(error).toHaveProperty('suppressed');
  return error as { error: unknown; suppressed: unknown };
}

describe('conversation example ownership without native execution', () => {
  it('ends the turn stream without deltas or a finish observation, then reads the result', async () => {
    const owned = exampleSessions();
    const writer = vi.fn();
    const running = runConversation({}, writer);
    await owned.waiting.promise;
    owned.answer.resolve({ finalOutput: 'You prefer vegetarian meals.' });
    expect(await running).toMatchObject({
      firstAnswer: 'You prefer vegetarian meals.',
      secondAnswer: 'You prefer vegetarian meals.',
      restoredAnswer: 'You prefer vegetarian meals.',
      history: { turns: [{ id: 'recorded-first', status: 'completed' }] },
    });
    expect(writer).not.toHaveBeenCalled();
    expect(owned.detached).not.toHaveBeenCalled();
    expect(owned.opening.mock.calls[1][0]).toMatchObject({
      state: {
        kind: 'idle',
        native: { format_version: 2, source_session_id: 'example-session' },
      },
    });
    expect(owned.calls).toEqual([
      'session.close',
      'restore.open',
      'restored.close',
      'provider.close',
    ]);
  });

  it('filters other submissions and joins cleanup when the writer throws', async () => {
    const owned = exampleSessions();
    const failure = new Error('Display closed');
    const writer = vi.fn(() => {
      throw failure;
    });
    const running = runConversation({}, writer);
    const rejected = expect(running).rejects.toBe(failure);
    await owned.waiting.promise;
    for (const submissionId of ['submission-1', 'submission-2']) {
      owned.buffer.append({
        type: 'output_text_delta',
        submissionId,
        turnId: 'native-turn',
        itemId: 'native-item',
        delta: submissionId,
      });
    }
    await rejected;
    expect(writer.mock.calls).toEqual([['submission-2']]);
    expect(owned.detached).toHaveBeenCalled();
    expect(owned.saveState).not.toHaveBeenCalled();
    expect(owned.calls).toEqual(['session.close', 'provider.close']);
    await expect(owned.answer.promise).resolves.toEqual({
      finalOutput: 'You prefer vegetarian meals.',
    });
  });

  it('preserves a failed result after the turn stream ends', async () => {
    const owned = exampleSessions();
    const failure = new Error('Turn failed');
    const running = runConversation();
    const rejected = expect(running).rejects.toBe(failure);
    await owned.waiting.promise;
    owned.answer.reject(failure);
    await rejected;
    expect(owned.detached).not.toHaveBeenCalled();
    expect(owned.saveState).not.toHaveBeenCalled();
    expect(owned.calls).toEqual(['session.close', 'provider.close']);
  });

  it.each([
    { source: 'writer', original: new Error('Writer failed') },
    { source: 'result', original: new Error('Result failed') },
    ...[undefined, null, false, 0, ''].map((original) => ({
      source: 'writer',
      original,
    })),
  ])(
    'retains $source failure $original through both cleanup failures',
    async ({ source, original }) => {
      const owned = exampleSessions();
      const sessionFailure = new Error('Session cleanup failed');
      const providerFailure = new Error('Provider cleanup failed');
      owned.session.close.mockImplementationOnce(async () => {
        owned.calls.push('session.close');
        owned.answer.resolve({ finalOutput: 'You prefer vegetarian meals.' });
        throw sessionFailure;
      });
      owned.closed.mockImplementationOnce(async () => {
        owned.calls.push('provider.close');
        throw providerFailure;
      });
      const running = runConversation({}, () => {
        throw original;
      });
      const rejected = running.then(
        () => {
          throw new Error('Conversation unexpectedly succeeded');
        },
        (error: unknown) => error,
      );
      await owned.waiting.promise;
      if (source === 'result') owned.answer.reject(original);
      else
        owned.buffer.append({
          type: 'output_text_delta',
          submissionId: 'submission-2',
          turnId: 'native-turn',
          itemId: 'native-item',
          delta: 'You prefer ',
        });
      const providerError = suppressedFailure(await rejected);
      expect(providerError.error).toBe(providerFailure);
      const sessionError = suppressedFailure(providerError.suppressed);
      expect(sessionError.error).toBe(sessionFailure);
      expect(sessionError.suppressed).toBe(original);
      expect(owned.calls).toEqual(['session.close', 'provider.close']);
      expect(owned.detached).toHaveBeenCalledTimes(source === 'writer' ? 1 : 0);
      expect(owned.saveState).not.toHaveBeenCalled();
    },
  );
});

// A small wire fixture proves the example against NativeProvider/Core separately.
async function conversationServer(streamText: boolean, failSecond = false) {
  const requests: Array<{ input: unknown }> = [];
  const failures: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const current = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(current);
      const ordinal = requests.length;
      assert(ordinal <= 3, 'Unexpected inference request');
      if (ordinal > 1) {
        assert(
          JSON.stringify(current.input).includes(
            'You prefer vegetarian meals.',
          ),
        );
      }
      if (failSecond && ordinal === 2) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: {
              message: 'CONVERSATION_SECOND_REQUEST_FAILED',
              type: 'invalid_request_error',
              code: 'invalid_request_error',
            },
          }),
        );
        return;
      }
      const text =
        ordinal === 2
          ? 'Try a vegetarian lentil curry.'
          : 'You prefer vegetarian meals.';
      const id = `conversation-response-${ordinal}`;
      const item = {
        type: 'message',
        id: `conversation-item-${ordinal}`,
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      };
      const send = (event: unknown) =>
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      send({ type: 'response.created', response: { id } });
      if (streamText && ordinal === 2) {
        send({
          type: 'response.output_item.added',
          output_index: 0,
          item: { ...item, content: [] },
        });
        for (const delta of ['Try a vegetarian ', 'lentil curry.']) {
          send({
            type: 'response.output_text.delta',
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            delta,
          });
        }
      }
      send({ type: 'response.output_item.done', output_index: 0, item });
      send({ type: 'response.completed', response: { id, output: [item] } });
      response.end();
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end('Conversation fixture failed');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    options: {
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'synthetic-conversation',
      supportsWebsockets: false,
    },
    assertExhausted(expectedRequests = 3) {
      expect(failures).toEqual([]);
      expect(requests).toHaveLength(expectedRequests);
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'conversation example with the native runtime',
  () => {
    it.each([true, false])(
      'continues and restores with streamText=%s',
      async (streamText) => {
        const server = await conversationServer(streamText);
        try {
          const deltas: string[] = [];
          const result = await runConversation(server.options, (delta) =>
            deltas.push(delta),
          );
          expect(result.secondAnswer).toBe('Try a vegetarian lentil curry.');
          expect(result.restoredAnswer).toBe('You prefer vegetarian meals.');
          expect(result.history.messages.map((item) => item.role)).toEqual([
            'user',
            'assistant',
            'user',
            'assistant',
          ]);
          expect(result.history.turns).toHaveLength(2);
          expect(
            result.history.turns.every((turn) => turn.status === 'completed'),
          ).toBe(true);
          expect(deltas.join('')).toBe(
            streamText ? 'Try a vegetarian lentil curry.' : '',
          );
          server.assertExhausted();
        } finally {
          await server.close();
        }
      },
      25000,
    );

    it('retains an actual failed second result after owned cleanup', async () => {
      const server = await conversationServer(false, true);
      try {
        await expect(runConversation(server.options)).rejects.toThrow(
          'CONVERSATION_SECOND_REQUEST_FAILED',
        );
        server.assertExhausted(2);
      } finally {
        await server.close();
      }
    }, 25000);

    it('retains an actual stream writer failure after owned cleanup', async () => {
      const server = await conversationServer(true);
      const failure = new Error('Conversation display failed');
      const writer = vi.fn((_delta: string) => {
        throw failure;
      });
      try {
        await expect(runConversation(server.options, writer)).rejects.toBe(
          failure,
        );
        expect(writer).toHaveBeenCalledOnce();
        server.assertExhausted(2);
      } finally {
        await server.close();
      }
    }, 25000);

    it('runs the CLI through the public package', async () => {
      const server = await conversationServer(true);
      try {
        const result = await exec(
          process.execPath,
          [
            '--import',
            'tsx',
            resolve('packages/agents/examples/conversation.ts'),
          ],
          {
            env: {
              ...process.env,
              OPENAI_API_KEY: server.options.apiKey,
              OPENAI_BASE_URL: server.options.baseUrl,
            },
            timeout: 20000,
          },
        );
        expect(result.stdout).toContain(
          'Try a vegetarian lentil curry.\nSettled answer: Try a vegetarian lentil curry.\nRestored answer: You prefer vegetarian meals.',
        );
        server.assertExhausted();
      } finally {
        await server.close();
      }
    }, 25000);
  },
);
