import {
  createServer,
  request as forwardRequest,
  type Server,
} from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  manualTool,
  pendingInput,
  withPendingInput,
  parseSessionState,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

const fronts: Server[] = [];
afterEach(async () => {
  for (const server of fronts.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
  await ModelServer.closeAll();
});
async function peer(model: ModelServer) {
  const modelPort = await model.port();
  const reads: string[] = [];
  const server = createServer((request, response) => {
    if (request.method === 'GET') {
      expect(request.headers.authorization).toBe(
        'Bearer synthetic-provider-staged',
      );
      reads.push(request.url!);
      const match = request.url!.match(
        /^\/v1\/(responses|conversations)\/([^/?]+)$/,
      );
      if (!match) {
        response.writeHead(404).end('{}');
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          id: match[2],
          ...(match[1] === 'responses'
            ? { status: 'completed' }
            : { object: 'conversation' }),
        }),
      );
      return;
    }
    const upstream = forwardRequest(
      {
        hostname: '127.0.0.1',
        port: modelPort,
        path: '/v1/responses',
        method: request.method,
        headers: request.headers,
      },
      (reply) => {
        response.writeHead(reply.statusCode ?? 500, reply.headers);
        reply.pipe(response);
      },
    );
    upstream.on('error', (error) => response.destroy(error));
    request.pipe(upstream);
  });
  fronts.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing peer port');
  return { reads, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}
it.each(['previous_response', 'conversation'] as const)(
  'preserves eventually delivered data under native before-step server staging (%s)',
  async (kind) => {
    const marker = 'FILTERED_SERVER_PENDING';
    const model = new ModelServer([
      [call('decision', {}, { callId: 'one' })],
      [message('terminal')],
      [message('fresh')],
    ]);
    const remote = await peer(model);
    await using provider = new NativeProvider({
      baseUrl: remote.baseUrl,
      apiKey: 'synthetic-provider-staged',
      supportsWebsockets: false,
    });
    let omit = true;
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      modelSettings: { store: true },
      instructions: 'Continue after each decision.',
      tools: [
        manualTool({
          name: 'decision',
          description: 'Decision',
          parameters: z.object({}),
          result: z.string(),
        }),
      ],
      transformContext: ({ items }) =>
        omit
          ? items.filter((item) => !JSON.stringify(item).includes(marker))
          : items,
    });
    const initial =
      kind === 'conversation'
        ? { type: 'conversation' as const, id: 'conv_current' }
        : { type: 'previous_response' as const };
    await using source = await agent.session({
      providerHistory: initial,
    });
    const original = await source.submit('original');
    await original.wait({ until: 'manual_tool' });
    const saved = await source.suspend();
    await source.close();
    const staged = parseSessionState(
      JSON.stringify(withPendingInput(saved, marker)),
    );
    const before = JSON.stringify(staged);
    const authorization =
      kind === 'conversation'
        ? { type: 'conversation' as const, id: 'conv_current' }
        : { type: 'previous_response' as const, id: 'response-1' };
    await using restored = await agent.session({
      state: staged,
      providerHistory: authorization,
    });
    const request = (await restored.pendingInteractions())[0];
    if (request?.type !== 'action_requested')
      throw new Error('Missing restored manual action');
    await restored.respond(request.reply('accepted first result'));
    expect((await restored.restoredTurn!.wait()).finalOutput).toBe('terminal');
    const again = await restored.saveState();
    omit = false;
    expect(
      (await (await restored.submit('include previously omitted data')).wait())
        .finalOutput,
    ).toBe('fresh');
    expect(model.requests).toHaveLength(3);
    expect(JSON.stringify(model.requests[1].input)).not.toContain(marker);
    expect(
      kind === 'conversation'
        ? model.requests[1].conversation
        : model.requests[1].previous_response_id,
    ).toBe(kind === 'conversation' ? 'conv_current' : 'response-1');
    expect(remote.reads).toContain(
      kind === 'conversation'
        ? '/v1/conversations/conv_current'
        : '/v1/responses/response-1',
    );
    expect(JSON.stringify(staged)).toBe(before);
    expect(JSON.stringify(model.requests[2].input)).toContain(marker);
    expect(pendingInput(again)).toEqual([]);
    expect(JSON.stringify(again.history)).toContain(marker);
    model.assertExhausted();
  },
  30_000,
);
