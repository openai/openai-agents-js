import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Manifest,
  sandboxEnvironment,
  type SandboxCapability,
  type SandboxSessionLike,
} from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import { Agent, Environment, NativeProvider, tool } from '../../src';
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

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
}
function owned(
  label: string,
  closed: string[],
  failure?: Error,
  capabilities: readonly SandboxCapability[] = [],
) {
  const client = new UnixLocalSandboxClient();
  let cwd = '';
  return {
    cwd: () => cwd,
    source: sandboxEnvironment({
      client,
      capabilities,
      manifest: new Manifest({
        entries: {
          'identity.txt': { type: 'file', content: label },
        },
      }),
      connect: async (sandbox) => {
        cwd = sandbox.state.workspaceRootPath as string;
        if (failure) throw failure;
        return Environment.lease(
          new Environment({
            url: peer.url,
            headers: peer.headers,
            cwd,
            writableRoots: [cwd],
            tools: [
              'exec_command',
              'write_stdin',
              'apply_patch',
              'project_grep',
            ],
          }),
          () => {
            closed.push(label);
          },
        );
      },
    }),
  };
}

it('has been rolling back earlier acquired resources when a later Agent source fails before native sampling', async () => {
  const server = new ModelServer([[message('Unreachable.')]]);
  await using provider = await providerFor(server);
  const closed: string[] = [];
  const first = owned('root-resource', closed);
  const failure = new Error('Destination acquisition failed');
  const second = owned('child-resource', closed, failure);
  const child = new Agent({
    name: 'child',
    instructions: 'Child.',
    environment: second.source,
  });
  const root = new Agent({
    name: 'root',
    instructions: 'Root.',
    provider,
    model: 'gpt-5.5',
    environment: first.source,
    handoffs: [child],
  });
  await expect(root.session()).rejects.toThrow(failure);
  expect(closed).toEqual(['root-resource']);
  expect(server.requests).toHaveLength(0);
  await expect(access(first.cwd())).rejects.toThrow();
  await expect(access(second.cwd())).rejects.toThrow();
});

it('has been retaining both resources until an entered destination callback finishes cancellation cleanup', async () => {
  const server = new ModelServer([
    [call('transfer_to_child', {}, { callId: 'cleanup-transfer' })],
    [call('hold_cleanup', {}, { callId: 'entered-cleanup' })],
  ]);
  await using provider = await providerFor(server);
  const closed: string[] = [];
  const first = owned('root-resource', closed);
  const second = owned('child-resource', closed);
  const entered = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let observed: string | undefined;
  const held = tool({
    name: 'hold_cleanup',
    description: 'Retain entered cleanup.',
    parameters: z.object({}),
    execute: async (_args, context) => {
      entered.resolve();
      await new Promise<void>((resolve) => {
        const abort = () => {
          cleanup.resolve();
          resolve();
        };
        context.signal.addEventListener('abort', abort, { once: true });
        if (context.signal.aborted) abort();
      });
      await release.promise;
      observed = await readFile(join(second.cwd(), 'identity.txt'), 'utf8');
      return 'Late result';
    },
  });
  const child = new Agent({
    name: 'child',
    instructions: 'Child.',
    model: 'gpt-5.5',
    environment: second.source,
    tools: [held],
  });
  const root = new Agent({
    name: 'root',
    instructions: 'Root.',
    model: 'gpt-5.5',
    provider,
    environment: first.source,
    handoffs: [child],
  });
  const session = await root.session();
  try {
    const turn = await session.submit('Transfer and retain cleanup.');
    const result = turn.wait().catch((error: unknown) => error);
    await entered.promise;
    const closing = session.close();
    await cleanup.promise;
    expect(closed).toEqual([]);
    expect(await readFile(join(first.cwd(), 'identity.txt'), 'utf8')).toBe(
      'root-resource',
    );
    expect(await readFile(join(second.cwd(), 'identity.txt'), 'utf8')).toBe(
      'child-resource',
    );
    release.resolve();
    await closing;
    await result;
    expect(observed).toBe('child-resource');
    expect(closed.sort()).toEqual(['child-resource', 'root-resource']);
  } finally {
    release.resolve();
    await session.close();
  }
});

it('has been binding contributed tools to their own resource clones across accepted transfers', async () => {
  const observed: string[] = [];
  const bound: SandboxSessionLike[] = [];
  class Scoped implements SandboxCapability {
    readonly type = 'scoped-probe';
    constructor(readonly label: string) {}
    clone() {
      return new Scoped(this.label);
    }
    prepareManifest(manifest: Manifest) {
      return manifest;
    }
    bind(session: SandboxSessionLike) {
      bound.push(session);
      return this;
    }
    instructions() {
      return 'CAP_OWNER_' + this.label;
    }
    tools() {
      return [
        tool({
          name: 'inspect_scoped',
          description: 'Use this bound resource.',
          parameters: z.object({}),
          execute: async (_args, context) => {
            const text = (
              await context.sandbox!.exec({
                cmd: 'cat identity.txt; printf scoped-effect > capability-effect.txt',
                login: false,
              })
            ).stdout;
            observed.push(this.label + ':' + text);
            return text;
          },
        }),
      ];
    }
  }
  const closed: string[] = [];
  const first = owned('root-resource', closed, undefined, [
    new Scoped('root-resource'),
  ]);
  const second = owned('child-resource', closed, undefined, [
    new Scoped('child-resource'),
  ]);
  const server = new ModelServer([
    [call('inspect_scoped', {}, { callId: 'root-capability' })],
    [call('transfer_to_child', {}, { callId: 'to-child' })],
    [call('inspect_scoped', {}, { callId: 'child-capability' })],
    [call('transfer_to_root', {}, { callId: 'to-root' })],
    [call('inspect_scoped', {}, { callId: 'returned-capability' })],
    [message('Scoped capabilities completed.')],
  ]);
  await using provider = await providerFor(server);
  const child = new Agent({
    name: 'child',
    instructions: 'Child.',
    model: 'gpt-5.5',
    environment: second.source,
    handoffs: [() => root],
  });
  const root: Agent = new Agent({
    name: 'root',
    instructions: 'Root.',
    model: 'gpt-5.5',
    provider,
    environment: first.source,
    handoffs: [child],
  });
  const session = await root.session();
  try {
    expect(
      (await (await session.submit('Use each resource.')).wait()).finalOutput,
    ).toBe('Scoped capabilities completed.');
    expect(observed).toEqual([
      'root-resource:root-resource',
      'child-resource:child-resource',
      'root-resource:root-resource',
    ]);
    expect(bound).toHaveLength(2);
    expect(bound[0]).not.toBe(bound[1]);
    expect(
      await readFile(join(first.cwd(), 'capability-effect.txt'), 'utf8'),
    ).toBe('scoped-effect');
    expect(
      await readFile(join(second.cwd(), 'capability-effect.txt'), 'utf8'),
    ).toBe('scoped-effect');
    expect(JSON.stringify(server.requests[0].input)).toContain(
      'CAP_OWNER_root-resource',
    );
    expect(JSON.stringify(server.requests[2].input)).toContain(
      'CAP_OWNER_child-resource',
    );
    expect(JSON.stringify(server.requests[4].input)).toContain(
      'CAP_OWNER_root-resource',
    );
    server.assertExhausted();
  } finally {
    await session.close();
  }
  expect(closed.sort()).toEqual(['child-resource', 'root-resource']);
});

it('has been projecting the issuing destination resource into a configured SDK child', async () => {
  const server = new ModelServer([
    [call('transfer_to_child', {}, { callId: 'to-child' })],
    [
      call(
        'configured_worker',
        { input: 'Search identity.' },
        { callId: 'configured-call' },
      ),
    ],
    [
      call(
        'project_grep',
        { pattern: 'child-resource' },
        { callId: 'worker-grep' },
      ),
    ],
    [message('Worker searched destination.')],
    [message('Configured child completed.')],
  ]);
  await using provider = await providerFor(server);
  const closed: string[] = [];
  const first = owned('root-resource', closed);
  const second = owned('child-resource', closed);
  const worker = new Agent({
    instructions: 'Search the inherited resource.',
    model: 'gpt-5.5',
    provider,
  });
  const configured = worker.asTool({ toolName: 'configured_worker' });
  const child = new Agent({
    name: 'child',
    instructions: 'Call the worker.',
    model: 'gpt-5.5',
    environment: second.source,
    tools: [configured],
  });
  const root = new Agent({
    name: 'root',
    instructions: 'Transfer.',
    model: 'gpt-5.5',
    provider,
    environment: first.source,
    tools: [configured],
    handoffs: [child],
  });
  const session = await root.session();
  try {
    expect(
      (await (await session.submit('Transfer and search.')).wait()).finalOutput,
    ).toBe('Configured child completed.');
    const output = (
      server.requests[3].input as { call_id?: string; output?: unknown }[]
    ).find(
      (row) => row.call_id === 'worker-grep' && row.output !== undefined,
    )?.output;
    expect(JSON.stringify(output)).toContain('child-resource');
    expect(JSON.stringify(output)).not.toContain('root-resource');
    server.assertExhausted();
  } finally {
    await session.close();
  }
  expect(closed.sort()).toEqual(['child-resource', 'root-resource']);
});
