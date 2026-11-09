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
import { ModelServer, call, message } from './native/fixtures/model-server';
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
  'fences old response feedback after newer speech begins without a response ID',
  async () => {
    const model = new ModelServer([]);
    const peer = new RealtimePeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Listen for the next user turn.',
        provider,
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      peer.send({ type: 'response.created', response: { id: 'old-A' } });
      peer.send({
        type: 'response.output_audio.delta',
        response_id: 'old-A',
        item_id: 'old-A-audio',
        content_index: 0,
        output_index: 0,
        delta: Buffer.alloc(4800).toString('base64'),
      });
      peer.send({ type: 'response.done', response: { id: 'old-A' } });
      // B is speaking, but the provider has not created its response yet.
      peer.send({
        type: 'input_audio_buffer.speech_started',
        item_id: 'new-B-input',
        audio_start_ms: 100,
      });
      const events = voice.events();
      let sawAudio = false;
      let sawDone = false;
      try {
        for (;;) {
          const next = await events.next();
          if (next.done)
            throw new Error('The newer speech boundary was not observed');
          const event = next.value;
          if (event.type === 'audio' && event.responseId === 'old-A')
            sawAudio = true;
          if (event.type === 'response' && event.status === 'done') {
            expect(event.responseId).toBe('old-A');
            sawDone = true;
          }
          if (event.type === 'lifecycle' && event.status === 'speech_started')
            break;
        }
      } finally {
        await events.return(undefined);
      }
      expect(sawAudio && sawDone).toBe(true);
      const start = peer.frames.length;
      await voice.interrupt('old-A', {
        playback: {
          responseId: 'old-A',
          itemId: 'old-A-audio',
          contentIndex: 0,
          audioEndMs: 50,
        },
        feedback: 'FORBIDDEN_OLD_A_FEEDBACK',
      });
      // This acknowledged update is a writer barrier after the interrupt.
      await voice.update({ instructions: 'Continue listening for B.' });
      await peer.frame((frame) => frame.type === 'session.update', start);
      const frames = peer.frames.slice(start);
      expect(
        frames.find((frame) => frame.type === 'conversation.item.truncate'),
      ).toMatchObject({
        type: 'conversation.item.truncate',
        item_id: 'old-A-audio',
        content_index: 0,
        audio_end_ms: 50,
      });
      expect(
        frames.some(
          (frame) =>
            frame.type === 'conversation.item.create' &&
            frame.item?.role === 'developer',
        ),
      ).toBe(false);
      expect(frames.some((frame) => frame.type === 'response.create')).toBe(
        false,
      );
      expect(model.requests).toHaveLength(0);
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

nativeIt(
  'activates an attached handoff and gates its target ACK while the original root stays owned',
  async () => {
    const enteredA = vi.fn();
    const releaseA = Promise.withResolvers<void>();
    const enteredB = vi.fn();
    const exitedA = vi.fn();
    let rootA: string | undefined;
    let rootB: string | undefined;
    let signalA: AbortSignal | undefined;
    const slowA = tool({
      name: 'slow_a',
      parameters: z.object({}),
      execute: async (_args, context) => {
        rootA = context.turnId;
        signalA = context.signal;
        enteredA();
        try {
          await releaseA.promise;
          return 'A retained result';
        } finally {
          exitedA();
        }
      },
    });
    const lookup = tool({
      name: 'target_lookup',
      parameters: z.object({}),
      execute: (_args, context) => {
        rootB = context.turnId;
        enteredB();
        return 'B owns this result';
      },
    });
    const target = new Agent({
      name: 'B',
      instructions: 'Target B instructions.',
      tools: [lookup],
    });
    const model = new ModelServer([[message('Caller remains open.')]]);
    const peer = new RealtimePeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        name: 'A',
        instructions: 'Source A instructions.',
        tools: [slowA],
        handoffs: [target],
        provider,
      }).session();
      const voice = await session.realtime({ model: 'fixture-realtime' });
      try {
        peer.call('slow_a', {}, 'held-a');
        await vi.waitFor(() => expect(enteredA).toHaveBeenCalledOnce(), {
          timeout: 10000,
        });
        const start = peer.frames.length;
        peer.autoAck = false;
        peer.call('transfer_to_b', {}, 'attached-handoff');
        // Accepted output proves this batch executed while A is still held.
        await peer.frame((frame) => frame.item?.call_id === 'attached-handoff');
        expect(exitedA).not.toHaveBeenCalled();
        const updated = await peer.frame(
          (frame) => frame.type === 'session.update',
          start,
        );
        expect(await session.getActiveAgent()).toBe(target);
        expect(updated.session.instructions).toContain(
          'Target B instructions.',
        );
        expect(
          updated.session.tools.some(
            (item: Frame) => item.name === 'target_lookup',
          ),
        ).toBe(true);
        // Cross the provider writer after the held target update, without a sleep.
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
        expect(signalA!.aborted).toBe(false);
        peer.autoAck = true;
        peer.acknowledge();
        await peer.frame((frame) => frame.type === 'response.create', start);
        expect(
          peer.frames
            .slice(start)
            .filter((frame) => frame.type === 'response.create'),
        ).toHaveLength(1);

        peer.call('target_lookup', {}, 'target-b');
        await vi.waitFor(() => expect(enteredB).toHaveBeenCalledOnce(), {
          timeout: 10000,
        });
        const resultB = await peer.frame(
          (frame) => frame.item?.call_id === 'target-b',
        );
        expect(resultB.item.output).toBe('B owns this result');
        expect(exitedA).not.toHaveBeenCalled();
        expect(signalA!.aborted).toBe(false);
        expect(rootA).toBeTypeOf('string');
        expect(rootB).toBe(rootA);
        releaseA.resolve();
        const resultA = await peer.frame(
          (frame) => frame.item?.call_id === 'held-a',
        );
        expect(resultA.item.output).toBe('A retained result');
        expect(await session.getActiveAgent()).toBe(target);
        expect(model.requests).toHaveLength(0);
      } finally {
        releaseA.resolve();
        peer.autoAck = true;
        while (peer.pendingUpdates.length) peer.acknowledge();
        await voice.close();
      }
      expect(
        (await (await session.submit('continue')).wait()).finalOutput,
      ).toBe('Caller remains open.');
      model.assertExhausted();
    } finally {
      releaseA.resolve();
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt.each(['omitted', 'empty', 'subset'] as const)(
  'keeps the captured %s voice ceiling on real background MCP calls after defaults change',
  async (mode) => {
    let selectedEffects = 0;
    let approvals = 0;
    const selected = tool({
      name: 'selected',
      parameters: z.object({}),
      execute: () => {
        selectedEffects++;
        return 'selected result';
      },
    });
    const model = new ModelServer([
      [
        ...(mode === 'subset'
          ? [call('selected', {}, { callId: 'selected-background' })]
          : []),
        call(
          'lookup',
          { key: 'background' },
          {
            callId: 'excluded-background',
            namespace: 'mcp__records',
          },
        ),
      ],
      [message('Background complete.')],
    ]);
    const peer = new RealtimePeer(model);
    const mcp = await mcpPeer();
    try {
      await using provider = await providerFor(model);
      const descriptor = new HttpMCP({
        name: 'records',
        url: mcp.url,
        tools: ['lookup'],
        approvalMode: 'preapproved',
        before: () => {
          approvals++;
          return { action: 'allow' as const };
        },
      });
      await using session = await new Agent({
        instructions: 'Use the available tools and finish.',
        model: 'gpt-5.5',
        tools: [selected, descriptor],
        provider,
      }).session();
      await session.update({ tools: [selected] });
      const ceiling = [selected];
      await using voice = await session.realtime({
        model: 'fixture-realtime',
        ...(mode === 'omitted'
          ? {}
          : { tools: mode === 'empty' ? [] : ceiling }),
        ...(mode === 'empty'
          ? {
              settings: {
                toolChoice: {
                  type: 'function' as const,
                  name: 'background_agent',
                },
              },
            }
          : {}),
      });
      const initial = await peer.frame(
        (frame) => frame.type === 'session.update',
      );
      if (mode === 'empty')
        expect(initial.session.tool_choice).toEqual({
          type: 'function',
          name: 'background_agent',
        });
      // Mutating the caller's list or broadening Session defaults cannot change
      // the explicit roster accepted when this voice owner opened.
      ceiling.length = 0;
      await session.update({ tools: [selected, descriptor] });
      await voice.sendText('Read the record.');
      await peer.frame((frame) => frame.type === 'response.create');
      peer.call(
        'background_agent',
        { input_transcript: 'Read the record.' },
        'background-ceiling',
      );
      const result = await peer.frame(
        (frame) => frame.item?.call_id === 'background-ceiling',
      );
      expect(result.item.output).toContain('Background complete.');
      expect(approvals).toBe(mode === 'omitted' ? 1 : 0);
      expect(mcp.calls).toHaveLength(mode === 'omitted' ? 1 : 0);
      expect(selectedEffects).toBe(mode === 'subset' ? 1 : 0);
      expect(mcp.failures).toEqual([]);
    } finally {
      await peer.close();
      await mcp.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt.each([false, true])(
  'retains background voice declaration identity after active-profile replacement (restricted=%s)',
  async (restricted) => {
    let leftEffects = 0;
    let rightEffects = 0;
    const left = tool({
      name: 'lookup',
      parameters: z.object({}),
      execute: () => {
        leftEffects++;
        return 'A';
      },
    });
    const right = tool({
      name: 'lookup',
      parameters: z.object({}),
      execute: () => {
        rightEffects++;
        return 'B';
      },
    });
    const target = new Agent({
      name: 'B',
      instructions: 'Use B lookup.',
      tools: [right],
    });
    const model = new ModelServer([
      [call('lookup', {}, { callId: 'background-replaced' })],
      [message('B complete.')],
    ]);
    const peer = new RealtimePeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        name: 'A',
        instructions: 'Use A lookup.',
        tools: [left],
        handoffs: [target],
        provider,
      }).session();
      await using voice = await session.realtime({
        model: 'fixture-realtime',
        ...(restricted ? { tools: [left] } : {}),
      });
      await session.update({ agent: target });
      const seen: NativeRealtimeEvent[] = [];
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })();
      void reading.catch(() => {});
      try {
        peer.call(
          'background_agent',
          { input_transcript: 'Use lookup.' },
          'background-replaced',
        );
        await vi.waitFor(
          () =>
            expect(
              seen.some(
                (event) =>
                  event.type === 'delegation' &&
                  event.handoffId === 'background-replaced' &&
                  (event.status === 'failed' || event.status === 'completed'),
              ),
            ).toBe(true),
          { timeout: 10000 },
        );
        expect(
          seen.find(
            (event) =>
              event.type === 'delegation' &&
              event.handoffId === 'background-replaced' &&
              event.status !== 'started',
          ),
        ).toMatchObject({
          status: restricted ? 'failed' : 'completed',
        });
        expect(leftEffects).toBe(0);
        expect(rightEffects).toBe(restricted ? 0 : 1);
        expect(model.requests).toHaveLength(restricted ? 0 : 2);
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

nativeIt.each([
  'default',
  'true',
  'false',
  'null',
  'ack-false',
  'ack-null',
  'pending-true',
] as const)(
  'uses accepted VAD interruption policy for a live native function (%s)',
  async (policy) => {
    const model = new ModelServer([]);
    const peer = new RealtimePeer(model);
    const entered = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    const lookup = tool({
      name: 'lookup',
      parameters: z.object({}),
      execute: async (_args, context) => {
        signal = context.signal;
        signal.addEventListener('abort', () => cancelled.resolve(), {
          once: true,
        });
        entered.resolve();
        await release.promise;
        return 'joined native callback';
      },
    });
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Read records.',
        tools: [lookup],
        provider,
      }).session();
      await using voice = await session.realtime({
        model: 'fixture-realtime',
        tools: [lookup],
        ...(policy === 'default'
          ? {}
          : {
              settings: {
                turnDetection:
                  policy === 'null'
                    ? null
                    : {
                        type: 'server_vad' as const,
                        interruptResponse: [
                          'true',
                          'ack-false',
                          'ack-null',
                        ].includes(policy),
                      },
              },
            }),
      });
      if (policy === 'ack-false' || policy === 'ack-null')
        await voice.update({
          turnDetection:
            policy === 'ack-null'
              ? null
              : { type: 'semantic_vad', interruptResponse: false },
        });
      let speechObserved = Promise.withResolvers<void>();
      const reading = (async () => {
        for await (const event of voice.events())
          if (event.type === 'lifecycle' && event.status === 'speech_started')
            speechObserved.resolve();
      })();
      void reading.catch(() => {});
      let updating: Promise<void> | undefined;
      try {
        peer.call('lookup', {}, 'speech-policy-tool');
        await entered.promise;
        let updated = false;
        if (policy === 'pending-true') {
          peer.autoAck = false;
          updating = voice
            .update({
              turnDetection: { type: 'server_vad', interruptResponse: true },
            })
            .then(() => {
              updated = true;
            });
          void updating.catch(() => {});
          await vi.waitFor(() => expect(peer.pendingUpdates).toHaveLength(1));
        }
        peer.send({
          type: 'input_audio_buffer.speech_started',
          item_id: 'speech-1',
          audio_start_ms: 0,
        });
        if (policy === 'pending-true') {
          expect(updated).toBe(false);
          // The native actor queues speech while waiting for ACK. Send ACK
          // after that frame, then observe its previously accepted policy.
          peer.autoAck = true;
          peer.acknowledge();
          await updating;
        }
        if (policy !== 'default' && policy !== 'true') {
          expect(
            await Promise.race([
              speechObserved.promise.then(() => 'speech'),
              cancelled.promise.then(() => 'cancelled'),
            ]),
          ).toBe('speech');
          expect(signal?.aborted).toBe(false);
          if (policy === 'pending-true') {
            speechObserved = Promise.withResolvers<void>();
            peer.send({
              type: 'input_audio_buffer.speech_started',
              item_id: 'speech-2',
              audio_start_ms: 100,
            });
            await cancelled.promise;
          }
        } else await cancelled.promise;
        let joined = false;
        const interrupting = voice.interrupt().then(() => {
          joined = true;
        });
        void interrupting.catch(() => {});
        await cancelled.promise;
        expect(joined).toBe(false);
        release.resolve();
        await interrupting;
        expect(joined).toBe(true);
        expect(model.requests).toEqual([]);
      } finally {
        release.resolve();
        peer.autoAck = true;
        while (peer.pendingUpdates.length) peer.acknowledge();
        await updating?.catch(() => {});
        await voice.close();
        await reading;
      }
    } finally {
      release.resolve();
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  15000,
);

nativeIt.each([
  [false, false],
  [false, true],
  [null, false],
  [null, true],
] as const)(
  'preserves native completion authority after speech (interruptResponse=%s, committed=%s)',
  async (interruptResponse, committed) => {
    const model = new ModelServer([]);
    const peer = new RealtimePeer(model);
    const entered = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    let submission: Turn<unknown> | undefined;
    const lookup = tool({
      name: 'lookup',
      parameters: z.object({}),
      execute: async (_args, context) => {
        signal = context.signal;
        signal.addEventListener('abort', () => cancelled.resolve(), {
          once: true,
        });
        if (!(context.submission instanceof Turn))
          throw new Error('Expected direct native Turn');
        submission = context.submission;
        entered.resolve();
        await release.promise;
        return 'surviving native result';
      },
    });
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Read records.',
        tools: [lookup],
        provider,
      }).session();
      await using voice = await session.realtime({
        model: 'fixture-realtime',
        tools: [lookup],
        settings: {
          turnDetection:
            interruptResponse === null
              ? null
              : { type: 'server_vad', interruptResponse },
        },
      });
      const speech = Promise.withResolvers<void>();
      const reading = (async () => {
        for await (const event of voice.events())
          if (event.type === 'lifecycle' && event.status === 'speech_started')
            speech.resolve();
      })();
      void reading.catch(() => {});
      try {
        peer.call('lookup', {}, 'surviving-native-tool');
        await entered.promise;
        peer.send({
          type: 'input_audio_buffer.speech_started',
          item_id: 'surviving-speech',
          audio_start_ms: 0,
        });
        expect(
          await Promise.race([
            speech.promise.then(() => 'speech'),
            cancelled.promise.then(() => 'cancelled'),
          ]),
        ).toBe('speech');
        expect(signal?.aborted).toBe(false);
        if (committed) {
          // The provider ends the observed VAD source before committing its user item.
          peer.send({
            type: 'input_audio_buffer.speech_stopped',
            item_id: 'surviving-speech',
            audio_end_ms: 1,
          });
          peer.send({
            type: 'input_audio_buffer.committed',
            item_id: 'surviving-speech',
          });
          await voice.update({
            instructions: 'Acknowledge the new committed input.',
          });
        }
        release.resolve();
        const output = await peer.frame(
          (frame) => frame.item?.call_id === 'surviving-native-tool',
        );
        expect(output.item.output).toContain('surviving native result');
        await submission!.wait();
        if (committed) {
          // Fence completion commands before asserting no stale continuation.
          await voice.update({ instructions: 'Completion has settled.' });
          expect(
            peer.frames.filter((frame) => frame.type === 'response.create'),
          ).toEqual([]);
        } else {
          await peer.frame((frame) => frame.type === 'response.create');
        }
        expect(model.requests).toEqual([]);
      } finally {
        release.resolve();
        await voice.close();
        await reading;
      }
    } finally {
      release.resolve();
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  15000,
);

nativeIt(
  'sends one provider commit after each complete audio call without requesting an audio response',
  async () => {
    const model = new ModelServer([]);
    const peer = new RealtimePeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Listen.',
        provider,
      }).session();
      await using voice = await session.realtime({
        model: 'fixture-realtime',
        settings: { turnDetection: null },
      });
      await voice.sendAudio(new Int16Array([0]));
      await peer.frame((frame) => frame.type === 'input_audio_buffer.append');
      expect(
        peer.frames.filter(
          (frame) => frame.type === 'input_audio_buffer.commit',
        ),
      ).toEqual([]);
      await expect(voice.sendAudio(new Int16Array())).rejects.toThrow(
        'nonempty',
      );
      await voice.sendAudio(new Int16Array(), { commit: true });
      await peer.frame((frame) => frame.type === 'input_audio_buffer.commit');
      expect(
        peer.frames.filter(
          (frame) => frame.type === 'input_audio_buffer.append',
        ),
      ).toHaveLength(1);
      expect(
        peer.frames.filter(
          (frame) => frame.type === 'input_audio_buffer.commit',
        ),
      ).toHaveLength(1);
      expect(
        peer.frames.filter((frame) => frame.type === 'response.create'),
      ).toEqual([]);
      const start = peer.frames.length;
      const first = voice.sendAudio(new Int16Array(40000).fill(1), {
        commit: true,
      });
      const text = voice.sendText('between audio calls');
      const second = voice.sendAudio(new Int16Array([2]), { commit: true });
      await Promise.all([first, text, second]);
      await vi.waitFor(() =>
        expect(
          peer.frames
            .slice(start)
            .filter((frame) => frame.type === 'input_audio_buffer.commit'),
        ).toHaveLength(2),
      );
      expect(
        peer.frames
          .slice(start)
          .filter((frame) =>
            [
              'input_audio_buffer.append',
              'input_audio_buffer.commit',
              'conversation.item.create',
            ].includes(frame.type),
          )
          .map((frame) => frame.type),
      ).toEqual([
        'input_audio_buffer.append',
        'input_audio_buffer.append',
        'input_audio_buffer.commit',
        'conversation.item.create',
        'input_audio_buffer.append',
        'input_audio_buffer.commit',
      ]);
      expect(
        peer.frames.filter((frame) => frame.type === 'response.create'),
      ).toHaveLength(1);
      expect(model.requests).toEqual([]);
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  15000,
);

nativeIt(
  'sends ordered user text/images without a response until explicitly requested',
  async () => {
    const model = new ModelServer([]);
    const peer = new RealtimePeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Describe images.',
        provider,
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      await voice.sendMessage(
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Describe this image.' },
            {
              type: 'input_image',
              image: 'data:image/png;base64,aW1hZ2U=',
              detail: 'low',
            },
          ],
        },
        { triggerResponse: false },
      );
      const message = await peer.frame(
        (frame) => frame.type === 'conversation.item.create',
      );
      expect(message.item).toMatchObject({
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Describe this image.' },
          {
            type: 'input_image',
            image_url: 'data:image/png;base64,aW1hZ2U=',
            detail: 'low',
          },
        ],
      });
      expect(
        peer.frames.filter((frame) => frame.type === 'response.create'),
      ).toEqual([]);
      await voice.requestResponse();
      await peer.frame((frame) => frame.type === 'response.create');
      expect(
        peer.frames.filter((frame) => frame.type === 'response.create'),
      ).toHaveLength(1);
      const start = peer.frames.length;
      await voice.addImage('https://example.com/image.png');
      const image = await peer.frame(
        (frame) => frame.type === 'conversation.item.create',
        start,
      );
      expect(image.item.content).toEqual([
        { type: 'input_image', image_url: 'https://example.com/image.png' },
      ]);
      await peer.frame((frame) => frame.type === 'response.create', start);
      expect(
        peer.frames.filter((frame) => frame.type === 'response.create'),
      ).toHaveLength(2);
      expect(model.requests).toEqual([]);
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  15000,
);

nativeIt(
  'uses actual tool-choice ACKs and preserves the accepted function subset after local rejection',
  async () => {
    const weather = tool({
      name: 'weather',
      parameters: z.object({}),
      execute: () => 'sunny',
    });
    const excluded = tool({
      name: 'excluded',
      parameters: z.object({}),
      execute: () => {
        throw new Error('Excluded function must never execute');
      },
    });
    const model = new ModelServer([]);
    const peer = new RealtimePeer(model);
    const named = { type: 'function' as const, name: 'weather' };
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Use weather.',
        tools: [weather, excluded],
        provider,
      }).session();
      await using voice = await session.realtime({
        model: 'fixture-realtime',
        tools: [weather],
        settings: { toolChoice: named },
      });
      const initial = await peer.frame(
        (frame) => frame.type === 'session.update',
      );
      expect(initial.session.tool_choice).toEqual(named);
      expect(
        initial.session.tools.some((entry: Frame) => entry.name === 'excluded'),
      ).toBe(false);
      let start = peer.frames.length;
      await expect(
        voice.update({ toolChoice: { type: 'function', name: 'excluded' } }),
      ).rejects.toThrow('advertised function subset');
      expect(
        peer.frames
          .slice(start)
          .some((frame) => frame.type === 'session.update'),
      ).toBe(false);
      peer.autoAck = false;
      let settled = false;
      const updating = voice.update({ outputSpeed: 1.1 }).finally(() => {
        settled = true;
      });
      try {
        const sparse = await peer.frame(
          (frame) => frame.type === 'session.update',
          start,
        );
        expect(sparse.session).not.toHaveProperty('tool_choice');
        expect(peer.pendingUpdates[0].session.tool_choice).toEqual(named);
        expect(settled).toBe(false);
        peer.autoAck = true;
        peer.acknowledge();
        await updating;
      } finally {
        peer.autoAck = true;
        while (peer.pendingUpdates.length) peer.acknowledge();
        await updating.catch(() => {});
      }
      for (const mode of ['none', 'required', 'auto'] as const) {
        start = peer.frames.length;
        await voice.update({ toolChoice: mode });
        expect(
          (await peer.frame((frame) => frame.type === 'session.update', start))
            .session.tool_choice,
        ).toBe(mode);
      }
      start = peer.frames.length;
      await voice.update({ outputSpeed: 1.2 });
      await peer.frame((frame) => frame.type === 'session.update', start);
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt(
  'deletes one observed provider item only after exact ACK and retains its canonical audit target',
  async () => {
    const model = new ModelServer([]);
    const peer = new RealtimePeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Keep the transcript.',
        provider,
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const seen: NativeRealtimeEvent[] = [];
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })();
      void reading.catch(() => {});
      try {
        await voice.sendMessage('Retain this original audit entry.', {
          triggerResponse: false,
        });
        await peer.frame((frame) => frame.type === 'conversation.item.create');
        const answer = {
          id: 'retained-answer',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            { type: 'audio', transcript: 'Retain this canonical transcript.' },
          ],
        };
        peer.send({
          type: 'response.created',
          response: { id: 'retained-response' },
        });
        peer.send({
          type: 'conversation.item.added',
          item: { ...answer, status: 'in_progress', content: [] },
        });
        peer.send({
          type: 'response.output_audio_transcript.delta',
          response_id: 'retained-response',
          item_id: answer.id,
          delta: 'Retain this canonical transcript.',
        });
        peer.send({
          type: 'response.output_audio_transcript.done',
          response_id: 'retained-response',
          item_id: answer.id,
          transcript: 'Retain this canonical transcript.',
        });
        peer.send({
          type: 'conversation.item.done',
          response_id: 'retained-response',
          item: answer,
        });
        peer.send({
          type: 'response.done',
          response: { id: 'retained-response', output: [answer] },
        });
        await vi.waitFor(() =>
          expect(JSON.stringify(voice.history)).toContain(
            'Retain this canonical transcript.',
          ),
        );
        const item = {
          id: 'provider-delete-target',
          type: 'message',
          role: 'user',
          status: 'completed',
          content: [
            { type: 'input_text', text: 'Retain this original audit entry.' },
          ],
        };
        peer.send({ type: 'conversation.item.added', item });
        peer.send({ type: 'conversation.item.done', item });
        await vi.waitFor(() =>
          expect(
            seen.some(
              (event) =>
                event.type === 'conversation_item' &&
                event.itemId === item.id &&
                event.status === 'done',
            ),
          ).toBe(true),
        );
        const before = voice.history.map((entry) => entry.id);
        let settled = false;
        const deleting = voice.deleteConversationItem(item.id).then(() => {
          settled = true;
        });
        void deleting.catch(() => {});
        const request = await peer.frame(
          (frame) => frame.type === 'conversation.item.delete',
        );
        expect(request.item_id).toBe(item.id);
        expect(settled).toBe(false);
        expect(voice.history.map((entry) => entry.id)).toEqual(before);
        peer.send({ type: 'conversation.item.deleted', item_id: item.id });
        await deleting;
        await vi.waitFor(() =>
          expect(
            seen.some(
              (event) =>
                event.type === 'conversation_item_deleted' &&
                event.itemId === item.id,
            ),
          ).toBe(true),
        );
        expect(
          voice.history.some(
            (entry) =>
              entry.kind === 'provider_item_deleted' &&
              entry.providerItemId === item.id,
          ),
        ).toBe(true);
        expect(
          voice.history
            .filter((entry) => before.includes(entry.id))
            .map((entry) => entry.id),
        ).toEqual(before);
        expect(model.requests).toEqual([]);
      } finally {
        await voice.close();
        await reading;
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  15000,
);

nativeIt(
  'retires the generation on provider deletion rejection without publishing a deletion audit',
  async () => {
    const model = new ModelServer([]);
    const peer = new RealtimePeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Keep the transcript.',
        provider,
      }).session();
      const voice = await session.realtime({ model: 'fixture-realtime' });
      const seen: NativeRealtimeEvent[] = [];
      let readFailure: unknown;
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })().catch((error: unknown) => {
        readFailure = error;
      });
      try {
        const item = {
          id: 'provider-rejected-delete',
          type: 'message',
          role: 'user',
          status: 'completed',
          content: [{ type: 'input_text', text: 'Keep me.' }],
        };
        peer.send({ type: 'conversation.item.added', item });
        peer.send({ type: 'conversation.item.done', item });
        await vi.waitFor(() =>
          expect(
            seen.some(
              (event) =>
                event.type === 'conversation_item' && event.itemId === item.id,
            ),
          ).toBe(true),
        );
        const deleting = voice.deleteConversationItem(item.id);
        void deleting.catch(() => {});
        await peer.frame((frame) => frame.type === 'conversation.item.delete');
        peer.send({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            code: 'item_not_found',
            message: 'delete rejected',
            param: 'item_id',
          },
        });
        await expect(deleting).rejects.toThrow();
        await reading;
        expect(readFailure).toBeDefined();
        expect(
          seen.some((event) => event.type === 'conversation_item_deleted'),
        ).toBe(false);
        expect(
          voice.history.some((entry) => entry.kind === 'provider_item_deleted'),
        ).toBe(false);
        await expect(voice.requestResponse()).rejects.toThrow();
      } finally {
        await voice.close().catch(() => {});
        await reading;
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  15000,
);

nativeIt(
  'executes 1030 sequential native function calls on one voice owner and reuses the caller Session',
  async () => {
    const executed: number[] = [];
    const lookup = tool({
      name: 'retention_lookup',
      parameters: z.object({ index: z.number().int() }),
      execute: ({ index }) => {
        executed.push(index);
        return `accepted result ${index}`;
      },
    });
    const model = new ModelServer([[message('caller Session is reusable')]]);
    const peer = new RealtimePeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Return accepted lookup results.',
        tools: [lookup],
        model: 'gpt-5.5',
        provider,
      }).session();
      const voice = await session.realtime({ model: 'fixture-realtime' });
      const finished = new Set<string>();
      const reading = (async () => {
        for await (const event of voice.events()) {
          if (event.type === 'function_call' && event.status === 'completed')
            finished.add(event.callId);
        }
      })();
      void reading.catch(() => {});
      try {
        const initial = await peer.frame(
          (frame) => frame.type === 'session.update',
        );
        expect(initial.session.tools).toContainEqual(
          expect.objectContaining({ name: 'retention_lookup' }),
        );
        // Cross Core's former 256-call and 1,024-request limits.
        for (let index = 0; index < 1030; index++) {
          const callId = `retention-call-${index}`;
          const after = peer.frames.length;
          peer.call('retention_lookup', { index }, callId);
          await vi.waitFor(
            () => {
              const output = peer.frames
                .slice(after)
                .find(
                  (frame) =>
                    frame.type === 'conversation.item.create' &&
                    frame.item?.type === 'function_call_output' &&
                    frame.item.call_id === callId,
                );
              expect(output?.item.output).toBe(`accepted result ${index}`);
              expect(finished.has(callId)).toBe(true);
            },
            { timeout: 10000, interval: 1 },
          );
        }
        expect(executed).toEqual(Array.from({ length: 1030 }, (_, i) => i));
        expect(
          peer.frames.filter(
            (frame) =>
              frame.type === 'conversation.item.create' &&
              frame.item?.type === 'function_call_output',
          ),
        ).toHaveLength(1030);
        expect(model.requests).toHaveLength(0);
      } finally {
        await voice.close();
        await reading;
      }
      expect(
        (await (await session.submit('continue after voice')).wait())
          .finalOutput,
      ).toBe('caller Session is reusable');
      model.assertExhausted();
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  120000,
);

nativeIt(
  'settles 1030 hosted MCP approvals through the actual native binding without a lifetime cap',
  async () => {
    const model = new ModelServer([[message('caller remains reusable')]]);
    const peer = new RealtimePeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Help the caller.',
        provider,
      }).session();
      const voice = await session.realtime({
        model: 'fixture-realtime',
        settings: {
          hostedMcpTools: [
            {
              serverLabel: 'docs',
              serverUrl: 'https://mcp.example.test/server',
              allowedTools: ['search'],
              requireApproval: 'always',
            },
          ],
        },
      });
      let approval: NativeRealtimeHostedMcpApprovalRequest | undefined;
      const completed = new Set<string>();
      const reading = (async () => {
        for await (const event of voice.events()) {
          if (event.type === 'hosted_mcp_approval_requested') approval = event;
          if (event.type === 'hosted_mcp_call_completed')
            completed.add(event.itemId);
        }
      })();
      void reading.catch(() => {});
      try {
        await peer.frame((frame) => frame.type === 'session.update');
        for (let index = 0; index < 1030; index++) {
          const responseId = `approval-response-${index}`;
          const requestId = `approval-item-${index}`;
          const callId = `denied-call-${index}`;
          approval = undefined;
          const item = {
            type: 'mcp_approval_request',
            id: requestId,
            server_label: 'docs',
            name: 'search',
            arguments: '{}',
          };
          peer.send({ type: 'response.created', response: { id: responseId } });
          peer.send({
            type: 'response.output_item.added',
            response_id: responseId,
            output_index: 0,
            item,
          });
          peer.send({ type: 'conversation.item.done', item });
          peer.send({
            type: 'response.done',
            response: { id: responseId, output: [item] },
          });
          await vi.waitFor(() => expect(approval?.requestId).toBe(requestId), {
            timeout: 10000,
            interval: 1,
          });
          const request = approval as
            NativeRealtimeHostedMcpApprovalRequest | undefined;
          if (!request) throw new Error('Missing native hosted approval');
          const after = peer.frames.length;
          await voice.approveHostedMcp(request, {
            approve: false,
            reason: 'Application decision',
          });
          await vi.waitFor(
            () => {
              expect(peer.frames.slice(after)).toContainEqual(
                expect.objectContaining({
                  type: 'conversation.item.create',
                  previous_item_id: requestId,
                  item: expect.objectContaining({
                    type: 'mcp_approval_response',
                    approval_request_id: requestId,
                    approve: false,
                    reason: 'Application decision',
                  }),
                }),
              );
            },
            { timeout: 10000, interval: 1 },
          );
          // Denial alone is not hosted-call completion. The provider reports its
          // linked terminal call before the next request enters the same owner.
          peer.send({
            type: 'conversation.item.done',
            response_id: responseId,
            item: {
              type: 'mcp_call',
              id: callId,
              server_label: 'docs',
              name: 'search',
              arguments: '{}',
              approval_request_id: requestId,
              status: 'failed',
              error: {
                type: 'permission_error',
                message: 'Application denied the call',
              },
            },
          });
          await vi.waitFor(() => expect(completed.has(callId)).toBe(true), {
            timeout: 10000,
            interval: 1,
          });
          await expect(
            voice.approveHostedMcp(request, { approve: true }),
          ).rejects.toThrow('submitted');
        }
        expect(
          peer.frames.filter(
            (frame) => frame.item?.type === 'mcp_approval_response',
          ),
        ).toHaveLength(1030);
        expect(model.requests).toHaveLength(0);
      } finally {
        await voice.close();
        await reading;
      }
      expect(
        (await (await session.submit('continue after approvals')).wait())
          .finalOutput,
      ).toBe('caller remains reusable');
      model.assertExhausted();
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  120000,
);

nativeIt.each([false, true])(
  'resolves an original voice selector to the same profile replacement (graph=%s)',
  async (graph) => {
    const original = tool({
      name: 'lookup',
      parameters: z.object({}),
      execute: () => 'original',
    });
    const replacement = tool({
      name: 'lookup',
      parameters: z.object({}),
      execute: () => 'replacement',
    });
    const foreign = tool({
      name: 'lookup',
      parameters: z.object({}),
      execute: () => 'foreign',
    });
    const target = new Agent({
      name: 'Other',
      instructions: 'Other profile.',
      tools: [foreign],
    });
    const model = new ModelServer([]);
    const peer = new RealtimePeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        name: 'Owner',
        instructions: 'Use lookup.',
        tools: [original],
        ...(graph ? { handoffs: [target] } : {}),
        provider,
      }).session();
      let voice = await session.realtime({
        model: 'fixture-realtime',
        tools: [original],
      });
      try {
        await session.update({ tools: [replacement] });
        peer.call('lookup', {}, 'updated-selector');
        expect(
          (
            await peer.frame(
              (frame) => frame.item?.call_id === 'updated-selector',
            )
          ).item.output,
        ).toBe('replacement');
        await voice.close();
        await expect(
          session.realtime({ model: 'fixture-realtime', tools: [foreign] }),
        ).rejects.toThrow(/not admitted/);
        voice = await session.realtime({
          model: 'fixture-realtime',
          tools: [original],
        });
        peer.call('lookup', {}, 'reopened-selector');
        expect(
          (
            await peer.frame(
              (frame) => frame.item?.call_id === 'reopened-selector',
            )
          ).item.output,
        ).toBe('replacement');
      } finally {
        await voice.close();
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt(
  'rejects a compact oversized hosted catalog on the provider wire',
  async () => {
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
      peer.send({
        type: 'response.output_item.done',
        response_id: 'catalog-response',
        output_index: 0,
        item: {
          type: 'mcp_list_tools',
          id: 'oversized-catalog',
          server_label: 'docs',
          tools: Array.from({ length: 1025 }, (_, index) => ({
            name: `tool_${index}`,
            input_schema: {},
          })),
        },
      });
      await expect(reading).rejects.toThrow();
      expect(
        seen.some((event) => event.type === 'hosted_mcp_tools_listed'),
      ).toBe(false);
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt.each(['conversation item', 'generic error'] as const)(
  'rejects dense %s JSON at the native wire allocation boundary',
  async (kind) => {
    const model = new ModelServer([]);
    const peer = new RealtimePeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Help the caller.',
        provider,
      }).session();
      const voice = await session.realtime({ model: 'fixture-realtime' });
      let failure: unknown;
      const seen: NativeRealtimeEvent[] = [];
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })().catch((error: unknown) => {
        failure = error;
      });
      try {
        const dense = Array.from({ length: 33_000 }, () => ({}));
        peer.send(
          kind === 'conversation item'
            ? {
                type: 'conversation.item.added',
                item: {
                  id: 'dense-item',
                  type: 'message',
                  role: 'assistant',
                  content: [],
                  metadata: { dense },
                },
              }
            : { type: 'error', error: { dense } },
        );
        await vi.waitFor(() => expect(failure).toBeDefined(), {
          timeout: 2000,
        });
        expect(
          /capacity/.test(String(failure) + String((failure as Error).cause)),
        ).toBe(true);
        expect(
          seen.some(
            (event) =>
              event.type === 'conversation_item' &&
              event.itemId === 'dense-item',
          ),
        ).toBe(false);
      } finally {
        await voice.close().catch(() => {});
        await reading;
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  15000,
);

nativeIt(
  'preserves small generic conversation items and provider errors',
  async () => {
    const model = new ModelServer([]);
    const peer = new RealtimePeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Help the caller.',
        provider,
      }).session();
      const voice = await session.realtime({ model: 'fixture-realtime' });
      const seen: NativeRealtimeEvent[] = [];
      let failure: unknown;
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })().catch((error: unknown) => {
        failure = error;
      });
      try {
        peer.send({
          type: 'conversation.item.added',
          item: {
            id: 'small-item',
            type: 'message',
            role: 'assistant',
            content: [],
          },
        });
        await vi.waitFor(() =>
          expect(
            seen.some(
              (event) =>
                event.type === 'conversation_item' &&
                event.itemId === 'small-item',
            ),
          ).toBe(true),
        );
        peer.send({ type: 'error', error: { code: 'small-provider-error' } });
        await reading;
        expect(String((failure as Error).cause)).toContain(
          'small-provider-error',
        );
      } finally {
        await voice.close().catch(() => {});
        await reading;
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  15000,
);
