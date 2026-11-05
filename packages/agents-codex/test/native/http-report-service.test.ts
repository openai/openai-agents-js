import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent, NativeProvider, Turn, type Session } from '@openai/agents';
import { startReportService } from '../../examples/http-report-service';
import { text, toolCall, withScriptedResponses } from '../../src/testing';
import { ModelServer, message } from './fixtures/model-server';

type Snapshot = {
  id: string;
  revision: number;
  status: string;
  pending: { id: string; prompt: string }[];
  result?: { title: string; body: string };
  error?: string;
  artifactAvailable: boolean;
};
type Service = Awaited<ReturnType<typeof startReportService>>;
const report = { title: 'A report', body: 'For the chosen audience.' };
const manual = (callId: string) =>
  toolCall('choose_audience', { prompt: 'Who is the audience?' }, { callId });
function request(
  service: Service,
  path: string,
  options: RequestInit = {},
  owner = 'alice',
) {
  return fetch(`${service.url}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${owner}`,
      'content-type': 'application/json',
      ...options.headers,
    },
  });
}
function serviceFor(provider: NativeProvider) {
  return startReportService({
    provider,
    authenticate: (request) => {
      const token = request.headers.authorization;
      return token === 'Bearer alice'
        ? 'alice'
        : token === 'Bearer bob'
          ? 'bob'
          : undefined;
    },
  });
}
async function start(service: Service, id = randomUUID(), owner = 'alice') {
  const response = await request(
    service,
    `/jobs/${id}`,
    { method: 'PUT', body: JSON.stringify({ prompt: 'Write a report.' }) },
    owner,
  );
  expect(response.status).toBe(202);
  return ((await response.json()) as Snapshot).id;
}
async function state(service: Service, id: string) {
  const response = await request(service, `/jobs/${id}`);
  expect(response.status).toBe(200);
  return response.json() as Promise<Snapshot>;
}
async function until(
  service: Service,
  id: string,
  predicate: (snapshot: Snapshot) => boolean,
) {
  let current: Snapshot;
  await vi.waitFor(
    async () => {
      current = await state(service, id);
      expect(predicate(current)).toBe(true);
    },
    { timeout: 15_000, interval: 10 },
  );
  return current!;
}
async function reply(
  service: Service,
  id: string,
  alias: string,
  audience = 'technical',
) {
  return request(service, `/jobs/${id}/replies/${alias}`, {
    method: 'POST',
    body: JSON.stringify({ audience }),
  });
}
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-service',
    supportsWebsockets: false,
  });
}
beforeEach(() => {
  vi.stubEnv('OPENAI_API_KEY', undefined);
  vi.stubEnv('CODEX_API_KEY', undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await ModelServer.closeAll();
});

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'worker-owned report service',
  () => {
    it('keeps a live request through disconnect, scopes access, and delivers exactly one native reply', async () => {
      await withScriptedResponses(
        [[manual('audience-a')], [text(JSON.stringify(report))]],
        async (peer) => {
          const service = await serviceFor(peer.provider);
          try {
            const id = await start(service);
            const pending = await until(
              service,
              id,
              (s) => s.pending.length === 1,
            );
            const alias = pending.pending[0].id;
            const stream = await request(service, `/jobs/${id}/events`);
            const reader = stream.body!.getReader();
            expect(
              new TextDecoder().decode((await reader.read()).value),
            ).toContain('snapshot');
            await reader.cancel();
            expect((await state(service, id)).pending[0].id).toBe(alias);
            for (const suffix of ['', '/events', '/artifact']) {
              expect(
                (await request(service, `/jobs/${id}${suffix}`, {}, 'bob'))
                  .status,
              ).toBe(404);
            }
            expect(
              (
                await request(
                  service,
                  `/jobs/${id}/replies/${alias}`,
                  { method: 'POST', body: '{"audience":"technical"}' },
                  'bob',
                )
              ).status,
            ).toBe(404);
            expect(
              (
                await request(service, `/jobs/${id}`, {
                  method: 'PUT',
                  body: '{"prompt":"again"}',
                })
              ).status,
            ).toBe(409);
            expect((await reply(service, id, alias, 'invalid')).status).toBe(
              400,
            );
            expect((await state(service, id)).pending[0].id).toBe(alias);
            expect(
              (await request(service, `/jobs/${id}/artifact`)).status,
            ).toBe(409);
            const reconnected = await request(service, `/jobs/${id}/events`);
            const replies = await Promise.all([
              reply(service, id, alias),
              reply(service, id, alias),
            ]);
            expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
            const frames = await reconnected.text();
            expect(frames).toContain('"status":"completed"');
            expect(frames).not.toContain('event: text'); // Fixture emits final items without deltas.
            const completed = await state(service, id);
            expect(completed.revision).toBeGreaterThan(pending.revision);
            expect(completed).toMatchObject({
              status: 'completed',
              result: report,
              artifactAvailable: true,
              pending: [],
            });
            expect(peer.toolOutput('audience-a')).toContain('technical');
            const artifact = await request(service, `/jobs/${id}/artifact`);
            expect(artifact.headers.get('content-disposition')).toBe(
              'attachment; filename="report.json"',
            );
            expect(await artifact.json()).toEqual(report);
            expect((await reply(service, id, alias)).status).toBe(409);
            const stopped = await request(service, `/jobs/${id}/stop`, {
              method: 'POST',
            });
            expect(await stopped.json()).toMatchObject({
              status: 'completed',
              result: report,
            });
          } finally {
            await service.close();
          }
          peer.assertExhausted();
        },
      );
    });

    it('stops only the captured job, fences wrong-job aliases, and joins reader/session cleanup', async () => {
      await withScriptedResponses(
        [[manual('a')], [manual('b')], [text(JSON.stringify(report))]],
        async (peer) => {
          const service = await serviceFor(peer.provider);
          try {
            const a = await start(service);
            const first = await until(
              service,
              a,
              (s) => s.pending.length === 1,
            );
            const b = await start(service);
            const second = await until(
              service,
              b,
              (s) => s.pending.length === 1,
            );
            const aliasA = first.pending[0].id;
            const aliasB = second.pending[0].id;
            expect((await reply(service, b, aliasA)).status).toBe(409);
            const stream = await request(service, `/jobs/${a}/events`);
            const stops = await Promise.all(
              [0, 1].map(() =>
                request(service, `/jobs/${a}/stop`, { method: 'POST' }),
              ),
            );
            for (const stopped of stops)
              expect(await stopped.json()).toMatchObject({
                status: 'stopped',
                pending: [],
                artifactAvailable: false,
              });
            expect(await stream.text()).toContain('"status":"stopped"');
            expect((await reply(service, a, aliasA)).status).toBe(409);
            expect((await state(service, b)).pending[0].id).toBe(aliasB);
            expect((await reply(service, b, aliasB)).status).toBe(200);
            await until(service, b, (s) => s.status === 'completed');
            expect(peer.toolOutput('b')).toContain('technical');
            expect(peer.toolOutput('a')).toBeUndefined();
          } finally {
            await service.close();
          }
        },
      );
    });

    it.each([undefined, '', 'not JSON', '{"title":"private raw output"}'])(
      'sanitizes invalid final output %j and never exposes an artifact',
      async (output) => {
        await withScriptedResponses(
          [output === undefined ? [] : [text(output)]],
          async (peer) => {
            const service = await serviceFor(peer.provider);
            try {
              const id = await start(service);
              const response = await request(service, `/jobs/${id}/events`);
              const frames = await response.text();
              expect(frames).toContain('"status":"failed"');
              expect(frames).not.toContain('private raw output');
              expect(await state(service, id)).toMatchObject({
                status: 'failed',
                // Core rejects a missing assistant item before local typed parsing.
                error: output === undefined ? 'run_failed' : 'output_invalid',
                artifactAvailable: false,
              });
              expect(
                (await request(service, `/jobs/${id}/artifact`)).status,
              ).toBe(409);
            } finally {
              await service.close();
            }
          },
        );
      },
    );

    it('retains Stop intent while a real Session is opening and skips model submission', async () => {
      await withScriptedResponses([], async (peer) => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const original = Agent.prototype.session;
        vi.spyOn(Agent.prototype, 'session').mockImplementationOnce(
          async function (this: Agent) {
            entered.resolve();
            await release.promise;
            return original.call(this);
          },
        );
        const closed = vi.spyOn(
          (await import('../../src/runtime/session')).Session.prototype,
          'close',
        );
        const service = await serviceFor(peer.provider);
        try {
          const id = await start(service);
          await entered.promise;
          let acknowledged = false;
          const stopping = request(service, `/jobs/${id}/stop`, {
            method: 'POST',
          }).then((r) => {
            acknowledged = true;
            return r;
          });
          await until(service, id, (s) => s.status === 'stopping');
          expect(acknowledged).toBe(false);
          release.resolve();
          expect(await (await stopping).json()).toMatchObject({
            status: 'stopped',
          });
          expect(closed).toHaveBeenCalled();
          expect(peer.requests).toHaveLength(0);
        } finally {
          release.resolve();
          await service.close();
        }
      });
    });

    it('cancels a real issued Turn when Stop crosses submit admission', async () => {
      await withScriptedResponses([[manual('admission')]], async (peer) => {
        const sessionModule = await import('../../src/runtime/session');
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const original = sessionModule.Session.prototype.submitWithOutput;
        vi.spyOn(
          sessionModule.Session.prototype,
          'submitWithOutput',
        ).mockImplementationOnce(async function (
          this: Session,
          ...args: Parameters<typeof original>
        ) {
          const turn = await original.apply(this, args);
          entered.resolve();
          await release.promise;
          return turn;
        });
        const service = await serviceFor(peer.provider);
        try {
          const id = await start(service);
          await entered.promise;
          await vi.waitFor(() => expect(peer.requests).toHaveLength(1));
          const stopping = request(service, `/jobs/${id}/stop`, {
            method: 'POST',
          });
          await until(service, id, (s) => s.status === 'stopping');
          release.resolve();
          expect(await (await stopping).json()).toMatchObject({
            status: 'stopped',
            pending: [],
          });
        } finally {
          release.resolve();
          await service.close();
        }
      });
    });

    it('waits for typed settlement and cleanup before publishing a no-delta artifact', async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const server = new ModelServer([
        async () => {
          entered.resolve();
          await release.promise;
          return [message(JSON.stringify(report))];
        },
      ]);
      await using provider = await providerFor(server);
      const service = await serviceFor(provider);
      try {
        const id = await start(service);
        await entered.promise;
        const stream = await request(service, `/jobs/${id}/events`);
        expect((await request(service, `/jobs/${id}/artifact`)).status).toBe(
          409,
        );
        release.resolve();
        expect(await stream.text()).toContain('"status":"completed"');
        expect(await state(service, id)).toMatchObject({ result: report });
        server.assertExhausted();
      } finally {
        release.resolve();
        await service.close();
      }
    });

    it('preserves a typed failure and a cleanup failure through a late Stop', async () => {
      await withScriptedResponses(
        [[text('private malformed output')]],
        async (peer) => {
          const sessionModule = await import('../../src/runtime/session');
          const original = sessionModule.Session.prototype.close;
          const closing = Promise.withResolvers<void>();
          const release = Promise.withResolvers<void>();
          vi.spyOn(
            sessionModule.Session.prototype,
            'close',
          ).mockImplementationOnce(async function (this: Session) {
            await original.call(this);
            closing.resolve();
            await release.promise;
            throw new Error('synthetic cleanup failure');
          });
          const service = await serviceFor(peer.provider);
          try {
            const id = await start(service);
            await closing.promise;
            const stopped = request(service, `/jobs/${id}/stop`, {
              method: 'POST',
            });
            expect(
              (await request(service, `/jobs/${id}/artifact`)).status,
            ).toBe(409);
            release.resolve();
            expect(await (await stopped).json()).toMatchObject({
              status: 'failed',
              error: 'output_invalid',
              artifactAvailable: false,
            });
          } finally {
            release.resolve();
            await service.close();
          }
        },
      );
    });

    it('joins the owned Session when native cancellation rejects before stopping work', async () => {
      await withScriptedResponses(
        [[manual('cancel-rejected')]],
        async (peer) => {
          const service = await serviceFor(peer.provider);
          try {
            const id = await start(service);
            await until(service, id, (s) => s.pending.length === 1);
            vi.spyOn(Turn.prototype, 'cancel').mockRejectedValueOnce(
              new Error('synthetic native reservation failure'),
            );
            const response = await request(service, `/jobs/${id}/stop`, {
              method: 'POST',
            });
            expect(await response.json()).toMatchObject({
              status: 'failed',
              error: 'cleanup_failed',
              pending: [],
              artifactAvailable: false,
            });
            expect(
              (await request(service, `/jobs/${id}/artifact`)).status,
            ).toBe(409);
          } finally {
            await service.close();
          }
        },
      );
    });

    it('closes readers and joins a pending Session without closing the borrowed provider', async () => {
      await withScriptedResponses([[manual('shutdown')]], async (peer) => {
        const closeProvider = vi.spyOn(peer.provider, 'close');
        const service = await serviceFor(peer.provider);
        const id = await start(service);
        await until(service, id, (s) => s.pending.length === 1);
        const stream = await request(service, `/jobs/${id}/events`);
        await service.close();
        await service.close();
        await expect(stream.text()).rejects.toThrow();
        expect(closeProvider).not.toHaveBeenCalled();
        closeProvider.mockRestore();
      });
    });
  },
);

// These controlled observation fixtures test HTTP framing and cleanup only;
// the suite above supplies the real native Session/Turn evidence.
describe('report observation transport', () => {
  async function fixture() {
    const { ObservationBuffer } = await import('../../src/runtime/observation');
    const buffer = new ObservationBuffer('transport-session');
    const completion = Promise.withResolvers<{ finalOutput: typeof report }>();
    const closing = Promise.withResolvers<void>();
    const releaseClose = Promise.withResolvers<void>();
    const detached = vi.fn();
    const turn = {
      submissionId: 'transport-root',
      wait: () => completion.promise,
      cancel: async () => {
        completion.resolve({ finalOutput: report });
      },
    };
    const session = {
      submitWithOutput: async () => turn,
      events: (options?: { after?: number }) => {
        const events = buffer.events(options);
        const original = events.return!.bind(events);
        events.return = async () => {
          detached();
          return original();
        };
        return events;
      },
      close: async () => {
        closing.resolve();
        await releaseClose.promise;
        buffer.finish('closed');
      },
    };
    vi.spyOn(Agent.prototype, 'session').mockResolvedValueOnce(
      session as unknown as Session,
    );
    const service = await serviceFor({} as NativeProvider);
    const id = await start(service);
    await until(service, id, (s) => s.status === 'running');
    return { buffer, completion, closing, releaseClose, detached, service, id };
  }

  it('resets gaps, filters unrelated text, and awaits terminal application state after SDK events end', async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 300; i++)
        f.buffer.append({
          type: 'output_text_delta',
          submissionId: 'unrelated',
          turnId: 'step',
          itemId: 'item',
          delta: 'must not render',
        });
      const response = await request(f.service, `/jobs/${f.id}/events?after=0`);
      let ended = false;
      const frames = response.text().then((text) => {
        ended = true;
        return text;
      });
      f.buffer.finish('closed');
      f.completion.resolve({ finalOutput: report });
      await f.closing.promise;
      expect((await request(f.service, `/jobs/${f.id}/artifact`)).status).toBe(
        409,
      );
      expect(ended).toBe(false);
      f.releaseClose.resolve();
      const text = await frames;
      expect(text).toContain('event: reset\ndata: {}');
      expect(text).toContain('"status":"completed"');
      expect(text).not.toContain('must not render');
      expect(f.detached).toHaveBeenCalledOnce();
    } finally {
      f.releaseClose.resolve();
      await f.service.close();
    }
  });

  it('disconnects oversized stream frames without cancelling work and joins reader teardown', async () => {
    const f = await fixture();
    try {
      const response = await request(f.service, `/jobs/${f.id}/events`);
      const reader = response.body!.getReader();
      await reader.read();
      // SDK-retainable text expands beyond the HTTP frame bound when JSON escaped.
      f.buffer.append({
        type: 'output_text_delta',
        submissionId: 'transport-root',
        turnId: 'step',
        itemId: 'item',
        delta: '\n'.repeat(40_000),
      });
      await expect(reader.read()).rejects.toThrow();
      await vi.waitFor(() => expect(f.detached).toHaveBeenCalledOnce());
      expect((await state(f.service, f.id)).status).toBe('running');
    } finally {
      f.releaseClose.resolve();
      await f.service.close();
    }
  });

  it('bounds request bodies and rejects unauthorized requests before creating a Session', async () => {
    const opened = vi.spyOn(Agent.prototype, 'session');
    const service = await serviceFor({} as NativeProvider);
    try {
      const id = randomUUID();
      expect((await fetch(`${service.url}/jobs/${id}`)).status).toBe(401);
      const response = await request(service, `/jobs/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ prompt: 'x'.repeat(17_000) }),
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: 'body_too_large' });
      expect(opened).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });
});
