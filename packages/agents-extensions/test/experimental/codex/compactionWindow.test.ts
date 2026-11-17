import { expect, test, vi } from 'vitest';
import { Agent, MemorySession, Runner } from '@openai/agents-core';
import { OpenAIResponsesCompactionSession } from '@openai/agents';
import { CodexProvider } from '../../../src/experimental/codex';

const boundary = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../../../src/experimental/codex/appServer', () => ({
  openCodexAppServer: boundary.open,
}));

test('keeps standalone retained user input while excluding SDK provenance from stock wire', async () => {
  const marker = {
    type: 'compaction',
    id: 'cmp_returned',
    encrypted_content: 'opaque-returned-ciphertext',
  };
  const prefix = {
    type: 'message',
    id: 'msg_returned',
    role: 'user',
    content: [{ type: 'input_text', text: 'Actual retained prefix.' }],
  };
  const session = new OpenAIResponsesCompactionSession({
    underlyingSession: new MemorySession(),
    compactionMode: 'input',
    shouldTriggerCompaction: () => false,
    client: {
      responses: { compact: vi.fn(async () => ({ output: [prefix, marker] })) },
    } as any,
  });
  await session.runCompaction({ force: true });
  const server = {
    request: vi.fn(async (method: string, _params?: unknown) =>
      method === 'thread/start'
        ? { thread: { id: 'thread' } }
        : method === 'turn/start'
          ? { turn: { id: 'turn' } }
          : {},
    ),
    notify: vi.fn(),
    close: vi.fn(async () => {}),
    events: (async function* () {
      yield {
        method: 'item/completed',
        params: {
          threadId: 'thread',
          turnId: 'turn',
          item: { type: 'agentMessage', id: 'message', text: 'Done.' },
        },
      };
      yield {
        method: 'turn/completed',
        params: {
          threadId: 'thread',
          turn: { id: 'turn', status: 'completed' },
        },
      };
    })(),
  };
  boundary.open.mockResolvedValueOnce(server);
  const result = await new Runner({
    modelProvider: new CodexProvider({
      threadOptions: { skipGitRepoCheck: true },
    }),
    tracingDisabled: true,
  }).run(
    new Agent({ name: 'Reader', modelSettings: { store: false } }),
    'Continue.',
    { session },
  );
  expect(result.finalOutput).toBe('Done.');
  const wire = server.request.mock.calls.find(
    ([method]) => method === 'thread/inject_items',
  )![1] as { items: unknown[] };
  expect(wire.items).toEqual([
    { type: prefix.type, role: prefix.role, content: prefix.content },
    marker,
  ]);
  expect(JSON.stringify(wire)).not.toContain(
    'standaloneCompactionRetainedItemIds',
  );
});
