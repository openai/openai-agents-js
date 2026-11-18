import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, NativeError, NativeProvider, tool } from '../../src';
import { binding, type JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

function response(events: JsonObject[]) {
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
  };
}

function interrupted(kind: 'delta' | 'completed-item' | 'before-text') {
  return response([
    { type: 'response.created', response: { id: 'interrupted' } },
    ...(kind === 'delta'
      ? [
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              type: 'message',
              id: 'partial-message',
              role: 'assistant',
              content: [],
            },
          },
          {
            type: 'response.output_text.delta',
            item_id: 'partial-message',
            output_index: 0,
            content_index: 0,
            delta: 'published prefix',
          },
        ]
      : []),
    ...(kind === 'completed-item'
      ? [
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: message('published prefix'),
          },
          {
            type: 'response.incomplete',
            response: {
              id: 'interrupted',
              status: 'incomplete',
              incomplete_details: { reason: 'max_output_tokens' },
            },
          },
        ]
      : []),
  ]);
}

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-publication-boundary',
    responseMode: 'streaming',
    supportsWebsockets: false,
    requestMaxRetries: 0,
    streamMaxRetries: 1,
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'ordinary assistant text publication',
  () => {
    it.each(['delta', 'completed-item'] as const)(
      'surfaces %s interruption from plain Agent.run without an event reader',
      async (kind) => {
        const server = new ModelServer([
          interrupted(kind),
          [message('recovery must remain unused')],
        ]);
        await using provider = await providerFor(server);
        const plain = vi.spyOn(
          (await binding()).Engine.prototype,
          '_plain_run',
        );
        await expect(
          new Agent({ instructions: 'Answer.', model: 'gpt-5', provider }).run(
            'Begin.',
          ),
        ).rejects.toBeInstanceOf(NativeError);
        expect(plain).toHaveBeenCalledTimes(1);
        expect(server.requests).toHaveLength(1);
      },
      30_000,
    );

    it.each([
      ['delta', false],
      ['completed-item', false],
      ['delta', true],
    ] as const)(
      'surfaces %s interruption from a session with active reader %s',
      async (kind, activeReader) => {
        const server = new ModelServer([
          interrupted(kind),
          [message('recovery must remain unused')],
        ]);
        await using provider = await providerFor(server);
        await using session = await new Agent({
          instructions: 'Answer.',
          model: 'gpt-5',
          provider,
        }).session();
        const turn = await session.submit('Begin.');
        const observed: string[] = [];
        const reader = activeReader
          ? (async () => {
              for await (const event of turn.events())
                if (event.type === 'output_text_delta')
                  observed.push(event.delta);
            })()
          : undefined;
        await expect(turn.wait()).rejects.toBeInstanceOf(NativeError);
        await reader;
        expect(server.requests).toHaveLength(1);
        if (activeReader) expect(observed).toEqual(['published prefix']);
      },
      30_000,
    );

    it('retries plain Agent.run before text publication', async () => {
      const server = new ModelServer([
        interrupted('before-text'),
        [message('recovered answer')],
      ]);
      await using provider = await providerFor(server);
      const completed = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
      }).run('Begin.');
      expect(completed.finalOutput).toBe('recovered answer');
      server.assertExhausted();
    }, 30_000);

    it('surfaces published provisional text without approving an incomplete answer', async () => {
      const server = new ModelServer([
        interrupted('delta'),
        [message('recovery must remain unused')],
      ]);
      await using provider = await providerFor(server);
      const checked = vi.fn(() => ({ tripwireTriggered: false }));
      const plain = vi.spyOn((await binding()).Engine.prototype, '_plain_run');
      const agent = new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
        outputGuardrails: [{ name: 'approve', callback: checked }],
      });
      await expect(agent.run('Begin.')).rejects.toBeInstanceOf(NativeError);
      expect(plain).not.toHaveBeenCalled();
      expect(checked).not.toHaveBeenCalled();
      expect(server.requests).toHaveLength(1);
    }, 30_000);

    it('retries before text publication with an output guardrail', async () => {
      const server = new ModelServer([
        interrupted('before-text'),
        [message('approved answer')],
      ]);
      await using provider = await providerFor(server);
      const checked: unknown[] = [];
      const completed = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
        outputGuardrails: [
          {
            name: 'approve',
            callback(context) {
              checked.push(context.finalOutput);
              return { tripwireTriggered: false };
            },
          },
        ],
      }).run('Begin.');
      expect(completed.finalOutput).toBe('approved answer');
      expect(checked).toEqual(['approved answer']);
      server.assertExhausted();
    }, 30_000);

    it('allows a fresh unpublished model attempt after earlier text and tool effects', async () => {
      const effects: string[] = [];
      const server = new ModelServer([
        [
          message('earlier accepted text'),
          call('record', {}, { callId: 'accepted-call' }),
        ],
        interrupted('before-text'),
        [message('final answer')],
      ]);
      await using provider = await providerFor(server);
      const completed = await new Agent({
        instructions: 'Use record, then answer.',
        model: 'gpt-5',
        provider,
        tools: [
          tool({
            name: 'record',
            parameters: z.object({}),
            execute() {
              effects.push('recorded once');
              return 'accepted result';
            },
          }),
        ],
      }).run('Begin.');
      expect(completed.finalOutput).toBe('final answer');
      expect(effects).toEqual(['recorded once']);
      expect(JSON.stringify(server.requests[2]?.input)).toContain(
        'accepted result',
      );
      server.assertExhausted();
    }, 30_000);
  },
);
