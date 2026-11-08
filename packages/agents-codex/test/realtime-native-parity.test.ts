import { once } from 'node:events';
import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import {
  Agent,
  HttpMCP,
  NativeProvider,
  Turn,
  tool,
  type MCPResultContext,
} from '../src';
import { ModelServer, message } from './native/fixtures/model-server';
import type {
  NativeRealtimeEvent,
  NativeRealtimeHostedMcpApprovalRequest,
} from '../src/runtime/realtime';

type Frame = Record<string, any>;

// Only provider protocols are scripted. The public SDK and native binding run.
class RealtimePeer {
  readonly frames: Frame[] = [];
  readonly authorization: (string | undefined)[] = [];
  readonly pendingUpdates: Frame[] = [];
  autoAck = true;
  private socket?: WebSocket;
  private readonly server = new WebSocketServer({ noServer: true });

  constructor(model: ModelServer) {
    model.onUpgrade((request, transport, head) => {
      this.authorization.push(request.headers.authorization);
      this.server.handleUpgrade(request, transport, head, (connection) =>
        this.server.emit('connection', connection, request),
      );
    });
    this.server.on('connection', (connection, request) => {
      this.socket = connection;
      const state: Frame = {
        model: new URL(request.url ?? '/', 'http://fixture').searchParams.get(
          'model',
        ),
      };
      connection.on('message', (raw) => {
        const frame: Frame = JSON.parse(raw.toString());
        this.frames.push(frame);
        if (frame.type === 'session.update') {
          merge(state, frame.session);
          const acknowledgement = {
            type: 'session.updated',
            session: { ...structuredClone(state), id: 'parity-session' },
          };
          if (this.autoAck) this.send(acknowledgement);
          else this.pendingUpdates.push(acknowledgement);
        } else if (frame.type === 'response.create') {
          const id = `continuation-${this.frames.length}`;
          this.send({ type: 'response.created', response: { id } });
          this.send({ type: 'response.done', response: { id } });
        }
      });
    });
  }

  send(frame: Frame) {
    if (!this.socket) throw new Error('Provider is not connected');
    this.socket.send(JSON.stringify(frame));
  }

  async frame(predicate: (frame: Frame) => boolean, after = 0) {
    let found: Frame | undefined;
    await vi.waitFor(
      () => {
        found = this.frames.slice(after).find(predicate);
        expect(found).toBeDefined();
      },
      { timeout: 10000 },
    );
    return found!;
  }

  acknowledge() {
    const update = this.pendingUpdates.shift();
    if (!update) throw new Error('No configuration acknowledgement is pending');
    this.send(update);
  }

  call(name: string, args: Frame, id: string) {
    const responseId = `response-${id}`;
    const item = {
      id: `item-${id}`,
      type: 'function_call',
      name,
      call_id: id,
      arguments: JSON.stringify(args),
    };
    this.send({ type: 'response.created', response: { id: responseId } });
    this.send({
      type: 'response.output_item.done',
      response_id: responseId,
      output_index: 0,
      item,
    });
    this.send({
      type: 'response.done',
      response: { id: responseId, output: [item] },
    });
  }

  async close() {
    for (const client of this.server.clients) client.terminate();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function merge(current: Frame, update: Frame) {
  for (const [key, value] of Object.entries(update)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current[key] &&
      typeof current[key] === 'object' &&
      !Array.isArray(current[key])
    ) {
      merge(current[key], value);
    } else current[key] = structuredClone(value);
  }
}

async function providerFor(model: ModelServer) {
  const config = await model.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-native-parity',
    supportsWebsockets: false,
  });
}

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');

nativeIt.each(['static', 'sync', 'async'] as const)(
  'resolves %s voice credentials per connection without replacing Session auth',
  async (kind) => {
    const model = new ModelServer([[message('still usable')]]);
    const peer = new RealtimePeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Help the caller.',
        provider,
      }).session();
      let calls = 0;
      const nextKey = () => `synthetic-voice-${++calls}`;
      const apiKey =
        kind === 'static'
          ? 'synthetic-voice-static'
          : kind === 'sync'
            ? nextKey
            : async () => nextKey();
      for (let index = 0; index < 2; index++) {
        const voice = await session.realtime({
          model: 'fixture-realtime',
          apiKey,
        });
        await voice.close();
      }
      expect(peer.authorization).toEqual(
        kind === 'static'
          ? ['Bearer synthetic-voice-static', 'Bearer synthetic-voice-static']
          : ['Bearer synthetic-voice-1', 'Bearer synthetic-voice-2'],
      );
      expect(calls).toBe(kind === 'static' ? 0 : 2);
      await (await session.submit('continue')).wait();
      expect(model.requestHeaders[0].authorization).toBe(
        'Bearer synthetic-native-parity',
      );
      model.assertExhausted();
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt(
  'cancels native setup waiting for its initial provider acknowledgement and permits reopening',
  async () => {
    const model = new ModelServer([]);
    const peer = new RealtimePeer(model);
    peer.autoAck = false;
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Help the caller.',
        provider,
      }).session();
      const controller = new AbortController();
      const opening = session.realtime({
        model: 'fixture-realtime',
        signal: controller.signal,
      });
      const rejected = expect(opening).rejects.toThrow(
        'cancel initial voice setup',
      );
      await peer.frame((frame) => frame.type === 'session.update');
      controller.abort(new Error('cancel initial voice setup'));
      await rejected;
      peer.autoAck = true;
      const reopened = await session.realtime({ model: 'fixture-realtime' });
      await reopened.close();
      expect(peer.authorization).toHaveLength(2);
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

async function mcpPeer() {
  const calls: Frame[] = [];
  const failures: unknown[] = [];
  const server = createServer(async (request, response) => {
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
      let result: Frame = {};
      if (rpc.method === 'initialize')
        result = {
          protocolVersion: rpc.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'voice-source-fixture', version: '1' },
        };
      else if (rpc.method === 'tools/list')
        result = {
          tools: [
            {
              name: 'lookup',
              description: 'Read a record.',
              inputSchema: {
                type: 'object',
                properties: { key: { type: 'string' } },
                required: ['key'],
                additionalProperties: false,
              },
            },
          ],
        };
      else if (rpc.method === 'tools/call') {
        calls.push(rpc.params);
        result = { content: [{ type: 'text', text: 'raw MCP result' }] };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected TCP peer');
  return {
    calls,
    failures,
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await closed;
    },
  };
}

nativeIt.each([
  [false, 'session', false],
  [false, 'operation', false],
  [true, 'session', false],
  [true, 'session', true],
] as const)(
  'clears and restores live native MCP selection and its result policy (graph=%s, activation=%s, guarded=%s)',
  async (withGraph, activation, guarded) => {
    const model = new ModelServer([]);
    const peer = new RealtimePeer(model);
    const mcp = await mcpPeer();
    const accepted: MCPResultContext[] = [];
    let checked = 0;
    try {
      await using provider = await providerFor(model);
      const descriptor = new HttpMCP({
        name: 'records',
        url: mcp.url,
        activation,
        tools: ['lookup'],
        approvalMode: 'preapproved',
        before: guarded
          ? () => {
              checked++;
              return { action: 'allow' as const };
            }
          : undefined,
        transformResult(context) {
          accepted.push(context);
          return { content: [{ type: 'text', text: 'accepted MCP result' }] };
        },
      });
      await using session = await new Agent({
        name: 'A',
        instructions: 'Read selected records.',
        tools: [descriptor],
        handoffs: withGraph
          ? [new Agent({ name: 'B', instructions: 'Help the caller.' })]
          : [],
        provider,
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const initial = await peer.frame(
        (frame) => frame.type === 'session.update',
      );
      const declaration = initial.session.tools.find((item: Frame) =>
        item.name?.includes('lookup'),
      );
      expect(declaration).toBeDefined();
      const settle = async () => {
        const submission = accepted.at(-1)?.submission;
        expect(submission).toBeInstanceOf(Turn);
        if (!(submission instanceof Turn))
          throw new Error('Expected native Turn');
        await submission.wait();
      };
      peer.call(declaration.name, { key: 'before' }, 'mcp-before');
      const before = await peer.frame(
        (frame) => frame.item?.call_id === 'mcp-before',
      );
      expect(before.item.output).toContain('accepted MCP result');
      expect(before.item.output).not.toContain('raw MCP result');
      await settle();

      let start = peer.frames.length;
      await session.update({ tools: [] });
      const cleared = await peer.frame(
        (frame) => frame.type === 'session.update',
        start,
      );
      expect(
        cleared.session.tools.some(
          (item: Frame) => item.name === declaration.name,
        ),
      ).toBe(false);
      start = peer.frames.length;
      await session.update({ tools: [descriptor] });
      const restored = await peer.frame(
        (frame) => frame.type === 'session.update',
        start,
      );
      expect(
        restored.session.tools.some(
          (item: Frame) => item.name === declaration.name,
        ),
      ).toBe(true);
      peer.call(declaration.name, { key: 'after' }, 'mcp-after');
      const after = await peer.frame(
        (frame) => frame.item?.call_id === 'mcp-after',
      );
      expect(after.item.output).toContain('accepted MCP result');
      await settle();
      expect(accepted).toHaveLength(2);
      expect(checked).toBe(guarded ? 2 : 0);
      expect(mcp.calls.map((call) => call.arguments.key)).toEqual([
        'before',
        'after',
      ]);
      expect(mcp.failures).toEqual([]);
      expect(model.requests).toHaveLength(0);
      await voice.update({ instructions: 'Keep listening.' });
    } finally {
      await peer.close();
      await ModelServer.closeAll();
      await mcp.close();
    }
  },
  30000,
);

nativeIt.each([true, false])(
  'waits for all hosted calls and honors automatic continuation (automatic=%s)',
  async (automatic) => {
    const model = new ModelServer([]);
    const peer = new RealtimePeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Help the caller.',
        provider,
      }).session();
      await using voice = await session.realtime({
        model: 'fixture-realtime',
        automaticallyTriggerResponseForMcpToolCalls: automatic,
        settings: {
          hostedMcpTools: [
            {
              serverLabel: 'docs',
              serverUrl: 'https://mcp.example.test/server',
              requireApproval: 'never',
            },
          ],
        },
      });
      const seen: NativeRealtimeEvent[] = [];
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })();
      void reading.catch(() => {});
      const completed = () =>
        seen.filter((event) => event.type === 'hosted_mcp_call_completed');
      const continuations = () =>
        peer.frames.filter((frame) => frame.type === 'response.create');
      try {
        const responseId = 'hosted-siblings';
        peer.send({ type: 'response.created', response: { id: responseId } });
        const items = ['mcp_call', 'mcp_tool_call'].map((type, index) => ({
          type,
          id: `hosted-${index}`,
          server_label: 'docs',
          name: 'search',
          arguments: JSON.stringify({ query: `query-${index}` }),
          status: 'in_progress',
        }));
        items.forEach((item, output_index) =>
          peer.send({
            type: 'response.output_item.added',
            response_id: responseId,
            output_index,
            item,
          }),
        );
        peer.send({
          type: 'response.done',
          response: { id: responseId, output: items },
        });
        for (const [index, item] of items.entries()) {
          peer.send({
            type: 'conversation.item.done',
            item: {
              ...item,
              arguments: JSON.stringify({ query: `query-${index}` }),
              output: `result-${index}`,
              status: 'completed',
            },
          });
          await vi.waitFor(() => expect(completed()).toHaveLength(index + 1), {
            timeout: 10000,
          });
          expect(completed()[index]).toMatchObject({
            itemId: item.id,
            responseId,
            output: `result-${index}`,
          });
          if (index === 0) {
            const after = peer.frames.length;
            await voice.sendAudio(new Int16Array([0]));
            await peer.frame(
              (frame) => frame.type === 'input_audio_buffer.append',
              after,
            );
            expect(continuations()).toHaveLength(0);
          }
        }
        if (automatic) {
          await peer.frame((frame) => frame.type === 'response.create');
          await vi.waitFor(
            () =>
              expect(
                seen.some(
                  (event) =>
                    event.type === 'response' &&
                    event.status === 'done' &&
                    event.responseId?.startsWith('continuation-'),
                ),
              ).toBe(true),
            { timeout: 10000 },
          );
        } else {
          // Both siblings have settled, so this barrier cannot hide a pending call.
          await voice.update({
            instructions: 'Both hosted calls have settled.',
          });
        }
        expect(continuations()).toHaveLength(Number(automatic));
        expect(model.requests).toHaveLength(0);
      } finally {
        await voice.close();
        await reading;
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt.each([true, false])(
  "answers only this owner's issued hosted MCP approval after response.done (approve=%s)",
  async (approve) => {
    const model = new ModelServer([]);
    const peer = new RealtimePeer(model);
    const secret = 'synthetic-hosted-authorization';
    const settings = {
      hostedMcpTools: [
        {
          serverLabel: 'docs',
          serverUrl: 'https://mcp.example.test/server',
          authorization: secret,
          allowedTools: ['search'],
          requireApproval: 'always' as const,
        },
      ],
    };
    try {
      await using provider = await providerFor(model);
      const agent = new Agent({
        instructions: 'Help with the conversation.',
        provider,
      });
      await using session = await agent.session();
      await using voice = await session.realtime({
        model: 'fixture-realtime',
        settings,
      });
      const approvals: NativeRealtimeHostedMcpApprovalRequest[] = [];
      const seen: unknown[] = [];
      let done = false;
      const reading = (async () => {
        for await (const event of voice.events()) {
          seen.push(event);
          if (event.type === 'hosted_mcp_approval_requested')
            approvals.push(event);
          if (
            event.type === 'response' &&
            event.responseId === 'hosted-response' &&
            event.status === 'done'
          )
            done = true;
        }
      })();
      void reading.catch(() => {});
      try {
        const initial = await peer.frame(
          (frame) => frame.type === 'session.update',
        );
        expect(
          initial.session.tools.find((item: Frame) => item.type === 'mcp')
            .authorization,
        ).toBe(secret);
        const item = {
          type: 'mcp_approval_request',
          id: 'approval-item',
          server_label: 'docs',
          name: 'search',
          arguments: '',
        };
        peer.send({
          type: 'response.created',
          response: { id: 'hosted-response' },
        });
        peer.send({
          type: 'response.output_item.added',
          response_id: 'hosted-response',
          output_index: 0,
          item,
        });
        const completed = { ...item, arguments: '{"query":"records"}' };
        peer.send({ type: 'conversation.item.done', item: completed });
        peer.send({
          type: 'response.done',
          response: { id: 'hosted-response', output: [completed] },
        });
        await vi.waitFor(
          () => {
            expect(approvals).toHaveLength(1);
            expect(done).toBe(true);
          },
          { timeout: 10000 },
        );
        const request = approvals[0];
        expect(request).toMatchObject({
          requestId: 'approval-item',
          serverLabel: 'docs',
          toolName: 'search',
          arguments: completed.arguments,
          responseId: 'hosted-response',
        });
        await expect(
          voice.approveHostedMcp({ ...request }, { approve }),
        ).rejects.toThrow();
        {
          await using foreignSession = await agent.session();
          await using foreign = await foreignSession.realtime({
            model: 'fixture-realtime',
            settings,
          });
          await expect(
            foreign.approveHostedMcp(request, { approve }),
          ).rejects.toThrow();
        }
        expect(
          peer.frames.some(
            (frame) => frame.item?.type === 'mcp_approval_response',
          ),
        ).toBe(false);
        await voice.approveHostedMcp(request, {
          approve,
          reason: 'Application decision',
        });
        const sent = await peer.frame(
          (frame) => frame.item?.type === 'mcp_approval_response',
        );
        expect(sent).toMatchObject({
          previous_item_id: 'approval-item',
          item: {
            approval_request_id: 'approval-item',
            approve,
            reason: 'Application decision',
          },
        });
        await expect(
          voice.approveHostedMcp(request, { approve }),
        ).rejects.toThrow();
        expect(
          peer.frames.filter(
            (frame) => frame.item?.type === 'mcp_approval_response',
          ),
        ).toHaveLength(1);
        expect(
          peer.frames.some((frame) => frame.type === 'response.create'),
        ).toBe(false);
        expect(JSON.stringify(seen)).not.toContain(secret);
        expect(JSON.stringify(voice.history)).not.toContain(secret);
        expect(model.requests).toHaveLength(0);
      } finally {
        await voice.close();
        await reading;
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt(
  'waits for the destination configuration before continuing a native handoff',
  async () => {
    const model = new ModelServer([]);
    const peer = new RealtimePeer(model);
    const calls: string[] = [];
    const lookup = tool({
      name: 'target_lookup',
      parameters: z.object({}),
      execute: () => {
        calls.push('B');
        return 'B owns this result';
      },
    });
    const target = new Agent({
      name: 'B',
      instructions: 'Target B instructions.',
      tools: [lookup],
    });
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        name: 'A',
        instructions: 'Source A instructions.',
        handoffs: [target],
        provider,
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const initial = await peer.frame(
        (frame) => frame.type === 'session.update',
      );
      expect(initial.session.instructions).toContain('Source A instructions.');
      expect(
        initial.session.tools.some(
          (item: Frame) => item.name === 'transfer_to_b',
        ),
      ).toBe(true);
      const start = peer.frames.length;
      peer.autoAck = false;
      peer.call('transfer_to_b', {}, 'route-to-B');
      const updated = await peer.frame(
        (frame) => frame.type === 'session.update',
        start,
      );
      expect(await session.getActiveAgent()).toBe(target);
      expect(updated.session.instructions).toContain('Target B instructions.');
      expect(
        updated.session.tools.some(
          (item: Frame) => item.name === 'target_lookup',
        ),
      ).toBe(true);
      // The provider continues reading while withholding ACK; this append crosses
      // the native writer after its pending destination configuration.
      await voice.sendAudio(new Int16Array([0]));
      await peer.frame(
        (frame) => frame.type === 'input_audio_buffer.append',
        start,
      );
      expect(
        peer.frames
          .slice(start)
          .filter((frame) => frame.type === 'response.create'),
      ).toHaveLength(0);
      peer.autoAck = true;
      peer.acknowledge();
      await peer.frame((frame) => frame.type === 'response.create', start);
      expect(
        peer.frames
          .slice(start)
          .filter((frame) => frame.type === 'response.create'),
      ).toHaveLength(1);
      peer.call('target_lookup', {}, 'target-lookup');
      const result = await peer.frame(
        (frame) => frame.item?.call_id === 'target-lookup',
      );
      expect(result.item.output).toBe('B owns this result');
      expect(calls).toEqual(['B']);
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt.each([false, true])(
  'refreshes live activation and preserves original tool identity (restricted=%s)',
  async (restricted) => {
    const model = new ModelServer([]);
    const peer = new RealtimePeer(model);
    const left = tool({
      name: 'lookup',
      description: 'Read through A.',
      parameters: z.object({}),
      execute: () => 'A',
    });
    const right = tool({
      name: 'lookup',
      description: 'Read through B.',
      parameters: z.object({}),
      execute: () => 'B',
    });
    const target = new Agent({
      name: 'B',
      instructions: 'Target B instructions.',
      tools: [right],
    });
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        name: 'A',
        instructions: 'Source A instructions.',
        tools: [left],
        handoffs: [target],
        provider,
      }).session();
      await using voice = await session.realtime({
        model: 'fixture-realtime',
        ...(restricted ? { tools: [left] } : {}),
      });
      await peer.frame((frame) => frame.type === 'session.update');
      const start = peer.frames.length;
      peer.autoAck = false;
      let finished = false;
      const updating = session.update({ agent: target }).finally(() => {
        finished = true;
      });
      // Keep a failure observed even if an earlier fixture assertion fails.
      void updating.catch(() => {});
      try {
        const updated = await peer.frame(
          (frame) => frame.type === 'session.update',
          start,
        );
        expect(updated.session.instructions).toContain(
          'Target B instructions.',
        );
        const lookups = updated.session.tools.filter(
          (item: Frame) => item.name === 'lookup',
        );
        expect(lookups).toHaveLength(restricted ? 0 : 1);
        if (lookups.length)
          expect(lookups[0].description).toContain('Read through B.');
        await voice.sendAudio(new Int16Array([0]));
        await peer.frame(
          (frame) => frame.type === 'input_audio_buffer.append',
          start,
        );
        expect(finished).toBe(false);
        peer.autoAck = true;
        peer.acknowledge();
        await updating;
        expect(await session.getActiveAgent()).toBe(target);
        expect(
          peer.frames
            .slice(start)
            .filter((frame) => frame.type === 'response.create'),
        ).toHaveLength(0);
      } finally {
        await voice.close();
        await updating.catch(() => {});
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);
