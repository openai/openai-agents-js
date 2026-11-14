import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { createOpenAI } from '@ai-sdk/openai';
import { Agent, AiSdkModel, NativeProvider } from '../../src';
import { token, response, frames } from './fixtures/raw-ai-sdk-compaction';
const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
nativeIt.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
] as const)(
  'retains real AI SDK compaction through native admission and same-provider replay stream=%s raw=%s',
  async (stream, capture) => {
    const requests: any[] = [];
    const server = createServer(async (request, reply) => {
      let text = '';
      for await (const chunk of request) text += chunk;
      const body = JSON.parse(text);
      requests.push(body);
      if (body.stream) {
        reply.setHeader('content-type', 'text/event-stream');
        reply.end(
          frames()
            .map((frame) => 'data: ' + JSON.stringify(frame) + '\n\n')
            .join(''),
        );
      } else {
        reply.setHeader('content-type', 'application/json');
        reply.end(JSON.stringify(response));
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    try {
      const library = createOpenAI({
        baseURL: url,
        apiKey: 'synthetic-raw-key',
      }).responses('gpt-4.1');
      await using provider = new NativeProvider({
        baseUrl: url,
        apiKey: 'synthetic-raw-key',
        supportsWebsockets: false,
        modelBackend: new AiSdkModel(library, {}, { stream }),
      });
      await using session = await new Agent({
        provider,
        model: 'gpt-4.1',
        instructions: 'Reply.',
      }).session({
        includeRawProviderEvents: capture,
        observationRetention: 'all',
      });
      for (const input of ['first', 'second']) {
        const turn = await session.submit(input);
        expect((await turn.wait()).finalOutput).toBe('raw answer');
        const raw: any[] = [];
        for await (const event of turn.events({
          includeExecutionDetails: true,
        }))
          if (event.type === 'raw_provider_event') raw.push(event.payload);
        if (!capture) expect(raw).toEqual([]);
        if (stream && capture)
          expect(raw).toContainEqual(
            expect.objectContaining({
              type: 'custom',
              kind: 'openai.compaction',
              providerMetadata: expect.objectContaining({
                openai: expect.objectContaining({ encryptedContent: token }),
              }),
            }),
          );
      }
      expect(JSON.stringify(requests[1].input)).toContain('cmp_fixture');
      expect(requests[1].input).toContainEqual({
        type: 'compaction',
        id: 'cmp_fixture',
        encrypted_content: token,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  30_000,
);

async function fixture() {
  const requests: any[] = [];
  const server = createServer(async (request, reply) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    requests.push(body);
    if (body.stream) {
      reply.setHeader('content-type', 'text/event-stream');
      reply.end(
        frames()
          .map((frame) => 'data: ' + JSON.stringify(frame) + '\n\n')
          .join(''),
      );
    } else {
      reply.setHeader('content-type', 'application/json');
      reply.end(JSON.stringify(response));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    requests,
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
for (const stream of [false, true]) {
  nativeIt.each(['same', 'provider', 'model'] as const)(
    'requires the retained compaction scope across adapter replacement %s stream=' +
      stream,
    async (scope) => {
      const wire = await fixture();
      try {
        const initial = createOpenAI({
          baseURL: wire.url,
          apiKey: 'synthetic-scope-key',
        }).responses('gpt-4.1');
        let active = new AiSdkModel(initial, {}, { stream });
        const backend = {
          complete: (request: import('../../src').ModelRequest) =>
            active.complete(request),
          ...(stream
            ? {
                stream: (request: import('../../src').ModelRequest) =>
                  active.stream!(request),
              }
            : {}),
        };
        await using provider = new NativeProvider({
          baseUrl: wire.url,
          apiKey: 'synthetic-scope-key',
          modelBackend: backend,
        });
        await using session = await new Agent({
          provider,
          model: 'gpt-4.1',
          instructions: 'Reply.',
        }).session({ includeRawProviderEvents: true });
        expect((await (await session.submit('first')).wait()).finalOutput).toBe(
          'raw answer',
        );
        const changed = createOpenAI({
          baseURL: wire.url,
          apiKey: 'synthetic-scope-key',
          ...(scope === 'provider' ? { name: 'other' } : {}),
        }).responses(scope === 'model' ? 'other-model' : 'gpt-4.1');
        active = new AiSdkModel(
          changed,
          {},
          { stream, providerFamily: 'openai' },
        );
        const second = await session.submit('second');
        if (scope === 'same') {
          expect((await second.wait()).finalOutput).toBe('raw answer');
          expect(wire.requests[1].input).toContainEqual({
            type: 'compaction',
            id: 'cmp_fixture',
            encrypted_content: token,
          });
          expect(wire.requests).toHaveLength(2);
        } else {
          await expect(second.wait()).rejects.toThrow(
            'AI SDK compaction requires its original provider and model',
          );
          expect(wire.requests).toHaveLength(1);
        }
      } finally {
        await wire.close();
      }
    },
    30_000,
  );
  nativeIt(
    'rejects caller-injected opaque compaction before provider I/O stream=' +
      stream,
    async () => {
      const wire = await fixture();
      try {
        const model = createOpenAI({
          baseURL: wire.url,
          apiKey: 'synthetic-scope-key',
        }).responses('gpt-4.1');
        await using provider = new NativeProvider({
          baseUrl: wire.url,
          apiKey: 'synthetic-scope-key',
          modelBackend: new AiSdkModel(model, {}, { stream }),
        });
        await using session = await new Agent({
          provider,
          model: 'gpt-4.1',
          instructions: 'Reply.',
        }).session();
        const history = await session.historySnapshot();
        await session.transactHistory({
          expectedRevision: history.revision,
          keep: 0,
          items: [
            { type: 'compaction', id: 'cmp_fixture', encrypted_content: token },
          ],
        });
        await expect(
          (async () => {
            const turn = await session.submit('caller supplied');
            return turn.wait();
          })(),
        ).rejects.toThrow(
          'AI SDK compaction requires its original provider and model',
        );
        expect(wire.requests).toHaveLength(0);
      } finally {
        await wire.close();
      }
    },
    30_000,
  );
}

nativeIt.each([false, true])(
  'restores admitted compaction into a fresh native Session stream=%s',
  async (stream) => {
    const wire = await fixture();
    try {
      const library = createOpenAI({
        baseURL: wire.url,
        apiKey: 'synthetic-cold-key',
      }).responses('gpt-4.1');
      await using provider = new NativeProvider({
        baseUrl: wire.url,
        apiKey: 'synthetic-cold-key',
        modelBackend: new AiSdkModel(library, {}, { stream }),
      });
      const agent = new Agent({
        provider,
        model: 'gpt-4.1',
        instructions: 'Reply.',
      });
      const first = await agent.session({ includeRawProviderEvents: true });
      expect((await (await first.submit('first')).wait()).finalOutput).toBe(
        'raw answer',
      );
      const state = await first.saveState();
      await first.close();
      await using restored = await agent.session({
        state,
        includeRawProviderEvents: true,
      });
      expect(
        (await (await restored.submit('after cold restore')).wait())
          .finalOutput,
      ).toBe('raw answer');
      expect(wire.requests).toHaveLength(2);
      expect(wire.requests[1].input).toContainEqual({
        type: 'compaction',
        id: 'cmp_fixture',
        encrypted_content: token,
      });
    } finally {
      await wire.close();
    }
  },
  30_000,
);
