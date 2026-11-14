import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  HttpMCP,
  InteractionRequired,
  NativeProvider,
  manualTool,
  parseSessionState,
} from '../../src';
import { UnixLocalSandboxClient } from '@openai/agents-core/sandbox/local';
import { Manifest, sandboxEnvironment } from '@openai/agents/sandbox';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(async () => {
  vi.unstubAllEnvs();
  await ModelServer.closeAll();
});
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-deferred-review',
    supportsWebsockets: false,
  });
}

it('has been preserving current MCP transport on deferred handoff and serialized pending restore', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sdk-deferred-mcp-'));
  const executor = await startPublicExecutor();
  let effects = 0;
  let acquisitions = 0;
  const http = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const rpc = JSON.parse(raw);
    if (rpc.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let result: unknown = {};
    if (rpc.method === 'initialize')
      result = {
        protocolVersion: rpc.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'deferred-current', version: '1' },
      };
    else if (rpc.method === 'tools/list')
      result = {
        tools: [
          {
            name: 'lookup',
            description: 'Read current fixture.',
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      };
    else if (rpc.method === 'tools/call') {
      expect(request.headers['x-current-deferred']).toBe('current');
      effects++;
      result = {
        content: [{ type: 'text', text: 'current deferred MCP result' }],
      };
    }
    response
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  try {
    const address = http.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected loopback address');
    const gate = manualTool({
      name: 'gate',
      description: 'Wait for caller approval.',
      parameters: z.object({}),
      result: z.string(),
    });
    const records = new HttpMCP({
      name: 'deferred-records',
      url: `http://127.0.0.1:${address.port}`,
      headers: { 'X-Current-Deferred': 'current' },
      tools: ['lookup'],
      approvalMode: 'preapproved',
    });
    const server = new ModelServer([
      [call('transfer_to_child', {}, { callId: 'enter-deferred-mcp' })],
      [call('gate', {}, { callId: 'deferred-mcp-gate' })],
      [
        call(
          records.tool('lookup').name,
          {},
          {
            callId: 'deferred-current-lookup',
            namespace: 'mcp__deferred_records',
          },
        ),
      ],
      [message('deferred complete')],
    ]);
    await using provider = await providerFor(server);
    const child = new Agent({
      name: 'child',
      instructions: 'Wait, then read the current MCP service.',
      tools: [gate, records],
      environment: async () => {
        acquisitions++;
        return Environment.lease(
          new Environment({
            url: executor.url,
            headers: executor.headers,
            cwd: directory,
            tools: [],
          }),
          () => {},
        );
      },
    });
    const root = new Agent({
      name: 'root',
      instructions: 'Transfer.',
      model: 'gpt-5.5',
      provider,
      handoffs: [child],
    });
    const source = await root.session();
    let saved;
    try {
      expect(acquisitions).toBe(0);
      const events = source.events()[Symbol.asyncIterator]();
      const turn = await source.submit('Transfer then wait.');
      const outcome = turn.wait().catch((error: unknown) => error);
      try {
        for (;;) {
          const next = await events.next();
          if (next.done) throw await outcome;
          if (gate.match(next.value)) break;
        }
      } finally {
        await events.return?.();
      }
      saved = await source.suspend();
      expect(await outcome).toBeInstanceOf(InteractionRequired);
      expect(acquisitions).toBe(1);
      expect(effects).toBe(0);
    } finally {
      await source.close();
    }
    const raw = JSON.stringify(saved);
    // This fixture has been retaining the digest at its trusted capture boundary.
    const expectedSha256 = createHash('sha256').update(raw).digest('hex');
    await using restored = await root.session({
      state: parseSessionState(raw, { expectedSha256 }),
    });
    const [pending] = await restored.pendingInteractions();
    const request = gate.match(pending);
    if (!request) throw new Error('Expected current restored gate');
    await restored.respond(request.reply('approved'));
    expect((await restored.restoredTurn!.wait()).finalOutput).toBe(
      'deferred complete',
    );
    expect(acquisitions).toBe(2);
    expect(effects).toBe(1);
    server.assertExhausted();
  } finally {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await executor.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('has been suspending a settled non-memory root after acquiring an unvisited memory child', async () => {
  const executor = await startPublicExecutor();
  const stateDirectory = await mkdtemp(join(tmpdir(), 'sdk-memory-state-'));
  vi.stubEnv('XDG_STATE_HOME', stateDirectory);
  try {
    const server = new ModelServer([[message('root settled')]]);
    const memoryServer = new ModelServer([]);
    await using provider = await providerFor(server);
    await using memoryProvider = await providerFor(memoryServer);
    const phase = new Agent({
      instructions: 'Produce memory only when required.',
      model: 'gpt-5.5',
      provider: memoryProvider,
    });
    let acquired = 0;
    const connect = async ({
      state,
    }: {
      state: { workspaceRootPath: string };
    }) =>
      Environment.lease(
        new Environment({
          url: executor.url,
          headers: executor.headers,
          cwd: state.workspaceRootPath,
          tools: [],
        }),
        () => {},
      );
    const child = new Agent({
      name: 'child',
      instructions: 'Child memory.',
      environment: sandboxEnvironment({
        client: new UnixLocalSandboxClient(),
        manifest: new Manifest({ entries: {} }),
        memory: { phaseOne: phase, phaseTwo: phase },
        connect: async (resource) => {
          acquired++;
          return connect(resource);
        },
      }),
    });
    const root = new Agent({
      name: 'root',
      instructions: 'Finish without entering child.',
      model: 'gpt-5.5',
      provider,
      environment: sandboxEnvironment({
        managedWorkspace: true,
        client: new UnixLocalSandboxClient(),
        manifest: new Manifest({ entries: {} }),
        connect,
      }),
      handoffs: [child],
    });
    await using session = await root.session();
    expect(
      (await (await session.submit('Finish here.')).wait()).finalOutput,
    ).toBe('root settled');
    expect(acquired).toBe(0);
    await session.update({ agent: child });
    expect(acquired).toBe(1);
    const checkpoint = await session.suspendWorkspace();
    expect(checkpoint.workspace.providerState).toBeDefined();
    expect(server.requests).toHaveLength(1);
    expect(memoryServer.requests).toHaveLength(0);
    server.assertExhausted();
  } finally {
    await executor.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
