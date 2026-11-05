import { z } from 'zod';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { describe, expect, it, afterEach } from 'vitest';
import {
  Agent,
  NativeProvider,
  NativeError,
  NativeAgents,
  manualTool,
  tool,
  InteractionRequired,
  Environment,
} from '../../src';
import type { ResponseIntegrityReason } from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

const cases: {
  reason: ResponseIntegrityReason;
  phase: 'added' | 'done';
  items: JsonObject[];
}[] = [
  ...(['added', 'done'] as const).map((phase) => ({
    reason: 'undecodable_output_item' as const,
    phase,
    items: [
      {
        type: 'message',
        id: 'private-item',
        role: 'assistant',
        content: [{ type: 'refusal', refusal: 'private-refusal' }],
      },
    ],
  })),
  ...(['added', 'done'] as const).map((phase) => ({
    reason: 'provider_owned_tool_receipt' as const,
    phase,
    items: [
      {
        type: 'function_call_output',
        call_id: 'private-provider-receipt',
        output: 'synthetic',
      },
    ],
  })),
  {
    reason: 'unfinished_assistant_item',
    phase: 'added',
    items: [{ type: 'message', id: 'pending', role: 'assistant', content: [] }],
  },
  { reason: 'missing_supported_terminal_output', phase: 'done', items: [] },
];
afterEach(() => ModelServer.closeAll());

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'response integrity reasons through actual native selection',
  () => {
    for (const websocket of [false, true])
      for (const test of cases) {
        it(`${websocket ? 'WebSocket' : 'HTTP'} ${test.reason} at ${test.phase}`, async () => {
          let generation = 0;
          const frames = (generate: boolean) => {
            const id = randomUUID();
            const first = generate && generation++ === 0;
            const items = first
              ? test.items
              : generate
                ? [message('successor usable')]
                : [];
            return [
              { type: 'response.created', response: { id } },
              ...items.map((item, output_index) => ({
                type: `response.output_item.${first ? test.phase : 'done'}`,
                output_index,
                item,
              })),
              { type: 'response.completed', response: { id } },
            ];
          };
          const server = createServer(async (request, response) => {
            for await (const _chunk of request) {
              /* Drain synthetic request. */
            }
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            for (const event of frames(true))
              response.write(`data: ${JSON.stringify(event)}\n\n`);
            response.end();
          });
          const sockets = new WebSocketServer({ noServer: true });
          server.on('upgrade', (request, socket, head) =>
            sockets.handleUpgrade(request, socket, head, (connection) => {
              connection.on('message', (data) => {
                const request = JSON.parse(data.toString());
                for (const event of frames(request.generate !== false))
                  connection.send(JSON.stringify(event));
              });
            }),
          );
          server.listen(0, '127.0.0.1');
          await once(server, 'listening');
          const address = server.address();
          if (!address || typeof address === 'string')
            throw new Error('Provider did not bind');
          const provider = new NativeProvider({
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKey: 'synthetic',
            supportsWebsockets: websocket,
          });
          const session = await new Agent({
            model: 'gpt-5',
            instructions: 'Answer.',
            provider,
          }).session();
          try {
            const turn = await session.submit('fail then recover');
            const error = await turn.wait().catch((error: unknown) => error);
            expect(error).toBeInstanceOf(NativeError);
            expect((error as NativeError).responseIntegrityReason).toBe(
              test.reason,
            );
            expect(String(error)).toContain(
              'Native model response ended without complete supported output',
            );
            expect(String(error)).not.toContain('private-');
            expect((error as NativeError).effects).toBe('unknown');
            await expect(turn.wait()).rejects.toBe(error);
            await expect(turn.waitForAttention()).rejects.toBe(error);
            expect(
              (await (await session.submit('fresh successor')).wait())
                .finalOutput,
            ).toBe('successor usable');
            expect(generation).toBe(2);
            expect((error as NativeError).responseIntegrityReason).toBe(
              test.reason,
            );
          } finally {
            await session.close();
            await provider.close();
            for (const socket of sockets.clients) socket.terminate();
            sockets.close();
            const closed = once(server, 'close');
            server.close();
            server.closeAllConnections();
            await closed;
          }
        }, 30000);
      }

    it.each([false, true])(
      'retains owned child reason with public event consumer=%s',
      async (consumeEvents) => {
        const executor = await startPublicExecutor();
        let rootId: string | undefined;
        let rootRequests = 0;
        const response = (request: JsonObject) => {
          const metadata = request.client_metadata as Record<string, string>;
          const id = String(
            JSON.parse(metadata['x-codex-turn-metadata']).thread_id,
          );
          rootId ??= id;
          if (id === rootId)
            return rootRequests++ === 0
              ? [
                  call(
                    'spawn_agent',
                    { task_name: 'child', message: 'Reply.' },
                    { namespace: 'collaboration', callId: 'spawn' },
                  ),
                ]
              : [message('root finished')];
          return [
            {
              type: 'message',
              id: 'private-child-item',
              role: 'assistant',
              content: [{ type: 'refusal', refusal: 'private-child-refusal' }],
            },
          ];
        };
        const model = new ModelServer([response, response, response]);
        const config = await model.config();
        const provider = new NativeProvider({
          baseUrl: (config['model_providers.fixture'] as { base_url: string })
            .base_url,
          apiKey: 'synthetic',
        });
        const session = await new Agent({
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
          expect(
            (await (await session.submit('Begin')).wait()).finalOutput,
          ).toBe('root finished');
          const children = [];
          for await (const child of session.subagents()) children.push(child);
          expect(children).toHaveLength(1);
          const turn = children[0].turn;
          if (!turn) throw new Error('Missing child turn');
          const observed = consumeEvents
            ? (async () => {
                for await (const _event of turn.events()) {
                  /* Consume progress. */
                }
              })()
            : undefined;
          const error = await turn.wait().catch((error: unknown) => error);
          expect(error).toBeInstanceOf(NativeError);
          expect((error as NativeError).responseIntegrityReason).toBe(
            'undecodable_output_item',
          );
          await expect(turn.wait()).rejects.toBe(error);
          await expect(turn.waitForAttention()).rejects.toBe(error);
          await observed;
          expect(String(error)).not.toContain('private-child');
          model.assertExhausted();
        } finally {
          await session.close();
          await provider.close();
          await executor.close();
        }
      },
      30000,
    );
    it('keeps an old public failure undecorated across same-ID manual recovery', async () => {
      const lookup = manualTool({
        name: 'lookup',
        description: 'Read a record.',
        parameters: z.strictObject({ key: z.string() }),
        result: z.string(),
      });
      const model = new ModelServer([
        [call('lookup', { key: 'A' }, { callId: 'manual-A' })],
        [
          {
            type: 'message',
            id: 'private-recovered-item',
            role: 'assistant',
            content: [{ type: 'refusal', refusal: 'private-refusal' }],
          },
        ],
      ]);
      const config = await model.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic',
      });
      const agent = new Agent({
        model: 'gpt-5',
        instructions: 'Use lookup then answer.',
        provider,
        tools: [lookup],
      });
      const original = await agent.session();
      const events = original.events()[Symbol.asyncIterator]();
      const first = await original.submit('Look up A');
      const action = async (
        stream: AsyncIterator<import('../../src').ObservedEvent>,
      ) => {
        for (;;) {
          const next = await stream.next();
          if (next.done) throw new Error('Missing manual request');
          if (next.value.type === 'action_requested') return next.value;
        }
      };
      const oldRequest = await action(events);
      const stale = oldRequest.reply('stale');
      const outcome = first.wait().catch((error: unknown) => error);
      const state = await original.suspend();
      const oldError = await outcome;
      expect(oldError).toBeInstanceOf(InteractionRequired);
      expect((oldError as NativeError).responseIntegrityReason).toBeNull();
      await events.return?.();
      await original.close();
      await using restored = await agent.session({ state });
      const currentEvents = restored.events()[Symbol.asyncIterator]();
      const current = await action(currentEvents);
      expect(current.turnId).toBe(oldRequest.turnId);
      await expect(restored.respond(stale)).rejects.toThrow();
      await restored.respond(current.reply('answer-A'));
      const currentError = await restored
        .wait()
        .catch((error: unknown) => error);
      expect(currentError).toBeInstanceOf(NativeError);
      expect([null, 'undecodable_output_item']).toContain(
        (currentError as NativeError).responseIntegrityReason,
      );
      expect((oldError as NativeError).responseIntegrityReason).toBeNull();
      await currentEvents.return?.();
      model.assertExhausted();
    }, 30000);
    it('settles an already-started tool before surfacing a malformed parser output', async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let cancelled = false;
      let effects = 0;
      const settle = tool({
        name: 'settle_once',
        parameters: z.strictObject({}),
        execute: async (_args, context) => {
          entered.resolve();
          await new Promise<void>((resolve, reject) => {
            const abort = () => {
              cancelled = true;
              reject(context.signal.reason);
            };
            context.signal.addEventListener('abort', abort, { once: true });
            if (context.signal.aborted) abort();
            void release.promise.then(() => {
              context.signal.removeEventListener('abort', abort);
              resolve();
            });
          });
          effects++;
          return 'settled';
        },
      });
      const model = new ModelServer([
        [
          call('settle_once', {}, { callId: 'owned-effect' }),
          {
            type: 'message',
            id: 'private-item',
            role: 'assistant',
            content: [{ type: 'refusal', refusal: 'private-refusal' }],
          },
        ],
      ]);
      const config = await model.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic',
      });
      await using session = await new Agent({
        instructions: 'Settle once then answer.',
        model: 'gpt-5',
        provider,
        tools: [settle],
      }).session();
      const turn = await session.submit('settle the started effect');
      const outcome = turn.wait().catch((error: unknown) => error);
      await entered.promise;
      try {
        expect(
          await Promise.race([
            outcome.then(() => 'settled'),
            new Promise<string>((resolve) =>
              setTimeout(() => resolve('held'), 100),
            ),
          ]),
        ).toBe('held');
        expect(cancelled).toBe(false);
      } finally {
        release.resolve();
      }
      const error = await outcome;
      expect(error).toBeInstanceOf(NativeError);
      expect((error as NativeError).responseIntegrityReason).toBe(
        'undecodable_output_item',
      );
      expect((error as NativeError).category).toBe('internal_error');
      expect(effects).toBe(1);
      expect(cancelled).toBe(false);
      model.assertExhausted();
    }, 30000);
  },
);
