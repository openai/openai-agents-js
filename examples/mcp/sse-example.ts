import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Agent, run, MCPServerSSE, withTrace } from '@openai/agents';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

const SSE_HOST = process.env.SSE_HOST ?? '127.0.0.1';
const REMOTE_SSE_URL = process.env.MCP_SSE_REMOTE_URL;

type LocalSseServer = {
  close: () => Promise<void>;
  url: string;
};

function parseOptionalPort(): number {
  const rawPort = process.env.SSE_PORT;
  if (!rawPort) {
    return 0;
  }

  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid SSE_PORT value: ${rawPort}`);
  }
  return port;
}

async function startLocalSseServer(): Promise<LocalSseServer> {
  const mcpServer = new McpServer({
    name: 'local-sse-example',
    version: '1.0.0',
  });
  mcpServer.tool('add', 'Add 7 and 22 for this example.', () => ({
    content: [{ type: 'text', text: '29' }],
  }));

  let transport: SSEServerTransport | undefined;
  const server = http.createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const requestUrl = new URL(
          req.url ?? '/',
          `http://${req.headers.host ?? SSE_HOST}`,
        );

        if (req.method === 'GET' && requestUrl.pathname === '/sse') {
          transport = new SSEServerTransport('/messages', res);
          await mcpServer.connect(transport);
          return;
        }

        if (req.method === 'POST' && requestUrl.pathname === '/messages') {
          if (
            !transport ||
            requestUrl.searchParams.get('sessionId') !== transport.sessionId
          ) {
            res.writeHead(404).end('Unknown SSE session');
            return;
          }
          await transport.handlePostMessage(req, res);
          return;
        }

        res.writeHead(404).end('Not found');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!res.headersSent) {
          res.writeHead(500);
        }
        res.end(message);
      }
    },
  );

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(parseOptionalPort(), SSE_HOST, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });

  const url = `http://${SSE_HOST}:${port}/sse`;
  console.log(`Started local SSE MCP server at ${url}`);

  return {
    url,
    close: async () => {
      await transport?.close();
      await mcpServer.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function runSseExample(url: string, name: string) {
  const mcpServer = new MCPServerSSE({
    url,
    name,
    clientSessionTimeoutSeconds: 15,
    timeout: 15_000,
  });

  const agent = new Agent({
    name: 'SSE Assistant',
    instructions: 'Use the available MCP tools to answer the user.',
    mcpServers: [mcpServer],
    modelSettings: { toolChoice: 'required' },
  });

  try {
    await withTrace('SSE MCP Server Example', async () => {
      await mcpServer.connect();
      const result = await run(agent, 'Use the MCP add tool to add 7 and 22.');
      console.log(result.finalOutput);
    });
  } finally {
    await mcpServer.close();
  }
}

async function main() {
  if (REMOTE_SSE_URL) {
    console.log(`Connecting to remote SSE MCP server at ${REMOTE_SSE_URL}`);
    await runSseExample(REMOTE_SSE_URL, 'Remote SSE MCP Server');
    return;
  }

  console.log(
    'MCP_SSE_REMOTE_URL is not set; using the bundled local SSE MCP server.',
  );
  const server = await startLocalSseServer();
  try {
    await runSseExample(server.url, 'Local SSE MCP Server');
  } finally {
    await server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
