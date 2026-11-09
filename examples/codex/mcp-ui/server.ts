/** Loopback-only synthetic MCP Apps counter using the real native transports. */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { Agent, HttpMCP, NativeProvider, type Session } from '@openai/agents';
import { vercelResponse } from '@openai/agents/ui';
import { MCPApp } from '@openai/agents/mcp-apps';

const root = dirname(fileURLToPath(import.meta.url));
interface Params {
  name: string;
  arguments: { amount: number };
}
interface RPC {
  id?: string | number;
  method: string;
  params: Params & { protocolVersion: string };
}
async function body(request: IncomingMessage): Promise<RPC> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw new Error('Request exceeds 8192 bytes');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as RPC;
}
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

export async function startCounter(port = 0) {
  let origin = '',
    host = '',
    count = 0,
    started = false;
  const owner = randomBytes(24).toString('hex');
  let app: MCPApp | undefined;
  let token: string | undefined;
  let modelRequests = 0;
  let resolveView: () => void;
  let rejectView: (error: unknown) => void;
  const viewReady = new Promise<void>((resolveReady, rejectReady) => {
    resolveView = resolveReady;
    rejectView = rejectReady;
  });
  // A failed request may finish before a browser asks for its view.
  void viewReady.catch(() => {});
  let session: Session | undefined;
  const result = () => ({
    content: [
      {
        type: 'resource',
        resource: {
          uri: 'ui://counter/app',
          mimeType: 'text/html;profile=mcp-app',
          text:
            '<!doctype html><html lang="en"><meta charset="utf-8">' +
            `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${origin}; connect-src 'none'">` +
            '<h1>Counter</h1><output id="count">Loading</output><button id="increment">Increment</button><pre id="error"></pre>' +
            `<script type="module" src="${origin}/app.js"></script></html>`,
        },
      },
    ],
    structuredContent: { count },
    isError: false,
  });
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.host !== host)
        return json(response, 403, { error: 'Unexpected host' });
      const path = request.url;
      if (path?.startsWith('/api/')) {
        if (
          !request.headers.cookie
            ?.split('; ')
            .includes(`synthetic-owner=${owner}`)
        )
          return json(response, 403, {
            error: 'Choose the local synthetic user first',
          });
        if (
          request.method === 'POST' &&
          (request.headers.origin !== origin ||
            request.headers['x-mcp-example'] !== '1')
        )
          return json(response, 403, { error: 'Unexpected action origin' });
      }
      if (path === '/' && request.method === 'GET') {
        response.writeHead(200, {
          'content-type': 'text/html',
          'set-cookie': `synthetic-owner=${owner}; HttpOnly; SameSite=Strict; Path=/`,
        });
        response.end(await readFile(join(root, 'index.html')));
        return;
      }
      if (
        (path === '/client.js' || path === '/app.js') &&
        request.method === 'GET'
      ) {
        response.writeHead(200, {
          'content-type': 'text/javascript',
          ...(path === '/app.js' ? { 'access-control-allow-origin': '*' } : {}),
        });
        response.end(await readFile(join(root, 'dist', path.slice(1))));
        return;
      }
      if (path === '/mcp' && request.method === 'POST') {
        if (request.headers.origin !== undefined)
          return json(response, 403, {});
        const rpc = await body(request);
        let value: unknown;
        switch (rpc.method) {
          case 'notifications/initialized':
            response.writeHead(202).end();
            return;
          case 'initialize':
            value = {
              protocolVersion: rpc.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'synthetic-counter', version: '1' },
            };
            break;
          case 'tools/list':
            value = {
              tools: [
                {
                  name: 'increment',
                  description: 'Increment synthetic counter',
                  inputSchema: {
                    type: 'object',
                    properties: { amount: { type: 'integer' } },
                    required: ['amount'],
                    additionalProperties: false,
                  },
                },
              ],
            };
            break;
          case 'tools/call':
            if (
              rpc.params.name !== 'increment' ||
              JSON.stringify(rpc.params.arguments) !== '{"amount":1}'
            )
              return json(response, 200, {
                jsonrpc: '2.0',
                id: rpc.id,
                error: {
                  code: -32602,
                  message: 'Only increment(1) is supported',
                },
              });
            count++;
            value = result();
            break;
          case 'ping':
            value = {};
            break;
          default:
            return json(response, 200, {
              jsonrpc: '2.0',
              id: rpc.id,
              error: { code: -32601, message: 'Unsupported method' },
            });
        }
        return json(response, 200, {
          jsonrpc: '2.0',
          id: rpc.id,
          result: value,
        });
      }
      if (path === '/v1/responses' && request.method === 'POST') {
        if (request.headers.origin !== undefined)
          return json(response, 403, {});
        await body(request);
        const number = ++modelRequests;
        if (number > 2)
          return json(response, 409, { error: 'Unexpected model request' });
        const responseId = `counter-response-${number}`;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (event: unknown) =>
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        send({ type: 'response.created', response: { id: responseId } });
        if (number === 1) {
          send({
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              type: 'function_call',
              call_id: 'counter-call',
              name: 'increment',
              namespace: 'mcp__counter',
              arguments: '{"amount":1}',
            },
          });
        } else {
          const item = {
            type: 'message',
            id: 'counter-message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Counter opened.' }],
          };
          send({
            type: 'response.output_item.added',
            output_index: 0,
            item: { ...item, content: [] },
          });
          send({
            type: 'response.content_part.added',
            output_index: 0,
            content_index: 0,
            item_id: item.id,
            part: { type: 'output_text', text: '' },
          });
          send({
            type: 'response.output_text.delta',
            output_index: 0,
            content_index: 0,
            item_id: item.id,
            delta: 'Counter opened.',
          });
          send({
            type: 'response.output_text.done',
            output_index: 0,
            content_index: 0,
            item_id: item.id,
            text: 'Counter opened.',
          });
          send({ type: 'response.output_item.done', output_index: 0, item });
        }
        send({ type: 'response.completed', response: { id: responseId } });
        response.end();
        return;
      }
      if (path === '/api/chat' && request.method === 'POST') {
        if (started)
          return json(response, 409, {
            error: 'This fixture supports one counter per process',
          });
        started = true;
        session = await new Agent({
          instructions: 'Open counter',
          provider: new NativeProvider({
            baseUrl: `${origin}/v1`,
            apiKey: 'synthetic-counter-key',
            supportsWebsockets: false,
          }),
          tools: [
            new HttpMCP({
              name: 'counter',
              url: `${origin}/mcp`,
              tools: ['increment'],
              approvalMode: 'preapproved',
            }),
          ],
        }).session();
        const turn = await session.submit('Open synthetic counter');
        const stream = vercelResponse(turn, session, { includeToolData: true });
        const headers: Record<string, string> = {};
        stream.headers.forEach((value, key) => {
          headers[key] = value;
        });
        response.writeHead(stream.status, headers);
        if (!stream.body) throw new Error('Missing UI stream');
        const reader = stream.body.getReader();
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            response.write(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
        app = await MCPApp.open(session, turn, 'counter-call');
        token = randomBytes(24).toString('hex');
        resolveView!();
        response.end();
        return;
      }
      if (path === '/api/view' && request.method === 'GET') {
        if (!started)
          return json(response, 409, { error: 'Start the native turn first' });
        await viewReady;
        return json(response, 200, { view: app!.view, token });
      }
      if (path === '/api/action' && request.method === 'POST') {
        if (!app || request.headers['x-view'] !== token)
          return json(response, 403, {
            error: 'Action does not belong to this view',
          });
        const params = (await body(request)) as unknown as Params;
        if (
          !params ||
          Object.keys(params).sort().join(',') !== 'arguments,name'
        )
          return json(response, 400, {
            error: 'Expected tools/call name and arguments',
          });
        return json(
          response,
          200,
          await app.callTool(params.name, params.arguments),
        );
      }
      json(response, 404, { error: 'Not found' });
    } catch (error) {
      if (request.url === '/api/chat') rejectView!(error);
      if (!response.headersSent) json(response, 400, { error: String(error) });
      else response.destroy(error instanceof Error ? error : undefined);
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxConnections = 16;
  await new Promise<void>((resolveStart, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveStart);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP port');
  host = `127.0.0.1:${address.port}`;
  origin = `http://${host}`;
  return {
    url: origin,
    async close() {
      app?.close();
      try {
        await session?.close();
      } finally {
        await new Promise<void>((resolveClose, reject) => {
          server.close((error) => (error ? reject(error) : resolveClose()));
          server.closeAllConnections();
        });
      }
    },
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const fixture = await startCounter(Number(process.argv[2] ?? 8081));
  console.log(fixture.url);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      void fixture.close().then(() => process.exit(0));
    });
}
