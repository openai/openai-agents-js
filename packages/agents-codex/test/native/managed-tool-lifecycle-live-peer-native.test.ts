import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  tool,
  parseSessionState,
  isFunctionApprovalRequest,
  type FunctionApprovalRequest,
} from '../../src';
import { ModelServer, call } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it('keeps a fresh completed terminal peer when a nonterminal end observer fails', async () => {
  const failure = new Error('later nonterminal end observer failed');
  const effects: string[] = [];
  const server = new ModelServer([
    [
      call('later', {}, { callId: 'live-nonterminal' }),
      call('terminal', {}, { callId: 'live-terminal' }),
    ],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-live-peer',
    supportsWebsockets: false,
    requestMaxRetries: 0,
    streamMaxRetries: 0,
  });
  const agent = new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Run both approved tools.',
    tools: [
      tool({
        name: 'later',
        parameters: z.object({}),
        needsApproval: true,
        execute: () => {
          effects.push('later');
          return 'FRESH_NONTERMINAL_PEER_RESULT';
        },
      }),
      tool({
        name: 'terminal',
        parameters: z.object({}),
        needsApproval: true,
        finishTurn: true,
        execute: () => {
          effects.push('terminal');
          return 'FRESH_TERMINAL_PEER_RESULT';
        },
      }),
    ],
  });
  async function approvals(session: {
    interactions(): AsyncIterable<unknown>;
  }) {
    const result: FunctionApprovalRequest[] = [];
    for await (const request of session.interactions()) {
      if (isFunctionApprovalRequest(request)) result.push(request);
      if (result.length === 2) return result;
    }
    throw Error('Missing two current approval owners');
  }
  let serialized: string;
  {
    await using source = await agent.session();
    const turn = await source.submit('Go.');
    void turn.wait().catch(() => {});
    await approvals(source);
    serialized = JSON.stringify(await source.suspend());
  }
  expect(effects).toEqual([]);
  const state = parseSessionState(serialized, {
    expectedSha256: createHash('sha256').update(serialized).digest('hex'),
  });
  await using restored = await agent.session({
    state,
    onToolLifecycle(event) {
      if (event.callId === 'live-nonterminal' && event.kind === 'end')
        throw failure;
    },
  });
  const requests = await approvals(restored);
  const terminal = requests.find(
    (request) => request.callId === 'live-terminal',
  )!;
  const later = requests.find(
    (request) => request.callId === 'live-nonterminal',
  )!;
  const done = restored.restoredTurn!.wait();
  void done.catch(() => {});
  await restored.respond(terminal.approve());
  await expect.poll(() => effects).toEqual(['terminal']);
  await restored.respond(later.approve());
  await expect(done).rejects.toBe(failure);
  expect(effects).toEqual(['terminal', 'later']);
  expect(server.requests).toHaveLength(1);
  let rows: readonly unknown[] = [];
  await expect
    .poll(
      async () => {
        try {
          rows = (await restored.historySnapshot()).items;
          return rows.filter((item) =>
            /FRESH_(NONTERMINAL|TERMINAL)_PEER_RESULT/.test(
              JSON.stringify(item),
            ),
          ).length;
        } catch (error) {
          if (
            error instanceof Error &&
            /requires a settled open session/.test(error.message)
          )
            return 0;
          throw error;
        }
      },
      { timeout: 3000 },
    )
    .toBe(2);
  expect(
    rows.filter((item) =>
      JSON.stringify(item).includes('FRESH_NONTERMINAL_PEER_RESULT'),
    ),
  ).toHaveLength(1);
  expect(
    rows.filter((item) =>
      JSON.stringify(item).includes('FRESH_TERMINAL_PEER_RESULT'),
    ),
  ).toHaveLength(1);
});
