import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { Agent, Environment, localStorage, NativeProvider } from '../../src';
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
    apiKey: 'synthetic-durable-graph',
    supportsWebsockets: false,
  });
}

function graph(
  provider: NativeProvider,
  rootPath: string,
  childPath: string,
  mode:
    | 'unchanged'
    | 'changed-child-grants'
    | 'changed-root-grants'
    | 'changed-child-tools'
    | 'changed-child-instructions'
    | 'missing-child',
) {
  // Reconstruct every public declaration. Native registrations must be fresh;
  // durable data cannot reconnect the old process-local environment IDs.
  const environment = (
    cwd: string,
    readOnly = false,
    tools: ('project_grep' | 'project_glob')[] = ['project_grep'],
  ) =>
    new Environment({
      url: peer.url,
      headers: peer.headers,
      cwd,
      ...(readOnly ? {} : { writableRoots: [cwd] }),
      readOnly,
      tools,
    });
  const child = new Agent({
    name: 'child',
    instructions:
      mode === 'changed-child-instructions'
        ? 'Changed child instructions.'
        : 'Use the child resource.',
    model: 'gpt-5.5',
    environment: environment(
      childPath,
      mode === 'changed-child-grants',
      mode === 'changed-child-tools' ? ['project_glob'] : ['project_grep'],
    ),
    handoffs: [() => root],
  });
  const root: Agent = new Agent({
    name: 'root',
    instructions: 'Use the root resource.',
    model: 'gpt-5.5',
    provider,
    environment: environment(rootPath, mode === 'changed-root-grants'),
    handoffs: mode === 'missing-child' ? [] : [child],
  });
  return root;
}

function expectRead(
  server: ModelServer,
  index: number,
  callId: string,
  line: string,
) {
  const input = server.requests[index]!.input;
  if (!Array.isArray(input)) throw new Error('Expected native model input.');
  const reply = input.find(
    (item) =>
      item !== null &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      item.type === 'function_call_output' &&
      item.call_id === callId,
  );
  if (
    !reply ||
    typeof reply !== 'object' ||
    Array.isArray(reply) ||
    typeof reply.output !== 'string'
  )
    throw new Error('Expected the exact native search reply.');
  expect(JSON.parse(reply.output)).toMatchObject({
    errors: [],
    matches: [{ line, path: 'identity.txt' }],
    truncated: false,
  });
}

it.each([
  'unchanged',
  'changed-child-grants',
  'changed-root-grants',
  'changed-child-tools',
  'changed-child-instructions',
  'missing-child',
] as const)(
  'has been reopening durable active-child history with fresh graph authority: %s',
  async (mode) => {
    const home = await mkdtemp(join(tmpdir(), 'native-durable-agent-graph-'));
    const rootPath = join(home, 'root');
    const childPath = join(home, 'child');
    await mkdir(rootPath);
    await mkdir(childPath);
    await writeFile(join(rootPath, 'identity.txt'), 'root-resource');
    await writeFile(join(childPath, 'identity.txt'), 'child-resource');
    const server = new ModelServer([
      [call('transfer_to_child', {}, { callId: 'durable-to-child' })],
      [
        call(
          'project_grep',
          { pattern: 'resource', path: '.' },
          { callId: 'durable-child-before', namespace: 'functions' },
        ),
      ],
      [message('Child history recorded.')],
      [
        call(
          'project_grep',
          { pattern: 'resource', path: '.' },
          { callId: 'durable-child-after', namespace: 'functions' },
        ),
      ],
      [call('transfer_to_root', {}, { callId: 'durable-to-root' })],
      [
        call(
          'project_grep',
          { pattern: 'resource', path: '.' },
          { callId: 'durable-root-after', namespace: 'functions' },
        ),
      ],
      [message('Fresh graph resumed.')],
    ]);
    const storage = localStorage(join(home, 'history'));
    try {
      let id: string;
      {
        await using provider = await providerFor(server);
        const source = graph(provider, rootPath, childPath, 'unchanged');
        await using session = await source.session({ storage });
        id = session.id;
        expect(
          (await (await session.submit('Transfer to child.')).wait())
            .finalOutput,
        ).toBe('Child history recorded.');
      }
      expectRead(server, 2, 'durable-child-before', 'child-resource');
      expect(server.requests).toHaveLength(3);
      const starts = peer.requests.filter(
        (row) => row.method === 'process/start',
      ).length;
      await using currentProvider = await providerFor(server);
      const current = graph(currentProvider, rootPath, childPath, mode);
      if (mode !== 'unchanged') {
        await expect(current.session({ storage, resume: id })).rejects.toThrow(
          mode === 'changed-child-instructions'
            ? /exact captured Agent declaration graph/
            : /recorded Agent environment grants/,
        );
        expect(server.requests).toHaveLength(3);
        expect(
          peer.requests.filter((row) => row.method === 'process/start'),
        ).toHaveLength(starts);
        return;
      }
      await using restored = await current.session({ storage, resume: id });
      expect(
        (await (await restored.submit('Continue, then return to root.')).wait())
          .finalOutput,
      ).toBe('Fresh graph resumed.');
      expectRead(server, 4, 'durable-child-after', 'child-resource');
      expectRead(server, 6, 'durable-root-after', 'root-resource');
      server.assertExhausted();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
