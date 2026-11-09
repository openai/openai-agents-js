import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeError,
  NativeProvider,
  tool,
  type CompletionContext,
  type ModelRequestContext,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { nativeDescendantModel } from './fixtures/native-descendant-model';
import { startPublicExecutor } from './fixtures/public-executor';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});
async function providerFor(model: ModelServer) {
  const config = await model.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-context-callback',
    supportsWebsockets: false,
  });
}
function input(text: string, role = 'user'): JsonObject {
  return { type: 'message', role, content: [{ type: 'input_text', text }] };
}
function historyText(value: unknown) {
  return JSON.stringify(value);
}

nativeIt(
  'replaces detached input, preserves roles and prior tool pairs, and never changes canonical history or instructions',
  async () => {
    const model = new ModelServer([[message('done')], [message('next')]]);
    const effects = vi.fn();
    const application = { account: 'owned-context' };
    let observed: ModelRequestContext<typeof application> | undefined;
    await using provider = await providerFor(model);
    await using session = await new Agent<typeof application>({
      instructions: 'CAPTURED_APPLICATION_INSTRUCTIONS',
      provider,
      tools: [
        tool({
          name: 'historical',
          parameters: z.object({}),
          execute: effects,
        }),
      ],
      transformContext: (context) => {
        if (observed) return;
        observed = context;
        return [
          input('SYNTHETIC_SYSTEM', 'system'),
          input('SYNTHETIC_DEVELOPER', 'developer'),
          {
            type: 'function_call',
            name: 'historical',
            call_id: 'old-pair',
            arguments: '{}',
          },
          {
            type: 'function_call_output',
            call_id: 'old-pair',
            output: 'historical result',
          },
          input('SYNTHETIC_ASSISTANT', 'assistant'),
          input('REQUEST_ONLY_INPUT'),
        ];
      },
    }).session({ context: application });
    const turn = await session.submit('CANONICAL_INPUT');
    expect((await turn.wait()).finalOutput).toBe('done');
    expect(observed?.context).toBe(application);
    expect(observed).toMatchObject({
      sessionId: session.id,
      turnId: turn.turnId,
      purpose: 'turn',
    });
    expect(observed?.requestId).toEqual(expect.any(String));
    expect(observed?.model).toBe(model.requests[0]!.model);
    expect(observed).not.toHaveProperty('agent');
    const request = model.requests[0]!;
    const base = 'You are an AI agent. Follow the application instructions';
    expect(historyText(request.input)).toContain(base);
    expect(historyText(observed?.items)).not.toContain(base);
    // Application instructions are editable request items, unlike Core's base prefix.
    expect(historyText(observed?.items)).toContain(
      'CAPTURED_APPLICATION_INSTRUCTIONS',
    );
    expect(historyText(request.input)).not.toContain(
      'CAPTURED_APPLICATION_INSTRUCTIONS',
    );
    const authority = (request.input as JsonObject[]).find(
      (item) => item.type === 'additional_tools',
    );
    expect(authority).toBeDefined();
    expect(historyText(authority)).toContain('historical');
    expect(historyText(observed?.items)).not.toContain('additional_tools');
    expect(request.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'developer' }),
        expect.objectContaining({ role: 'assistant' }),
        expect.objectContaining({
          call_id: 'old-pair',
          type: 'function_call_output',
        }),
      ]),
    );
    expect(historyText(request.input)).toContain('REQUEST_ONLY_INPUT');
    expect(historyText(request.input)).not.toContain('CANONICAL_INPUT');
    expect(effects).not.toHaveBeenCalled();
    const state = await session.saveState();
    expect(historyText(state.history)).toContain('CANONICAL_INPUT');
    expect(historyText(state.history)).not.toContain('REQUEST_ONLY_INPUT');
    expect(historyText(state.history)).not.toContain('old-pair');
    expect((await (await session.submit('next turn')).wait()).finalOutput).toBe(
      'next',
    );
    expect(model.requests).toHaveLength(2);
    expect(historyText(model.requests[1]!.input)).toContain(
      'CAPTURED_APPLICATION_INSTRUCTIONS',
    );
    expect(historyText(model.requests[1]!.input)).not.toContain(
      'REQUEST_ONLY_INPUT',
    );
  },
);

nativeIt(
  'undefined keeps native input even if the detached callback copy was changed',
  async () => {
    const model = new ModelServer([[message('done')]]);
    await using provider = await providerFor(model);
    await using session = await new Agent({
      instructions: 'Test native callbacks.',
      provider,
      transformContext: (context) => {
        const item = context.items.find((item) => item.role === 'user');
        if (item)
          item.content = [{ type: 'input_text', text: 'DETACHED_MUTATION' }];
      },
    }).session();
    expect(
      (await (await session.submit('ORIGINAL_ONLY')).wait()).finalOutput,
    ).toBe('done');
    expect(historyText(model.requests[0]!.input)).toContain('ORIGINAL_ONLY');
    expect(historyText(model.requests[0]!.input)).not.toContain(
      'DETACHED_MUTATION',
    );
  },
);

nativeIt.each(['throw', 'lossy'])(
  'prevents dispatch when context transformation is %s',
  async (mode) => {
    const model = new ModelServer([[message('must not dispatch')]]);
    const failure = new Error('application transform failed');
    await using provider = await providerFor(model);
    await using session = await new Agent({
      instructions: 'Test native callbacks.',
      provider,
      transformContext: () => {
        if (mode === 'throw') throw failure;
        return [{ type: 'item_reference', id: 'unsupported-reference' }];
      },
    }).session();
    const turn = await session.submit('one');
    if (mode === 'throw') await expect(turn.wait()).rejects.toBe(failure);
    else await expect(turn.wait()).rejects.toBeInstanceOf(Error);
    expect(model.requests).toHaveLength(0);
  },
);

nativeIt(
  'runs beforeComplete on raw text before schema conversion and keeps continuations in one turn',
  async () => {
    const model = new ModelServer([
      [message('not valid JSON')],
      [message('{"value":7}')],
    ]);
    const schema = z.object({ value: z.number() });
    const parsed = vi.spyOn(schema, 'parse');
    const proposals: CompletionContext[] = [];
    await using provider = await providerFor(model);
    await using session = await new Agent({
      instructions: 'Test native callbacks.',
      provider,
      outputType: schema,
      beforeComplete: (context) => {
        proposals.push(context);
        if (context.continuationCount === 0)
          return { action: 'continue', instructions: 'Return valid JSON.' };
      },
    }).session();
    const turn = await session.submit('one');
    expect((await turn.wait()).finalOutput).toEqual({ value: 7 });
    expect(proposals.map((context) => context.text)).toEqual([
      'not valid JSON',
      '{"value":7}',
    ]);
    expect(proposals.map((context) => context.continuationCount)).toEqual([
      0, 1,
    ]);
    expect(new Set(proposals.map((context) => context.turnId))).toEqual(
      new Set([turn.turnId]),
    );
    expect(parsed).toHaveBeenCalledTimes(1);
    expect(model.requests).toHaveLength(2);
  },
);

nativeIt(
  'a completion stop prevents another request and leaves the Session usable',
  async () => {
    const model = new ModelServer([
      [message('stopped proposal')],
      [message('next turn')],
    ]);
    let count = 0;
    await using provider = await providerFor(model);
    await using session = await new Agent({
      instructions: 'Test native callbacks.',
      provider,
      beforeComplete: () => {
        if (count++ === 0) return { action: 'stop' };
      },
    }).session();
    const stopped = await (
      await session.submit('stop')
    )
      .wait()
      .catch((error) => error);
    expect(stopped).toBeInstanceOf(NativeError);
    expect(stopped.message).not.toMatch(/expired.*reply|reply.*expired/i);
    expect(model.requests).toHaveLength(1);
    expect((await (await session.submit('next')).wait()).finalOutput).toBe(
      'next turn',
    );
  },
);

nativeIt(
  'completion continuation preserves the existing model-step budget',
  async () => {
    const model = new ModelServer([
      [message('first')],
      [message('must not dispatch')],
    ]);
    await using provider = await providerFor(model);
    const agent = new Agent({
      instructions: 'Test native callbacks.',
      provider,
      beforeComplete: () => ({ action: 'continue', instructions: 'Again.' }),
    });
    await expect(agent.run('one', { maxModelSteps: 1 })).rejects.toBeInstanceOf(
      Error,
    );
    expect(model.requests).toHaveLength(1);
  },
);

nativeIt(
  'captures callbacks at opening and binds fresh application callbacks on restore',
  async () => {
    const model = new ModelServer([[message('first')], [message('restored')]]);
    const captured = vi.fn(),
      late = vi.fn(),
      fresh = vi.fn();
    await using provider = await providerFor(model);
    const agent = new Agent({
      instructions: 'Test native callbacks.',
      provider,
      beforeComplete: captured,
    });
    const session = await agent.session();
    let state;
    try {
      agent.beforeComplete = late;
      expect((await (await session.submit('one')).wait()).finalOutput).toBe(
        'first',
      );
      state = await session.saveState();
    } finally {
      await session.close();
    }
    await using restored = await new Agent({
      instructions: 'Test native callbacks.',
      provider,
      beforeComplete: fresh,
    }).session({ state });
    expect((await (await restored.submit('two')).wait()).finalOutput).toBe(
      'restored',
    );
    expect(captured).toHaveBeenCalledTimes(1);
    expect(late).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
  },
);

nativeIt(
  'joins an entered context callback on cancellation and rejects its late replacement',
  async () => {
    const model = new ModelServer([[message('next turn')]]);
    const entered = Promise.withResolvers<AbortSignal>(),
      release = Promise.withResolvers<void>();
    let calls = 0,
      physicallyFinished = false,
      cancellationFinished = false;
    await using provider = await providerFor(model);
    await using session = await new Agent({
      instructions: 'Test native callbacks.',
      provider,
      transformContext: async (context) => {
        if (calls++ !== 0) return;
        entered.resolve(context.signal);
        await release.promise;
        physicallyFinished = true;
        return [input('LATE_REPLACEMENT')];
      },
    }).session();
    const turn = await session.submit('cancel');
    const result = turn.wait().catch((error) => error);
    try {
      const signal = await entered.promise;
      const cancelling = turn.cancel().then(() => {
        cancellationFinished = true;
      });
      await vi.waitFor(() => expect(signal.aborted).toBe(true));
      expect(cancellationFinished).toBe(false);
      expect(physicallyFinished).toBe(false);
      release.resolve();
      await cancelling;
      expect(await result).toBeInstanceOf(NativeError);
      expect(physicallyFinished).toBe(true);
      expect(model.requests).toHaveLength(0);
      expect((await (await session.submit('next')).wait()).finalOutput).toBe(
        'next turn',
      );
      expect(historyText(model.requests)).not.toContain('LATE_REPLACEMENT');
    } finally {
      release.resolve();
      await result;
    }
  },
);

nativeIt(
  'keeps Session mutation guarded inside completion callbacks',
  async () => {
    const model = new ModelServer([[message('done')]]);
    await using provider = await providerFor(model);
    await using session = await new Agent({
      instructions: 'Test native callbacks.',
      provider,
      beforeComplete: async () => {
        await expect(update()).rejects.toThrow('own session');
      },
    }).session();
    const update = () => session.update({ instructions: 'must not apply' });
    expect((await (await session.submit('one')).wait()).finalOutput).toBe(
      'done',
    );
  },
);

nativeIt(
  'captures output-repair context and purpose without running completion acceptance for the repair',
  async () => {
    const model = new ModelServer([
      [message('invalid')],
      [message('{"value":9}')],
    ]);
    const app = { key: 'repair-context' };
    const requests: ModelRequestContext<typeof app>[] = [],
      completion = vi.fn();
    await using provider = await providerFor(model);
    await using session = await new Agent<typeof app, { value: number }>({
      instructions: 'Test native callbacks.',
      provider,
      outputType: {
        mode: 'prompted',
        schema: z.object({ value: z.number() }),
        maxRetries: 1,
      },
      beforeComplete: completion,
      transformContext: (context) => {
        requests.push(context);
      },
    }).session({ context: app });
    expect((await (await session.submit('one')).wait()).finalOutput).toEqual({
      value: 9,
    });
    expect(requests.map((request) => request.purpose)).toEqual([
      'turn',
      'output_repair',
    ]);
    expect(requests.every((request) => request.context === app)).toBe(true);
    expect(completion).toHaveBeenCalledTimes(1);
  },
);

nativeIt(
  'transforms actual summarizing compaction and does not run completion acceptance for it',
  async () => {
    const model = new ModelServer([
      [message('initial')],
      [message('compact summary')],
    ]);
    const purposes: string[] = [],
      completion = vi.fn();
    await using provider = await providerFor(model);
    await using session = await new Agent({
      instructions: 'Test native callbacks.',
      provider,
      beforeComplete: completion,
      transformContext: (context) => {
        purposes.push(context.purpose);
      },
    }).session();
    await (await session.submit('one')).wait();
    await session.compact();
    expect(purposes).toEqual(['turn', 'compaction']);
    expect(completion).toHaveBeenCalledTimes(1);
    expect(model.requests).toHaveLength(2);
  },
);

nativeIt(
  'reuses one context transformation across an HTTP transport retry',
  async () => {
    const model = new ModelServer([
      { status: 503, body: '{"error":{"message":"retry"}}' },
      [message('done')],
    ]);
    const transform = vi.fn(() => [input('ONE_CAPTURE')]);
    await using provider = await providerFor(model);
    await using session = await new Agent({
      instructions: 'Test native callbacks.',
      provider,
      transformContext: transform,
    }).session();
    expect((await (await session.submit('one')).wait()).finalOutput).toBe(
      'done',
    );
    expect(model.requests).toHaveLength(2);
    expect(transform).toHaveBeenCalledTimes(1);
    expect(model.requests[0]!.input).toEqual(model.requests[1]!.input);
  },
);

nativeIt(
  'captures destination profile callbacks even when the opening Agent has none',
  async () => {
    const model = new ModelServer([
      [call('transfer_to_b', {}, { callId: 'handoff' })],
      [message('B final')],
    ]);
    const accepted = vi.fn(),
      late = vi.fn(),
      transformed = vi.fn();
    await using provider = await providerFor(model);
    const destination = new Agent({
      name: 'B',
      instructions: 'B base',
      provider,
      beforeComplete: accepted,
      transformContext: transformed,
    });
    await using session = await new Agent({
      instructions: 'Test native callbacks.',
      name: 'A',
      provider,
      handoffs: [destination],
    }).session();
    destination.beforeComplete = late;
    destination.transformContext = late;
    expect((await (await session.submit('one')).wait()).finalOutput).toBe(
      'B final',
    );
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(transformed).toHaveBeenCalledTimes(1);
    expect(late).not.toHaveBeenCalled();
    expect(historyText(model.requests[1]!.input)).toContain('B base');
  },
);

nativeIt(
  'terminal acceptance receives detached validated JSON and parses the proposal once',
  async () => {
    const model = new ModelServer([[call('finish', {}, { callId: 'finish' })]]);
    const schema = z.object({ value: z.number() });
    const parsed = vi.spyOn(schema, 'parse');
    await using provider = await providerFor(model);
    await using session = await new Agent({
      instructions: 'Test native callbacks.',
      provider,
      outputType: schema,
      tools: [
        tool({
          name: 'finish',
          parameters: z.object({}),
          finishTurn: true,
          execute: () => ({ value: 7 }),
        }),
      ],
      beforeComplete: (context) => {
        expect(context.text).toBeNull();
        expect(context.toolCall).toMatchObject({
          callId: 'finish',
          tool: { name: 'finish' },
        });
        expect(context.finalOutput).toEqual({ value: 7 });
        (context.finalOutput as { value: number }).value = 999;
      },
    }).session();
    expect((await (await session.submit('one')).wait()).finalOutput).toEqual({
      value: 7,
    });
    expect(parsed).toHaveBeenCalledTimes(1);
    expect(model.requests).toHaveLength(1);
  },
);

nativeIt(
  'terminal continuation discards its provisional value and advances the shared continuation count',
  async () => {
    const model = new ModelServer([
      [call('finish', {}, { callId: 'finish' })],
      [message('natural final')],
    ]);
    const contexts: CompletionContext[] = [],
      effects = vi.fn(() => 'provisional');
    await using provider = await providerFor(model);
    await using session = await new Agent({
      instructions: 'Test native callbacks.',
      provider,
      tools: [
        tool({
          name: 'finish',
          parameters: z.object({}),
          finishTurn: true,
          execute: effects,
        }),
      ],
      beforeComplete: (context) => {
        contexts.push(context);
        if (context.toolCall)
          return {
            action: 'continue',
            instructions: 'Continue with a natural answer.',
          };
      },
    }).session();
    const turn = await session.submit('one');
    const result = await turn.wait();
    expect(result.finalOutput).toBe('natural final');
    expect(result.toolCall).toBeUndefined();
    expect(contexts.map((context) => context.continuationCount)).toEqual([
      0, 1,
    ]);
    expect(contexts.every((context) => context.turnId === turn.turnId)).toBe(
      true,
    );
    expect(effects).toHaveBeenCalledTimes(1);
  },
);

nativeIt.each(['accept', 'stop'] as const)(
  'applies captured hooks to a real native child (%s) without changing its root owner',
  async (mode) => {
    let rootId: string | undefined;
    const counts = new Map<string, number>();
    const respond = (request: JsonObject) => {
      const metadata = request.client_metadata as Record<string, string>;
      const id = String(
        JSON.parse(metadata['x-codex-turn-metadata']!).thread_id,
      );
      rootId ??= id;
      const count = (counts.get(id) ?? 0) + 1;
      counts.set(id, count);
      return id === rootId && count === 1
        ? [
            call(
              'spawn_agent',
              { task_name: 'child', message: 'Answer child.' },
              { namespace: 'collaboration', callId: 'spawn' },
            ),
          ]
        : [message(id === rootId ? 'root final' : 'child final')];
    };
    const model = new ModelServer(Array.from({ length: 3 }, () => respond));
    const observed: CompletionContext[] = [],
      contexts: ModelRequestContext[] = [];
    const executor = await startPublicExecutor();
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Test native callbacks.',
        provider,
        model: nativeDescendantModel,
        tools: [new NativeAgents()],
        transformContext: (context) => {
          contexts.push(context);
        },
        beforeComplete: (context) => {
          observed.push(context);
          if (context.subagentId && mode === 'stop') return { action: 'stop' };
        },
      }).session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
      });
      expect(
        (await (await session.submit('delegate')).wait()).finalOutput,
      ).toBe('root final');
      const children = await vi.waitUntil(async () => {
        const entries = await Array.fromAsync(session.subagents());
        return entries.length === 1 && entries[0]!.turn ? entries : false;
      });
      const child = children[0]!,
        turn = child.turn!;
      if (mode === 'accept')
        expect((await turn.wait()).finalOutput).toBe('child final');
      else await expect(turn.wait()).rejects.toBeInstanceOf(NativeError);
      const proposal = observed.find(
        (context) => context.subagentId === child.id,
      );
      expect(proposal).toMatchObject({
        sessionId: session.id,
        turnId: turn.turnId,
        text: 'child final',
      });
      expect(
        contexts.some(
          (context) =>
            context.subagentId === child.id && context.turnId === turn.turnId,
        ),
      ).toBe(true);
      expect(
        observed.some(
          (context) =>
            context.subagentId === undefined && context.text === 'root final',
        ),
      ).toBe(true);
    } finally {
      await executor.close();
    }
  },
);

nativeIt(
  'honors steering admitted while completion acceptance is waiting',
  async () => {
    const model = new ModelServer([
      [message('old proposal')],
      [message('answer after steering')],
    ]);
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let calls = 0;
    await using provider = await providerFor(model);
    await using session = await new Agent({
      instructions: 'Respond to current input.',
      provider,
      beforeComplete: async () => {
        if (calls++ === 0) {
          entered.resolve();
          await release.promise;
        }
      },
    }).session();
    const original = await session.submit('initial input');
    const outcome = original.wait();
    outcome.catch(() => {});
    try {
      await entered.promise;
      await original.steer('STEER_DURING_ACCEPTANCE');
      release.resolve();
      expect((await outcome).finalOutput).toBe('answer after steering');
      expect(model.requests).toHaveLength(2);
      expect(historyText(model.requests[1]!.input)).toContain(
        'STEER_DURING_ACCEPTANCE',
      );
      expect(calls).toBe(2);
    } finally {
      release.resolve();
      await outcome.catch(() => {});
    }
  },
);

nativeIt(
  'terminal Stop acknowledges its reply and never accepts a provisional value',
  async () => {
    const model = new ModelServer([
      [call('finish', {}, { callId: 'stopped-finish' })],
      [message('healthy later turn')],
    ]);
    const effects = vi.fn(() => 'provisional');
    await using provider = await providerFor(model);
    await using session = await new Agent({
      instructions: 'Finish.',
      provider,
      tools: [
        tool({
          name: 'finish',
          parameters: z.object({}),
          finishTurn: true,
          execute: effects,
        }),
      ],
      beforeComplete: (context) => {
        if (context.toolCall) {
          expect(context.toolCall.callId).toBe('stopped-finish');
          return { action: 'stop' };
        }
      },
    }).session();
    const result = await (
      await session.submit('one')
    )
      .wait()
      .catch((error) => error);
    expect(result).toBeInstanceOf(NativeError);
    expect(result.message).not.toMatch(/expired.*reply|reply.*expired/i);
    expect(effects).toHaveBeenCalledTimes(1);
    expect(model.requests).toHaveLength(1);
    const state = await session.saveState();
    expect(
      state.history.some(
        (row) =>
          row.type === 'event_msg' &&
          row.payload &&
          typeof row.payload === 'object' &&
          !Array.isArray(row.payload) &&
          row.payload.tool_completion,
      ),
    ).toBe(false);
    expect((await (await session.submit('later')).wait()).finalOutput).toBe(
      'healthy later turn',
    );
    expect(model.requests).toHaveLength(2);
  },
);

nativeIt(
  'preserves literal JSON through terminal acceptance and its detached proposal',
  async () => {
    const model = new ModelServer([
      [call('finish_literal', {}, { callId: 'literal-terminal' })],
    ]);
    const value = () =>
      JSON.parse(
        '{"key":"kept","__proto__":{"literalTop":true},"nested":{"__proto__":{"literalNested":true}}}',
      ) as JsonObject;
    let validations = 0;
    const schema = z.object({ payload: z.unknown() }).transform((value) => {
      validations++;
      return value;
    });
    await using provider = await providerFor(model);
    await using session = await new Agent({
      instructions: 'Finish once.',
      model: 'gpt-5',
      provider,
      outputType: { mode: 'prompted', schema },
      tools: [
        tool({
          name: 'finish_literal',
          parameters: z.object({}),
          finishTurn: true,
          execute: () => JSON.stringify({ payload: value() }),
        }),
      ],
      beforeComplete: (context) => {
        const proposal = context.finalOutput as { payload: JsonObject };
        expect(Object.hasOwn(proposal.payload, '__proto__')).toBe(true);
        expect(
          Object.hasOwn(proposal.payload.nested as JsonObject, '__proto__'),
        ).toBe(true);
        expect(proposal.payload).toEqual(value());
        expect(Object.getPrototypeOf(proposal.payload)).toBe(Object.prototype);
        proposal.payload.key = 'changed detached proposal';
      },
    }).session();
    const result = await (await session.submit('finish')).wait();
    expect(result.finalOutput.payload).toEqual(value());
    expect(
      Object.hasOwn(result.finalOutput.payload as object, '__proto__'),
    ).toBe(true);
    expect(validations).toBe(1);
    expect(Object.prototype).not.toHaveProperty('literalTop');
    expect(Object.prototype).not.toHaveProperty('literalNested');
    expect(JSON.stringify((await session.saveState()).history)).toContain(
      'literalTop',
    );
  },
);

nativeIt(
  'preserves literal JSON keys in a request-only tool presentation',
  async () => {
    const model = new ModelServer([[message('done')]]);
    const parameters = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"}}}',
    ) as JsonObject;
    await using provider = await providerFor(model);
    await using session = await new Agent({
      instructions: 'Test request projection.',
      provider,
      transformContext: ({ items }) => [
        ...items,
        {
          type: 'additional_tools',
          role: 'developer',
          tools: [
            {
              type: 'function',
              name: 'presentation_only',
              description: 'Request-only schema data.',
              parameters,
              strict: false,
            },
          ],
        },
      ],
    }).session();
    expect((await (await session.submit('one')).wait()).finalOutput).toBe(
      'done',
    );
    const projected = (model.requests[0]!.input as JsonObject[]).find(
      (item) =>
        item.type === 'additional_tools' &&
        JSON.stringify(item).includes('presentation_only'),
    );
    expect(projected).toBeDefined();
    const definition = (projected!.tools as JsonObject[])[0]!;
    const properties = (definition.parameters as JsonObject)
      .properties as JsonObject;
    expect(Object.hasOwn(properties, '__proto__')).toBe(true);
    expect(properties['__proto__']).toEqual({ type: 'string' });
    expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
    expect(JSON.stringify((await session.saveState()).history)).not.toContain(
      'presentation_only',
    );
  },
);
