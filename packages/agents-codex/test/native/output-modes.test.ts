import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  InteractionRequired,
  NativeProvider,
  OutputValidationError,
  manualTool,
  tool,
  type OutputSpec,
} from '../../src';
import { binding, type NativeThread } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'fixture-output-modes',
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

describe('declaration output modes', () => {
  it('keeps bare strings plain and explicitly wraps native strings', async () => {
    const server = new ModelServer([
      [message('plain, without JSON')],
      [message('{"response":"native text"}')],
      [message('"prompted text"')],
    ]);
    const provider = await providerFor(server);
    const declaration = { instructions: 'Answer.', model: 'gpt-5', provider };
    try {
      const plain = await new Agent({
        ...declaration,
        outputType: z.string(),
      }).run('Plain');
      const native = await new Agent({
        ...declaration,
        outputType: { mode: 'native', schema: z.string() },
      }).run('Native');
      const prompted = await new Agent({
        ...declaration,
        outputType: { mode: 'prompted', schema: z.string() },
      }).run('Prompted');
      expectTypeOf(native.finalOutput).toEqualTypeOf<string>();
      expectTypeOf(prompted.finalOutput).toEqualTypeOf<string>();
      expect(plain.finalOutput).toBe('plain, without JSON');
      expect(native.finalOutput).toBe('native text');
      expect(prompted.finalOutput).toBe('prompted text');
      expect(server.requests[0]).not.toHaveProperty('text.format');
      expect(server.requests[1].text).toMatchObject({
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['response'],
            properties: { response: { type: 'string' } },
          },
        },
      });
      expect(server.requests[2]).not.toHaveProperty('text.format');
      server.assertExhausted();
    } finally {
      await provider.close();
    }
  });

  it('retains constrained bare-string generation and native object/array inference', async () => {
    const server = new ModelServer([
      [message('{"response":"valid"}')],
      [message('{"answer":7}')],
      [message('{"response":[2,3]}')],
    ]);
    const provider = await providerFor(server);
    const declaration = { instructions: 'Answer.', model: 'gpt-5', provider };
    try {
      const constrained = await new Agent({
        ...declaration,
        outputType: z.string().min(2),
      }).run('String');
      const object = await new Agent({
        ...declaration,
        outputType: {
          mode: 'native',
          schema: z.object({ answer: z.number() }),
        },
      }).run('Object');
      const array = await new Agent({
        ...declaration,
        outputType: { mode: 'native', schema: z.array(z.number()) },
      }).run('Array');
      expectTypeOf(object.finalOutput).toEqualTypeOf<{ answer: number }>();
      expectTypeOf(array.finalOutput).toEqualTypeOf<number[]>();
      expect(constrained.finalOutput).toBe('valid');
      expect(object.finalOutput).toEqual({ answer: 7 });
      expect(array.finalOutput).toEqual([2, 3]);
      expect(server.requests[0].text).toHaveProperty('format');
      expect(server.requests[2].text).toMatchObject({
        format: { schema: { properties: { response: { type: 'array' } } } },
      });
      server.assertExhausted();
    } finally {
      await provider.close();
    }
  });

  it('uses direct JSON for prompted arrays, open maps, and transformed parser inputs', async () => {
    const server = new ModelServer([
      [message('[2,3]')],
      [message('{"count":7}')],
      [message('"hello"')],
    ]);
    const provider = await providerFor(server);
    const declaration = { instructions: 'Answer.', model: 'gpt-5', provider };
    try {
      const array = await new Agent({
        ...declaration,
        outputType: { mode: 'prompted', schema: z.array(z.number()) },
      }).run('Array');
      const map = await new Agent({
        ...declaration,
        outputType: {
          mode: 'prompted',
          schema: z.record(z.string(), z.number()),
        },
      }).run('Map');
      const transformed = await new Agent({
        ...declaration,
        outputType: {
          mode: 'prompted',
          schema: z.string().transform((value) => value.length),
        },
      }).run('Transformed');
      expectTypeOf(array.finalOutput).toEqualTypeOf<number[]>();
      expectTypeOf(map.finalOutput).toEqualTypeOf<Record<string, number>>();
      expectTypeOf(transformed.finalOutput).toEqualTypeOf<number>();
      expect(array.finalOutput).toEqual([2, 3]);
      expect(map.finalOutput).toEqual({ count: 7 });
      expect(transformed.finalOutput).toBe(5);
      for (const request of server.requests)
        expect(request).not.toHaveProperty('text.format');
      const transformedInput = JSON.stringify(server.requests[2].input);
      expect(transformedInput).toContain('\\"type\\":\\"string\\"');
      expect(transformedInput).not.toContain('\\"response\\"');
      server.assertExhausted();
    } finally {
      await provider.close();
    }
  });

  it('scopes captured guidance to each root, runs tools once, and caches validation', async () => {
    const validate = vi.fn(() => true);
    const execute = vi.fn(() => 'record');
    const lookup = tool({ name: 'lookup', parameters: z.object({}), execute });
    const server = new ModelServer([
      [call('lookup', {}, { callId: 'output-lookup' })],
      [message('{"label":"first"}')],
      [message('{"label":"second"}')],
      [message('ordinary text after restore')],
    ]);
    const provider = await providerFor(server);
    const declaration = {
      instructions: 'Read a record.',
      model: 'gpt-5',
      provider,
      tools: [lookup],
    };
    const capturedOutput = {
      mode: 'prompted' as const,
      schema: z.object({ label: z.string() }).refine(validate),
    };
    const agent = new Agent({ ...declaration, outputType: capturedOutput });
    const input = {
      role: 'user' as const,
      content: [{ type: 'input_text' as const, text: 'ROOT_FIRST' }],
    };
    const originalInput = structuredClone(input);
    const session = await agent.session();
    try {
      // Later declaration changes cannot rewrite the open Session's output contract.
      agent.outputType = {
        mode: 'native',
        schema: z.object({ label: z.string() }),
      };
      const first = await session.submit(input);
      const one = await first.wait();
      expectTypeOf(one.finalOutput).toEqualTypeOf<{ label: string }>();
      expect(one.finalOutput).toEqual({ label: 'first' });
      expect(await first.wait()).toBe(one);
      expect(
        (await (await session.submit('ROOT_SECOND')).wait()).finalOutput,
      ).toEqual({ label: 'second' });
      expect(await first.wait()).toBe(one);
      expect(input).toEqual(originalInput);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(validate).toHaveBeenCalledTimes(2);
      const state = await session.saveState();
      expect(state.format_version).toBe(4);
      await session.close();
      const requestsBeforeRestore = server.requests.length;
      await expect(new Agent(declaration).session({ state })).rejects.toThrow(
        'matching current output contract',
      );
      expect(server.requests).toHaveLength(requestsBeforeRestore);
      await using restored = await new Agent({
        ...declaration,
        outputType: capturedOutput,
      }).session({ state });
      const plain = await (
        await restored.submitWithOutput('ROOT_PLAIN', z.string())
      ).wait();
      expect(plain.finalOutput).toBe('ordinary text after restore');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(validate).toHaveBeenCalledTimes(2);
      for (const request of server.requests) {
        expect(request).not.toHaveProperty('text.format');
        const messages = request.input as Array<{ role?: string }>;
        const instructions = messages.filter((item) =>
          ['system', 'developer'].includes(item.role ?? ''),
        );
        expect(JSON.stringify(instructions)).not.toContain('Return only JSON');
      }
      const guidance = JSON.stringify(server.requests[0].input);
      expect(guidance).toContain('only for this request');
      expect(guidance).toContain(
        'including its automatic continuations and tool results',
      );
      expect(guidance).toContain('does not apply to later requests');
      // Tool follow-ups retain the original root, and old historical guidance stays scoped.
      expect(JSON.stringify(server.requests[1].input)).toContain('ROOT_FIRST');
      expect(JSON.stringify(server.requests[1].input)).toContain(
        'only for this request',
      );
      const later = server.requests[3].input as Array<{
        role?: string;
        content?: unknown;
      }>;
      const current = later.filter((item) =>
        JSON.stringify(item).includes('ROOT_PLAIN'),
      );
      expect(current).toHaveLength(1);
      expect(JSON.stringify(current[0])).not.toContain('Return only JSON');
      server.assertExhausted();
    } finally {
      await session.close();
      await provider.close();
    }
  });

  it('keeps prompted guidance and parsing across an automatic successor', async () => {
    const native = await binding();
    const nextEvent = native.NativeThread.prototype._next_session_event;
    const submit = native.NativeThread.prototype._submit;
    let originalId: string | undefined;
    let continuations = 0;
    // Project only the unschedulable terminal-to-idle hint and admission guard.
    // Every model request, tool invocation, and history item still comes from Core.
    vi.spyOn(
      native.NativeThread.prototype,
      '_next_session_event',
    ).mockImplementation(async function (this: NativeThread) {
      const raw = await nextEvent.call(this);
      const event = JSON.parse(raw);
      if (
        !originalId &&
        !event.subagent_id &&
        ['task_complete', 'turn_complete'].includes(event.msg.type)
      ) {
        originalId = event.id;
        event.sdk_unsampled_steering = true;
        return JSON.stringify(event);
      }
      return raw;
    });
    vi.spyOn(native.NativeThread.prototype, '_submit').mockImplementation(
      async function (this: NativeThread, raw) {
        const request = JSON.parse(raw);
        if (request.mode !== 'continue_if_idle') return submit.call(this, raw);
        continuations++;
        expect(request.expected_previous_turn_id).toBe(originalId);
        expect(request.input).toEqual([]);
        expect(request).not.toHaveProperty('start.final_output_json_schema');
        return submit.call(
          this,
          JSON.stringify({
            mode: 'start_if_idle',
            input: [{ type: 'text', text: 'projected continuation admission' }],
          }),
        );
      },
    );
    const execute = vi.fn(() => 'one visible tool effect');
    const validate = vi.fn(() => true);
    const server = new ModelServer([
      [call('lookup', {}, { callId: 'successor-lookup' })],
      [message('{"label":"first"}')],
      [message('{"label":"continued"}')],
      [message('{"label":"later"}')],
    ]);
    const provider = await providerFor(server);
    const session = await new Agent({
      instructions: 'Read a record.',
      model: 'gpt-5',
      provider,
      tools: [tool({ name: 'lookup', parameters: z.object({}), execute })],
      outputType: {
        mode: 'prompted',
        schema: z.object({ label: z.string() }).refine(validate),
      },
    }).session();
    try {
      const first = await session.submit('ROOT_AUTOMATIC');
      const continued = await session.wait();
      expectTypeOf(continued.finalOutput).toEqualTypeOf<{ label: string }>();
      expect(continued.finalOutput).toEqual({ label: 'continued' });
      expect(continued.turn.sessionId).toBe(first.sessionId);
      expect(await session.wait()).toBe(continued);
      expect(continuations).toBe(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(validate).toHaveBeenCalledTimes(2);
      const later = await (await session.submit('ROOT_LATER')).wait();
      expect(later.finalOutput).toEqual({ label: 'later' });
      expect(continued.finalOutput).toEqual({ label: 'continued' });
      expect(validate).toHaveBeenCalledTimes(3);
      for (const request of server.requests) {
        expect(request).not.toHaveProperty('text.format');
        const input = request.input as Array<{ role?: string }>;
        const root = input.filter(
          (item) =>
            item.role === 'user' &&
            JSON.stringify(item).includes('ROOT_AUTOMATIC'),
        );
        expect(root).toHaveLength(1);
        expect(JSON.stringify(root[0])).toContain('only for this request');
        expect(JSON.stringify(root[0])).toContain(
          'including its automatic continuations and tool results',
        );
        expect(JSON.stringify(root[0])).toContain(
          'does not apply to later requests',
        );
        const instructions = input.filter((item) =>
          ['system', 'developer'].includes(item.role ?? ''),
        );
        expect(JSON.stringify(instructions)).not.toContain('Return only JSON');
      }
      server.assertExhausted();
    } finally {
      await session.close();
      await provider.close();
    }
  });

  it.each(['native', 'prompted'] as const)(
    'exposes safe %s validation errors and permits a later root',
    async (mode) => {
      const invalid = [
        'private-invalid-json',
        '{"answer":"private-wrong-type"}',
      ];
      const server = new ModelServer([
        ...invalid.map((text) => [message(text)]),
        [message('{"answer":7}')],
        [message('Summary: seven')],
      ]);
      const provider = await providerFor(server);
      const session = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
        outputType: { mode, schema: z.object({ answer: z.number() }) },
      }).session();
      try {
        for (const text of invalid) {
          const turn = await session.submit('Answer');
          const failure = await turn.wait().catch((error: unknown) => error);
          expect(failure).toBeInstanceOf(OutputValidationError);
          if (!(failure instanceof OutputValidationError))
            throw new Error('Expected safe validation error');
          expect(failure.message).toBe(
            'Final output did not match the requested output type',
          );
          expect(failure.rawOutput).toBe(text);
          expect(failure).not.toHaveProperty('cause');
          expect(failure).not.toHaveProperty('issues');
          expect(String(failure)).not.toContain('private');
          await expect(turn.wait()).rejects.toBe(failure);
        }
        const valid = await (await session.submit('Try again')).wait();
        expect(valid.finalOutput).toEqual({ answer: 7 });
        await session.compact();
        expect(await session.wait()).toBe(valid);
        server.assertExhausted();
      } finally {
        await session.close();
        await provider.close();
      }
    },
  );

  it('rejects invalid retry budgets and unrepresentable schemas before acquiring a provider', async () => {
    const invalidRetries = [
      null,
      true,
      false,
      -1,
      1.5,
      NaN,
      Infinity,
      -Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      '2',
    ].map((maxRetries) => ({
      mode: 'prompted' as const,
      schema: z.string(),
      maxRetries,
    }));
    const nativeRetries = [undefined, 0, 1].map((maxRetries) => ({
      mode: 'native' as const,
      schema: z.string(),
      maxRetries,
    }));
    const invalid: OutputSpec<unknown>[] = [
      { mode: 'native', schema: z.record(z.string(), z.number()) },
      { mode: 'prompted', schema: z.date() },
      ...(invalidRetries as unknown as OutputSpec<unknown>[]),
      ...nativeRetries,
    ];
    for (const outputType of invalid) {
      const provider = new NativeProvider();
      const acquire = vi.spyOn(provider, '_acquire');
      await provider.close();
      const failure = await new Agent({
        instructions: 'Answer.',
        provider,
        outputType,
      })
        .session()
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain('NativeProvider is closed');
      expect(acquire).not.toHaveBeenCalled();
    }
  });

  it('requires an interaction handler only for implicit one-shot prompted runs', async () => {
    const decision = manualTool({
      name: 'decision',
      description: 'Ask.',
      parameters: z.object({}),
      result: z.string(),
    });
    const server = new ModelServer([
      [call('decision', {}, { callId: 'prompted-decision' })],
      [message('{"answer":"accepted"}')],
    ]);
    const provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Ask decision.',
      model: 'gpt-5',
      provider,
      tools: [decision],
      outputType: {
        mode: 'prompted',
        schema: z.object({ answer: z.string() }),
      },
    });
    await expect(agent.run('Ask')).rejects.toBeInstanceOf(InteractionRequired);
    expect(server.requests).toHaveLength(0);
    const session = await agent.session();
    try {
      const turn = await session.submit('Ask');
      let action;
      for await (const event of session.events()) {
        if (event.type === 'action_requested') {
          action = event;
          break;
        }
      }
      if (!action) throw new Error('Expected decision request');
      const replyTurn = await session.submit(action.reply('accepted'));
      expect(replyTurn).toBe(turn);
      expect((await turn.wait()).finalOutput).toEqual({ answer: 'accepted' });
      server.assertExhausted();
    } finally {
      await session.close();
      await provider.close();
    }
  });
  it('rejects a prompted declaration when restoring a pending plain checkpoint', async () => {
    const decision = manualTool({
      name: 'decision',
      description: 'Ask.',
      parameters: z.object({}),
      result: z.string(),
    });
    const server = new ModelServer([
      [call('decision', {}, { callId: 'restore-decision' })],
      [message('accepted')],
    ]);
    const provider = await providerFor(server);
    const declaration = {
      instructions: 'Ask.',
      model: 'gpt-5',
      provider,
      tools: [decision],
    };
    const agent = new Agent(declaration);
    const original = await agent.session();
    try {
      await original.submit('Ask');
      for await (const event of original.events()) {
        if (event.type === 'action_requested') break;
      }
      const state = await original.suspend();
      await original.close();
      const prompted = new Agent({
        ...declaration,
        outputType: { mode: 'prompted', schema: z.string() },
      });
      await expect(prompted.session({ state })).rejects.toThrow(
        'matching current output contract',
      );
      expect(server.requests).toHaveLength(1);
      const restored = await agent.session({ state });
      try {
        for await (const event of restored.events()) {
          if (event.type !== 'action_requested') continue;
          const turn = await restored.submit(event.reply('accepted'));
          expect((await turn.wait()).finalOutput).toBe('accepted');
          break;
        }
      } finally {
        await restored.close();
      }
      server.assertExhausted();
    } finally {
      await original.close();
      await provider.close();
    }
  });
});
