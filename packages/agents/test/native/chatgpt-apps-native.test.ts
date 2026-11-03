import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import {
  Agent,
  ChatGPTAppsMCP,
  NativeProvider,
  type ElicitationRequest,
  type Session,
} from '../../src';
import { binding } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import {
  startAppsBackend,
  syntheticAppsCredentials,
  type AuthReason,
  type BackendOutcome,
} from './fixtures/chatgpt-apps';

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

async function application(peer: Awaited<ReturnType<typeof startAppsBackend>>) {
  const model = new ModelServer([
    [
      call(
        'calendar_search',
        { key: 'one' },
        { callId: 'native-auth', namespace: 'mcp__codex_apps' },
      ),
    ],
    [message('finished')],
  ]);
  const config = await model.config();
  const route = config['model_providers.fixture'] as { base_url: string };
  const { accessToken: token } = syntheticAppsCredentials();
  const provider = new NativeProvider({
    baseUrl: route.base_url,
    apiKey: 'synthetic-model-key',
    supportsWebsockets: false,
    chatGPT: { accountId: 'synthetic-account', accessToken: token },
  });
  // Match the pinned Python fixture: redirect captured native backend config
  // only. Production declarations still have no backend URL or bearer knob.
  const native = await binding();
  const original = native.create_engine.bind(native);
  vi.spyOn(native, 'create_engine').mockImplementation(
    (configJson, runtimeJson, apiKey, appsJson) =>
      original(
        JSON.stringify({
          ...JSON.parse(configJson),
          chatgpt_base_url: peer.baseUrl,
        }),
        runtimeJson,
        apiKey,
        appsJson,
      ),
  );
  const agent = new Agent({
    instructions: 'Use calendar_search once.',
    model: 'gpt-5',
    provider,
    tools: [new ChatGPTAppsMCP({ tools: ['calendar_search'] })],
  });
  return { model, provider, token, agent };
}

async function closeApplication(
  session: Session | undefined,
  provider: NativeProvider,
  peer: Awaited<ReturnType<typeof startAppsBackend>>,
) {
  peer.complete();
  const failures: unknown[] = [];
  for (const close of [
    () => session?.close(),
    () => provider.close(),
    () => peer.close(),
  ]) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, 'Personal Apps cleanup failed');
}

async function urlRequest(turn: Awaited<ReturnType<Session['submit']>>) {
  const pending = await turn.wait({ until: 'interaction' });
  if (
    !('requests' in pending) ||
    pending.requests[0]?.type !== 'elicitation_request'
  )
    throw new Error('Expected the real backend URL consent');
  const request = pending.requests[0];
  if (request.mode !== 'url' || request.elicitationId === null)
    throw new Error(
      'Expected a URL request with its actual elicitation identity',
    );
  return request as ElicitationRequest & { mode: 'url'; elicitationId: string };
}

it.each<AuthReason>([
  'missing_link',
  'reauthentication_required',
  'oauth_upgrade_required',
])(
  'requires backend completion and exact grants after explicit consent: %s',
  async (reason) => {
    const peer = await startAppsBackend(reason);
    const f = await application(peer);
    let session: Session | undefined;
    try {
      session = await f.agent.session();
      const turn = await session.submit('Authenticate once');
      const request = await urlRequest(turn);
      expect(request.mode).toBe('url');
      expect(request.url).toBe(peer.redirectUrl);
      await session.respond(request.replyUrlAccept());
      let completed = false;
      const completion = request
        .waitForCompletion({ timeoutMs: 5_000 })
        .finally(() => {
          completed = true;
        });
      completion.catch(() => {});
      await Promise.race([
        peer.polled,
        completion.then(() => {
          throw new Error('Completion settled before any backend poll');
        }),
      ]);
      peer.sendPeerCompletion(request.elicitationId);
      await delay(100);
      expect(completed).toBe(false);
      peer.complete();
      await completion;
      expect((await turn.wait()).finalOutput).toBe('finished');
      expect(peer.calls).toHaveLength(1);
      expect(peer.initRequests).toHaveLength(1);
      expect(peer.mcpHeaders.length).toBeGreaterThan(0);
      expect(
        peer.mcpHeaders.every(
          (headers) =>
            headers.authorization === undefined &&
            headers['chatgpt-account-id'] === undefined,
        ),
      ).toBe(true);
      expect(peer.initRequests[0].path).toBe(
        reason === 'missing_link'
          ? '/api/aip/connectors/links/oauth'
          : '/api/aip/connectors/links/oauth/reauth',
      );
      expect(peer.initRequests[0].body).toMatchObject({
        requested_scopes: ['calendar.write'],
        callback_url: 'https://chatgpt.com/connector_platform_oauth_redirect',
        post_auth_url: 'https://chatgpt.com/apps/calendar/calendar',
      });
      expect(
        peer.initRequests[0].body[
          reason === 'missing_link' ? 'connector_id' : 'link_id'
        ],
      ).toBe(reason === 'missing_link' ? 'calendar' : 'legacy-real-link');
      expect(peer.initRequests[0].headers.authorization).toBe(
        `Bearer ${f.token}`,
      );
      expect(peer.initRequests[0].headers['chatgpt-account-id']).toBe(
        'synthetic-account',
      );
      expect(
        f.model.requestHeaders.every(
          (headers) => headers.authorization === 'Bearer synthetic-model-key',
        ),
      ).toBe(true);
      expect(JSON.stringify(f.model.requests[1]?.input)).toContain(
        'Authentication for Calendar completed',
      );
      expect(JSON.stringify(f.model.requests)).not.toContain(peer.stateId);
      expect(peer.redirects).toEqual([]);
      expect(() => request.replyUrlAccept()).toThrow();
    } finally {
      await closeApplication(session, f.provider, peer);
    }
  },
  30_000,
);

it.each<BackendOutcome>(['partial', 'wrong-link', 'wrong-connector'])(
  'refuses a backend result that does not prove the original grants: %s',
  async (outcome) => {
    const peer = await startAppsBackend('oauth_upgrade_required', outcome);
    const f = await application(peer);
    let session: Session | undefined;
    try {
      session = await f.agent.session();
      const turn = await session.submit('Authenticate once');
      const request = await urlRequest(turn);
      await session.respond(request.replyUrlAccept());
      peer.complete();
      const completion = request.waitForCompletion({ timeoutMs: 5_000 });
      await expect(completion).rejects.toThrow(TypeError);
      await expect(completion).rejects.toThrow(
        /^Native URL request is expired$/,
      );
      expect(peer.initRequests).toHaveLength(1);
      expect(peer.initRequests[0].body.requested_scopes).toEqual([
        'calendar.write',
      ]);
      expect(peer.polls.length).toBeGreaterThan(0);
      expect(
        peer.polls.every(
          (path) =>
            path ===
            `/api/aip/connectors/links/oauth/state//${encodeURIComponent(peer.stateId)}`,
        ),
      ).toBe(true);
      const completed = peer.pollResponses.filter(
        (response) => response.body.status === 'COMPLETE',
      );
      expect(completed).toHaveLength(1);
      expect(completed[0]).toEqual({
        path: `/api/aip/connectors/links/oauth/state//${encodeURIComponent(peer.stateId)}`,
        status: 200,
        body: {
          status: 'COMPLETE',
          connector_id:
            outcome === 'wrong-connector' ? 'different-connector' : 'calendar',
          link: {
            id:
              outcome === 'wrong-link' ? 'different-link' : 'legacy-real-link',
            connector_id: 'calendar',
            auth_status: 'ACTIVE',
            scopes:
              outcome === 'partial'
                ? ['calendar.read']
                : ['calendar.read', 'calendar.write'],
          },
        },
      });
      await turn.wait();
      expect(JSON.stringify(f.model.requests[1]?.input)).toContain(
        'synthetic_original_authentication_failure',
      );
      expect(peer.calls).toHaveLength(1);
      expect(peer.redirects).toEqual([]);
    } finally {
      await closeApplication(session, f.provider, peer);
    }
  },
  30_000,
);

it.each<BackendOutcome>(['401', '403', 'redirect'])(
  'does not offer consent, follow redirects or fall back on backend failure: %s',
  async (outcome) => {
    const peer = await startAppsBackend('reauthentication_required', outcome);
    const f = await application(peer);
    const handler = vi.fn();
    try {
      await f.agent.run('Authenticate once', { onNativeQuestion: handler });
      expect(handler).not.toHaveBeenCalled();
      expect(peer.calls).toHaveLength(1);
      expect(peer.initRequests).toHaveLength(1);
      expect(peer.polls).toEqual([]);
      expect(peer.redirects).toEqual([]);
      expect(JSON.stringify(f.model.requests[1]?.input)).toContain(
        'synthetic_original_authentication_failure',
      );
    } finally {
      await closeApplication(undefined, f.provider, peer);
    }
  },
  30_000,
);
