import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeError,
  NativeProvider,
  tool,
} from '@openai/agents';
import {
  vercelResponse,
  ownedVercelResponse,
} from '../../../../examples/codex/native-ui/vercel';
import { agUiResponse } from '../../../../examples/codex/native-ui/ag-ui';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

// Real Responses SSE, including text deltas and a done-only negative control.
// No native observations are manufactured.
async function textPeer(
  text: string,
  doneFirst = false,
  children?: Map<string, ReturnType<typeof Promise.withResolvers<void>>>,
) {
  let rootId: string | undefined;
  let rootRequests = 0;
  let requests = 0;
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    let answer = text;
    if (children) {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const id: unknown = JSON.parse(
        body.client_metadata['x-codex-turn-metadata'],
      ).thread_id;
      if (typeof id !== 'string')
        throw new Error('Missing native thread identity');
      rootId ??= id;
      if (id === rootId) {
        if (++rootRequests === 1) {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const frame of [
            { type: 'response.created', response: { id: 'root-spawn' } },
            ...['alpha', 'beta'].map((name, output_index) => ({
              type: 'response.output_item.done',
              output_index,
              item: call(
                'spawn_agent',
                { task_name: name, message: 'Complete the assigned work.' },
                { namespace: 'collaboration', callId: `spawn-${name}` },
              ),
            })),
            { type: 'response.completed', response: { id: 'root-spawn' } },
          ])
            response.write(`data: ${JSON.stringify(frame)}\n\n`);
          response.end();
          return;
        }
        answer = 'root finished';
      } else {
        const release = Promise.withResolvers<void>();
        children.set(id, release);
        await release.promise;
        answer = `completed ${id}`;
      }
    }
    const sequence = ++requests;
    const item = {
      id: `wire-message-${sequence}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: answer }],
    };
    const frames = [
      { type: 'response.created', response: { id: 'response' } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...item, status: 'in_progress', content: [] },
      },
      {
        type: 'response.content_part.added',
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '' },
      },
      {
        type: 'response.output_text.delta',
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: answer,
      },
      {
        type: 'response.output_text.done',
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        text: answer,
      },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'response' } },
    ];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const frame of frames.filter(
      (frame) =>
        !doneFirst ||
        sequence !== 1 ||
        [
          'response.created',
          'response.output_item.done',
          'response.completed',
        ].includes(frame.type),
    ))
      response.write(`data: ${JSON.stringify(frame)}\n\n`);
    response.end();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing peer address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    async [Symbol.asyncDispose]() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
async function providerFor(server: ModelServer) {
  const config = await server.config();
  const entry = config['model_providers.fixture'];
  if (
    !entry ||
    typeof entry !== 'object' ||
    Array.isArray(entry) ||
    typeof entry.base_url !== 'string'
  )
    throw new Error('Missing fixture URL');
  return new NativeProvider({
    baseUrl: entry.base_url,
    apiKey: 'synthetic-ui',
    supportsWebsockets: false,
  });
}

describe('native UI adapters with real Sessions', () => {
  it.each(['vercel', 'ag-ui'] as const)(
    '%s preserves real observed/canonical item identity',
    async (protocol) => {
      await using peer = await textPeer('Native UI text');
      await using provider = new NativeProvider({
        baseUrl: peer.baseUrl,
        apiKey: 'synthetic-ui',
        supportsWebsockets: false,
      });
      await using session = await new Agent({
        instructions: 'Answer.',
        provider,
        tools: [],
      }).session();
      const turn = await session.submit('Hello');
      const response =
        protocol === 'vercel'
          ? vercelResponse(turn, session)
          : agUiResponse(turn, session, undefined);
      const wire = await response.text();
      const completed = await turn.wait();
      expect(completed.finalOutput).toBe('Native UI text');
      const items = await Array.fromAsync(session.items());
      const final = items.find(
        (item) =>
          item.type === 'message' &&
          item.role === 'assistant' &&
          item.turnId === turn.turnId,
      );
      expect(final).toBeDefined();
      expect(wire).toContain(final!.id);
      expect(wire).toContain(
        protocol === 'vercel' ? '"type":"finish"' : 'RUN_FINISHED',
      );
      expect(wire).not.toContain('resync_required');
    },
    30_000,
  );

  it('done-only output requires resync without modifying history; a later intact Turn works', async () => {
    await using peer = await textPeer('No observed delta', true);
    await using provider = new NativeProvider({
      baseUrl: peer.baseUrl,
      apiKey: 'synthetic-ui',
      supportsWebsockets: false,
    });
    await using session = await new Agent({
      instructions: 'Answer.',
      provider,
    }).session();
    const turn = await session.submit('Hello');
    const wire = await vercelResponse(turn, session).text();
    expect(wire).toContain('resync_required');
    expect(wire).not.toContain('"type":"finish"');
    expect((await turn.wait()).finalOutput).toBe('No observed delta');
    expect(
      (await Array.fromAsync(session.items())).some(
        (item) => item.type === 'message' && item.role === 'assistant',
      ),
    ).toBe(true);
    const later = await session.submit('Again');
    expect(await vercelResponse(later, session).text()).toContain(
      '"type":"finish"',
    );
    expect((await later.wait()).finalOutput).toBe('No observed delta');
  }, 30_000);

  it('AG-UI uses the actual typed declaration without inventing text from done-only output', async () => {
    const peer = new ModelServer([[message('{"answer":"typed"}')]]);
    await using provider = await providerFor(peer);
    const outputType = z.object({ answer: z.string() });
    await using session = await new Agent<undefined, { answer: string }>({
      instructions: 'Return the requested JSON.',
      provider,
      outputType,
    }).session();
    const turn = await session.submit('Answer');
    const wire = await agUiResponse(turn, session, outputType).text();
    expect((await turn.wait()).finalOutput).toEqual({ answer: 'typed' });
    expect(wire).toContain('RUN_FINISHED');
    expect(wire).not.toContain('TEXT_MESSAGE_CONTENT');
    expect(wire).not.toContain('resync_required');
  }, 30_000);

  it('projects real child cancellation while a sibling completes with its own canonical history', async () => {
    const children = new Map<
      string,
      ReturnType<typeof Promise.withResolvers<void>>
    >();
    await using peer = await textPeer('', false, children);
    const executor = await startPublicExecutor();
    try {
      await using provider = new NativeProvider({
        baseUrl: peer.baseUrl,
        apiKey: 'synthetic-ui',
        supportsWebsockets: false,
      });
      await using session = await new Agent({
        instructions: 'Delegate.',
        model: 'gpt-5.5',
        provider,
        tools: [new NativeAgents()],
      }).session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
      });
      try {
        await (await session.submit('Start both children.')).wait();
        await vi.waitFor(() => expect(children.size).toBe(2));
        const [selected, sibling] = await Array.fromAsync(session.subagents());
        if (!selected?.turn || !sibling?.turn)
          throw new Error('Missing native child Turns');
        const selectedWire = agUiResponse(
          selected.turn,
          session,
          undefined,
        ).text();
        const siblingWire = agUiResponse(
          sibling.turn,
          session,
          undefined,
        ).text();
        await expect(selected.tryCancel(selected.turn)).resolves.toBe(true);
        await expect(selected.turn.wait()).rejects.toBeInstanceOf(NativeError);
        const stopped = await selectedWire;
        expect(stopped).toContain(selected.id);
        expect(stopped).toContain(selected.turn.submissionId);
        expect(stopped).toContain('turn_cancelled');
        expect(stopped).not.toContain('RUN_FINISHED');
        let finished = false;
        const surviving = sibling.turn.wait().then((result) => {
          finished = true;
          return result;
        });
        await Promise.resolve();
        expect(finished).toBe(false);
        children.get(sibling.id)!.resolve();
        expect((await surviving).finalOutput).toBe(`completed ${sibling.id}`);
        const wire = await siblingWire;
        expect(wire).toContain(sibling.id);
        expect(wire).toContain(sibling.turn.submissionId);
        expect(wire).toContain('RUN_FINISHED');
        expect(wire).not.toContain('resync_required');
        expect(wire).not.toContain('root finished');
        const items = await Array.fromAsync(
          session.items({ subagentId: sibling.id }),
        );
        const final = items.find(
          (item) =>
            item.type === 'message' &&
            item.role === 'assistant' &&
            item.turnId === sibling.turn!.turnId,
        );
        expect(final).toBeDefined();
        expect(wire).toContain(final!.id);
        expect(wire).toContain('TEXT_MESSAGE_CONTENT');
      } finally {
        for (const release of children.values()) release.resolve();
      }
    } finally {
      await executor.close();
    }
  }, 30_000);

  it('passive disconnect leaves entered work alive and lets its original Turn finish', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const peer = new ModelServer([
      [call('held', {}, { callId: 'held-call' })],
      [message('Finished externally')],
    ]);
    await using provider = await providerFor(peer);
    await using session = await new Agent({
      instructions: 'Call held, then answer.',
      provider,
      tools: [
        tool({
          name: 'held',
          description: 'Wait for application release.',
          parameters: z.object({}),
          execute: async () => {
            entered.resolve();
            await release.promise;
            return 'released';
          },
        }),
      ],
    }).session();
    try {
      const turn = await session.submit('Run');
      const reader = vercelResponse(turn, session).body!.getReader();
      await reader.read();
      await entered.promise;
      await reader.cancel();
      release.resolve();
      expect((await turn.wait()).finalOutput).toBe('Finished externally');
    } finally {
      release.resolve();
    }
  }, 30_000);

  it('owned response cancellation joins entered callback cleanup', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let cleaned = false;
    const peer = new ModelServer([
      [call('held', {}, { callId: 'owned-held' })],
    ]);
    await using provider = await providerFor(peer);
    const agent = new Agent<undefined>({
      instructions: 'Call held.',
      provider,
      tools: [
        tool({
          name: 'held',
          description: 'Wait for application cleanup.',
          parameters: z.object({}),
          execute: async () => {
            entered.resolve();
            await release.promise;
            cleaned = true;
            return 'released';
          },
        }),
      ],
    });
    const response = await ownedVercelResponse(agent, 'Run');
    const reader = response.body!.getReader();
    let cancel: Promise<void> | undefined;
    try {
      await reader.read();
      await entered.promise;
      let joined = false;
      cancel = reader.cancel().then(() => {
        joined = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(joined).toBe(false);
      release.resolve();
      await cancel;
      expect(cleaned).toBe(true);
    } finally {
      release.resolve();
      await (cancel ?? reader.cancel());
    }
  }, 30_000);
});
