import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Manifest,
  sandboxEnvironment,
  type SandboxCapability,
  type SandboxSessionLike,
} from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import {
  Agent,
  Environment,
  Handoff,
  NativeProvider,
  tool,
  type ModelSettings,
  type ModelRequestContext,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

let peer: Awaited<ReturnType<typeof startPublicExecutor>>;
beforeAll(async () => {
  peer = await startPublicExecutor();
});
afterAll(async () => {
  await peer?.close();
});
afterEach(() => ModelServer.closeAll());

it.each(['plain', 'callback', 'resolver'] as const)(
  'has been retaining distinct bound capability contributions across an accepted transfer and return: %s',
  async (kind) => {
    const bindings: Contribution[] = [];
    const effects: number[] = [];
    let resolutions = 0;
    let handoffCallbacks = 0;
    const route = tool({
      name: 'route_bound',
      description: 'Accept the captured transfer.',
      parameters: z.object({}),
      execute: () => {
        handoffCallbacks++;
        return 'accepted';
      },
    });
    class Contribution implements SandboxCapability {
      readonly type = 'profile-probe';
      bound?: SandboxSessionLike;
      index = -1;
      clone() {
        return new Contribution();
      }
      prepareManifest(manifest: Manifest) {
        return new Manifest({
          ...manifest,
          entries: {
            ...manifest.entries,
            'shared.txt': { type: 'file', content: 'same-owned-resource' },
          },
        });
      }
      bind(session: SandboxSessionLike) {
        this.bound = session;
        this.index = bindings.length;
        bindings.push(this);
        return this;
      }
      instructions() {
        return 'CAP_INSTRUCTION_LEASE_' + this.index;
      }
      tools() {
        return [
          tool({
            name: 'read_shared',
            description: 'Read the currently bound resource.',
            parameters: z.object({}),
            execute: async (_args, context) => {
              effects.push(this.index);
              return (
                await context.sandbox!.exec({
                  cmd: 'cat shared.txt',
                  login: false,
                })
              ).stdout;
            },
          }),
        ];
      }
      samplingSettings(settings: ModelSettings): ModelSettings {
        return { metadata: { ...settings.metadata, capability: 'current' } };
      }
      transformContext(context: ModelRequestContext) {
        return [
          ...context.items,
          {
            type: 'message',
            role: 'developer',
            content: [
              { type: 'input_text', text: 'CAP_CONTEXT_LEASE_' + this.index },
            ],
          },
        ];
      }
    }
    const server = new ModelServer([
      [call('read_shared', {}, { callId: 'root-read' })],
      [
        call(
          kind === 'callback' ? 'route_bound' : 'transfer_to_receiver',
          {},
          { callId: 'transfer' },
        ),
      ],
      [call('read_shared', {}, { callId: 'receiver-read' })],
      [message('receiver done')],
      [call('read_shared', {}, { callId: 'root-return-read' })],
      [message('root done')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic',
      supportsWebsockets: false,
    });
    const receiver = new Agent({
      name: 'receiver',
      instructions: 'Receiver instructions.',
      model: 'gpt-5.5',
      modelSettings: { metadata: { profile: 'receiver' } },
    });
    const root = new Agent({
      name: 'root',
      instructions: 'Root instructions.',
      provider,
      model: 'gpt-5.5',
      modelSettings: { metadata: { profile: 'root' } },
      tools: kind === 'callback' ? [route] : [],
      handoffs: [
        kind === 'callback'
          ? new Handoff(receiver, route)
          : kind === 'resolver'
            ? () => {
                resolutions++;
                return receiver;
              }
            : receiver,
      ],
    });
    const source = sandboxEnvironment({
      client: new UnixLocalSandboxClient(),
      manifest: new Manifest(),
      capabilities: [new Contribution()],
      connect: async (sandbox) =>
        Environment.lease(
          new Environment({
            url: peer.url,
            headers: peer.headers,
            cwd: sandbox.state.workspaceRootPath as string,
            tools: [],
          }),
          () => {},
        ),
    });
    await using session = await root.session({ environment: source });
    expect(
      (await (await session.submit('Read the resource and transfer.')).wait())
        .finalOutput,
    ).toBe('receiver done');
    expect(JSON.stringify(await session.saveState())).toContain(
      'CAP_INSTRUCTION_LEASE_1',
    );
    await session.update({ agent: root });
    expect(
      (await (await session.submit('Read after returning.')).wait())
        .finalOutput,
    ).toBe('root done');
    expect(resolutions).toBe(kind === 'resolver' ? 1 : 0);
    expect(handoffCallbacks).toBe(kind === 'callback' ? 1 : 0);
    expect(bindings).toHaveLength(2);
    expect(bindings[0]).not.toBe(bindings[1]);
    expect(bindings[0].bound).toBe(bindings[1].bound);
    expect(effects).toEqual([0, 1, 0]);
    for (const [index, request] of server.requests.entries()) {
      expect(request.metadata).toEqual({
        profile: index === 2 || index === 3 ? 'receiver' : 'root',
        capability: 'current',
      });
      expect(JSON.stringify(request.input)).toContain(
        'CAP_CONTEXT_LEASE_' + (index === 2 || index === 3 ? '1' : '0'),
      );
    }
    server.assertExhausted();
  },
);
