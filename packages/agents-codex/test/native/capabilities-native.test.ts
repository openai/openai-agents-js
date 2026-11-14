import {
  firstNativeBatchWire,
  replaceSingletonNativeBatchEvent,
} from '../fixtures/native-event-batches';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  CapabilityError,
  Environment,
  NativeAgents,
  NativeError,
  NativeProvider,
  checklist,
  localStorage,
  manualTool,
  parseSessionState,
  readSessionInstructions,
  tool,
  type ActionRequested,
  type FeatureName,
  type Session,
  type SessionState,
} from '../../src';
import {
  binding,
  encodeReceipt,
  type NativeThread,
} from '../../src/runtime/binding';
import { parseEvent } from '../../src/runtime/events';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-capabilities',
    supportsWebsockets: false,
  });
}

async function nextAction(
  session: Session<unknown>,
  submissionId?: string,
): Promise<ActionRequested> {
  for await (const event of session.events())
    if (
      event.type === 'action_requested' &&
      (submissionId === undefined || event.submissionId === submissionId)
    )
      return event;
  throw new Error('Expected an issued manual request');
}

async function observeNative() {
  const native = await binding();
  const next = native.NativeThread.prototype._next_session_events;
  const entered = Promise.withResolvers<NativeThread>();
  let keys: string | undefined;
  vi.spyOn(
    native.NativeThread.prototype,
    '_next_session_events',
  ).mockImplementation(async function (this: NativeThread) {
    entered.resolve(this);
    const raw = await next.call(this);
    const event = parseEvent(firstNativeBatchWire(raw));
    if (event.msg._sdk_python_tool) keys = '[' + encodeReceipt(event.msg) + ']';
    return raw;
  });
  return {
    entered: entered.promise,
    async settleManual() {
      const thread = await entered.promise;
      if (!keys) throw new Error('Expected a real captured manual receipt');
      const token = thread._begin_manual_checkpoint_wait(keys);
      try {
        while (!(await thread._manual_checkpoint_ready(keys)))
          await thread._wait_manual_checkpoint_progress(token);
      } finally {
        thread._end_manual_checkpoint_wait(token);
      }
    },
  };
}

const decision = () =>
  manualTool({
    name: 'lookup',
    description: 'Supply a value.',
    parameters: z.object({}),
    result: z.string(),
  });

let releaseManualSamplingFence: (() => void) | undefined;
afterEach(async () => {
  // Timeout cleanup must release the provider's SSE fence before server close.
  releaseManualSamplingFence?.();
  releaseManualSamplingFence = undefined;
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

describe('public live capabilities and checkpoint advice', () => {
  it('reports all thirteen routes through a retained immutable view and preserves close precedence', async () => {
    const server = new ModelServer([]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Inspect configuration.',
      model: 'gpt-5',
      provider,
    });
    const session = await agent.session();
    const view = session.capabilities;
    const statuses = {
      nativeOutput: 'supported',
      promptedOutput: 'limited',
      manualSuspend: 'unsupported',
      nativeOutputManualRestore: 'unsupported',
      toolSelection: 'limited',
      functionPolicy: 'unsupported',
      mcpBeforePolicy: 'unsupported',
      mcpResultPolicy: 'unsupported',
      environmentBeforePolicy: 'unsupported',
      environmentCodeResultPolicy: 'unsupported',
      nativeAgents: 'unsupported',
      remoteSkills: 'unsupported',
      checklist: 'unsupported',
    } as const;
    try {
      expect(Object.isFrozen(view)).toBe(true);
      expect(view.websocketsAllowed).toBe(false);
      expect(Object.keys(statuses)).toHaveLength(13);
      for (const [feature, status] of Object.entries(statuses)) {
        const report = view.get(feature as FeatureName);
        expect(report.status).toBe(status);
        expect(report.reason.length).toBeGreaterThan(0);
        expect(report.scope.length).toBeGreaterThan(0);
        expect(Object.isFrozen(report)).toBe(true);
      }
      const old = view.get('functionPolicy');
      agent.tools = [
        tool({
          name: 'late',
          parameters: z.object({}),
          execute: () => 'unused',
        }),
      ];
      expect(view.get('functionPolicy').status).toBe('unsupported');
      expect(old.status).toBe('unsupported');
      expect(() => view.require('nativeOutput')).not.toThrow();
      expect(() => view.require('promptedOutput')).toThrow(CapabilityError);
      expect(() =>
        view.require('promptedOutput', { allowLimited: true }),
      ).not.toThrow();
      let rejection: unknown;
      try {
        view.require('functionPolicy', { allowLimited: true });
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(CapabilityError);
      expect(rejection).toBeInstanceOf(NativeError);
      expect(rejection).toMatchObject({
        feature: 'functionPolicy',
        statusCode: null,
        code: null,
        requestId: null,
        category: null,
      });
      expect(Object.isFrozen((rejection as CapabilityError).support)).toBe(
        true,
      );
      expect((rejection as CapabilityError).support).not.toBe(old);
      expect(server.requests).toHaveLength(0);
      const closing = session.close();
      expect(() => view.get('nativeOutput')).toThrow(NativeError);
      expect(() => view.get('unknown' as FeatureName)).toThrow(TypeError);
      expect((await session.checkpointStatus({ kind: 'idle' })).status).toBe(
        'notReady',
      );
      await closing;
      expect(() => view.require('nativeOutput')).toThrow(NativeError);
      expect(() => view.websocketsAllowed).toThrow(NativeError);
      expect(old.status).toBe('unsupported');
      server.assertExhausted();
    } finally {
      await session.close();
    }
  });

  it('uses only the acknowledged callback catalog across manual to function to manual replacement', async () => {
    const native = await binding();
    const replace = native.NativeThread.prototype._replace_tools;
    let gate:
      | {
          entered: ReturnType<typeof Promise.withResolvers<void>>;
          release: ReturnType<typeof Promise.withResolvers<void>>;
        }
      | undefined;
    vi.spyOn(
      native.NativeThread.prototype,
      '_replace_tools',
    ).mockImplementation(async function (this: NativeThread, ...args) {
      const result = await replace.apply(this, args);
      const held = gate;
      if (held) {
        held.entered.resolve();
        await held.release.promise;
      }
      return result;
    });
    const stages: string[] = [];
    const callback = tool({
      name: 'lookup',
      parameters: z.object({}),
      result: z.string().transform((value) => {
        stages.push('result');
        return value;
      }),
      before() {
        stages.push('before');
        return { action: 'allow' };
      },
      execute() {
        stages.push('execute');
        return 'validated';
      },
      after(output) {
        stages.push('after');
        return output;
      },
    });
    const server = new ModelServer([
      [call('lookup', {}, { callId: 'callback' })],
      [message('done')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Use lookup.',
      model: 'gpt-5',
      provider,
      tools: [decision()],
    }).session();
    try {
      const view = session.capabilities;
      const old = view.get('functionPolicy');
      expect(old.status).toBe('unsupported');
      gate = {
        entered: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      const publishing = session.update({ tools: [callback] });
      await gate.entered.promise;
      expect(view.get('functionPolicy').status).toBe('unsupported');
      expect(stages).toEqual([]);
      gate.release.resolve();
      await publishing;
      gate = undefined;
      const admitted = view.get('functionPolicy');
      expect(admitted.status).toBe('supported');
      expect(old.status).toBe('unsupported');
      expect((await (await session.submit('invoke')).wait()).finalOutput).toBe(
        'done',
      );
      expect(stages).toEqual(['before', 'execute', 'result', 'after']);
      expect(view.get('functionPolicy').status).toBe('supported');
      gate = {
        entered: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      const removing = session.update({ tools: [decision()] });
      await gate.entered.promise;
      expect(view.get('functionPolicy').status).toBe('supported');
      gate.release.resolve();
      await removing;
      expect(view.get('functionPolicy').status).toBe('unsupported');
      expect(admitted.status).toBe('supported');
      expect(stages).toEqual(['before', 'execute', 'result', 'after']);
      server.assertExhausted();
    } finally {
      gate?.release.resolve();
    }
  });

  it.each(['manual', 'empty'] as const)(
    'removes opening callback support after acknowledged %s selection',
    async (replacement) => {
      const server = new ModelServer([]);
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Inspect.',
        model: 'gpt-5',
        provider,
        tools: [
          tool({
            name: 'lookup',
            parameters: z.object({}),
            execute: () => 'unused',
          }),
        ],
      }).session();
      const retained = session.capabilities;
      expect(retained.get('functionPolicy').status).toBe('supported');
      await session.update({
        tools: replacement === 'manual' ? [decision()] : [],
      });
      expect(retained.get('functionPolicy').status).toBe('unsupported');
      expect(server.requests).toHaveLength(0);
      server.assertExhausted();
    },
  );

  it.each(['native', 'prompted', 'plain'] as const)(
    'advises from the captured %s root override rather than the opening prompted default',
    async (mode) => {
      const observed = await observeNative();
      const server = new ModelServer([
        [call('lookup', {}, { callId: 'manual' })],
        [
          message(
            mode === 'native'
              ? '{"response":"done"}'
              : mode === 'prompted'
                ? '"done"'
                : 'done',
          ),
        ],
      ]);
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Ask.',
        model: 'gpt-5',
        provider,
        tools: [decision()],
        outputType: { mode: 'prompted', schema: z.string() },
      }).session();
      const output =
        mode === 'plain' ? z.string() : { mode, schema: z.string() };
      const turn = await session.submit('override', { outputType: output });
      const request = await nextAction(session);
      expect(session.capabilities.get('nativeOutput').status).toBe('supported');
      expect(session.capabilities.get('promptedOutput').status).toBe('limited');
      expect(session.capabilities.get('manualSuspend').status).toBe('limited');
      expect(session.capabilities.get('nativeOutputManualRestore').status).toBe(
        'limited',
      );
      await observed.settleManual();
      expect(
        (await session.checkpointStatus({ kind: 'manualWait' })).status,
      ).toBe('ready');
      await session.respond(request.reply('accepted'));
      expect((await turn.wait()).finalOutput).toBe('done');
      server.assertExhausted();
    },
  );

  it('supports a prompted current root even when the opening default is plain', async () => {
    const observed = await observeNative();
    const server = new ModelServer([
      [call('lookup', {}, { callId: 'manual' })],
      [message('"done"')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Ask.',
      model: 'gpt-5',
      provider,
      tools: [decision()],
    }).session();
    const turn = await session.submit('prompted', {
      outputType: {
        mode: 'prompted',
        schema: z.string(),
      },
    });
    const request = await nextAction(session);
    await observed.settleManual();
    expect(
      (await session.checkpointStatus({ kind: 'manualWait' })).status,
    ).toBe('ready');
    await session.respond(request.reply('accepted'));
    expect((await turn.wait()).finalOutput).toBe('done');
    server.assertExhausted();
  });

  it('uses the current physical owned successor for plain override manual advice', async () => {
    // Qualified existing seam: project conditional continuation admission only.
    // Native model work, pending receipts, grants and checkpoint readiness stay real.
    const native = await binding();
    const next = native.NativeThread.prototype._next_session_events;
    const submit = native.NativeThread.prototype._submit;
    let initialId: string | undefined;
    let pendingOwner: { thread: NativeThread; keys: string } | undefined;
    vi.spyOn(
      native.NativeThread.prototype,
      '_next_session_events',
    ).mockImplementation(async function (this: NativeThread) {
      const raw = await next.call(this);
      const event = parseEvent(firstNativeBatchWire(raw));
      if (
        !initialId &&
        !event.subagent_id &&
        ['task_complete', 'turn_complete'].includes(event.msg.type)
      ) {
        initialId = event.id;
        return replaceSingletonNativeBatchEvent(raw, {
          ...JSON.parse(firstNativeBatchWire(raw)),
          sdk_unsampled_steering: true,
        });
      }
      if (event.msg._sdk_python_tool) {
        pendingOwner = {
          thread: this,
          keys: '[' + encodeReceipt(event.msg) + ']',
        };
        expect(event.msg.turnId).not.toBe(initialId);
      }
      return raw;
    });
    vi.spyOn(native.NativeThread.prototype, '_submit').mockImplementation(
      async function (this: NativeThread, raw) {
        const request = JSON.parse(raw);
        if (request.mode !== 'continue_if_idle') return submit.call(this, raw);
        expect(request.expected_previous_turn_id).toBe(initialId);
        expect(request).not.toHaveProperty('start');
        return submit.call(
          this,
          JSON.stringify({
            mode: 'start_if_idle',
            input: [{ type: 'text', text: 'projected owned successor' }],
          }),
        );
      },
    );
    const server = new ModelServer([
      [message('first')],
      [call('lookup', {}, { callId: 'successor-manual' })],
      [message('done')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Ask.',
      model: 'gpt-5',
      provider,
      tools: [decision()],
      outputType: { mode: 'prompted', schema: z.string() },
    }).session();
    const turn = await session.submit('plain override', {
      outputType: z.string(),
    });
    const request = await nextAction(session);
    expect(request.callId).toBe('successor-manual');
    expect(turn.turnId).toBe(initialId);
    if (!pendingOwner) throw new Error('Expected successor native owner');
    const { thread, keys } = pendingOwner;
    const token = thread._begin_manual_checkpoint_wait(keys);
    try {
      while (!(await thread._manual_checkpoint_ready(keys)))
        await thread._wait_manual_checkpoint_progress(token);
    } finally {
      thread._end_manual_checkpoint_wait(token);
    }
    expect(
      (await session.checkpointStatus({ kind: 'manualWait' })).status,
    ).toBe('ready');
    await session.respond(request.reply('accepted'));
    expect((await turn.wait()).finalOutput).toBe('done');
    expect(session.capabilities.get('promptedOutput').status).toBe('limited');
    server.assertExhausted();
  });

  it('allows passive reports inside a callback while rejecting same-Session advice', async () => {
    const server = new ModelServer([
      [call('inspect', {}, { callId: 'inspect' })],
      [message('done')],
    ]);
    await using provider = await providerFor(server);
    const inspect = tool({
      name: 'inspect',
      parameters: z.object({}),
      async execute() {
        expect(session.capabilities.get('functionPolicy').status).toBe(
          'supported',
        );
        for (const kind of ['idle', 'manualWait'] as const)
          await expect(session.checkpointStatus({ kind })).rejects.toThrow(
            'callback',
          );
        return 'checked';
      },
    });
    const session: Session = await new Agent({
      instructions: 'Inspect.',
      model: 'gpt-5',
      provider,
      tools: [inspect],
    }).session();
    try {
      expect((await (await session.submit('inspect')).wait()).finalOutput).toBe(
        'done',
      );
      server.assertExhausted();
    } finally {
      await session.close();
    }
  });

  it('preserves the opening instruction receipt across fresh idle advice and ordinary save', async () => {
    const observed = await observeNative();
    const server = new ModelServer([]);
    await using provider = await providerFor(server);
    const execute = vi.fn(() => 'unexpected');
    await using session = await new Agent({
      instructions: 'CAPABILITY_ADVICE_MUST_NOT_PUBLISH',
      model: 'gpt-5',
      provider,
      tools: [tool({ name: 'unused', parameters: z.object({}), execute })],
    }).session();
    const thread = await observed.entered;
    const native = await binding();
    const original = native.NativeThread.prototype._export_checkpoint;
    const probes: SessionState[] = [];
    vi.spyOn(
      native.NativeThread.prototype,
      '_export_checkpoint',
    ).mockImplementation(async function (this: NativeThread, ...args) {
      const wire = await original.apply(this, args);
      if (args[2] === true) {
        const envelope = JSON.parse(wire);
        expect(envelope.kind).toBe('snapshot');
        expect(typeof envelope.snapshot).toBe('string');
        probes.push(parseSessionState(envelope.snapshot));
      }
      return wire;
    });
    const openingText = thread._application_instructions();
    expect(openingText).toBe('CAPABILITY_ADVICE_MUST_NOT_PUBLISH');
    const opening = await session.saveState();
    const receipts = (state: SessionState) =>
      state.history.filter((row) => {
        const item = row.payload;
        return (
          row.type === 'response_item' &&
          typeof item === 'object' &&
          item !== null &&
          !Array.isArray(item) &&
          typeof item.id === 'string' &&
          item.id.startsWith('msg_sdk_application_')
        );
      });
    const openingReceipts = receipts(opening);
    expect(openingReceipts).toHaveLength(1);
    expect(
      native._validate_application_instructions(
        JSON.stringify(opening.history),
        openingText,
      ),
    ).toBe(true);
    for (let index = 0; index < 2; index++) {
      const advice = await session.checkpointStatus({ kind: 'idle' });
      expect(advice).toEqual({ status: 'ready', reasons: [] });
      expect(Object.isFrozen(advice)).toBe(true);
      expect(Object.isFrozen(advice.reasons)).toBe(true);
    }
    expect(probes).toHaveLength(2);
    for (const state of probes) {
      expect(
        native._validate_application_instructions(
          JSON.stringify(state.history),
          'CAPABILITY_ADVICE_MUST_NOT_PUBLISH',
        ),
      ).toBe(true);
      expect(receipts(state)).toEqual(openingReceipts);
      expect(await readSessionInstructions(state)).toBe(openingText);
    }
    expect(thread._application_instructions()).toBe(openingText);
    expect(execute).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(0);
    const saved = await session.saveState();
    expect(receipts(saved)).toEqual(openingReceipts);
    expect(await readSessionInstructions(saved)).toBe(
      'CAPABILITY_ADVICE_MUST_NOT_PUBLISH',
    );
    expect(
      native._validate_application_instructions(
        JSON.stringify(saved.history),
        'CAPABILITY_ADVICE_MUST_NOT_PUBLISH',
      ),
    ).toBe(true);
    expect(saved.format_version).toBe(4);
    expect('kind' in saved).toBe(false);
    server.assertExhausted();
  });

  it('samples manual advice once without taking its grant and rechecks a reply racing readiness', async () => {
    const observed = await observeNative();
    const server = new ModelServer([
      [call('lookup', {}, { callId: 'manual' })],
      [message('done')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Ask.',
      model: 'gpt-5',
      provider,
      tools: [decision()],
    }).session();
    const turn = await session.submit('begin');
    const request = await nextAction(session);
    await observed.settleManual();
    const native = await binding();
    const ready = vi.spyOn(
      native.NativeThread.prototype,
      '_manual_checkpoint_ready',
    );
    const begin = vi.spyOn(
      native.NativeThread.prototype,
      '_begin_manual_checkpoint_wait',
    );
    const wait = vi.spyOn(
      native.NativeThread.prototype,
      '_wait_manual_checkpoint_progress',
    );
    const end = vi.spyOn(
      native.NativeThread.prototype,
      '_end_manual_checkpoint_wait',
    );
    const seal = vi.spyOn(
      native.NativeThread.prototype,
      '_seal_manual_checkpoint',
    );
    const capture = vi.spyOn(
      native.NativeThread.prototype,
      '_export_checkpoint',
    );
    expect(
      (await session.checkpointStatus({ kind: 'manualWait' })).status,
    ).toBe('ready');
    expect(ready).toHaveBeenCalledTimes(1);
    expect(begin).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    expect(seal).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(1);
    const entered = Promise.withResolvers<boolean>();
    const release = Promise.withResolvers<void>();
    ready.mockRestore();
    const actual = native.NativeThread.prototype._manual_checkpoint_ready;
    vi.spyOn(
      native.NativeThread.prototype,
      '_manual_checkpoint_ready',
    ).mockImplementation(async function (this: NativeThread, keys) {
      const result = await actual.call(this, keys).catch((error: unknown) => {
        entered.reject(error);
        throw error;
      });
      entered.resolve(result);
      await release.promise;
      return result;
    });
    try {
      const pending = session.checkpointStatus({ kind: 'manualWait' });
      expect(await entered.promise).toBe(true);
      await session.respond(request.reply('accepted'));
      expect((await turn.wait()).finalOutput).toBe('done');
      release.resolve();
      expect((await pending).status).toBe('notReady');
      expect(seal).not.toHaveBeenCalled();
      server.assertExhausted();
    } finally {
      release.resolve();
    }
  });

  it.each(['queue', 'stop', 'close'] as const)(
    'rejects held real manual readiness after %s while preserving the surviving owner',
    async (change) => {
      const observed = await observeNative();
      const server = new ModelServer([
        [call('lookup', {}, { callId: 'manual' })],
        ...(change === 'queue'
          ? [[message('A done')], [message('queued done')]]
          : change === 'stop'
            ? [[message('survivor')]]
            : []),
      ]);
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Ask.',
        model: 'gpt-5',
        provider,
        tools: [decision()],
      }).session();
      const turn = await session.submit('A');
      const result = turn.wait().catch((error: unknown) => error);
      const request = await nextAction(session, turn.submissionId);
      await observed.settleManual();
      const native = await binding();
      const actual = native.NativeThread.prototype._manual_checkpoint_ready;
      const entered = Promise.withResolvers<boolean>();
      const release = Promise.withResolvers<void>();
      const sample = vi
        .spyOn(native.NativeThread.prototype, '_manual_checkpoint_ready')
        .mockImplementationOnce(async function (this: NativeThread, keys) {
          const ready = await actual
            .call(this, keys)
            .catch((error: unknown) => {
              entered.reject(error);
              throw error;
            });
          entered.resolve(ready);
          await release.promise;
          return ready;
        });
      const pending = session.checkpointStatus({ kind: 'manualWait' });
      try {
        expect(await entered.promise).toBe(true);
        if (change === 'queue') {
          const queued = await session.enqueue('B');
          expect(queued.turnId).toBeNull();
          expect(server.requests).toHaveLength(1);
          release.resolve();
          expect((await pending).status).toBe('notReady');
          expect(sample).toHaveBeenCalledTimes(1);
          await session.respond(request.reply('accepted'));
          expect(await result).toMatchObject({ finalOutput: 'A done' });
          expect((await queued.wait()).finalOutput).toBe('queued done');
        } else {
          if (change === 'stop') await turn.cancel();
          else await session.close();
          expect(await result).toBeInstanceOf(Error);
          release.resolve();
          expect((await pending).status).toBe('notReady');
          expect(sample).toHaveBeenCalledTimes(1);
          if (change === 'stop') {
            expect(
              (await (await session.submit('survivor')).wait()).finalOutput,
            ).toBe('survivor');
          } else {
            await expect(session.submit('late')).rejects.toThrow();
            await session.close();
          }
        }
        server.assertExhausted();
      } finally {
        release.resolve();
        await pending;
      }
    },
  );

  it.each(['active', 'completed'] as const)(
    'rejects held manual advice after an independent replacement root is %s',
    async (replacement) => {
      const observed = await observeNative();
      const server = new ModelServer([
        [call('lookup', {}, { callId: 'A-manual' })],
        [message('A done')],
        replacement === 'active'
          ? [call('lookup', {}, { callId: 'B-manual' })]
          : [message('B done')],
        ...(replacement === 'active' ? [[message('B done')]] : []),
      ]);
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Ask.',
        model: 'gpt-5',
        provider,
        tools: [decision()],
      }).session();
      const first = await session.submit('A');
      const request = await nextAction(session, first.submissionId);
      await observed.settleManual();
      const native = await binding();
      const actual = native.NativeThread.prototype._manual_checkpoint_ready;
      const entered = Promise.withResolvers<boolean>();
      const release = Promise.withResolvers<void>();
      vi.spyOn(
        native.NativeThread.prototype,
        '_manual_checkpoint_ready',
      ).mockImplementationOnce(async function (this: NativeThread, keys) {
        const ready = await actual.call(this, keys).catch((error: unknown) => {
          entered.reject(error);
          throw error;
        });
        entered.resolve(ready);
        await release.promise;
        return ready;
      });
      const pending = session.checkpointStatus({ kind: 'manualWait' });
      try {
        expect(await entered.promise).toBe(true);
        await session.respond(request.reply('accepted'));
        expect((await first.wait()).finalOutput).toBe('A done');
        const second = await session.submit('B');
        expect(second).not.toBe(first);
        expect(second.turnId).not.toBeNull();
        if (replacement === 'active') {
          const current = await nextAction(session, second.submissionId);
          expect(current.callId).toBe('B-manual');
          release.resolve();
          expect((await pending).status).toBe('notReady');
          await session.respond(current.reply('accepted'));
        } else {
          expect((await second.wait()).finalOutput).toBe('B done');
          release.resolve();
          expect((await pending).status).toBe('notReady');
        }
        expect((await second.wait()).finalOutput).toBe('B done');
        server.assertExhausted();
      } finally {
        release.resolve();
        await pending;
      }
    },
  );

  it('keeps LocalStorage output routes independent from idle and manual advice', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'capability-public-profile-'),
    );
    const server = new ModelServer([
      [message('{"response":7}')],
      [message('8')],
    ]);
    try {
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
      }).session({ storage: localStorage(directory) });
      const native = await binding();
      const exported = vi.spyOn(
        native.NativeThread.prototype,
        '_export_checkpoint',
      );
      expect(session.capabilities.get('manualSuspend').status).toBe(
        'unsupported',
      );
      expect(session.capabilities.get('nativeOutput').status).toBe('supported');
      expect(session.capabilities.get('promptedOutput').status).toBe('limited');
      expect(await session.checkpointStatus({ kind: 'idle' })).toEqual({
        status: 'ready',
        reasons: [],
      });
      expect(exported).toHaveBeenCalledWith(null, false, true);
      expect(await session.checkpointStatus({ kind: 'manualWait' })).toEqual({
        status: 'notReady',
        reasons: ['Persistent storage cannot export SessionState'],
      });
      expect(exported).toHaveBeenCalledTimes(1);
      expect(
        (
          await (
            await session.submit('native', {
              outputType: {
                mode: 'native',
                schema: z.number(),
              },
            })
          ).wait()
        ).finalOutput,
      ).toBe(7);
      expect(
        (
          await (
            await session.submit('prompted', {
              outputType: {
                mode: 'prompted',
                schema: z.number(),
              },
            })
          ).wait()
        ).finalOutput,
      ).toBe(8);
      server.assertExhausted();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports current destination roots and the fixed Checklist grant rather than saved data or tool names', async () => {
    const executor = await startPublicExecutor();
    const server = new ModelServer([
      [
        call(
          'update_plan',
          { plan: [{ step: 'Inspect', status: 'completed' }] },
          { callId: 'plan' },
        ),
      ],
      [message('done')],
    ]);
    try {
      const replacementRoot = join(executor.cwd, 'replacement');
      await mkdir(replacementRoot);
      await using provider = await providerFor(server);
      const agent = new Agent({
        instructions: 'Plan.',
        model: 'gpt-5',
        provider,
        tools: [checklist()],
      });
      let state: SessionState;
      {
        await using source = await agent.session({
          environment: new Environment({
            url: executor.url,
            cwd: executor.cwd,
            headers: executor.headers,
            // This fixture intentionally removes or replaces discovery authority on restore.
            writePolicy: 'legacy',
            capabilityDirectories: [executor.cwd],
          }),
        });
        expect(source.capabilities.get('remoteSkills').status).toBe(
          'supported',
        );
        expect(source.capabilities.get('environmentBeforePolicy').status).toBe(
          'unsupported',
        );
        expect(source.capabilities.get('checklist').status).toBe('supported');
        await (await source.submit('plan')).wait();
        await source.update({ tools: [] });
        expect(source.capabilities.get('checklist').status).toBe('supported');
        state = await source.saveState();
      }
      {
        await using destination = await agent.session({ state, tools: [] });
        expect(destination.capabilities.get('remoteSkills').status).toBe(
          'unsupported',
        );
        expect(destination.capabilities.get('checklist').status).toBe(
          'unsupported',
        );
        expect((await destination.checklist())?.plan).toEqual([
          { step: 'Inspect', status: 'completed' },
        ]);
      }
      for (const capabilityDirectories of [[], [replacementRoot]] as const) {
        await using destination = await agent.session({
          state,
          tools: [],
          environment: new Environment({
            url: executor.url,
            cwd: executor.cwd,
            headers: executor.headers,
            // This fixture intentionally removes or replaces discovery authority on restore.
            writePolicy: 'legacy',
            capabilityDirectories,
          }),
        });
        expect(destination.capabilities.get('remoteSkills').status).toBe(
          capabilityDirectories.length ? 'supported' : 'unsupported',
        );
        expect(
          destination.capabilities.get('environmentBeforePolicy').status,
        ).toBe('unsupported');
        expect(destination.capabilities.get('checklist').status).toBe(
          'unsupported',
        );
        expect((await destination.checklist())?.plan).toEqual([
          { step: 'Inspect', status: 'completed' },
        ]);
      }
      {
        await using namesake = await new Agent({
          instructions: 'Inspect.',
          provider,
          tools: [
            tool({
              name: 'update_plan',
              parameters: z.object({}),
              execute: () => 'application callback',
            }),
          ],
        }).session();
        expect(namesake.capabilities.get('checklist').status).toBe(
          'unsupported',
        );
        expect(namesake.capabilities.get('functionPolicy').status).toBe(
          'supported',
        );
      }
      for (const programmaticToolCalling of [false, true]) {
        await using delegated = await new Agent({
          instructions: 'Inspect.',
          model: 'gpt-5.5',
          provider,
          tools: [new NativeAgents()],
          programmaticToolCalling,
        }).session({
          environment: new Environment({
            url: executor.url,
            cwd: executor.cwd,
            headers: executor.headers,
            tools: ['exec_command', 'write_stdin', 'apply_patch'],
          }),
        });
        expect(
          delegated.capabilities.get('environmentBeforePolicy').status,
        ).toBe('supported');
        expect(delegated.capabilities.get('nativeAgents').status).toBe(
          'supported',
        );
        expect(
          delegated.capabilities.get('environmentCodeResultPolicy').status,
        ).toBe('limited');
        expect(delegated.capabilities.get('remoteSkills').status).toBe(
          'unsupported',
        );
      }
      server.assertExhausted();
    } finally {
      await executor.close();
    }
  }, 30_000);
  it('wakes manual readiness when the sampled response completes after a false check', async () => {
    const releaseCompleted = Promise.withResolvers<void>();
    const completionHeld = Promise.withResolvers<void>();
    const rawObserved = Promise.withResolvers<void>();
    releaseManualSamplingFence = releaseCompleted.resolve;
    const server = new ModelServer(
      [
        [
          call('lookup', {}, { callId: 'manual-progress' }),
          { type: 'reasoning', id: 'manual-sampling-fence', summary: [] },
        ],
        [message('{"response":"done"}')],
      ],
      [],
      async (item) => {
        // Tool dispatch starts at output_item.done. Hold a later harmless item
        // so response.completed cannot reach either readiness ledger yet.
        if (item.id === 'manual-sampling-fence') {
          completionHeld.resolve();
          await releaseCompleted.promise;
        }
      },
    );
    const native = await binding();
    const prototype = native.NativeThread.prototype;
    const next = prototype._next_session_events;
    let owner: NativeThread | undefined;
    let keys: string | undefined;
    let physicalTurn: string | undefined;
    vi.spyOn(prototype, '_next_session_events').mockImplementation(
      async function (this: NativeThread) {
        const result = await next.call(this);
        for (const wire of result) {
          const event = parseEvent(wire);
          if (event.msg._sdk_python_tool) {
            // Keep the exact receiver for the later capability assertion.
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            owner = this;
            keys = '[' + encodeReceipt(event.msg) + ']';
            if (typeof event.msg.turnId !== 'string')
              throw new Error('Missing physical manual turn');
            physicalTurn = event.msg.turnId;
          }
          if (
            event.msg.type === 'raw_response_completed' &&
            event.id === physicalTurn
          )
            rawObserved.resolve();
        }
        return result;
      },
    );
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Ask.',
      model: 'gpt-5',
      provider,
      tools: [decision()],
      outputType: { mode: 'prompted', schema: z.string() },
    }).session();
    // A local deadline unwinds this body on the unfixed runtime. Vitest's
    // outer timeout alone would leave its pending native wait registered.
    let phase = 'submission';
    const deadline = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      deadline.reject(
        new Error(`Manual checkpoint regression stalled at ${phase}`),
      );
    }, 2000);
    const bounded = <T>(pending: Promise<T>, label: string) => {
      phase = label;
      return Promise.race([pending, deadline.promise]);
    };
    try {
      const turn = await bounded(
        session.submit('override', {
          outputType: {
            mode: 'native',
            schema: z.string(),
          },
        }),
        'submission',
      );
      const request = await bounded(nextAction(session), 'manual request');
      await bounded(completionHeld.promise, 'provider completion fence');
      expect(server.completedFrames).toHaveLength(0);
      if (!owner || !keys)
        throw new Error('Expected the real pending manual receipt');
      const thread = owner;
      const token = thread._begin_manual_checkpoint_wait(keys);
      let waiting: Promise<void> | undefined;
      try {
        expect(
          await bounded(
            thread._manual_checkpoint_ready(keys),
            'initial readiness',
          ),
        ).toBe(false);
        waiting = thread._wait_manual_checkpoint_progress(token);
        releaseCompleted.resolve();
        await bounded(waiting, 'progress after sampling completion');
        while (
          !(await bounded(
            thread._manual_checkpoint_ready(keys),
            'updated readiness',
          ))
        ) {
          waiting = thread._wait_manual_checkpoint_progress(token);
          await bounded(waiting, 'next progress');
        }
        await bounded(rawObserved.promise, 'matching raw completion');
      } finally {
        // End cancels an asleep native waiter even on the old binary. Join its
        // original Promise before any session/provider disposer can run.
        releaseCompleted.resolve();
        thread._end_manual_checkpoint_wait(token);
        await waiting?.catch(() => {});
      }
      expect(
        (
          await bounded(
            session.checkpointStatus({ kind: 'manualWait' }),
            'checkpoint status',
          )
        ).status,
      ).toBe('ready');
      await bounded(
        session.respond(request.reply('accepted')),
        'manual response',
      );
      expect((await bounded(turn.wait(), 'turn completion')).finalOutput).toBe(
        'done',
      );
      server.assertExhausted();
    } finally {
      // This finally runs before await-using disposes session/provider. The
      // suite afterEach above covers Vitest timeouts that leave this body pending.
      clearTimeout(timer);
      releaseCompleted.resolve();
      releaseManualSamplingFence = undefined;
    }
  });
});
