import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { Agent, Environment, NativeProvider } from '../../src';
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

it('has been leaving an unvisited failing destination source unprepared', async () => {
  const server = new ModelServer([
    [message('Root completed without transfer.')],
  ]);
  await using provider = await providerFor(server);
  let preparations = 0;
  const destination = new Agent({
    name: 'unvisited',
    instructions: 'Unvisited destination.',
    environment: async () => {
      preparations++;
      throw new Error('Unused destination preparation failed');
    },
  });
  const root = new Agent({
    name: 'root',
    instructions: 'Complete without transferring.',
    model: 'gpt-5.5',
    provider,
    handoffs: [destination],
  });
  await using session = await root.session();
  expect((await (await session.submit('Complete.')).wait()).finalOutput).toBe(
    'Root completed without transfer.',
  );
  expect(preparations).toBe(0);
  server.assertExhausted();
});

it('has been preparing the admitted destination once and rebinding it on portable restore', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'sdk-lazy-destination-'));
  try {
    const server = new ModelServer([
      [call('transfer_to_visited', {}, { callId: 'visit-source' })],
      [message('Destination admitted.')],
      [message('Destination restored.')],
    ]);
    await using provider = await providerFor(server);
    let preparations = 0;
    let disposals = 0;
    let unused = 0;
    const visited = new Agent({
      name: 'visited',
      instructions: 'Selected destination.',
      environment: async () => {
        preparations++;
        return Environment.lease(
          new Environment({
            url: peer.url,
            headers: peer.headers,
            cwd,
            readOnly: true,
            tools: [],
          }),
          () => {
            disposals++;
          },
        );
      },
    });
    const unvisited = new Agent({
      name: 'unused',
      instructions: 'Unused destination.',
      environment: async () => {
        unused++;
        throw new Error('Unused source');
      },
    });
    const root = new Agent({
      name: 'root',
      instructions: 'Transfer to the selected destination.',
      provider,
      model: 'gpt-5.5',
      handoffs: [visited, unvisited],
    });
    const session = await root.session();
    expect(preparations).toBe(0);
    expect((await (await session.submit('Transfer.')).wait()).finalOutput).toBe(
      'Destination admitted.',
    );
    expect(await session.getActiveAgent()).toBe(visited);
    expect(preparations).toBe(1);
    const state = await session.saveState();
    await session.close();
    expect(disposals).toBe(1);
    await using restored = await root.session({ state });
    expect(preparations).toBe(2);
    expect(await restored.getActiveAgent()).toBe(visited);
    expect(
      (await (await restored.submit('Continue.')).wait()).finalOutput,
    ).toBe('Destination restored.');
    expect(unused).toBe(0);
    server.assertExhausted();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('has been retaining cancelled Source cleanup and disposing a late lease once', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'sdk-cancelled-destination-'));
  try {
    const server = new ModelServer([
      [call('transfer_to_child', {}, { callId: 'cancel-source' })],
    ]);
    await using provider = await providerFor(server);
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let disposals = 0;
    const child = new Agent({
      name: 'child',
      instructions: 'Child.',
      environment: async ({ signal }) => {
        signal.addEventListener('abort', () => aborted.resolve(), {
          once: true,
        });
        entered.resolve();
        await release.promise;
        return Environment.lease(
          new Environment({
            url: peer.url,
            headers: peer.headers,
            cwd,
            readOnly: true,
            tools: [],
          }),
          () => {
            disposals++;
          },
        );
      },
    });
    const root = new Agent({
      name: 'root',
      instructions: 'Transfer.',
      provider,
      model: 'gpt-5.5',
      handoffs: [child],
    });
    const session = await root.session();
    try {
      const turn = await session.submit('Transfer.');
      const result = turn.wait().catch((error: unknown) => error);
      await entered.promise;
      const cancelled = turn.cancel();
      await aborted.promise;
      let closed = false;
      const closing = session.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(disposals).toBe(0);
      release.resolve();
      await closing;
      await cancelled;
      expect(await result).toBeInstanceOf(Error);
      expect(disposals).toBe(1);
      expect(server.requests).toHaveLength(1);
    } finally {
      release.resolve();
      await session.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('has been cancelling idle destination preparation while joining its late lease', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'sdk-idle-destination-'));
  try {
    const server = new ModelServer([]);
    await using provider = await providerFor(server);
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let disposals = 0;
    const child = new Agent({
      name: 'child',
      instructions: 'Child.',
      environment: async ({ signal }) => {
        signal.addEventListener('abort', () => aborted.resolve(), {
          once: true,
        });
        entered.resolve();
        await release.promise;
        return Environment.lease(
          new Environment({
            url: peer.url,
            headers: peer.headers,
            cwd,
            readOnly: true,
            tools: [],
          }),
          () => {
            disposals++;
          },
        );
      },
    });
    const root = new Agent({
      name: 'root',
      instructions: 'Root.',
      provider,
      model: 'gpt-5.5',
      handoffs: [child],
    });
    const session = await root.session();
    try {
      const update = session
        .update({ agent: child })
        .catch((error: unknown) => error);
      await entered.promise;
      let closed = false;
      const closing = session.close().then(() => {
        closed = true;
      });
      await aborted.promise;
      expect(closed).toBe(false);
      expect(disposals).toBe(0);
      release.resolve();
      expect(await update).toBeInstanceOf(Error);
      await closing;
      expect(disposals).toBe(1);
      expect(server.requests).toHaveLength(0);
    } finally {
      release.resolve();
      await session.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('has been restoring an eager resource receipt through a current Source declaration', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'sdk-eager-source-restore-'));
  try {
    const server = new ModelServer([
      [call('transfer_to_child', {}, { callId: 'legacy-resource' })],
      [message('Legacy destination.')],
      [message('Legacy destination restored.')],
    ]);
    await using provider = await providerFor(server);
    const environment = new Environment({
      url: peer.url,
      headers: peer.headers,
      cwd,
      readOnly: true,
      tools: [],
    });
    let preparations = 0;
    const graph = (deferred: boolean) => {
      const child = new Agent({
        name: 'child',
        instructions: 'Child resource.',
        environment: deferred
          ? async () => {
              preparations++;
              return Environment.lease(environment, () => {});
            }
          : environment,
      });
      return new Agent({
        name: 'root',
        instructions: 'Transfer to child.',
        provider,
        model: 'gpt-5.5',
        handoffs: [child],
      });
    };
    const original = await graph(false).session();
    let state;
    try {
      expect(
        (await (await original.submit('Transfer.')).wait()).finalOutput,
      ).toBe('Legacy destination.');
      state = await original.saveState();
    } finally {
      await original.close();
    }
    await using restored = await graph(true).session({ state });
    expect(preparations).toBe(1);
    expect(
      (await (await restored.submit('Continue.')).wait()).finalOutput,
    ).toBe('Legacy destination restored.');
    server.assertExhausted();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
