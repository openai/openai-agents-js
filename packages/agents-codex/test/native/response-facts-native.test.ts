import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { expect, it } from 'vitest';
import {
  Agent,
  NativeError,
  NativeProvider,
  type RecordedTurn,
} from '../../src';
const PRIVATE = 'SYNTHETIC_FACT_PRIVATE_CONTENT_9f0368';
const token = {
  token: 'a',
  bytes: [97],
  logprob: -1,
  top_logprobs: [{ token: PRIVATE, bytes: [], logprob: -2 }],
};
class FactPeer implements AsyncDisposable {
  readonly requests: any[] = [];
  readonly replies: boolean[] = [];
  readonly errors: unknown[] = [];
  private readonly sockets = new Set<Socket>();
  private readonly server = createServer(async (request, response) => {
    try {
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/v1/responses');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      this.requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      expect(this.replies.length).toBeGreaterThan(0);
      const refused = this.replies.shift()!,
        index = this.requests.length,
        id = `response-${index}`;
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'x-request-id': `upstream-${index}`,
      });
      const events: any[] = [{ type: 'response.created', response: { id } }];
      events.push({
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'message',
          id: refused ? 'refusal' : 'item-facts',
          role: 'assistant',
          content: [],
        },
      });
      if (refused)
        events.push(
          {
            type: 'response.refusal.delta',
            item_id: 'refusal',
            content_index: 0,
            delta: PRIVATE,
          },
          {
            type: 'response.refusal.done',
            item_id: 'refusal',
            content_index: 0,
            refusal: PRIVATE,
          },
        );
      else
        events.push(
          ...[0, 1].map(() => ({
            type: 'response.output_text.delta',
            item_id: 'item-facts',
            output_index: 0,
            content_index: 0,
            delta: 'a',
            logprobs: [token],
          })),
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              type: 'message',
              id: 'item-facts',
              role: 'assistant',
              content: [
                { type: 'output_text', text: 'aa', logprobs: [token, token] },
              ],
            },
          },
          { type: 'response.completed', response: { id } },
        );
      for (const event of events)
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end();
    } catch (error) {
      this.errors.push(error);
      response.destroy();
    }
  });
  url = '';
  async start() {
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', resolve),
    );
    const address = this.server.address();
    if (!address || typeof address === 'string')
      throw Error('missing owned endpoint');
    this.url = `http://127.0.0.1:${address.port}/v1`;
    return this;
  }
  async [Symbol.asyncDispose]() {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
    expect(this.replies).toEqual([]);
    expect(this.errors).toEqual([]);
  }
}
async function turnsOf(session: { turns(): AsyncIterable<RecordedTurn> }) {
  const turns: RecordedTurn[] = [];
  for await (const turn of session.turns()) turns.push(turn);
  return turns;
}
async function eventsOf(events: AsyncIterable<unknown>) {
  const result: unknown[] = [];
  for await (const event of events) result.push(event);
  return result;
}
it('preserves zero, actual IDs, trusted streamed probabilities and private history through restore without replay', async () => {
  await using peer = await new FactPeer().start();
  peer.replies.push(false, false, false);
  await using provider = new NativeProvider({
    baseUrl: peer.url,
    apiKey: 'synthetic-facts-key',
  });
  const agent = new Agent({
    instructions: 'Answer.',
    model: 'gpt-5.2',
    provider,
    modelSettings: { topLogprobs: 0 },
  });
  await using session = await agent.session();
  const turn = await session.submit('answer');
  expect((await turn.wait()).finalOutput).toBe('aa');
  expect(JSON.stringify(await eventsOf(turn.events()))).not.toContain(PRIVATE);
  expect(
    JSON.stringify(
      await eventsOf(turn.events({ includeExecutionDetails: true })),
    ),
  ).toContain(PRIVATE);
  const first = (await turnsOf(session))[0],
    facts = first.responseFacts!;
  expect(JSON.stringify(facts)).toContain(PRIVATE);
  const probabilities = facts.flatMap((record) =>
    record.fact.kind === 'text_probabilities' ? [record.fact] : [],
  );
  expect(
    probabilities.filter((fact) => !fact.snapshot).map((fact) => fact.delta),
  ).toEqual(['a', 'a']);
  expect(probabilities.every((fact) => fact.captureComplete)).toBe(true);
  expect(probabilities[0].tokens[0].topLogprobs![0].bytes).toEqual([]);
  expect(first.responses![0]).toMatchObject({
    responseId: 'response-1',
    upstreamRequestId: 'upstream-1',
    status: 'completed',
  });
  expect(facts[0].upstreamRequestId).toBe('upstream-1');
  expect(facts[0].requestId).not.toBeNull();
  expect(facts[0].requestId).not.toBe('upstream-1');
  expect(facts[0].requestId).not.toBe('response-1');
  expect(new Set(facts.map((record) => record.requestId)).size).toBe(1);
  const state = await session.saveState();
  await (await session.submit('again')).wait();
  expect(JSON.stringify(peer.requests.at(-1))).not.toContain(PRIVATE);
  await using restored = await new Agent({
    instructions: 'Answer.',
    provider,
  }).session({ state });
  expect((await turnsOf(restored))[0].responseFacts).toEqual(facts);
  await (await restored.submit('restored')).wait();
  expect(JSON.stringify(peer.requests.at(-1))).not.toContain(PRIVATE);
  expect(
    peer.requests.every(
      (request) =>
        request.top_logprobs === 0 &&
        request.include.includes('message.output_text.logprobs') &&
        request.include.includes('reasoning.encrypted_content'),
    ),
  ).toBe(true);
}, 30_000);
it('retains refusal content after failure without adding a provider terminal or replaying the content', async () => {
  await using peer = await new FactPeer().start();
  peer.replies.push(true, false);
  await using provider = new NativeProvider({
    baseUrl: peer.url,
    apiKey: 'synthetic-facts-key',
  });
  const agent = new Agent({
    instructions: 'Answer.',
    model: 'gpt-5.2',
    provider,
  });
  await using session = await agent.session();
  const turn = await session.submit('answer');
  const error = await turn.wait().then(
    () => {
      throw Error('refusal accepted');
    },
    (error) => error,
  );
  expect(error).toBeInstanceOf(NativeError);
  expect(error.responseIntegrityReason).toBe('provider_refusal');
  expect(String(error)).not.toContain(PRIVATE);
  expect(JSON.stringify(await eventsOf(turn.events()))).not.toContain(PRIVATE);
  expect(
    JSON.stringify(
      await eventsOf(turn.events({ includeExecutionDetails: true })),
    ),
  ).toContain(PRIVATE);
  const recorded = (await turnsOf(session))[0];
  expect(recorded.status).toBe('failed');
  expect(recorded.responses ?? []).toEqual([]);
  expect(
    recorded.responseFacts!.some(
      (record) =>
        record.fact.kind === 'refusal' &&
        record.fact.text === PRIVATE &&
        record.fact.captureComplete,
    ),
  ).toBe(true);
  const state = await session.saveState();
  await (await session.submit('continue')).wait();
  expect(JSON.stringify(peer.requests.at(-1))).not.toContain(PRIVATE);
  await using restored = await agent.session({ state });
  expect((await turnsOf(restored))[0].responseFacts).toEqual(
    recorded.responseFacts,
  );
}, 30_000);
it('does not retain or publish unsolicited probabilities', async () => {
  await using peer = await new FactPeer().start();
  peer.replies.push(false);
  await using provider = new NativeProvider({
    baseUrl: peer.url,
    apiKey: 'synthetic-facts-key',
  });
  await using session = await new Agent({
    instructions: 'Answer.',
    provider,
  }).session();
  const turn = await session.submit('answer');
  await turn.wait();
  expect(
    ((await turnsOf(session))[0].responseFacts ?? []).every(
      (record) => record.fact.kind !== 'text_probabilities',
    ),
  ).toBe(true);
  expect(
    JSON.stringify(
      await eventsOf(turn.events({ includeExecutionDetails: true })),
    ),
  ).not.toContain(PRIVATE);
  expect(peer.requests[0]).not.toHaveProperty('top_logprobs');
  expect(peer.requests[0].include).not.toContain(
    'message.output_text.logprobs',
  );
}, 30_000);
