import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { Manifest, sandboxEnvironment } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import { Agent, Environment, NativeProvider } from '../../src';
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
  'inherits the text-selected executor through repeated voice updates (child=%s)',
  async (childSelected) => {
    const executor = await startPublicExecutor();
    const selected = childSelected ? 'child-resource' : 'root-resource';
    const model = new ModelServer([
      ...(childSelected
        ? [
            [call('transfer_to_child', {}, { callId: 'resource-transfer' })],
            [message('Child ready.')],
          ]
        : [[message('Root ready.')]]),
      [
        call(
          'exec_command',
          { cmd: 'cat identity.txt', login: false },
          { callId: 'inspect-one' },
        ),
      ],
      [message('First resource inspected.')],
      [
        call(
          'exec_command',
          { cmd: 'cat identity.txt', login: false },
          { callId: 'inspect-two' },
        ),
      ],
      [message('Second resource inspected.')],
    ]);
    const peer = new PolicyPeer(model);
    const paths = new Map<string, string>();
    for (const label of ['root-resource', 'child-resource']) {
      const cwd = join(executor.cwd, label);
      await mkdir(cwd);
      await writeFile(join(cwd, 'identity.txt'), label);
      paths.set(label, cwd);
    }
    const environment = (label: string) => {
      const cwd = paths.get(label)!;
      return new Environment({
        url: executor.url,
        headers: executor.headers,
        cwd,
        writableRoots: [cwd],
        tools: ['exec_command', 'write_stdin'],
      });
    };
    let session: Awaited<ReturnType<Agent['session']>> | undefined;
    await using provider = await providerFor(model);
    try {
      const child = new Agent({
        name: 'child',
        instructions: 'Child.',
        environment: environment('child-resource'),
      });
      const root = new Agent({
        name: 'root',
        instructions: 'Root.',
        model: 'gpt-5.5',
        provider,
        environment: environment('root-resource'),
        handoffs: [child],
      });
      session = await root.session();
      expect(
        (await (await session.submit('Select the text agent.')).wait())
          .finalOutput,
      ).toBe(childSelected ? 'Child ready.' : 'Root ready.');
      const voice = await session.realtime({ model: 'fixture-realtime' });
      try {
        const internal = session as unknown as CoreSession<string, undefined>;
        const current = await internal._realtimeCurrentProfile();
        if (current === null || typeof current.profile_id !== 'string')
          throw new Error('Expected the native text Agent receipt');
        const admit = internal._admitRealtimeGraph.bind(internal);
        for (const invalid of [
          { profile_id: 'foreign-profile', epoch: '0' },
          { profile_id: current.profile_id, epoch: '18446744073709551615' },
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
                }),
              ),
            ).rejects.toThrow();
          } finally {
            admission.mockRestore();
          }
          expect(await internal._realtimeCurrentProfile()).toEqual(current);
        }
        for (const [index, name] of ['voice-one', 'voice-two'].entries()) {
          await voice.updateAgent(
            new Agent({
              name,
              instructions: 'Inspect the inherited resource.',
            }),
          );
          peer.call(
            'background_agent',
            { input_transcript: 'Read identity.txt with exec_command.' },
            name,
          );
          expect(await peer.output(name)).toContain(
            index === 0
              ? 'First resource inspected.'
              : 'Second resource inspected.',
          );
        }
        const starts = executor.requests.filter(
          (request) => request.method === 'process/start',
        );
        expect(starts).toHaveLength(2);
        expect(starts.map((request) => (request.params as Frame).cwd)).toEqual(
          Array(2).fill(pathToFileURL(paths.get(selected)!).href),
        );
        for (const callId of ['inspect-one', 'inspect-two']) {
          const reply = model.requests
            .flatMap((request) => request.input as Frame[])
            .find(
              (item) => item.call_id === callId && item.output !== undefined,
            );
          expect(JSON.stringify(reply?.output)).toContain(selected);
          expect(JSON.stringify(reply?.output)).not.toContain(
            childSelected ? 'root-resource' : 'child-resource',
          );
        }
        expect(await session.getActiveAgent()).toBe(
          childSelected ? child : root,
        );
      } finally {
        await voice.close();
      }
      await session.close();
      session = undefined;
      for (const cwd of paths.values()) await access(join(cwd, 'identity.txt'));
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

it('rejects live sandbox sources before opening Realtime', async () => {
  const model = new ModelServer([]);
  const peer = new PolicyPeer(model);
  await using provider = await providerFor(model);
  const connect = vi.fn(() => {
    throw new Error('Unexpected sandbox acquisition');
  });
  try {
    const child = new Agent({
      name: 'child',
      instructions: 'Child.',
      environment: sandboxEnvironment({
        client: new UnixLocalSandboxClient(),
        manifest: new Manifest({
          entries: {
            'identity.txt': { type: 'file', content: 'child-resource' },
          },
        }),
        connect,
      }),
    });
    await using session = await new Agent({
      instructions: 'Root.',
      model: 'gpt-5.5',
      provider,
      handoffs: [child],
    }).session();
    await expect(
      session.realtime({ model: 'fixture-realtime' }),
    ).rejects.toThrow(
      'Live sandbox capability manifests require text Agent activation',
    );
    expect(connect).not.toHaveBeenCalled();
    expect(peer.frames).toEqual([]);
    expect(model.requests).toEqual([]);
  } finally {
    await peer.close();
    await ModelServer.closeAll();
  }
}, 30000);
