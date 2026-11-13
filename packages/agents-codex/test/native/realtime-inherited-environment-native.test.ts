import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { Manifest, sandboxEnvironment } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import { Agent, Environment, NativeProvider, tool } from '../../src';
import type { Session as CoreSession } from '../../src/runtime/session';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

type Frame = Record<string, any>;
class PolicyPeer {
  readonly frames: Frame[] = [];
  private readonly server = new WebSocketServer({ noServer: true });
  private socket?: WebSocket;
  readonly disconnected = Promise.withResolvers<void>();
  constructor(model: ModelServer) {
    model.onUpgrade((request, transport, head) => {
      this.server.handleUpgrade(request, transport, head, (connection) =>
        this.server.emit('connection', connection, request),
      );
    });
    this.server.on('connection', (connection) => {
      this.socket = connection;
      connection.once('close', () => this.disconnected.resolve());
      const accepted: Frame = {};
      connection.on('message', (raw) => {
        const frame: Frame = JSON.parse(raw.toString());
        this.frames.push(frame);
        if (frame.type === 'session.update') {
          merge(accepted, frame.session);
          this.send({
            type: 'session.updated',
            session: { ...structuredClone(accepted), id: 'policy-session' },
          });
        } else if (frame.type === 'response.create') {
          const id = `continuation-${this.frames.length}`;
          this.send({ type: 'response.created', response: { id } });
          this.send({ type: 'response.done', response: { id, output: [] } });
        }
      });
    });
  }
  send(frame: Frame): void {
    if (!this.socket) throw new Error('Provider is not connected');
    this.socket.send(JSON.stringify(frame));
  }
  call(name: string, args: Frame | string, callId: string): string {
    return this.calls([[name, args, callId]], `response-${callId}`);
  }
  calls(
    calls: [string, Frame | string, string][],
    responseId: string,
    start = true,
  ): string {
    const items = calls.map(([name, args, callId]) => ({
      id: `item-${callId}`,
      type: 'function_call',
      name,
      call_id: callId,
      // Already-encoded provider arguments for string inputs.
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    }));
    if (start)
      this.send({ type: 'response.created', response: { id: responseId } });
    items.forEach((item, output_index) =>
      this.send({
        type: 'response.output_item.done',
        response_id: responseId,
        output_index,
        item,
      }),
    );
    this.send({
      type: 'response.done',
      response: { id: responseId, output: items },
    });
    return responseId;
  }
  async output(callId: string): Promise<string> {
    let result: Frame | undefined;
    await vi.waitFor(
      () => {
        result = this.frames.find(
          (frame) =>
            frame.type === 'conversation.item.create' &&
            frame.item?.type === 'function_call_output' &&
            frame.item.call_id === callId,
        );
        expect(result).toBeDefined();
      },
      { timeout: 10000 },
    );
    return result!.item.output;
  }
  async close(): Promise<void> {
    for (const socket of this.server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
function merge(current: Frame, update: Frame): void {
  for (const [key, value] of Object.entries(update)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current[key] &&
      typeof current[key] === 'object' &&
      !Array.isArray(current[key])
    )
      merge(current[key], value);
    else current[key] = structuredClone(value);
  }
}
async function providerFor(model: ModelServer): Promise<NativeProvider> {
  const config = await model.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-native-policy',
    supportsWebsockets: false,
  });
}

it.each([false, true])(
  'inherits the text-selected resource through repeated voice updates (child=%s)',
  async (childSelected) => {
    const executor = await startPublicExecutor();
    const model = new ModelServer(
      childSelected
        ? [
            [call('transfer_to_child', {}, { callId: 'resource-transfer' })],
            [message('Child ready.')],
          ]
        : [[message('Root ready.')]],
    );
    const peer = new PolicyPeer(model);
    const closed: string[] = [];
    const paths = new Map<string, string>();
    const source = (label: string) =>
      sandboxEnvironment({
        client: new UnixLocalSandboxClient(),
        manifest: new Manifest({
          entries: { 'identity.txt': { type: 'file', content: label } },
        }),
        connect: async (sandbox) => {
          const cwd = sandbox.state.workspaceRootPath as string;
          paths.set(label, cwd);
          return Environment.lease(
            new Environment({
              url: executor.url,
              headers: executor.headers,
              cwd,
              writableRoots: [cwd],
              tools: ['exec_command', 'write_stdin'],
            }),
            () => {
              closed.push(label);
            },
          );
        },
      });
    let session: Awaited<ReturnType<Agent['session']>> | undefined;
    await using provider = await providerFor(model);
    try {
      const child = new Agent({
        name: 'child',
        instructions: 'Child.',
        environment: source('child-resource'),
      });
      const root = new Agent({
        name: 'root',
        instructions: 'Root.',
        model: 'gpt-5.5',
        provider,
        environment: source('root-resource'),
        handoffs: [child],
      });
      session = await root.session();
      expect(
        (await (await session.submit('Select the text agent.')).wait())
          .finalOutput,
      ).toBe(childSelected ? 'Child ready.' : 'Root ready.');
      const observed: string[] = [];
      const inspect = tool({
        name: 'inspect_resource',
        description: 'Inspect this resource.',
        parameters: z.object({}),
        execute: async (_args, context) => {
          const text = (
            await context.sandbox!.exec({
              cmd: 'cat identity.txt',
              login: false,
            })
          ).stdout;
          observed.push(text);
          return text;
        },
      });
      const voice = await session.realtime({ model: 'fixture-realtime' });
      try {
        const internal = session as unknown as CoreSession<string, undefined>;
        const current = await internal._realtimeCurrentProfile();
        expect(current).not.toBeNull();
        const admit = internal._admitRealtimeGraph.bind(internal);
        for (const invalid of [
          { profile_id: 'foreign-profile', epoch: '0' },
          { ...current!, epoch: '18446744073709551615' },
        ]) {
          const admission = vi
            .spyOn(internal, '_admitRealtimeGraph')
            .mockImplementationOnce((generation, agent) =>
              admit(generation, agent, invalid),
            );
          try {
            await expect(
              voice.updateAgent(
                new Agent({
                  instructions: 'Rejected resource selection.',
                  tools: [inspect],
                }),
              ),
            ).rejects.toThrow();
          } finally {
            admission.mockRestore();
          }
          expect(await internal._realtimeCurrentProfile()).toEqual(current);
        }
        for (const name of ['voice-one', 'voice-two']) {
          await voice.updateAgent(
            new Agent({
              name,
              instructions: 'Inspect the inherited resource.',
              tools: [inspect],
            }),
          );
          peer.call('inspect_resource', {}, name);
          expect(await peer.output(name)).toContain(
            childSelected ? 'child-resource' : 'root-resource',
          );
        }
        expect(observed.map((value) => value.trim())).toEqual(
          Array(2).fill(childSelected ? 'child-resource' : 'root-resource'),
        );
      } finally {
        await voice.close();
      }
      expect(closed).toEqual([]);
      for (const cwd of paths.values()) await access(join(cwd, 'identity.txt'));
      await session.close();
      session = undefined;
      expect(closed.sort()).toEqual(['child-resource', 'root-resource']);
      model.assertExhausted();
    } finally {
      await session?.close();
      await peer.close();
      await executor.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);
