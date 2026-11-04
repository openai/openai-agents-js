import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import {
  Agent,
  HttpMCP,
  NativeProvider,
  type MCPResultContext,
  type ObservedEvent,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
import { TurnAborted } from '../../src/runtime/session';
import { binding, type NativeThread } from '../../src/runtime/binding';

afterEach(() => ModelServer.closeAll());

async function throughTurnFinished<Event extends ObservedEvent>(
  events: AsyncIterableIterator<Event>,
): Promise<Event[]> {
  const observations: Event[] = [];
  for await (const event of events) {
    observations.push(event);
    if (event.type === 'turn_finished') break;
  }
  return observations;
}

it('selects native MCP tools and applies the captured async result transform before model and history', async () => {
  const calls: unknown[] = [];
  const failures: unknown[] = [];
  const peer = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const rpc = JSON.parse(Buffer.concat(chunks).toString());
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result;
      switch (rpc.method) {
        case 'initialize':
          result = {
            protocolVersion: rpc.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'parity-fixture', version: '1' },
          };
          break;
        case 'tools/list':
          result = {
            tools: ['lookup', 'hidden'].map((name) => ({
              name,
              description: name,
              inputSchema: {
                type: 'object',
                properties: { value: { type: 'string' } },
                additionalProperties: false,
              },
            })),
          };
          break;
        case 'tools/call':
          calls.push(rpc.params);
          result = { content: [{ type: 'text', text: 'private-result' }] };
          break;
        default:
          result = {};
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end();
    }
  });
  peer.listen(0, '127.0.0.1');
  await once(peer, 'listening');
  const address = peer.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected TCP peer');
  const model = new ModelServer([
    (request) => {
      expect(JSON.stringify(request.tools)).not.toContain('hidden');
      return [
        call(
          'lookup',
          { value: 'private-argument' },
          { callId: 'mcp-1', namespace: 'mcp__fixture' },
        ),
      ];
    },
    (request) => {
      expect(JSON.stringify(request.input)).toContain('public-result');
      expect(JSON.stringify(request.input)).not.toContain('private-result');
      return [message('done')];
    },
    [call('lookup', {}, { callId: 'mcp-auto', namespace: 'mcp__fixture' })],
    [
      call(
        'lookup',
        {},
        { callId: 'mcp-recovered', namespace: 'mcp__fixture' },
      ),
    ],
    [message('recovered')],
  ]);
  const config = await model.config();
  const route = config['model_providers.fixture'] as { base_url: string };
  const provider = new NativeProvider({
    baseUrl: route.base_url,
    apiKey: 'fixture',
  });
  const context = { tenant: 'a' };
  let invocation: MCPResultContext<typeof context> | undefined;
  const agent = new Agent({
    instructions: 'Call lookup.',
    model: 'gpt-5',
    provider,
    tools: [
      new HttpMCP({
        name: 'fixture',
        url: `http://127.0.0.1:${address.port}/mcp`,
        tools: ['lookup'],
        approvalMode: 'approve',
        async transformResult(info: MCPResultContext<typeof context>, result) {
          invocation = info;
          expect(result.content).toEqual([
            { type: 'text', text: 'private-result' },
          ]);
          await new Promise<void>((resolve) => setImmediate(resolve));
          return { content: [{ type: 'text', text: 'public-result' }] };
        },
      }),
    ],
  });
  let session: Awaited<ReturnType<typeof agent.session>> | undefined;
  try {
    session = await agent.session({ context });
    const capabilities = session.capabilities;
    expect(capabilities.get('mcpBeforePolicy').status).toBe('supported');
    expect(capabilities.get('mcpResultPolicy').status).toBe('supported');
    const passive = throughTurnFinished(session.events());
    const detailed = throughTurnFinished(
      session.events({ includeExecutionDetails: true }),
    );
    const turn = await session.submit('Run lookup');
    expect((await turn.wait()).finalOutput).toBe('done');
    expect(invocation?.context).toBe(context);
    expect(invocation?.submission).toBe(turn);
    expect(invocation).toMatchObject({
      callId: 'mcp-1',
      serverName: 'fixture',
      toolName: 'lookup',
    });
    expect(calls).toMatchObject([
      { name: 'lookup', arguments: { value: 'private-argument' } },
    ]);
    const observations = await passive;
    const compactCompletion = observations.find(
      (event) => event.type === 'execution_item_completed',
    );
    expect(compactCompletion?.item).toEqual({
      type: 'mcp_call',
      id: 'mcp-1',
      callId: 'mcp-1',
      threadId: session.id,
      turnId: turn.turnId,
      status: 'completed',
    });
    expect(JSON.stringify(observations)).not.toMatch(
      /private-argument|private-result|public-result/,
    );
    const detailedCompletion = (await detailed).find(
      (event) => event.type === 'execution_item_completed',
    );
    expect(detailedCompletion).toMatchObject({
      sequence: compactCompletion?.sequence,
      submissionId: compactCompletion?.submissionId,
      item: {
        arguments: { value: 'private-argument' },
        output: { content: [{ type: 'text', text: 'public-result' }] },
      },
    });
    expect(JSON.stringify(detailedCompletion)).not.toContain('private-result');
    expect(await Array.fromAsync(turn.events())).toContainEqual(
      compactCompletion,
    );
    expect(
      await Array.fromAsync(turn.events({ includeExecutionDetails: true })),
    ).toContainEqual(detailedCompletion);
    expect(
      observations.filter(
        (event) =>
          event.type === 'tool_started' || event.type === 'tool_finished',
      ),
    ).toMatchObject([
      {
        type: 'tool_started',
        family: 'mcp',
        name: 'lookup',
        callId: 'mcp-1',
        submissionId: turn.submissionId,
      },
      {
        type: 'tool_finished',
        family: 'mcp',
        name: 'lookup',
        callId: 'mcp-1',
        status: 'completed',
        submissionId: turn.submissionId,
      },
    ]);
    const history = [];
    for await (const item of session.items()) history.push(item);
    expect(JSON.stringify(history)).toContain('private-argument');
    expect(JSON.stringify(history)).toContain('public-result');
    expect(JSON.stringify(history)).not.toContain('private-result');
    await session.update({
      tools: [
        new HttpMCP({
          name: 'fixture',
          url: `http://127.0.0.1:${address.port}/mcp`,
          tools: ['lookup'],
        }),
      ],
    });
    const pendingApproval = await session.submit('Needs approval');
    const pending = await pendingApproval.wait({ until: 'interaction' });
    if (!('requests' in pending)) throw new Error('Expected a live approval');
    expect(pending.turn).toBe(pendingApproval);
    expect(pending.requests).toHaveLength(1);
    expect(pending.requests[0]?.type).toBe('approval_request');
    expect(calls).toHaveLength(1);
    const completion = pendingApproval.wait();
    completion.catch(() => {});
    await Promise.all([
      pendingApproval.cancel({ mode: 'force' }),
      expect(completion).rejects.toBeInstanceOf(TurnAborted),
    ]);
    expect(model.requests).toHaveLength(3);
    expect(calls).toHaveLength(1);
    await session.update({ tools: agent.tools });
    expect(
      (await (await session.submit('Retry approved')).wait()).finalOutput,
    ).toBe('recovered');
    expect(calls).toHaveLength(2);
    const previous = capabilities.get('mcpResultPolicy');
    const native = await binding();
    const replace = native.NativeThread.prototype._replace_mcp_servers;
    const acknowledged = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const publication = vi
      .spyOn(native.NativeThread.prototype, '_replace_mcp_servers')
      .mockImplementationOnce(async function (this: NativeThread, ...args) {
        const receipt = await replace.apply(this, args);
        acknowledged.resolve();
        await release.promise;
        return receipt;
      });
    const removal = session.update({ tools: [] });
    try {
      await acknowledged.promise;
      expect(capabilities.get('mcpBeforePolicy').status).toBe('supported');
      expect(capabilities.get('mcpResultPolicy').status).toBe('supported');
      release.resolve();
      await removal;
      expect(capabilities.get('mcpBeforePolicy').status).toBe('unsupported');
      expect(capabilities.get('mcpResultPolicy').status).toBe('unsupported');
      expect(previous.status).toBe('supported');
    } finally {
      release.resolve();
      try {
        await removal;
      } finally {
        publication.mockRestore();
      }
    }
    model.assertExhausted();
    expect(failures).toEqual([]);
  } finally {
    try {
      try {
        await session?.close();
      } finally {
        await provider.close();
      }
    } finally {
      peer.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        peer.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
}, 10_000);
