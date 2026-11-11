import type OpenAI from 'openai';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeError,
  NativeProvider,
  parseSessionState,
  responsesCompaction,
  tool,
} from '../../src';
import { ModelServer, message, call } from './fixtures/model-server';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
afterEach(async () => {
  await ModelServer.closeAll();
});
const text = (value: unknown) => JSON.stringify(value);
const window = () => ({
  id: 'COMPACT_RESULT_NOT_AN_ANCHOR',
  output: [
    message('RETAINED_BEFORE_OPAQUE'),
    { type: 'compaction', encrypted_content: 'OPAQUE_COMPLETE_WINDOW' },
    {
      type: 'function_call',
      call_id: 'historic',
      name: 'historical',
      arguments: '{}',
    },
    {
      type: 'function_call_output',
      call_id: 'historic',
      output: 'HISTORIC_TOOL_OUTPUT',
    },
    message('RETAINED_AFTER_OPAQUE'),
  ],
  usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
});
const clientFor = (compact: (body: any) => Promise<any>) =>
  ({ responses: { compact } }) as unknown as OpenAI;
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-compaction',
    supportsWebsockets: false,
  });
}

nativeIt.each([false, true])(
  'keeps the entire returned window and current instructions through cold restore (profiles=%s)',
  async (profiled) => {
    const server = new ModelServer([
      [message('OLD_ASSISTANT')],
      [message('continued')],
    ]);
    const compact = vi.fn(async (_body) => window());
    const predicate = vi.fn(() => false);
    await using provider = await providerFor(server);
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'ORIGINAL_APPLICATION',
      handoffs: profiled
        ? [
            new Agent<unknown>({
              name: 'Unused',
              instructions: 'Unused.',
              provider,
              model: 'gpt-5.5',
            }),
          ]
        : [],
      compaction: responsesCompaction({
        client: clientFor(compact),
        model: 'separate-compactor',
        shouldCompact: predicate,
      }),
    });
    let saved;
    {
      await using session = await agent.session();
      await (await session.submit('OLD_USER_SENTINEL')).wait();
      await session.update({ instructions: 'CURRENT_APPLICATION' });
      const count = predicate.mock.calls.length;
      await session.compact();
      expect(predicate).toHaveBeenCalledTimes(count);
      saved = await session.saveState();
      expect(text(saved)).toContain('OLD_USER_SENTINEL');
    }
    {
      await using restored = await agent.session({
        state: parseSessionState(JSON.parse(text(saved))),
      });
      await (await restored.submit('followup')).wait();
    }
    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact.mock.calls[0]![0].model).toBe('separate-compactor');
    expect(text(compact.mock.calls[0]![0].input)).toContain(
      'OLD_USER_SENTINEL',
    );
    const body = text(server.requests.at(-1));
    expect(body).not.toContain('OLD_USER_SENTINEL');
    expect(body).not.toContain('OLD_ASSISTANT');
    expect(body).toContain('CURRENT_APPLICATION');
    expect(body).toContain('HISTORIC_TOOL_OUTPUT');
    expect(body.indexOf('RETAINED_BEFORE_OPAQUE')).toBeLessThan(
      body.indexOf('OPAQUE_COMPLETE_WINDOW'),
    );
    expect(body.indexOf('OPAQUE_COMPLETE_WINDOW')).toBeLessThan(
      body.indexOf('RETAINED_AFTER_OPAQUE'),
    );
    expect(server.requests.at(-1)?.previous_response_id).not.toBe(
      'COMPACT_RESULT_NOT_AN_ANCHOR',
    );
  },
  30_000,
);

nativeIt(
  'skips nine candidates and compacts ten after successful persistence',
  async () => {
    const server = new ModelServer([
      Array.from({ length: 9 }, (_, index) => message(`candidate-${index}`)),
      [message('candidate-ten')],
    ]);
    const compact = vi.fn(async () => window());
    await using provider = await providerFor(server);
    await using session = await new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Answer.',
      compaction: responsesCompaction({
        client: clientFor(compact),
        model: 'compact',
      }),
    }).session();
    await (await session.submit('first')).wait();
    expect(compact).not.toHaveBeenCalled();
    await (await session.submit('second')).wait();
    expect(compact).toHaveBeenCalledTimes(1);
    expect(
      (await session.saveState()).history.some(
        (row) => row.type === 'compacted',
      ),
    ).toBe(true);
    expect(server.requests).toHaveLength(2);
  },
  30_000,
);

nativeIt(
  'compacts accepted terminal tools before native terminal retirement',
  async () => {
    const server = new ModelServer([
      [call('finish', {}, { callId: 'finish-call' })],
    ]);
    const compact = vi.fn(async () => window());
    const effect = vi.fn(() => 'terminal result');
    await using provider = await providerFor(server);
    await using session = await new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Use finish.',
      tools: [
        tool({
          name: 'finish',
          parameters: z.object({}),
          finishTurn: true,
          execute: effect,
        }),
      ],
      compaction: responsesCompaction({
        client: clientFor(compact),
        model: 'compact',
        shouldCompact: () => true,
      }),
    }).session();
    const result = await (await session.submit('finish now')).wait();
    expect(result.finalOutput).toBe('terminal result');
    expect(effect).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(server.requests).toHaveLength(1);
    expect(text(await session.saveState())).toContain('finish-call');
  },
  30_000,
);

nativeIt.each([
  'predicate',
  'client',
  'missing_anchor',
  'malformed_id',
] as const)(
  'preserves the completed answer on optional %s failure',
  async (failure) => {
    const server = new ModelServer([[message('completed answer')]]);
    const compact = vi.fn(async (_body) => {
      if (failure === 'malformed_id') return { ...window(), id: 7 };
      throw new Error('compact unavailable');
    });
    const predicate = vi.fn(async (context) => {
      expect(context.mode).toBe('input');
      expect(context.model).toBe('compact');
      expect(
        context.candidates.every((item: any) => item.role !== 'user'),
      ).toBe(true);
      if (failure === 'predicate') throw new Error('predicate unavailable');
      context.items[0].content = [
        { type: 'input_text', text: 'MUTATED_DETACHED_CONTEXT' },
      ];
      return true;
    });
    await using provider = await providerFor(server);
    await using session = await new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Answer.',
      compaction: responsesCompaction({
        client: clientFor(compact),
        model: 'compact',
        mode: failure === 'missing_anchor' ? 'previous_response_id' : 'auto',
        shouldCompact: predicate,
      }),
    }).session();
    expect(
      (await (await session.submit('KEEP_ORIGINAL_CONTEXT')).wait())
        .finalOutput,
    ).toBe('completed answer');
    expect(predicate).toHaveBeenCalledTimes(
      failure === 'missing_anchor' ? 0 : 1,
    );
    expect(compact).toHaveBeenCalledTimes(
      failure === 'client' || failure === 'malformed_id' ? 1 : 0,
    );
    if (failure === 'client')
      expect(text(compact.mock.calls[0]![0])).not.toContain(
        'MUTATED_DETACHED_CONTEXT',
      );
    const saved = await session.saveState();
    expect(text(saved)).toContain('KEEP_ORIGINAL_CONTEXT');
    expect(saved.history.some((row) => row.type === 'compacted')).toBe(false);
  },
  30_000,
);

nativeIt(
  'rejects an incomplete returned pair without publishing',
  async () => {
    const server = new ModelServer([
      [message('original')],
      [message('continued')],
    ]);
    const compact = async () => ({
      output: [
        {
          type: 'function_call',
          call_id: 'missing',
          name: 'historical',
          arguments: '{}',
        },
      ],
    });
    await using provider = await providerFor(server);
    await using session = await new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Answer.',
      compaction: responsesCompaction({
        client: clientFor(compact),
        model: 'compact',
        shouldCompact: () => false,
      }),
    }).session();
    await (await session.submit('KEEP_ORIGINAL_CONTEXT')).wait();
    await expect(session.compact()).rejects.toBeInstanceOf(NativeError);
    await (await session.submit('continue')).wait();
    expect(text(server.requests.at(-1))).toContain('KEEP_ORIGINAL_CONTEXT');
    expect(
      (await session.saveState()).history.some(
        (row) => row.type === 'compacted',
      ),
    ).toBe(false);
  },
  30_000,
);

nativeIt(
  'joins cancelled compact callbacks and rejects late window publication',
  async () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    let exited = false,
      canceled = false;
    const compact = async () => {
      enter();
      await gate;
      exited = true;
      return window();
    };
    const server = new ModelServer([[message('completed before compaction')]]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Answer.',
      compaction: responsesCompaction({
        client: clientFor(compact),
        model: 'compact',
        shouldCompact: () => true,
      }),
    }).session();
    const turn = await session.submit('cancel target');
    const outcome = turn.wait().catch((error) => error);
    try {
      await entered;
      const cancelling = turn.cancel().then(() => {
        canceled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(canceled).toBe(false);
      expect(exited).toBe(false);
      release();
      await cancelling;
      expect(await outcome).toBeInstanceOf(NativeError);
      expect(exited).toBe(true);
      expect(text(await session.saveState())).not.toContain(
        'OPAQUE_COMPLETE_WINDOW',
      );
    } finally {
      release();
    }
  },
  30_000,
);
