import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { NativeProvider } from '../../src';
import type { CallToolResult } from '@openai/agents/classic';
import { ReportServer, openReportSession } from '../../examples/mcp-reports';
import { ModelServer, call, message } from './fixtures/model-server';

const releases: Array<() => void> = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  await ModelServer.closeAll();
  if (failures.length)
    throw new AggregateError(failures, 'Report cleanup failed');
});

function gate() {
  const result = Promise.withResolvers<void>();
  releases.push(result.resolve);
  return result;
}

async function reportPeer(result: () => Promise<CallToolResult>) {
  let calls = 0;
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
      let value;
      if (rpc.method === 'initialize') {
        value = {
          protocolVersion: rpc.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'reports', version: '1' },
        };
      } else if (rpc.method === 'tools/list') {
        value = {
          tools: [
            { name: 'report', inputSchema: { type: 'object', properties: {} } },
          ],
        };
      } else if (rpc.method === 'tools/call') {
        calls++;
        value = await result();
      } else value = {};
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: value }),
      );
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing peer port');
  cleanups.push(async () => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
    expect(failures).toEqual([]);
  });
  return { url: `http://127.0.0.1:${address.port}/mcp`, calls: () => calls };
}

async function connectReportServer(
  peer: Awaited<ReturnType<typeof reportPeer>>,
  resolve: ConstructorParameters<typeof ReportServer>[2] = async (result) =>
    result,
) {
  const owner = Symbol('authenticated owner');
  const server = new ReportServer(peer.url, owner, resolve);
  cleanups.push(() => server.close());
  await server.connect();
  return { server, owner };
}

async function reportSession(server: ReportServer, model: ModelServer) {
  const config = await model.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-report-provider',
    supportsWebsockets: false,
  });
  cleanups.push(() => provider.close());
  const session = await openReportSession(server, provider);
  cleanups.push(() => session.close());
  return session;
}

const reportText =
  'Quarterly revenue grew. ' + 'detail '.repeat(900) + 'PRIVATE_TAIL';
const image = {
  type: 'image' as const,
  mimeType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
};

it.each(['mixed', 'structured-only'] as const)(
  'awaits peer and application resolution before bounded model/caller consumption (%s)',
  async (shape) => {
    const peerEntered = gate();
    const peerRelease = gate();
    const resolverEntered = gate();
    const resolverRelease = gate();
    const peer = await reportPeer(async () => {
      peerEntered.resolve();
      await peerRelease.promise;
      return { content: [{ type: 'text', text: 'report pending' }] };
    });
    const original: CallToolResult = {
      content:
        shape === 'mixed' ? [{ type: 'text', text: reportText }, image] : [],
      structuredContent: { title: 'Quarterly overview', body: reportText },
    };
    let resolutions = 0;
    const { server, owner } = await connectReportServer(peer, async () => {
      resolutions++;
      resolverEntered.resolve();
      await resolverRelease.promise;
      return original;
    });
    const model = new ModelServer([
      [call('report', {}, { callId: 'report-1', namespace: 'reports' })],
      (request) => {
        const input = JSON.stringify(request.input);
        expect(input).toContain('Quarterly');
        expect(input).toContain('overview');
        expect(input).toContain(server.references(owner)[0]);
        expect(input).not.toContain('PRIVATE_TAIL');
        if (shape === 'mixed') expect(input).toContain(image.data);
        return [message('Report ready.')];
      },
    ]);
    const session = await reportSession(server, model);
    const done = (await session.submit('Request the report.')).wait();
    await peerEntered.promise;
    expect(model.requests).toHaveLength(1);
    expect(server.references(owner)).toEqual([]);
    peerRelease.resolve();
    await resolverEntered.promise;
    expect(model.requests).toHaveLength(1);
    expect(server.references(owner)).toEqual([]);
    resolverRelease.resolve();
    expect((await done).finalOutput).toBe('Report ready.');
    expect(peer.calls()).toBe(1);
    expect(resolutions).toBe(1);
    const [reference] = server.references(owner);
    expect(reference).toMatch(/^[a-f0-9-]{36}$/);
    expect(server.read(owner, reference)).toEqual(original);
    expect(() => server.read(Symbol('different owner'), reference)).toThrow(
      'owner',
    );
    server.read(owner, reference).content.length = 0;
    expect(server.read(owner, reference)).toEqual(original);
    const history = [];
    for await (const item of session.items()) history.push(item);
    expect(JSON.stringify(history)).toContain(reference);
    expect(JSON.stringify(history)).not.toContain('PRIVATE_TAIL');
    await session.close();
    // A successful turn's signal is also aborted: references must survive it.
    expect(server.read(owner, reference)).toEqual(original);
    await server.close();
    expect(() => server.read(owner, reference)).toThrow('unavailable');
  },
  30_000,
);

it('does not publish a late resolver result after interruption', async () => {
  const entered = gate();
  const aborted = gate();
  const release = gate();
  const peer = await reportPeer(async () => ({
    content: [{ type: 'text', text: 'pending' }],
  }));
  const { server, owner } = await connectReportServer(
    peer,
    async (_result, signal) => {
      signal!.addEventListener('abort', () => aborted.resolve(), {
        once: true,
      });
      entered.resolve();
      await release.promise; // Deliberately ignores cancellation until it settles.
      return { content: [{ type: 'text', text: reportText }] };
    },
  );
  const model = new ModelServer([
    [call('report', {}, { callId: 'cancel-report', namespace: 'reports' })],
  ]);
  const session = await reportSession(server, model);
  const done = (await session.submit('Request the report.')).wait();
  const rejected = expect(done).rejects.toThrow();
  await entered.promise;
  const interrupted = session.interrupt({ scope: 'all' });
  await aborted.promise;
  release.resolve();
  await interrupted;
  await rejected;
  expect(model.requests).toHaveLength(1);
  expect(peer.calls()).toBe(1);
  expect(server.references(owner)).toEqual([]);
}, 30_000);

it('preserves media and text slots while replacing both oversized result fields', async () => {
  const original: CallToolResult = {
    content: [
      { type: 'text', text: reportText },
      image,
      { type: 'text', text: 'last slot' },
    ],
    structuredContent: { title: 'Quarterly report', body: reportText },
  };
  const peer = await reportPeer(async () => original);
  const { server, owner } = await connectReportServer(peer);
  const result = await server.callToolResult('report', {});
  expect(result.content.map((block) => block.type)).toEqual([
    'text',
    'image',
    'text',
  ]);
  expect(result.content[1]).toEqual(image);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(4096);
  expect(JSON.stringify(result)).not.toContain('PRIVATE_TAIL');
  expect(result.structuredContent?.reference).toBe(server.references(owner)[0]);
  expect(server.read(owner, server.references(owner)[0])).toEqual(original);
});

it('stores neither peer errors nor failed application resolution', async () => {
  let resolveCalls = 0;
  let peerError = true;
  const peer = await reportPeer(async () => ({
    content: [{ type: 'text', text: 'failed report' }],
    isError: peerError,
  }));
  const { server, owner } = await connectReportServer(peer, async () => {
    resolveCalls++;
    throw new Error('Application resolution failed');
  });
  expect((await server.callToolResult('report', {})).isError).toBe(true);
  expect(resolveCalls).toBe(0);
  peerError = false;
  await expect(server.callToolResult('report', {})).rejects.toThrow(
    'resolution failed',
  );
  expect(server.references(owner)).toEqual([]);
  expect(peer.calls()).toBe(2);
  expect(resolveCalls).toBe(1);
});

it('fences a pending resolver when its owner closes the server', async () => {
  const entered = gate();
  const release = gate();
  const peer = await reportPeer(async () => ({
    content: [{ type: 'text', text: 'pending' }],
  }));
  const { server, owner } = await connectReportServer(peer, async () => {
    entered.resolve();
    await release.promise;
    return { content: [{ type: 'text', text: reportText }] };
  });
  const call = server.callToolResult('report', {});
  const rejected = expect(call).rejects.toThrow('unavailable');
  await entered.promise;
  await server.close();
  release.resolve();
  await rejected;
  expect(() => server.references(owner)).toThrow('unavailable');
});

it.each([
  ['entry', 4, 6000],
  ['byte', 2, 60000],
] as const)(
  'rejects %s capacity without expiring an advertised reference',
  async (_kind, count, length) => {
    const original: CallToolResult = {
      content: [{ type: 'text', text: 'x'.repeat(length) }],
    };
    const peer = await reportPeer(async () => original);
    const { server, owner } = await connectReportServer(peer);
    for (let i = 0; i < count; i++) await server.callToolResult('report', {});
    const references = server.references(owner);
    await expect(server.callToolResult('report', {})).rejects.toThrow(
      'storage limit',
    );
    expect(server.references(owner)).toEqual(references);
    for (const reference of references)
      expect(server.read(owner, reference)).toEqual(original);
  },
);

it.each([
  ['report size', [{ type: 'text', text: 'x'.repeat(65 * 1024) }]],
  [
    'content count',
    Array.from({ length: 9 }, () => ({ type: 'text', text: 'x' })),
  ],
] as const)(
  'rejects excess %s without storing a report',
  async (_kind, content) => {
    const peer = await reportPeer(async () => ({ content: [...content] }));
    const { server, owner } = await connectReportServer(peer);
    await expect(server.callToolResult('report', {})).rejects.toThrow();
    expect(server.references(owner)).toEqual([]);
  },
);
