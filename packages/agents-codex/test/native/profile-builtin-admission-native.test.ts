import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { Agent, Environment, NativeProvider, toolRef } from '../../src';
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
async function graphFor(server: ModelServer, cwd: string) {
  const config = await server.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-profile-admission',
    supportsWebsockets: false,
  });
  const child = new Agent({
    name: 'child',
    instructions: 'Use only the child workspace.',
    environment: new Environment({
      url: peer.url,
      headers: peer.headers,
      cwd,
      writableRoots: [cwd],
      tools: ['exec_command'],
    }),
  });
  const root = new Agent({
    name: 'root',
    instructions: 'Transfer to the child.',
    provider,
    model: 'gpt-5.5',
    handoffs: [child],
  });
  return { root, provider };
}
it.each(['omitted', 'explicit step'] as const)(
  'has been advertising child exec after handoff with %s selection',
  async (kind) => {
    const cwd = await mkdtemp(join(tmpdir(), 'sdk-child-admission-'));
    try {
      const server = new ModelServer([
        (request) => {
          expect(JSON.stringify(request.tools)).not.toContain(
            '"name":"exec_command"',
          );
          return [call('transfer_to_child', {}, { callId: 'child-admission' })];
        },
        (request) => {
          expect(JSON.stringify(request.tools)).toContain(
            '"name":"exec_command"',
          );
          return [message('Child sampled.')];
        },
      ]);
      const { root, provider } = await graphFor(server, cwd);
      await using lease = provider;
      await using session = await root.session({ provider: lease });
      const turn = await session.submit(
        'Transfer.',
        kind === 'omitted'
          ? undefined
          : {
              beforeStep: ({ stepIndex }) => [
                toolRef(stepIndex === 0 ? 'transfer_to_child' : 'exec_command'),
              ],
            },
      );
      expect((await turn.wait()).finalOutput).toBe('Child sampled.');
      server.assertExhausted();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
it('has been rejecting an explicit child-only exec selection on the model-only root', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'sdk-root-admission-'));
  try {
    const server = new ModelServer([[message('Unreachable.')]]);
    const { root, provider } = await graphFor(server, cwd);
    await using lease = provider;
    await using session = await root.session({ provider: lease });
    await expect(
      (async () => {
        const turn = await session.submit('Stay at root.', {
          beforeStep: () => [toolRef('exec_command')],
        });
        return turn.wait();
      })(),
    ).rejects.toThrow('beforeStep may only narrow');
    expect(server.requests).toHaveLength(0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('has been rejecting an unadvertised child-only exec call with omitted selection', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'sdk-root-default-denial-'));
  try {
    const server = new ModelServer([
      (request) => {
        expect(JSON.stringify(request.tools)).not.toContain(
          '"name":"exec_command"',
        );
        return [
          call(
            'exec_command',
            { cmd: 'echo root-must-not-execute' },
            { callId: 'root-forbidden-exec' },
          ),
        ];
      },
    ]);
    const { root, provider } = await graphFor(server, cwd);
    await using lease = provider;
    await using session = await root.session({ provider: lease });
    await expect(
      (async () => {
        const turn = await session.submit('Stay at root.', {
          toolNotFoundBehavior: 'raise_error',
        });
        return turn.wait();
      })(),
    ).rejects.toThrow('exec_command');
    expect(server.requests).toHaveLength(1);
    expect(JSON.stringify(peer.requests)).not.toContain(
      'root-must-not-execute',
    );
    server.assertExhausted();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
