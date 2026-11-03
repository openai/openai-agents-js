import {
  createServer,
  type IncomingHttpHeaders,
  type ServerResponse,
} from 'node:http';

export type BackendOutcome =
  | 'complete'
  | 'partial'
  | 'wrong-link'
  | 'wrong-connector'
  | '401'
  | '403'
  | 'redirect';
export type AuthReason =
  'missing_link' | 'reauthentication_required' | 'oauth_upgrade_required';

export function syntheticAppsCredentials() {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return {
    accountId: 'synthetic-account',
    accessToken: `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ exp: 4102444800, 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account', chatgpt_user_id: 'synthetic-user', chatgpt_plan_type: 'plus' } })}.synthetic-only`,
  };
}

/** Synthetic personal Apps backend; no real account, OAuth provider or browser. */
export async function startAppsBackend(
  reason: AuthReason = 'reauthentication_required',
  outcome: BackendOutcome = 'complete',
) {
  const expected = syntheticAppsCredentials();
  const authorized = (headers: IncomingHttpHeaders) =>
    headers.authorization === `Bearer ${expected.accessToken}` &&
    headers['chatgpt-account-id'] === expected.accountId;
  const calls: unknown[] = [];
  const initRequests: Array<{
    path: string;
    body: Record<string, unknown>;
    headers: IncomingHttpHeaders;
  }> = [];
  const mcpHeaders: IncomingHttpHeaders[] = [];
  const polls: string[] = [];
  const pollResponses: Array<{
    path: string;
    status: number;
    body: Record<string, unknown>;
  }> = [];
  const redirects: string[] = [];
  const failures: unknown[] = [];
  const streams = new Set<ServerResponse>();
  const handlers = new Set<Promise<void>>();
  const connected = Promise.withResolvers<void>();
  const polled = Promise.withResolvers<void>();
  const stateId = 'synthetic-private-exact-oauth-state';
  const redirectUrl =
    'https://provider.synthetic.invalid/authorize?state=synthetic-provider-state';
  let complete = false;
  const server = createServer((request, response) => {
    const work = (async () => {
      const path = request.url ?? '';
      if (path.startsWith('/forbidden-redirect')) {
        redirects.push(path);
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end('{}');
        return;
      }
      // Pinned Core appends the state after a trailing empty URL segment.
      // Match that exact wire path and opaque state, not an arbitrary suffix.
      if (path.startsWith('/api/aip/connectors/links/oauth/state/')) {
        if (
          path !==
          `/api/aip/connectors/links/oauth/state//${encodeURIComponent(stateId)}`
        ) {
          response.writeHead(404).end();
          return;
        }
        if (!authorized(request.headers)) {
          response.writeHead(401).end();
          return;
        }
        polls.push(path);
        polled.resolve();
        const link: Record<string, unknown> = {
          id: reason === 'missing_link' ? 'new-real-link' : 'legacy-real-link',
          connector_id: 'calendar',
          auth_status: 'ACTIVE',
          scopes: ['calendar.read', 'calendar.write'],
        };
        const value: Record<string, unknown> = complete
          ? { status: 'COMPLETE', connector_id: 'calendar', link }
          : { status: 'PENDING', connector_id: 'calendar', link: null };
        if (complete && outcome === 'partial') link.scopes = ['calendar.read'];
        if (complete && outcome === 'wrong-link') link.id = 'different-link';
        if (complete && outcome === 'wrong-connector')
          value.connector_id = 'different-connector';
        response.once('finish', () =>
          pollResponses.push({
            path,
            status: response.statusCode,
            body: structuredClone(value),
          }),
        );
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify(value));
        return;
      }
      if (path.startsWith('/api/aip/connectors/links/oauth')) {
        if (!authorized(request.headers)) {
          response.writeHead(401).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const part of request) chunks.push(Buffer.from(part));
        initRequests.push({
          path,
          body: JSON.parse(Buffer.concat(chunks).toString()),
          headers: { ...request.headers },
        });
        if (outcome === '401' || outcome === '403' || outcome === 'redirect') {
          response
            .writeHead(outcome === 'redirect' ? 302 : Number(outcome), {
              Location: '/forbidden-redirect',
            })
            .end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            oauth_state_id: stateId,
            redirect_url: redirectUrl,
          }),
        );
        return;
      }
      if (path.split('?')[0] !== '/api/codex/ps/mcp') {
        response.writeHead(404).end();
        return;
      }
      // Core keeps account credentials off non-first-party MCP origins.
      // This loopback MCP peer stays anonymous; backend routes above require
      // the explicit Apps token and account. Live MCP authentication is not proven here.
      if (
        request.headers.authorization !== undefined ||
        request.headers['chatgpt-account-id'] !== undefined
      ) {
        response.writeHead(400).end();
        return;
      }
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.flushHeaders();
        streams.add(response);
        response.once('close', () => streams.delete(response));
        connected.resolve();
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      mcpHeaders.push({ ...request.headers });
      const chunks: Buffer[] = [];
      for await (const part of request) chunks.push(Buffer.from(part));
      const rpc = JSON.parse(Buffer.concat(chunks).toString());
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result: unknown = {};
      if (rpc.method === 'initialize')
        result = {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'synthetic-personal-apps', version: '1' },
        };
      if (rpc.method === 'tools/list')
        result = {
          tools: [
            {
              name: 'calendar_search',
              description: 'Read one synthetic record',
              annotations: { readOnlyHint: true },
              inputSchema: {
                type: 'object',
                properties: { key: { type: 'string' } },
                required: ['key'],
                additionalProperties: false,
              },
              _meta: { connector_id: 'calendar', connector_name: 'Calendar' },
            },
          ],
        };
      if (rpc.method === 'tools/call') {
        calls.push(rpc.params);
        await connected.promise;
        result = {
          isError: true,
          content: [
            { type: 'text', text: 'synthetic_original_authentication_failure' },
          ],
          _meta: {
            _codex_apps: {
              connector_auth_failure: {
                is_auth_failure: true,
                connector_id: 'calendar',
                auth_reason: reason,
                link_id:
                  reason === 'missing_link'
                    ? 'synthetic_link::calendar'
                    : 'legacy-real-link',
                requested_scopes: ['calendar.write'],
              },
            },
          },
        };
      }
      response.writeHead(200, {
        'content-type': 'application/json',
        ...(rpc.method === 'initialize'
          ? { 'Mcp-Session-Id': 'synthetic-native-apps' }
          : {}),
      });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    })().catch((error) => {
      failures.push(error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
    handlers.add(work);
    void work.finally(() => handlers.delete(work));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing Apps fixture address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    redirectUrl,
    stateId,
    calls,
    initRequests,
    mcpHeaders,
    polls,
    pollResponses,
    redirects,
    polled: polled.promise,
    complete: () => {
      complete = true;
    },
    sendPeerCompletion(elicitationId: string) {
      if (!streams.size) throw new Error('No active MCP notification stream');
      for (const response of streams)
        response.write(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/elicitation/complete', params: { elicitationId } })}\n\n`,
        );
    },
    async close() {
      connected.resolve();
      for (const stream of streams) stream.end();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await Promise.all(handlers);
      if (failures.length)
        throw new AggregateError(failures, 'Apps backend fixture failed');
    },
  };
}
