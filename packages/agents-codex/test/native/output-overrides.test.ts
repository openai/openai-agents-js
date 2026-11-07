import {
  firstNativeBatchWire,
  replaceSingletonNativeBatchEvent,
} from '../fixtures/native-event-batches';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  OutputValidationError,
  manualTool,
  tool,
  type ActionRequested,
  type Session,
  type SubmitOptions,
  type Turn,
} from '../../src';
import { binding, type NativeThread } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (
      config['model_providers.fixture'] as {
        base_url: string;
      }
    ).base_url,
    apiKey: 'synthetic-overrides',
  });
}
async function nextAction(session: Session<unknown>): Promise<ActionRequested> {
  for await (const event of session.events())
    if (event.type === 'action_requested') return event;
  throw new Error('Expected live manual request');
}
afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});
describe('persistent per-operation output contracts', () => {
  it('infers different root types in one conversation and restores the opening default', async () => {
    const server = new ModelServer([
      [message('{"label":"default"}')],
      [message('{"response":7}')],
      [message('ordinary text')],
      [message('{"count":2}')],
      [message('"hello"')],
      [message('{"label":"again"}')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
      outputType: z.object({ label: z.string() }),
    }).session();
    const first = await (await session.submit('DEFAULT_ROOT')).wait();
    const options = { outputType: z.number() };
    const count = await session.submit('COUNT_ROOT', {
      outputType: options.outputType,
    });
    expectTypeOf(count).toEqualTypeOf<Turn<number>>();
    expect((await count.wait()).finalOutput).toBe(7);
    const plain = await session.submit('PLAIN_ROOT', {
      outputType: z.string(),
    });
    expect((await plain.wait()).finalOutput).toBe('ordinary text');
    const map = await session.submit('MAP_ROOT', {
      outputType: {
        mode: 'prompted',
        schema: z.record(z.string(), z.number()),
      },
    });
    expectTypeOf(map).toEqualTypeOf<Turn<Record<string, number>>>();
    expect((await map.wait()).finalOutput).toEqual({ count: 2 });
    const transformed = await session.submit('TRANSFORM_ROOT', {
      outputType: {
        mode: 'prompted',
        schema: z.string().transform((text) => text.length),
      },
    });
    expectTypeOf(transformed).toEqualTypeOf<Turn<number>>();
    expect((await transformed.wait()).finalOutput).toBe(5);
    const last = await session.submit('DEFAULT_AGAIN');
    expectTypeOf(last).toEqualTypeOf<
      Turn<{
        label: string;
      }>
    >();
    expect((await session.wait()).finalOutput).toEqual({ label: 'again' });
    expect(await first.turn.wait()).toBe(first);
    expect(server.requests[0].text).toHaveProperty(
      'format.schema.properties.label',
    );
    expect(server.requests[1].text).toHaveProperty(
      'format.schema.properties.response',
    );
    for (const request of server.requests.slice(2, 5))
      expect(request).not.toHaveProperty('text.format');
    expect(JSON.stringify(server.requests[3].input)).toContain(
      'only for this request',
    );
    expect(server.requests[5].text).toEqual(server.requests[0].text);
    server.assertExhausted();
  });
  it('guards fixed and widened aliases while exact steering remains usable', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = new ModelServer([
      [call('hold', {}, { callId: 'hold' })],
      (request) => {
        expect(JSON.stringify(request.input)).toContain('EXACT_DETAIL');
        expect(JSON.stringify(request.input)).not.toContain('REJECTED_DETAIL');
        return [message('{"response":8}')];
      },
      [message('default again')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Use hold.',
      model: 'gpt-5',
      provider,
      tools: [
        tool({
          name: 'hold',
          parameters: z.object({}),
          async execute() {
            entered.resolve();
            await release.promise;
            return 'one effect';
          },
        }),
      ],
    }).session();
    const fixed: Session<string> = session;
    const wider: Session<unknown> = session;
    try {
      const turn = await wider.submit('COUNT', { outputType: z.number() });
      await entered.promise;
      await expect(fixed.wait()).rejects.toThrow('returned Turn');
      await expect(fixed.submit('REJECTED_DETAIL')).rejects.toThrow('settled');
      await expect(
        session.submit('REJECTED_DETAIL', { outputType: z.string() }),
      ).rejects.toThrow('settled');
      await turn.steer('EXACT_DETAIL');
      release.resolve();
      const completed = await turn.wait();
      expect(completed.finalOutput).toBe(8);
      expect(await turn.wait()).toBe(completed);
      await expect(wider.wait()).rejects.toThrow('returned Turn');
      expect((await (await fixed.submit('DEFAULT')).wait()).finalOutput).toBe(
        'default again',
      );
      expect((await fixed.wait()).finalOutput).toBe('default again');
      server.assertExhausted();
    } finally {
      release.resolve();
    }
  });
  it('rejects legacy manual return paths before result validation and shares no-result delivery', async () => {
    const validate = vi.fn(() => true);
    const decision = manualTool({
      name: 'decision',
      description: 'Ask.',
      parameters: z.object({}),
      result: z.string().refine(validate),
    });
    const server = new ModelServer([
      [call('decision', {}, { callId: 'decision' })],
      [message('{"response":9}')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Ask.',
      model: 'gpt-5',
      provider,
      tools: [decision],
    }).session();
    const turn = await session.submit('COUNT', { outputType: z.number() });
    const action = await nextAction(session);
    const reply = action.reply('yes');
    // @ts-expect-error Replies cannot start user work.
    await expect(session.submit(reply)).rejects.toThrow('Session.respond');
    await expect(
      session.submit({
        // @ts-expect-error Raw results are delivered with respond.
        type: 'function_call_output',
        call_id: action.callId,
        output: 'yes',
      }),
    ).rejects.toThrow('Session.respond');
    expect(validate).not.toHaveBeenCalled();
    await expect(
      session.respond({
        type: 'function_call_output',
        call_id: 'foreign',
        output: 'yes',
      }),
    ).rejects.toThrow('pending call');
    expect(validate).not.toHaveBeenCalled();
    expect(await session.respond(reply)).toBeUndefined();
    expect(validate).toHaveBeenCalledTimes(1);
    expect((await turn.wait()).finalOutput).toBe(9);
    await expect(session.respond(reply)).rejects.toThrow('pending call');
    expect(validate).toHaveBeenCalledTimes(1);
    server.assertExhausted();
  });
  it('publishes the marker before admission and captures a default wait independently of a later override', async () => {
    const native = await binding();
    const submit = native.NativeThread.prototype._submit;
    const release = Promise.withResolvers<void>();
    let gate = true;
    vi.spyOn(native.NativeThread.prototype, '_submit').mockImplementation(
      async function (this: NativeThread, raw) {
        if (gate && JSON.parse(raw).mode === 'start_if_idle') {
          gate = false;
          await release.promise;
        }
        return submit.call(this, raw);
      },
    );
    const server = new ModelServer([
      [message('{"response":1}')],
      [message('default')],
      [message('{"response":2}')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    }).session();
    try {
      const admission = session.submit('OVERRIDE', { outputType: z.number() });
      const guarded = session.wait().catch((error: unknown) => error);
      release.resolve();
      const first = await admission;
      expect((await first.wait()).finalOutput).toBe(1);
      expect(await guarded).toBeInstanceOf(TypeError);
      const defaultAdmission = session.submit('DEFAULT');
      const captured = session.wait();
      const normal = await defaultAdmission;
      const defaultResult = await normal.wait();
      const later = await session.submit('LATER', { outputType: z.number() });
      expect((await later.wait()).finalOutput).toBe(2);
      expect(await captured).toBe(defaultResult);
      await expect(session.wait()).rejects.toThrow('returned Turn');
      server.assertExhausted();
    } finally {
      release.resolve();
    }
  });
  it.each(['native', 'prompted'] as const)(
    'inherits the captured %s contract through a real native successor',
    async (mode) => {
      const native = await binding();
      const nextEvent = native.NativeThread.prototype._next_session_events;
      const submit = native.NativeThread.prototype._submit;
      let originalId: string | undefined;
      vi.spyOn(
        native.NativeThread.prototype,
        '_next_session_events',
      ).mockImplementation(async function (this: NativeThread) {
        const raw = await nextEvent.call(this);
        const event = JSON.parse(firstNativeBatchWire(raw));
        if (
          !originalId &&
          !event.subagent_id &&
          ['task_complete', 'turn_complete'].includes(event.msg.type)
        ) {
          originalId = event.id;
          event.sdk_unsampled_steering = true;
          return replaceSingletonNativeBatchEvent(raw, event);
        }
        return raw;
      });
      vi.spyOn(native.NativeThread.prototype, '_submit').mockImplementation(
        async function (this: NativeThread, raw) {
          const request = JSON.parse(raw);
          if (request.mode !== 'continue_if_idle')
            return submit.call(this, raw);
          expect(request.expected_previous_turn_id).toBe(originalId);
          expect(request.input).toEqual([]);
          if (mode === 'native')
            expect(request.start).toHaveProperty(
              'final_output_json_schema.properties.response.type',
              'number',
            );
          else expect(request).not.toHaveProperty('start');
          return submit.call(
            this,
            JSON.stringify({
              mode: 'start_if_idle',
              input: [
                { type: 'text', text: 'projected continuation admission' },
              ],
              start: request.start,
            }),
          );
        },
      );
      const execute = vi.fn();
      const validate = vi.fn(() => true);
      const server = new ModelServer([
        [call('lookup', {}, { callId: 'owned-lookup' })],
        [message(mode === 'native' ? '{"response":1}' : '1')],
        [message(mode === 'native' ? '{"response":2}' : '2')],
        [message('default after successor')],
      ]);
      await using provider = await providerFor(server);
      let callbackTurn: Turn<unknown> | undefined;
      await using session = await new Agent({
        instructions: 'Lookup once.',
        model: 'gpt-5',
        provider,
        tools: [
          tool({
            name: 'lookup',
            parameters: z.object({}),
            async execute(_args, context) {
              const own = context.submission;
              if (!('wait' in own)) throw new Error('Expected root callback');
              expectTypeOf(own).toEqualTypeOf<Turn<unknown>>();
              callbackTurn = own;
              expect(() => own.wait()).toThrow();
              await expect(
                session.respond({
                  type: 'function_call_output',
                  call_id: 'foreign',
                  output: 'no',
                }),
              ).rejects.toThrow('callback');
              execute();
              return 'one effect';
            },
          }),
        ],
      }).session();
      const turn = await session.submit('ROOT_OVERRIDE', {
        outputType: {
          mode,
          schema: z.number().refine(validate),
        },
      });
      const completed = await turn.wait();
      expect(completed.turn).toBe(turn);
      expect(callbackTurn).toBe(turn);
      expect(completed.finalOutput).toBe(2);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(validate).toHaveBeenCalledTimes(2);
      expect(await turn.wait()).toBe(completed);
      await expect(session.wait()).rejects.toThrow('returned Turn');
      for (const request of server.requests) {
        if (mode === 'native')
          expect(request.text).toHaveProperty(
            'format.schema.properties.response.type',
            'number',
          );
        else {
          expect(request).not.toHaveProperty('text.format');
          const input = request.input as Array<{
            role?: string;
          }>;
          const original = input.filter(
            (item) =>
              item.role === 'user' &&
              JSON.stringify(item).includes('ROOT_OVERRIDE'),
          );
          expect(original).toHaveLength(1);
          expect(JSON.stringify(original[0])).toContain(
            'only for this request',
          );
          const instructions = input.filter((item) =>
            ['system', 'developer'].includes(item.role ?? ''),
          );
          expect(JSON.stringify(instructions)).not.toContain(
            'Return only JSON',
          );
        }
      }
      const later = await session.submit('DEFAULT');
      expect((await later.wait()).finalOutput).toBe('default after successor');
      expect(await turn.wait()).toBe(completed);
      expect(validate).toHaveBeenCalledTimes(2);
      server.assertExhausted();
    },
  );
  it('retains override guards through compaction and idle capture, but restores a fresh default', async () => {
    const server = new ModelServer([
      [message('{"response":4}')],
      [message('Summary: four')],
      [message('new default')],
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    });
    await using session = await agent.session();
    const turn = await session.submit('COUNT', { outputType: z.number() });
    const completed = await turn.wait();
    await session.compact();
    const state = await session.saveState();
    expect(state.format_version).toBe(4);
    if (state.format_version !== 4)
      throw new Error('Expected output-aware idle state');
    expect(state.output_context.mode).toBe('plain');
    await expect(session.wait()).rejects.toThrow('returned Turn');
    expect(await turn.wait()).toBe(completed);
    await session.close();
    expect((await agent.run('DEFAULT', { state })).finalOutput).toBe(
      'new default',
    );
    server.assertExhausted();
  });
  it('uses the selected plain contract for pending capture on a structured-default Session', async () => {
    const decision = manualTool({
      name: 'decision',
      description: 'Ask.',
      parameters: z.object({}),
      result: z.string(),
    });
    const server = new ModelServer([
      [call('decision', {}, { callId: 'plain-override' })],
      [message('accepted')],
    ]);
    await using provider = await providerFor(server);
    const declaration = {
      instructions: 'Ask.',
      model: 'gpt-5',
      provider,
      tools: [decision],
    };
    await using session = await new Agent({
      ...declaration,
      outputType: z.number(),
    }).session();
    const turn = await session.submit('ASK', { outputType: z.string() });
    await nextAction(session);
    const failed = turn.wait().catch((error: unknown) => error);
    const state = await session.suspend();
    expect(await failed).toHaveProperty('state');
    await session.close();
    await using restored = await new Agent(declaration).session({ state });
    const action = await nextAction(restored);
    await restored.respond(action.reply('yes'));
    expect((await restored.wait()).finalOutput).toBe('accepted');
    server.assertExhausted();
  });
  it.each(['native'] as const)(
    'retains the selected %s contract when capturing a pending plain-default root',
    async (mode) => {
      const decision = manualTool({
        name: 'decision',
        description: 'Ask.',
        parameters: z.object({}),
        result: z.string(),
      });
      const server = new ModelServer([
        [call('decision', {}, { callId: mode })],
        [message('{"response":3}')],
      ]);
      await using provider = await providerFor(server);
      const declaration = {
        instructions: 'Ask.',
        model: 'gpt-5',
        provider,
        tools: [decision],
      };
      await using session = await new Agent(declaration).session();
      const output = {
        mode,
        schema: z.number(),
      };
      const turn = await session.submit('ASK', { outputType: output });
      const action = await nextAction(session);
      const stale = action.reply('yes');
      const interrupted = turn.wait().catch((error: unknown) => error);
      const state = await session.suspend();
      expect(await interrupted).toHaveProperty('state');
      expect(state).toMatchObject({
        format_version: 5,
        manual_continuation: {
          turn_id: turn.turnId,
          pending_manual: [{ call_id: mode }],
        },
      });
      await session.close();
      await expect(new Agent(declaration).session({ state })).rejects.toThrow(
        'matching current output contract',
      );
      await using restored = await new Agent({
        ...declaration,
        outputType: output,
      }).session({ state });
      await expect(restored.respond(stale)).rejects.toThrow();
      expect(server.requests).toHaveLength(1);
      const current = await nextAction(restored);
      expect(current.callId).toBe(mode);
      const resumed = restored.restoredTurn;
      expectTypeOf(resumed).toEqualTypeOf<Turn<number> | null>();
      if (!resumed) throw new Error('Expected the restored typed root');
      expect(resumed.turnId).toBe(turn.turnId);
      await restored.respond(current.reply('yes'));
      expect((await resumed.wait()).finalOutput).toBe(3);
      expect(server.requests).toHaveLength(2);
      expect(server.requests[1].text).toEqual(server.requests[0].text);
      server.assertExhausted();
    },
  );
  it('keeps guards for an explicit override that reuses the default schema', async () => {
    const schema = z.object({ label: z.string() });
    const server = new ModelServer([[message('{"label":"same"}')]]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
      outputType: schema,
    }).session();
    const turn = await session.submit('SAME', { outputType: schema });
    expect((await turn.wait()).finalOutput).toEqual({ label: 'same' });
    await expect(session.wait()).rejects.toThrow('returned Turn');
    server.assertExhausted();
  });
  it('joins override cancellation without replacing it with output validation', async () => {
    const entered = Promise.withResolvers<void>();
    const validate = vi.fn(() => true);
    const cleaned = vi.fn();
    const server = new ModelServer([
      [call('hold', {}, { callId: 'cancel-override' })],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Use hold.',
      model: 'gpt-5',
      provider,
      tools: [
        tool({
          name: 'hold',
          parameters: z.object({}),
          async execute(_args, context) {
            entered.resolve();
            await new Promise<void>((resolve) =>
              context.signal.addEventListener('abort', () => resolve(), {
                once: true,
              }),
            );
            cleaned();
            return 'cancelled tool';
          },
        }),
      ],
    }).session();
    const turn = await session.submit('CANCEL', {
      outputType: z.number().refine(validate),
    });
    const result = turn.wait().catch((error: unknown) => error);
    await entered.promise;
    await turn.cancel();
    expect(cleaned).toHaveBeenCalledTimes(1);
    expect(await result).toBeInstanceOf(Error);
    expect(await result).not.toBeInstanceOf(OutputValidationError);
    await expect(turn.wait()).rejects.toBe(await result);
    expect(validate).not.toHaveBeenCalled();
    server.assertExhausted();
  });
  it('rejects hidden output selection through a structurally erased options alias', async () => {
    const server = new ModelServer([
      [message('default')],
      [message('{"response":7}')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Count.',
      model: 'gpt-5',
      provider,
    }).session();
    const chosen = { ifBusy: 'reject' as const, outputType: z.number() };
    const normal = await session.submit('Normal', { ifBusy: 'reject' });
    expectTypeOf(normal).toEqualTypeOf<Turn<string>>();
    expect((await normal.wait()).finalOutput).toBe('default');
    const explicit = await session.submit('Count', {
      outputType: chosen.outputType,
    });
    expectTypeOf(explicit).toEqualTypeOf<Turn<number>>();
    expect((await explicit.wait()).finalOutput).toBe(7);
    server.assertExhausted();
  });

  it('rejects unsupported override options and schemas before native input, and retains validation failures', async () => {
    const server = new ModelServer([
      [message('private-invalid')],
      [message('default')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    }).session();

    await expect(
      session.submit('NO_INPUT', {
        outputType: z.record(z.string(), z.number()),
      }),
    ).rejects.toThrow('open maps');
    expect(server.requests).toHaveLength(0);
    const turn = await session.submit('INVALID', { outputType: z.number() });
    const failure = await turn.wait().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OutputValidationError);
    await expect(turn.wait()).rejects.toBe(failure);
    expect((await (await session.submit('DEFAULT')).wait()).finalOutput).toBe(
      'default',
    );
    server.assertExhausted();
  });
});
// Compile-only API checks: no model/provider effects.
function checkTypes(session: Session<string>) {
  const schema = z.number();
  expectTypeOf(session.submit('count', { outputType: schema })).toEqualTypeOf<
    Promise<Turn<number>>
  >();
  const normal: SubmitOptions = { ifBusy: 'reject' };
  expectTypeOf(session.submit('normal', normal)).toEqualTypeOf<
    Promise<Turn<string>>
  >();
  // @ts-expect-error The removed branch-local method is not a public API.
  session.submitWithOutput<number>('count');
  // @ts-expect-error submitWithOutput accepts a schema, not a second options object.
  session.submit('count', { ...{ ifBusy: 'steer' }, outputType: schema });
}
void checkTypes;
