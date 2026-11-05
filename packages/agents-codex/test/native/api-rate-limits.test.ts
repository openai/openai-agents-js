import { once } from 'node:events';
import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, type Observation } from '../../src';
import { message } from './fixtures/model-server';

async function nextLimits(events: AsyncIterableIterator<Observation>) {
  for (;;) {
    const { done, value } = await events.next();
    if (done) throw new Error('Turn finished before the rate-limit update');
    if (value.type === 'api_rate_limits_updated') return value;
  }
}

it('reports sparse HTTP limits before usage and keeps the latest usable response per session', async () => {
  const update = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the fixture's only model request.
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-ratelimit-limit-requests': '18446744073709551615',
      'x-ratelimit-remaining-requests': '0',
      'x-ratelimit-reset-project-tokens': '125ms',
      'x-ratelimit-reset-requests': 'not-a-duration',
      authorization: 'synthetic-private-header',
    });
    const write = (payload: object) =>
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
    const id = 'resp_limits';
    write({ type: 'response.created', response: { id } });
    await update.promise;
    write({
      type: 'response.in_progress',
      response: {
        id,
        headers: {
          'x-ratelimit-reset-tokens': '1m0.25s',
          'retry-after': 'Sun, 06 Nov 2095 08:49:37 GMT',
        },
      },
    });
    await finish.promise;
    write({
      type: 'response.output_item.done',
      output_index: 0,
      item: message('done'),
    });
    write({
      type: 'response.completed',
      response: {
        id,
        usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
      },
    });
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Fixture did not bind');
  try {
    await using provider = new NativeProvider({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'synthetic-rate-limit-key',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      instructions: 'Reply.',
      model: 'gpt-5',
      provider,
    });
    await using session = await agent.session();
    await using other = await agent.session();
    expect(session.rateLimits()).toEqual({});
    const turn = await session.submit('Reply.');
    const events = turn.events();
    try {
      const first = await nextLimits(events);
      expect(first.turnId).toBe(turn.turnId);
      expect(first.snapshot).toEqual({
        requests: { limit: 18_446_744_073_709_551_615n, remaining: 0 },
        projectTokens: { resetAfterSeconds: 0.125 },
      });
      expect(session.rateLimits()).toEqual(first.snapshot);
      expect(other.rateLimits()).toEqual({});
      update.resolve();
      const second = await nextLimits(events);
      expect(second.turnId).toBe(turn.turnId);
      expect(second.snapshot).toEqual({
        tokens: { resetAfterSeconds: 60.25 },
        retryAt: '2095-11-06T08:49:37.000Z',
      });
      expect(session.rateLimits()).toEqual(second.snapshot);
      finish.resolve();
      const result = await turn.wait();
      expect(result.finalOutput).toBe('done');
      expect(result.usage?.totalTokenUsage.totalTokens).toBe(7);
      expect(session.rateLimits()).toEqual(second.snapshot);
    } finally {
      update.resolve();
      finish.resolve();
      await events.return?.();
    }
  } finally {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
}, 15_000);

it.each([false, true])(
  'keeps the owning session current when a prompted repair is rate-limited: %s',
  async (rateLimited) => {
    const finishRepair = Promise.withResolvers<void>();
    let requests = 0;
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drain each fixture request before replying.
      }
      const repair = ++requests > 1;
      const remaining = repair ? (rateLimited ? '0' : '1') : '9';
      if (repair && rateLimited) {
        response.writeHead(429, {
          'content-type': 'application/json',
          'x-ratelimit-remaining-requests': remaining,
          'retry-after': '0',
        });
        response.end(
          JSON.stringify({
            error: {
              code: 'rate_limit_exceeded',
              message: 'Synthetic rate limit.',
            },
          }),
        );
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'x-ratelimit-remaining-requests': remaining,
      });
      const write = (payload: object) =>
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
      const id = repair ? 'resp_repair' : 'resp_original';
      write({ type: 'response.created', response: { id } });
      if (repair) await finishRepair.promise;
      write({
        type: 'response.output_item.done',
        output_index: 0,
        item: message(repair ? '{"label":"repaired"}' : '{"label":"x"}'),
      });
      write({ type: 'response.completed', response: { id } });
      response.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Fixture did not bind');
    try {
      await using provider = new NativeProvider({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: 'synthetic-rate-limit-key',
        supportsWebsockets: false,
      });
      const acquire = provider._acquire.bind(provider);
      vi.spyOn(provider, '_acquire').mockImplementation((captured) => {
        const lease = acquire(captured);
        lease.config['model_providers.native_agent.request_max_retries'] = 0;
        lease.config['model_providers.native_agent.stream_max_retries'] = 0;
        return lease;
      });
      await using session = await new Agent({
        instructions: 'Reply.',
        model: 'gpt-5',
        provider,
      }).session();
      const turn = await session.submitWithOutput('Reply.', {
        mode: 'prompted',
        schema: z.object({ label: z.string().min(2) }),
        maxRetries: 1,
      });
      const events = turn.events();
      try {
        const original = await nextLimits(events);
        expect(original.snapshot).toEqual({ requests: { remaining: 9 } });
        const repair = await nextLimits(events);
        expect(repair.parentSubmissionId).toBe(turn.submissionId);
        expect(repair.sessionId).not.toBe(session.id);
        expect(repair.snapshot).toEqual({
          requests: { remaining: rateLimited ? 0 : 1 },
          ...(rateLimited ? { retryAfterSeconds: 0 } : {}),
        });
        expect(session.rateLimits()).toEqual(repair.snapshot);
        finishRepair.resolve();
        if (rateLimited) {
          await expect(turn.waitForAttention()).resolves.toMatchObject({
            type: 'needs_attention',
            reason: 'rate_limited',
            rateLimits: repair.snapshot,
          });
        } else {
          expect((await turn.wait()).finalOutput).toEqual({
            label: 'repaired',
          });
        }
        expect(session.rateLimits()).toEqual(repair.snapshot);
        expect(requests).toBe(2);
      } finally {
        finishRepair.resolve();
        await events.return?.();
      }
    } finally {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    }
  },
  15_000,
);
