import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { ownerSchema, type Owner } from './protocol';

const MAX_BODY_BYTES = 8192;
const MAX_ACTIVE_REQUESTS = 8;
const MAX_CREDENTIAL_TTL_MS = 300_000;
const REQUEST_TIMEOUT_MS = 5000;

const requestId = z.union([z.string().max(128), z.number().int()]);
const envelope = { jsonrpc: z.literal('2.0'), id: requestId };
// Only the fixture's finite methods are accepted; this is not an RPC framework.
const requestSchema = z.discriminatedUnion('method', [
  z.object({
    ...envelope,
    method: z.literal('initialize'),
    params: z.object({ protocolVersion: z.string().max(32) }),
  }),
  z.object({ ...envelope, method: z.literal('ping') }),
  z.object({
    ...envelope,
    method: z.literal('tools/list'),
    params: z.object({ cursor: z.never().optional() }).optional(),
  }),
  z.object({
    ...envelope,
    method: z.literal('tools/call'),
    params: z.object({
      name: z.literal('report'),
      arguments: z.strictObject({}).optional(),
    }),
  }),
  z.object({
    jsonrpc: z.literal('2.0'),
    id: z.never().optional(),
    method: z.literal('notifications/initialized'),
  }),
]);

export interface StoredReport {
  owner: Owner;
  reference: string;
  expiresAt: number;
  title: string;
  text: string;
}

export interface ReportPeer {
  url: string;
  issue(
    owner: string,
    ttlMs?: number,
  ): {
    token: string;
    expiresAt: number;
    revoke(): void;
  };
  close(): Promise<void>;
}

interface Credential {
  owner: Owner;
  token: string;
  expiresAt: number;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

/** A local synthetic peer. Core owns private storage and credential lifetimes. */
export async function startReportPeer(options: {
  // Synchronous SQLite commit: no await can separate authorization and storage.
  storeReport(report: StoredReport): undefined;
}): Promise<ReportPeer> {
  const credentials = new Map<Owner, Credential>();
  let closed = false;
  let closing: Promise<void> | undefined;
  let activeRequests = 0;
  let resolveDrain: (() => void) | undefined;
  let host = '';

  const isCurrent = (credential: Credential): boolean =>
    !closed &&
    credentials.get(credential.owner) === credential &&
    credential.expiresAt > Date.now();

  const server = createServer(async (request, response) => {
    // Close rejected connections rather than drain an unbounded request body.
    response.setHeader('connection', 'close');
    if (closed || activeRequests >= MAX_ACTIVE_REQUESTS) {
      response.writeHead(503).end();
      return;
    }
    if (request.headers.host !== host || request.headers.origin !== undefined) {
      response.writeHead(403).end();
      return;
    }
    if (request.url !== '/mcp') {
      response.writeHead(404).end();
      return;
    }
    const bearer = /^Bearer ([a-f0-9]{64})$/.exec(
      request.headers.authorization ?? '',
    );
    const credential = bearer
      ? [...credentials.values()].find((candidate) =>
          timingSafeEqual(Buffer.from(candidate.token), Buffer.from(bearer[1])),
        )
      : undefined;
    if (!credential || !isCurrent(credential)) {
      response.writeHead(401).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    if (
      request.headers['content-type']?.split(';')[0].trim().toLowerCase() !==
      'application/json'
    ) {
      response.writeHead(415).end();
      return;
    }

    activeRequests++;
    // An absolute body deadline also bounds clients that keep sending bytes.
    const timer = setTimeout(() => request.destroy(), REQUEST_TIMEOUT_MS);
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_BODY_BYTES) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(buffer);
      }
      // Revocation/rotation/expiry during body receipt must deny discovery too.
      if (!isCurrent(credential)) {
        response.writeHead(401).end();
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        json(response, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Invalid JSON.' },
        });
        return;
      }
      const parsed = requestSchema.safeParse(body);
      if (!parsed.success) {
        json(response, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Unsupported report request.' },
        });
        return;
      }
      const rpc = parsed.data;
      if (!isCurrent(credential)) {
        response.writeHead(401).end();
        return;
      }
      if (rpc.method === 'notifications/initialized') {
        response.writeHead(202).end();
        return;
      }
      let result: unknown;
      switch (rpc.method) {
        case 'initialize':
          result = {
            protocolVersion: [
              '2024-11-05',
              '2025-03-26',
              '2025-06-18',
              '2025-11-25',
            ].includes(rpc.params.protocolVersion)
              ? rpc.params.protocolVersion
              : '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'reports', version: '1' },
          };
          break;
        case 'ping':
          result = {};
          break;
        case 'tools/list':
          result = {
            tools: [
              {
                name: 'report',
                description:
                  'Prepare your synthetic report and private reference.',
                inputSchema: {
                  type: 'object',
                  properties: {},
                  additionalProperties: false,
                },
                annotations: {
                  readOnlyHint: false,
                  destructiveHint: false,
                  openWorldHint: false,
                },
              },
            ],
          };
          break;
        case 'tools/call': {
          const report: StoredReport = {
            owner: credential.owner,
            reference: randomUUID(),
            expiresAt: credential.expiresAt,
            title: 'Synthetic quarterly report',
            text:
              `Synthetic report for ${credential.owner}.\n` +
              'Quarterly revenue grew. Synthetic detail for the application only.\n'.repeat(
                128,
              ),
          };
          const summary = {
            summary: 'Synthetic quarterly report ready. Revenue grew.',
            reference: report.reference,
            bytes: Buffer.byteLength(report.text),
            expiresAt: report.expiresAt,
          };
          // Never spread the full report into either model-visible result field.
          if (!isCurrent(credential)) {
            response.writeHead(401).end();
            return;
          }
          try {
            options.storeReport(report);
            if (!isCurrent(credential)) {
              response.writeHead(401).end();
              return;
            }
            result = {
              content: [{ type: 'text', text: JSON.stringify(summary) }],
              structuredContent: summary,
              isError: false,
            };
          } catch {
            result = {
              content: [{ type: 'text', text: 'Report storage unavailable.' }],
              isError: true,
            };
          }
          break;
        }
      }
      json(response, 200, { jsonrpc: '2.0', id: rpc.id, result });
    } catch {
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(500).end();
      }
    } finally {
      clearTimeout(timer);
      activeRequests--;
      if (activeRequests === 0) resolveDrain?.();
    }
  });
  server.maxConnections = 16;
  server.maxRequestsPerSocket = 1;
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.setTimeout(REQUEST_TIMEOUT_MS, (socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Report peer did not receive a TCP port.');
  }
  host = `127.0.0.1:${address.port}`;

  return {
    url: `http://${host}/mcp`,
    issue(owner, ttlMs = 60_000) {
      if (closed) throw new Error('Report peer is closed.');
      const identity = ownerSchema.parse(owner);
      if (
        !Number.isInteger(ttlMs) ||
        ttlMs <= 0 ||
        ttlMs > MAX_CREDENTIAL_TTL_MS
      ) {
        throw new Error('Report credential TTL must be 1 through 300000 ms.');
      }
      const credential: Credential = {
        owner: identity,
        token: randomBytes(32).toString('hex'),
        expiresAt: Date.now() + ttlMs,
      };
      credentials.set(identity, credential);
      return {
        token: credential.token,
        expiresAt: credential.expiresAt,
        revoke() {
          if (credentials.get(identity) === credential) {
            credentials.delete(identity);
          }
        },
      };
    },
    close() {
      if (!closing) {
        closed = true;
        credentials.clear();
        const drained = new Promise<void>((resolve) => {
          if (activeRequests === 0) resolve();
          else resolveDrain = resolve;
        });
        const socketsClosed = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
        closing = Promise.all([drained, socketsClosed]).then(() => {});
      }
      return closing;
    },
  };
}
