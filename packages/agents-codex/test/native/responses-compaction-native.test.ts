import OpenAI from 'openai';
import * as openAIEntrypoint from '../../node/openai-entrypoint.js';
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
  vi.restoreAllMocks();
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

nativeIt(
  'keeps omitted ResponsesCompaction independent of borrowed compact and alternate client loading',
  async () => {
    const load = vi
      .spyOn(openAIEntrypoint, 'loadOpenAIEntrypoint')
      .mockRejectedValue(new Error('Unexpected alternate client loading'));
    const compact = vi
      .spyOn(OpenAI.Responses.prototype, 'compact')
      .mockRejectedValue(new Error('Unexpected borrowed compact call'));
    const server = new ModelServer([[message('remembered')]]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Answer briefly.',
      beforeCompact: () => 'APPLICATION_SUMMARY_WITHOUT_RESPONSES_COMPACTION',
    }).session();
    await (await session.submit('Remember the source.')).wait();
    await session.compact();
    expect(text(await session.saveState())).toContain(
      'APPLICATION_SUMMARY_WITHOUT_RESPONSES_COMPACTION',
    );
    expect(server.requests).toHaveLength(1);
    expect(compact).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    server.assertExhausted();
  },
  20_000,
);

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
    const options = {
      provider,
      model: 'gpt-5.5',
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
    };
    const agent = new Agent({
      ...options,
      instructions: 'ORIGINAL_APPLICATION',
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
      const currentAgent = profiled
        ? agent
        : new Agent({ ...options, instructions: 'CURRENT_APPLICATION' });
      await using restored = await currentAgent.session({
        state: parseSessionState(text(saved)),
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
    let enter!: () => void, release!: () => void, abort!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const aborted = new Promise<void>((resolve) => (abort = resolve));
    let exited = false,
      canceled = false;
    const compact = async (
      _body: unknown,
      options?: { signal?: AbortSignal | null },
    ) => {
      const signal = options?.signal;
      signal?.addEventListener('abort', abort, { once: true });
      enter();
      try {
        await gate;
        return window();
      } finally {
        signal?.removeEventListener('abort', abort);
        exited = true;
      }
    };
    const server = new ModelServer([
      [message('completed before compaction')],
      [message('successor answer')],
    ]);
    await using provider = await providerFor(server);
    let policies = 0;
    await using session = await new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Answer.',
      compaction: responsesCompaction({
        client: clientFor(compact),
        model: 'compact',
        shouldCompact: () => ++policies === 1,
      }),
    }).session();
    const turn = await session.submit('cancel target');
    const outcome = turn.wait().catch((error) => error);
    try {
      await entered;
      const cancelling = turn.cancel().then(() => {
        canceled = true;
      });
      await aborted;
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
      expect(
        (await (await session.submit('successor')).wait()).finalOutput,
      ).toBe('successor answer');
      expect(text(server.requests[1])).not.toContain('OPAQUE_COMPLETE_WINDOW');
      expect(text(await session.saveState())).not.toContain(
        'OPAQUE_COMPLETE_WINDOW',
      );
      server.assertExhausted();
    } finally {
      release();
    }
  },
  30_000,
);

nativeIt('runs configured compaction for tool-free Agent.run', async () => {
  const server = new ModelServer([[message('plain answer')]]);
  const compact = vi.fn(async (_body) => window());
  const predicate = vi.fn(() => true);
  await using provider = await providerFor(server);
  const agent = new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Answer briefly.',
    compaction: responsesCompaction({
      client: clientFor(compact),
      model: 'separate-compactor',
      shouldCompact: predicate,
    }),
  });
  expect((await agent.run('plain input')).finalOutput).toBe('plain answer');
  expect(predicate).toHaveBeenCalledTimes(1);
  expect(compact).toHaveBeenCalledTimes(1);
  server.assertExhausted();
});

nativeIt.each(
  [false, true].flatMap((automatic) =>
    [false, true].map((structured) => [automatic, structured] as const),
  ),
)(
  'transforms compaction input before borrowed-client effects (automatic=%s, structured=%s)',
  async (automatic, structured) => {
    const secret = 'COMPACTION_TOOL_SECRET_SENTINEL';
    const server = new ModelServer([
      [call('secret', {}, { callId: 'secret-call' })],
      [message('answer')],
    ]);
    const compact = vi.fn(async (_body) => window());
    const transforms: { purpose: string; model: string }[] = [];
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Answer.',
      model: 'gpt-5.5',
      provider,
      tools: [
        tool({
          name: 'secret',
          parameters: z.object({}),
          execute: () => (structured ? { secret } : secret),
        }),
      ],
      transformContext(context) {
        transforms.push({ purpose: context.purpose, model: context.model });
        return context.items.map((item) =>
          JSON.parse(text(item).replaceAll(secret, '[redacted]')),
        );
      },
      compaction: responsesCompaction({
        client: clientFor(compact),
        model: 'separate-compactor',
        mode: automatic ? 'auto' : 'input',
        shouldCompact: () => automatic,
      }),
    });
    await using session = await agent.session();
    expect((await (await session.submit('go')).wait()).finalOutput).toBe(
      'answer',
    );
    if (!automatic) await session.compact();
    expect(compact).toHaveBeenCalledTimes(1);
    expect(text(compact.mock.calls[0]![0].input)).not.toContain(secret);
    expect(text(compact.mock.calls[0]![0].input)).toContain('[redacted]');
    expect(
      transforms.filter((context) => context.purpose === 'compaction'),
    ).toEqual([{ purpose: 'compaction', model: 'separate-compactor' }]);
    server.assertExhausted();
  },
);

nativeIt.each([false, true])(
  'reconciles transformed instruction echoes through checkpoint restore (altered=%s)',
  async (altered) => {
    const server = new ModelServer([
      [message('old answer')],
      [message('continued')],
    ]);
    await using provider = await providerFor(server);
    const compact = vi.fn(async (body: any) => {
      const output = JSON.parse(JSON.stringify(body.input));
      if (altered) {
        const control = output.find(
          (item: any) => item.type === 'message' && item.role === 'developer',
        );
        control.content = [{ type: 'input_text', text: 'FORGED_CONTROL' }];
      }
      return {
        id: 'echo-window',
        output: [
          ...output,
          { type: 'compaction', encrypted_content: 'OPAQUE_ECHO' },
        ],
      };
    });
    const options = {
      provider,
      model: 'gpt-5.5',
      compaction: responsesCompaction({
        client: clientFor(compact),
        model: 'compactor',
        mode: 'input',
        shouldCompact: () => false,
      }),
      transformContext(context: any) {
        return context.items.map((item: any) =>
          item.type === 'message' && ['developer', 'system'].includes(item.role)
            ? {
                ...item,
                content: [{ type: 'input_text', text: 'REDACTED_CONTROL' }],
              }
            : item,
        );
      },
    };
    const agent = new Agent({
      ...options,
      instructions: 'PRIVATE_APP_ORIGINAL',
    });
    let saved;
    {
      await using session = await agent.session();
      await (await session.submit('original user')).wait();
      await session.update({ instructions: 'PRIVATE_APP_CURRENT' });
      const originals = await session.historySnapshot();
      if (altered) {
        await expect(session.compact()).rejects.toThrow(
          'new or modified instruction or control',
        );
        expect(
          (await (await session.submit('continue after refusal')).wait())
            .finalOutput,
        ).toBe('continued');
      } else {
        await session.compact();
        const after = await session.historySnapshot();
        expect(after.items.slice(0, originals.total)).toEqual(originals.items);
        saved = await session.saveState();
      }
    }
    expect(compact).toHaveBeenCalledTimes(1);
    expect(text(compact.mock.calls[0]![0].input)).toContain('REDACTED_CONTROL');
    expect(text(compact.mock.calls[0]![0].input)).not.toContain('PRIVATE_APP_');
    if (!altered) {
      await using restored = await new Agent({
        ...options,
        instructions: 'PRIVATE_APP_CURRENT',
      }).session({ state: parseSessionState(text(saved)) });
      expect(
        (await (await restored.submit('continue after restore')).wait())
          .finalOutput,
      ).toBe('continued');
    }
    expect(server.requests).toHaveLength(2);
    expect(text(server.requests.at(-1))).toContain('REDACTED_CONTROL');
    expect(text(server.requests.at(-1))).not.toContain('PRIVATE_APP_');
  },
  30000,
);

nativeIt(
  'keeps an added compaction-only instruction outside durable history',
  async () => {
    const server = new ModelServer([
      [message('original answer')],
      [message('continued')],
    ]);
    await using provider = await providerFor(server);
    const compact = vi.fn(async (body: any) => ({
      output: [
        ...body.input,
        { type: 'compaction', encrypted_content: 'OPAQUE_PROJECTED' },
      ],
    }));
    const options = {
      provider,
      model: 'gpt-5.5',
      instructions: 'CANONICAL_INSTRUCTIONS',
      compaction: responsesCompaction({
        client: clientFor(compact),
        model: 'compactor',
        mode: 'input',
        shouldCompact: () => false,
      }),
      transformContext(context: any) {
        if (context.purpose === 'compaction')
          return [
            ...context.items,
            {
              type: 'message',
              role: 'developer',
              content: [{ type: 'input_text', text: 'PROJECTED_ONLY_CONTROL' }],
            },
          ];
      },
    };
    let saved;
    {
      await using session = await new Agent(options).session();
      await (await session.submit('original user')).wait();
      await expect(session.compact()).rejects.toThrow(
        'new or modified instruction or control',
      );
      expect(compact).toHaveBeenCalledTimes(1);
      expect(text(compact.mock.calls[0]![0].input)).toContain(
        'PROJECTED_ONLY_CONTROL',
      );
      saved = await session.saveState();
      expect(text(saved)).not.toContain('PROJECTED_ONLY_CONTROL');
    }
    await using restored = await new Agent(options).session({
      state: parseSessionState(text(saved)),
    });
    expect((await (await restored.submit('continue')).wait()).finalOutput).toBe(
      'continued',
    );
    expect(text(server.requests.at(-1))).not.toContain(
      'PROJECTED_ONLY_CONTROL',
    );
  },
  30000,
);
