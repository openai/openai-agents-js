import { firstNativeBatchWire } from '../fixtures/native-event-batches';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  InteractionRequired,
  NativeAgents,
  NativeProvider,
  isFunctionApprovalRequest,
  manualTool,
  tool,
  type Interaction,
} from '../../src';
import {
  binding,
  encodeReceipt,
  type NativeThread,
} from '../../src/runtime/binding';
import { parseEvents } from '../../src/runtime/events';
import { captureTools } from '../../src/runtime/tools';
import type { ObservationBuffer } from '../../src/runtime/observation';
import { Session as CoreSession } from '../../src/runtime/session';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-request-wait',
    supportsWebsockets: false,
  });
}

async function holdReader() {
  const { NativeThread: Thread } = await binding();
  const next = Thread.prototype._next_session_events;
  const entered = Promise.withResolvers<NativeThread>();
  const delivered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  vi.spyOn(Thread.prototype, '_next_session_events').mockImplementation(
    async function (this: NativeThread) {
      entered.resolve(this);
      await release.promise;
      const raw = await next.call(this);
      if (
        JSON.parse(firstNativeBatchWire(raw)).msg?.type ===
        'dynamic_tool_call_request'
      )
        delivered.resolve();
      return raw;
    },
  );
  return {
    entered: entered.promise,
    delivered: delivered.promise,
    release: () => release.resolve(),
  };
}

function deferManualAdmission() {
  // This private scheduling seam preserves the real callback owner and its
  // cleanup accounting. Only manual admission's `invoke` callback is delayed.
  const prototype = CoreSession.prototype as unknown as {
    trackOwnedCallback(
      owner: unknown,
      callback: () => Promise<void>,
    ): Promise<void>;
  };
  const track = prototype.trackOwnedCallback;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let count = 0;
  vi.spyOn(prototype, 'trackOwnedCallback').mockImplementation(function (
    this: CoreSession<unknown>,
    owner,
    callback,
  ) {
    if (callback.name !== 'invoke') return track.call(this, owner, callback);
    count++;
    entered.resolve();
    return track.call(this, owner, async () => {
      await release.promise;
      await callback();
    });
  });
  return {
    entered: entered.promise,
    count: () => count,
    release: () => release.resolve(),
  };
}

async function pendingCount(
  native: NativeThread,
  turnId: string,
  count: number,
) {
  // Test-only synchronization: sample the real pending owner without draining its inbox.
  await expect
    .poll(
      () =>
        JSON.parse(
          native._pending_manual_tools(
            JSON.stringify({
              thread: native.id,
              turnId,
            }),
          ),
        ).length,
      { timeout: 5_000 },
    )
    .toBe(count);
}

async function bounded<T>(promise: Promise<T>, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out: ${phase}`)),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

function signalListeners(signal: AbortSignal) {
  const added = vi.spyOn(signal, 'addEventListener');
  const removed = vi.spyOn(signal, 'removeEventListener');
  return () => {
    const listeners = added.mock.calls.filter(([type]) => type === 'abort');
    expect(listeners).toHaveLength(1);
    expect(removed.mock.calls.filter(([type]) => type === 'abort')).toEqual([
      ['abort', listeners[0][1]],
    ]);
  };
}

function notifyObservers(session: unknown) {
  // Wake the real passive buffer without introducing a request or authority.
  (session as { observations: { notify(): void } }).observations.notify();
}

describe('exact request waits with the native pending owner', () => {
  it('preserves a live grant on refused replacement and excludes it after idle catalogue publication', async () => {
    const reader = await holdReader();
    const decision = manualTool({
      name: 'decision',
      description: '',
      parameters: z.object({}),
      result: z.string(),
    });
    const server = new ModelServer([
      [call('decision', {}, { callId: 'reused' })],
      [message('first done')],
      [call('decision', {}, { callId: 'reused' })],
      [message('second done')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Ask.',
      model: 'gpt-5',
      provider,
      tools: [decision],
    }).session();
    try {
      const native = await reader.entered;
      const first = await session.submit('first');
      await pendingCount(native, first.turnId, 1);
      const [old] = parseEvents(
        native._pending_manual_tools(
          JSON.stringify({ thread: native.id, turnId: first.turnId }),
        ),
      );
      const generation = BigInt(old.msg._sdk_python_tool!.generation);
      const candidate = captureTools([decision], generation + 1n);
      await expect(
        native._replace_tools(
          candidate.generation.toString(),
          candidate.specsJson,
        ),
      ).rejects.toThrow();
      await expect(session.update({ tools: [decision] })).rejects.toThrow();
      expect(native._manual_tool_current(encodeReceipt(old.msg))).toBe(true);
      const batch = await first.wait({ until: 'manual_tool' });
      if (!('requests' in batch))
        throw new Error('Replacement consumed the original request');
      await session.respond(batch.requests[0].reply('first reply'));
      reader.release();
      expect((await first.wait()).finalOutput).toBe('first done');
      await session.update({ tools: [decision] });
      const second = await session.submit('second');
      const next = await second.wait({ until: 'manual_tool' });
      if (!('requests' in next))
        throw new Error('Expected replacement catalogue request');
      const [current] = parseEvents(
        native._pending_manual_tools(
          JSON.stringify({ thread: native.id, turnId: second.turnId }),
        ),
      );
      expect(BigInt(current.msg._sdk_python_tool!.generation)).toBe(
        generation + 1n,
      );
      expect(native._manual_tool_current(encodeReceipt(old.msg))).toBe(false);
      expect(native._manual_tool_current(encodeReceipt(current.msg))).toBe(
        true,
      );
      await expect(
        session.respond(batch.requests[0].reply('old reply')),
      ).rejects.toThrow();
      expect(next.requests).toHaveLength(1);
      await session.respond(next.requests[0].reply('second reply'));
      expect((await second.wait()).finalOutput).toBe('second done');
      server.assertExhausted();
    } finally {
      reader.release();
    }
  }, 15_000);

  it('keeps distinct live grants with equal wire call IDs independent within one owner', async () => {
    const reader = await holdReader();
    const parse = vi.fn((value: string) => value.toUpperCase());
    const decision = manualTool({
      name: 'decision',
      description: '',
      parameters: z.object({ value: z.string().transform(parse) }),
      result: z.string(),
    });
    const server = new ModelServer([
      [
        call('decision', { value: 'a' }, { callId: 'reused' }),
        call('decision', { value: 'b' }, { callId: 'reused' }),
      ],
      [message('both accepted')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Ask twice.',
      model: 'gpt-5',
      provider,
      tools: [decision],
    }).session();
    try {
      const native = await reader.entered;
      const turn = await session.submit('begin');
      await pendingCount(native, turn.turnId, 2);
      const sampled = parseEvents(
        native._pending_manual_tools(
          JSON.stringify({ thread: native.id, turnId: turn.turnId }),
        ),
      );
      expect(sampled.map((event) => event.msg.callId)).toEqual([
        'reused',
        'reused',
      ]);
      const grants = sampled.map(
        (event) => event.msg._sdk_python_tool?.manual_grant,
      );
      expect(grants.every((grant) => typeof grant === 'string')).toBe(true);
      expect(new Set(grants).size).toBe(2);
      const batch = await turn.wait({ until: 'manual_tool' });
      if (!('requests' in batch))
        throw new Error('Expected both distinct native grants');
      expect(batch.requests).toHaveLength(2);
      const typed = batch.requests.map((request) => decision.match(request));
      const a = typed.find((request) => request?.arguments.value === 'A');
      const b = typed.find((request) => request?.arguments.value === 'B');
      if (!a || !b)
        throw new Error(
          'Equal wire IDs collapsed distinct arguments or grants',
        );
      expect(a).not.toBe(b);
      expect(parse).toHaveBeenCalledTimes(2);
      expect(parse.mock.calls.map(([value]) => value)).toEqual(
        expect.arrayContaining(['a', 'b']),
      );
      await session.respond(a.reply('A reply'));
      await pendingCount(native, turn.turnId, 1);
      const remaining = await turn.wait({ until: 'manual_tool' });
      if (!('requests' in remaining))
        throw new Error('Expected B to remain live');
      expect(remaining.requests).toHaveLength(1);
      expect(remaining.requests[0]).toBe(b);
      expect(parse).toHaveBeenCalledTimes(2);
      await expect(session.respond(a.reply('duplicate A'))).rejects.toThrow();
      await session.respond(b.reply('B reply'));
      await pendingCount(native, turn.turnId, 0);
      reader.release();
      const completed = await turn.wait();
      expect(completed.finalOutput).toBe('both accepted');
      expect(await turn.wait({ until: 'manual_tool' })).toBe(completed);
      expect(parse).toHaveBeenCalledTimes(2);
      await session.close();
      const observations = await Array.fromAsync(session.events());
      expect(
        observations.filter(
          (event) => event.type === 'tool_started' && event.callId === 'reused',
        ),
      ).toHaveLength(2);
      expect(
        observations.filter(
          (event) =>
            event.type === 'tool_finished' && event.callId === 'reused',
        ),
      ).toHaveLength(2);
      server.assertExhausted();
    } finally {
      reader.release();
    }
  }, 15_000);

  it('fences a scheduled manual admission when close starts and joins the captured failure', async () => {
    const reader = await holdReader();
    const admission = deferManualAdmission();
    const parse = vi.fn(() => true);
    const decision = manualTool({
      name: 'decision',
      description: '',
      parameters: z.object({}).refine(parse),
      result: z.string(),
    });
    const server = new ModelServer([
      [call('decision', {}, { callId: 'decision' })],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Ask.',
      model: 'gpt-5',
      provider,
      tools: [decision],
    }).session();
    try {
      const native = await reader.entered;
      const turn = await session.submit('begin');
      await pendingCount(native, turn.turnId, 1);
      const [sampled] = parseEvents(
        native._pending_manual_tools(
          JSON.stringify({ thread: native.id, turnId: turn.turnId }),
        ),
      );
      const ordinary = turn.wait().catch((error: unknown) => error);
      let exposed = false;
      const waiting = turn.wait({ until: 'manual_tool' }).then(
        (outcome) => {
          exposed = 'requests' in outcome;
          return outcome;
        },
        (error: unknown) => error,
      );
      await admission.entered;
      let closed = false;
      const closing = session.close().then(() => {
        closed = true;
      });
      reader.release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
      expect(exposed).toBe(false);
      expect(parse).not.toHaveBeenCalled();
      admission.release();
      await closing;
      const failure = await waiting;
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toBe(await ordinary);
      expect(
        await turn
          .wait({ until: 'manual_tool' })
          .catch((error: unknown) => error),
      ).toBe(failure);
      expect(parse).not.toHaveBeenCalled();
      expect(exposed).toBe(false);
      expect(() =>
        native._pending_manual_tools(
          JSON.stringify({ thread: native.id, turnId: turn.turnId }),
        ),
      ).toThrow('Codex thread is closed');
      expect(() =>
        native._manual_tool_current(encodeReceipt(sampled.msg)),
      ).toThrow('Codex thread is closed');
      server.assertExhausted();
    } finally {
      admission.release();
      reader.release();
    }
  }, 15_000);

  it('suppresses scheduled manual input after a real sibling callback fails', async () => {
    const reader = await holdReader();
    const admission = deferManualAdmission();
    const failed = Promise.withResolvers<void>();
    const primary = new Error('callback primary failure');
    const parse = vi.fn(() => true);
    const decision = manualTool({
      name: 'decision',
      description: '',
      parameters: z.object({}).refine(parse),
      result: z.string(),
    });
    const fail = tool({
      name: 'fail',
      parameters: z.object({}),
      execute() {
        failed.resolve();
        throw primary;
      },
    });
    const server = new ModelServer([
      [
        call('decision', {}, { callId: 'decision' }),
        call('fail', {}, { callId: 'fail' }),
      ],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Ask and fail.',
      model: 'gpt-5',
      provider,
      tools: [decision, fail],
    }).session();
    try {
      const native = await reader.entered;
      const turn = await session.submit('begin');
      await pendingCount(native, turn.turnId, 1);
      const ordinary = turn.wait().catch((error: unknown) => error);
      let exposed = false;
      const waiting = turn.wait({ until: 'manual_tool' }).then(
        (outcome) => {
          exposed = 'requests' in outcome;
          return outcome;
        },
        (error: unknown) => error,
      );
      await admission.entered;
      reader.release();
      await failed.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(parse).not.toHaveBeenCalled();
      expect(exposed).toBe(false);
      admission.release();
      const failure = await waiting;
      expect(failure).toBe(primary);
      expect(failure).toBe(await ordinary);
      expect(parse).not.toHaveBeenCalled();
      expect(exposed).toBe(false);
      await pendingCount(native, turn.turnId, 0);
      server.assertExhausted();
    } finally {
      admission.release();
      reader.release();
    }
  }, 15_000);

  it.each(['publication', 'handler entry'] as const)(
    'suppresses a current approval when its sibling fails before %s',
    async (phase) => {
      const beforePublication = phase === 'publication';
      const primary = new Error('sibling approval policy primary failure');
      const siblingEntered = Promise.withResolvers<void>();
      const failSibling = Promise.withResolvers<void>();
      const approvalHeld = Promise.withResolvers<void>();
      const releaseApproval = Promise.withResolvers<void>();
      const interruptEntered = Promise.withResolvers<unknown>();
      const releaseInterrupt = Promise.withResolvers<void>();
      const releaseReply = Promise.withResolvers<void>();
      type Owner = { readonly failure?: unknown };
      const prototype = CoreSession.prototype as unknown as {
        interruptRun(owner: Owner): Promise<void>;
        invokeCallback(
          owner: Owner,
          callback: () => Promise<void>,
          signal?: AbortSignal,
          tracingContext?: string,
        ): Promise<void>;
        publishManualRequest(
          owner: Owner,
          event: ReturnType<typeof parseEvents>[number],
        ): void;
      };
      const interrupt = prototype.interruptRun;
      vi.spyOn(prototype, 'interruptRun').mockImplementation(async function (
        this: CoreSession<unknown>,
        owner,
      ) {
        interruptEntered.resolve(owner.failure);
        await releaseInterrupt.promise;
        return interrupt.call(this, owner);
      });
      const invoke = prototype.invokeCallback;
      const callbacks = vi
        .spyOn(prototype, 'invokeCallback')
        .mockImplementation(function (
          this: CoreSession<unknown>,
          owner,
          callback,
          ...context
        ) {
          if (callback.name !== (beforePublication ? 'invoke' : 'answer'))
            return invoke.call(this, owner, callback, ...context);
          return invoke.call(
            this,
            owner,
            async () => {
              // Only the review admission succeeds. The sibling throws.
              if (beforePublication) await callback();
              approvalHeld.resolve();
              await releaseApproval.promise;
              if (!beforePublication) await callback();
            },
            ...context,
          );
        });
      const publication = vi.spyOn(prototype, 'publishManualRequest');
      const publicationAttempted = () =>
        publication.mock.calls.some(
          ([, event]) => event.msg.callId === 'review-race',
        );
      const execute = vi.fn(() => 'unexpected execution');
      const onInteraction = vi.fn(
        async (request: Interaction, signal: AbortSignal) => {
          if (!isFunctionApprovalRequest(request))
            throw new Error('Expected a function approval');
          const reply = request.approve();
          signal.addEventListener('abort', () => releaseReply.resolve(), {
            once: true,
          });
          await releaseReply.promise;
          return reply;
        },
      );
      const server = new ModelServer([
        [
          call('review', {}, { callId: 'review-race' }),
          call('sibling', {}, { callId: 'sibling-failure' }),
        ],
      ]);
      await using provider = await providerFor(server);
      const reader = await holdReader();
      await using session = await new Agent({
        instructions: 'Use both functions.',
        model: 'gpt-5',
        modelSettings: { parallelToolCalls: true },
        provider,
        tools: [
          tool({
            name: 'review',
            parameters: z.object({}),
            needsApproval: true,
            execute,
          }),
          tool({
            name: 'sibling',
            parameters: z.object({}),
            async needsApproval() {
              siblingEntered.resolve();
              await failSibling.promise;
              throw primary;
            },
            execute,
          }),
        ],
      }).session({ onInteraction });
      try {
        const native = await bounded(reader.entered, 'native reader entering');
        const turn = await bounded(session.submit('begin'), 'turn submission');
        const completion = turn.wait().catch((error: unknown) => error);
        await pendingCount(native, turn.turnId, 2);
        const review = parseEvents(
          native._pending_manual_tools(
            encodeReceipt({ thread: native.id, turnId: turn.turnId }),
          ),
        ).find((event) => event.msg.callId === 'review-race');
        if (!review) throw new Error('Missing native review grant');
        const receipt = encodeReceipt(review.msg);
        reader.release();
        await bounded(
          Promise.all([approvalHeld.promise, siblingEntered.promise]),
          'held review approval and sibling policy entering',
        );
        expect(publicationAttempted()).toBe(!beforePublication);
        expect(onInteraction).not.toHaveBeenCalled();

        failSibling.resolve();
        expect(
          await bounded(interruptEntered.promise, 'owning interruption'),
        ).toBe(primary);
        expect(native._manual_tool_current(receipt)).toBe(true);
        releaseApproval.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(publicationAttempted()).toBe(true);
        expect(native._manual_tool_current(receipt)).toBe(true);
        const handlerEntries = onInteraction.mock.calls.length;

        releaseInterrupt.resolve();
        expect(await bounded(completion, 'public turn failure')).toBe(primary);
        await pendingCount(native, turn.turnId, 0);
        expect(native._manual_tool_current(receipt)).toBe(false);
        await bounded(session.close(), 'native session close');
        expect(() => native._manual_tool_current(receipt)).toThrow(
          'Codex thread is closed',
        );
        expect(server.requests).toHaveLength(1);
        expect(execute).not.toHaveBeenCalled();
        server.assertExhausted();
        expect(handlerEntries, 'handler entries before native revocation').toBe(
          0,
        );
        expect(onInteraction).not.toHaveBeenCalled();
        expect(
          callbacks.mock.calls.filter(
            ([, callback]) => callback.name === 'answer',
          ),
        ).toHaveLength(beforePublication ? 0 : 1);
      } finally {
        failSibling.resolve();
        releaseApproval.resolve();
        releaseInterrupt.resolve();
        releaseReply.resolve();
        reader.release();
      }
    },
    30_000,
  );

  it('ignores stale tool metadata and retention gaps when discovering real native grants', async () => {
    const reader = await holdReader();
    const decision = manualTool({
      name: 'decision',
      description: '',
      parameters: z.object({}),
      result: z.string(),
    });
    const server = new ModelServer([
      [call('decision', {}, { callId: 'live' })],
      [message('done')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Ask.',
      model: 'gpt-5',
      provider,
      tools: [decision],
    }).session();
    try {
      const native = await reader.entered;
      const turn = await session.submit('begin');
      await pendingCount(native, turn.turnId, 1);
      const observations = (
        session as unknown as { observations: ObservationBuffer }
      ).observations;
      for (let index = 0; index < 300; index++)
        observations.append({
          type: 'output_text_delta',
          submissionId: turn.submissionId,
          turnId: turn.turnId,
          itemId: `retained-${index}`,
          delta: 'fixture',
        });
      const stale = observations.append({
        type: 'tool_started',
        submissionId: turn.submissionId,
        turnId: turn.turnId,
        callId: 'stale-call',
        name: 'decision',
        namespace: null,
        family: 'function',
      });
      expect(decision.match(stale)).toBeUndefined();
      const events = session.events();
      try {
        expect((await events.next()).value).toMatchObject({ type: 'gap' });
      } finally {
        await events.return?.();
      }
      const batch = await turn.wait({ until: 'manual_tool' });
      if (!('requests' in batch))
        throw new Error(
          'Expected live owner discovery despite lost observations',
        );
      expect(batch.requests.map((request) => request.callId)).toEqual(['live']);
      expect(decision.match(batch.requests[0])).toBe(batch.requests[0]);
      await session.respond(batch.requests[0].reply('accepted'));
      reader.release();
      expect((await turn.wait()).finalOutput).toBe('done');
      server.assertExhausted();
    } finally {
      reader.release();
    }
  }, 15_000);

  it('wakes existing request waiters after a real not_ready seal from projected genuine keys', async () => {
    // INPUT PROJECTION: this exercises the real native refusal/reopen boundary.
    // It does not claim a supported public interleaving produces stale keys.
    const { NativeThread: Thread } = await binding();
    const seal = Thread.prototype._seal_manual_checkpoint;
    const ready = Thread.prototype._manual_checkpoint_ready;
    const sealEntered = Promise.withResolvers<void>();
    const allowRefusal = Promise.withResolvers<void>();
    const retryEntered = Promise.withResolvers<void>();
    const allowRetry = Promise.withResolvers<void>();
    let refused = false;
    let projected = false;
    vi.spyOn(Thread.prototype, '_seal_manual_checkpoint').mockImplementation(
      async function (this: NativeThread, raw) {
        if (projected) return seal.call(this, raw);
        projected = true;
        sealEntered.resolve();
        await allowRefusal.promise;
        // Preserve every original numeric token while projecting one actual key.
        const keys: unknown[] = JSON.parse(
          raw,
          function (_key, value, context?: { source?: string }) {
            return typeof value === 'number' && context?.source
              ? JSON.rawJSON(context.source)
              : value;
          },
        );
        expect(keys).toHaveLength(2);
        const result = await seal.call(this, JSON.stringify(keys.slice(0, 1)));
        expect(JSON.parse(result)).toEqual({ status: 'not_ready' });
        refused = true;
        return result;
      },
    );
    vi.spyOn(Thread.prototype, '_manual_checkpoint_ready').mockImplementation(
      async function (this: NativeThread, keys) {
        if (refused) {
          retryEntered.resolve();
          await allowRetry.promise;
        }
        return ready.call(this, keys);
      },
    );
    const decision = manualTool({
      name: 'decision',
      description: '',
      parameters: z.object({}),
      result: z.string(),
    });
    const server = new ModelServer([
      [
        call('decision', {}, { callId: 'A' }),
        call('decision', {}, { callId: 'B' }),
      ],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Ask twice.',
      model: 'gpt-5',
      provider,
      tools: [decision],
    }).session();
    try {
      const turn = await session.submit('begin');
      const original = await turn.wait({ until: 'manual_tool' });
      if (!('requests' in original))
        throw new Error('Expected portable live requests');
      const suspending = session.suspend();
      await sealEntered.promise;
      let exposed = false;
      const waiting = turn.wait({ until: 'manual_tool' }).then((outcome) => {
        exposed = 'requests' in outcome;
        return outcome;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(exposed).toBe(false);
      allowRefusal.resolve();
      await retryEntered.promise;
      const reopened = await waiting;
      if (!('requests' in reopened))
        throw new Error(
          'Expected original grants to reopen after native refusal',
        );
      expect(reopened.requests.map((request) => request.callId).sort()).toEqual(
        ['A', 'B'],
      );
      for (const request of reopened.requests)
        expect(request).toBe(
          original.requests.find(
            (candidate) => candidate.callId === request.callId,
          ),
        );
      expect(server.requests).toHaveLength(1);
      allowRetry.resolve();
      expect((await suspending).format_version).toBe(5);
      await expect(turn.wait()).rejects.toBeInstanceOf(InteractionRequired);
      server.assertExhausted();
    } finally {
      allowRefusal.resolve();
      allowRetry.resolve();
    }
  }, 15_000);

  it('returns settled public outcomes before caller abort and stale notifications, removing its listeners', async () => {
    const server = new ModelServer([[message('done')]]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    }).session();
    const turn = await session.submit('begin');
    const completed = await turn.wait();
    const controller = new AbortController();
    controller.abort(new Error('late observer abort'));
    const detached = signalListeners(controller.signal);
    notifyObservers(session);
    expect(
      await turn.wait({ until: 'manual_tool', signal: controller.signal }),
    ).toBe(completed);
    detached();
    expect(await turn.wait()).toBe(completed);
    server.assertExhausted();
  });

  it('retains a settled primary failure ahead of abort and detaches the failed observer', async () => {
    const invalid = manualTool({
      name: 'invalid',
      description: '',
      parameters: z.object({ value: z.string().refine(() => false) }),
      result: z.string(),
    });
    const server = new ModelServer([
      [call('invalid', { value: 'private fixture' }, { callId: 'invalid' })],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Ask.',
      model: 'gpt-5',
      provider,
      tools: [invalid],
    }).session();
    const turn = await session.submit('begin');
    const firstController = new AbortController();
    const firstDetached = signalListeners(firstController.signal);
    const failure = await turn
      .wait({ until: 'manual_tool', signal: firstController.signal })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(await turn.wait().catch((error: unknown) => error)).toBe(failure);
    firstDetached();
    const lateController = new AbortController();
    lateController.abort(new Error('late observer abort'));
    const lateDetached = signalListeners(lateController.signal);
    notifyObservers(session);
    expect(
      await turn
        .wait({ until: 'manual_tool', signal: lateController.signal })
        .catch((error: unknown) => error),
    ).toBe(failure);
    lateDetached();
    server.assertExhausted();
  });
  it('admits the entire live batch while the reader is held and tolerates replies before inbox delivery', async () => {
    const reader = await holdReader();
    const parse = vi.fn((value: string) => value.toUpperCase());
    const execute = vi.fn(() => 'callback result');
    const decision = manualTool({
      name: 'decision',
      description: 'Request a decision.',
      parameters: z.object({ value: z.string().transform(parse) }),
      result: z.string(),
    });
    const server = new ModelServer([
      [
        call('decision', { value: 'a' }, { callId: 'a' }),
        call('decision', { value: 'b' }, { callId: 'b' }),
        call('callback', {}, { callId: 'callback' }),
      ],
      [message('done')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Ask two decisions and use callback.',
      model: 'gpt-5',
      provider,
      tools: [
        decision,
        tool({ name: 'callback', parameters: z.object({}), execute }),
      ],
    }).session();
    try {
      const native = await reader.entered;
      const turn = await session.submit('begin');
      await pendingCount(native, turn.turnId, 2);
      const [first, second] = await Promise.all([
        turn.wait({ until: 'manual_tool' }),
        turn.wait({ until: 'manual_tool' }),
      ]);
      if (!('requests' in first) || !('requests' in second))
        throw new Error('Expected the two pending manual calls');
      expect(first.turn).toBe(turn);
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.requests)).toBe(true);
      expect(first.requests.map((request) => request.callId).sort()).toEqual([
        'a',
        'b',
      ]);
      expect(parse).toHaveBeenCalledTimes(2);
      expect(execute).not.toHaveBeenCalled();
      const answered = new Set<string>();
      for (const request of first.requests) {
        const typed = decision.match(request);
        if (!typed) throw new Error('Expected the captured declaration');
        expect(typed.arguments.value).toBe(request.callId.toUpperCase());
        const alias = second.requests.find(
          (item) => item.callId === request.callId,
        );
        if (!alias) throw new Error('Expected an alias of the same grant');
        await session.respond(typed.reply('accepted'));
        answered.add(request.callId);
        await expect(
          session.respond(alias.reply('duplicate')),
        ).rejects.toThrow();
        if (answered.size === 1) {
          const remaining = await turn.wait({ until: 'manual_tool' });
          if (!('requests' in remaining))
            throw new Error('Expected the surviving sibling');
          expect(remaining.requests.map((item) => item.callId)).toEqual(
            first.requests
              .filter((item) => !answered.has(item.callId))
              .map((item) => item.callId),
          );
        }
      }
      await pendingCount(native, turn.turnId, 0);
      reader.release();
      const completed = await turn.wait();
      expect(completed.finalOutput).toBe('done');
      expect(await turn.wait({ until: 'manual_tool' })).toBe(completed);
      expect(parse).toHaveBeenCalledTimes(2);
      expect(execute).toHaveBeenCalledTimes(1);
      await session.close();
      const events = await Array.fromAsync(session.events());
      for (const callId of ['a', 'b', 'callback']) {
        expect(
          events.filter(
            (event) => event.type === 'tool_started' && event.callId === callId,
          ),
        ).toHaveLength(1);
        expect(
          events.filter(
            (event) =>
              event.type === 'tool_finished' && event.callId === callId,
          ),
        ).toHaveLength(1);
      }
      server.assertExhausted();
    } finally {
      reader.release();
    }
  }, 15_000);

  it('suppresses a valid sibling when malformed input is already pending behind the held reader', async () => {
    const reader = await holdReader();
    const privateValue = 'synthetic-private-validator-value';
    const invalidParsed = Promise.withResolvers<void>();
    const validate = vi.fn((value: string) => {
      if (value === privateValue) invalidParsed.resolve();
      return value !== privateValue;
    });
    const decision = manualTool({
      name: 'decision',
      description: 'Request a decision.',
      parameters: z.object({ value: z.string().refine(validate) }),
      result: z.string(),
    });
    const server = new ModelServer([
      [
        call('decision', { value: 'valid' }, { callId: 'valid' }),
        call('decision', { value: privateValue }, { callId: 'invalid' }),
      ],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Ask two decisions.',
      model: 'gpt-5',
      provider,
      tools: [decision],
    }).session();
    try {
      const native = await reader.entered;
      const turn = await session.submit('begin');
      await pendingCount(native, turn.turnId, 2);
      const completion = turn.wait().catch((error: unknown) => error);
      let exposed = false;
      const waiting = turn.wait({ until: 'manual_tool' }).then(
        (outcome) => {
          exposed = 'requests' in outcome;
          return outcome;
        },
        (error: unknown) => error,
      );
      await invalidParsed.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(exposed).toBe(false);
      expect(validate).toHaveBeenCalledWith(privateValue);
      // The snapshot must validate the invalid sibling while delivery is held;
      // the real terminal reader still owns completion and cleanup progress.
      reader.release();
      const outcome = await waiting;
      expect(outcome).toBeInstanceOf(Error);
      expect(outcome).toBe(await completion);
      expect(String(outcome)).not.toContain(privateValue);
      await pendingCount(native, turn.turnId, 0);
      expect(await turn.wait().catch((error: unknown) => error)).toBe(outcome);
      server.assertExhausted();
    } finally {
      reader.release();
    }
  }, 15_000);

  it('joins an in-flight manual admission across two waiters and the original inbox event', async () => {
    const reader = await holdReader();
    const admission = deferManualAdmission();
    const parse = vi.fn((value: string) => value.length);
    const decision = manualTool({
      name: 'decision',
      description: '',
      parameters: z.object({ value: z.string().transform(parse) }),
      result: z.string(),
    });
    const server = new ModelServer([
      [call('decision', { value: 'captured' }, { callId: 'decision' })],
      [message('done')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Ask.',
      model: 'gpt-5',
      provider,
      tools: [decision],
    }).session();
    try {
      const native = await reader.entered;
      const turn = await session.submit('begin');
      await pendingCount(native, turn.turnId, 1);
      const first = turn.wait({ until: 'manual_tool' });
      await admission.entered;
      const second = turn.wait({ until: 'manual_tool' });
      reader.release();
      await reader.delivered;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(admission.count()).toBe(1);
      expect(parse).not.toHaveBeenCalled();
      admission.release();
      const [a, b] = await Promise.all([first, second]);
      if (!('requests' in a) || !('requests' in b))
        throw new Error('Expected shared manual admission');
      expect(a.requests).toHaveLength(1);
      expect(b.requests[0]).toBe(a.requests[0]);
      expect(parse).toHaveBeenCalledTimes(1);
      const request = decision.match(a.requests[0]);
      if (!request) throw new Error('Expected the captured grant');
      expect(request.arguments).toEqual({ value: 8 });
      await session.respond(request.reply('accepted'));
      expect((await turn.wait()).finalOutput).toBe('done');
      await session.close();
      const events = await Array.fromAsync(session.events());
      expect(
        events.filter(
          (event) =>
            event.type === 'tool_started' && event.callId === 'decision',
        ),
      ).toHaveLength(1);
      expect(
        events.filter(
          (event) =>
            event.type === 'tool_finished' && event.callId === 'decision',
        ),
      ).toHaveLength(1);
      expect(admission.count()).toBe(1);
      expect(parse).toHaveBeenCalledTimes(1);
      server.assertExhausted();
    } finally {
      admission.release();
      reader.release();
    }
  }, 15_000);

  it('reconciles a sampled sender answered by its native owner while admission is scheduled', async () => {
    const reader = await holdReader();
    const admission = deferManualAdmission();
    const parse = vi.fn((value: string) => value.toUpperCase());
    const decision = manualTool({
      name: 'decision',
      description: '',
      parameters: z.object({ value: z.string().transform(parse) }),
      result: z.string(),
    });
    const server = new ModelServer([
      [
        call('decision', { value: 'a' }, { callId: 'a' }),
        call('decision', { value: 'b' }, { callId: 'b' }),
      ],
      [message('both replies accepted')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Ask twice.',
      model: 'gpt-5',
      provider,
      tools: [decision],
    }).session();
    try {
      const native = await reader.entered;
      const turn = await session.submit('begin');
      await pendingCount(native, turn.turnId, 2);
      const waiting = turn.wait({ until: 'manual_tool' });
      await admission.entered;
      expect(admission.count()).toBe(2);
      expect(parse).not.toHaveBeenCalled();
      const sampled = parseEvents(
        native._pending_manual_tools(
          JSON.stringify({ thread: native.id, turnId: turn.turnId }),
        ),
      );
      const answered = sampled.find((event) => event.msg.callId === 'a');
      if (!answered) throw new Error('Expected the real sampled sender');
      // Deliver through the original native pending owner with its exact receipt.
      // No SDK grant exists yet; this models another owner answering the sample.
      expect(
        await native._respond_python_tool(
          encodeReceipt({
            request: answered.msg,
            response: {
              success: true,
              contentItems: [{ type: 'inputText', text: 'native answer a' }],
            },
          }),
        ),
      ).toBe(true);
      await pendingCount(native, turn.turnId, 1);
      admission.release();
      const batch = await waiting;
      if (!('requests' in batch))
        throw new Error('Expected the surviving request');
      expect(batch.requests.map((request) => request.callId)).toEqual(['b']);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(parse.mock.calls.map(([value]) => value)).toEqual(['b']);
      reader.release();
      await session.respond(batch.requests[0].reply('SDK answer b'));
      const completed = await turn.wait();
      expect(completed.finalOutput).toBe('both replies accepted');
      expect(await turn.wait({ until: 'manual_tool' })).toBe(completed);
      await session.close();
      const events = await Array.fromAsync(session.events());
      expect(
        events.filter(
          (event) =>
            event.type === 'turn_finished' &&
            event.submissionId === turn.submissionId,
        ),
      ).toEqual([expect.objectContaining({ status: 'completed' })]);
      expect(parse).toHaveBeenCalledTimes(1);
      server.assertExhausted();
    } finally {
      admission.release();
      reader.release();
    }
  }, 15_000);

  it('rescans a genuinely new malformed sibling produced during awaited admission', async () => {
    const reader = await holdReader();
    const admission = deferManualAdmission();
    const bWithheld = Promise.withResolvers<void>();
    const releaseB = Promise.withResolvers<void>();
    const malformedParsed = Promise.withResolvers<void>();
    const validate = vi.fn((value: string) => {
      if (value === 'new-invalid-B') malformedParsed.resolve();
      return value !== 'new-invalid-B';
    });
    const decision = manualTool({
      name: 'decision',
      description: '',
      parameters: z.object({ value: z.string().refine(validate) }),
      result: z.string(),
    });
    const server = new ModelServer(
      [
        [
          call('decision', { value: 'A' }, { callId: 'A' }),
          call('decision', { value: 'new-invalid-B' }, { callId: 'B' }),
        ],
      ],
      [],
      async (_item, index) => {
        if (index === 1) {
          bWithheld.resolve();
          await releaseB.promise;
        }
      },
    );
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Ask again.',
      model: 'gpt-5',
      provider,
      tools: [decision],
    }).session();
    try {
      const native = await reader.entered;
      const turn = await session.submit('begin');
      await bWithheld.promise;
      await pendingCount(native, turn.turnId, 1);
      const original = parseEvents(
        native._pending_manual_tools(
          JSON.stringify({ thread: native.id, turnId: turn.turnId }),
        ),
      );
      expect(original.map((event) => event.msg.callId)).toEqual(['A']);
      const completion = turn.wait().catch((error: unknown) => error);
      let exposed = false;
      const waiting = turn.wait({ until: 'manual_tool' }).then(
        (outcome) => {
          exposed = 'requests' in outcome;
          return outcome;
        },
        (error: unknown) => error,
      );
      await admission.entered;
      // Core dispatched A while the provider stream remained open. Deliver B
      // only after this waiter sampled A and deferred A's shared admission.
      // Neither the test nor the SDK replies to A before B becomes pending.
      releaseB.resolve();
      await expect
        .poll(
          () => {
            const events = parseEvents(
              native._pending_manual_tools(
                JSON.stringify({ thread: native.id, turnId: turn.turnId }),
              ),
            );
            return events.map((event) => event.msg.callId).sort();
          },
          { timeout: 5_000 },
        )
        .toEqual(['A', 'B']);
      expect(server.requests).toHaveLength(1);
      expect(validate).not.toHaveBeenCalled();
      admission.release();
      await malformedParsed.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(exposed).toBe(false);
      expect(validate).toHaveBeenCalledWith('A');
      expect(validate).toHaveBeenCalledWith('new-invalid-B');
      reader.release();
      const failure = await waiting;
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toBe(await completion);
      expect(String(failure)).not.toContain('new-invalid-B');
      server.assertExhausted();
    } finally {
      releaseB.resolve();
      admission.release();
      reader.release();
    }
  }, 15_000);

  it('aborts only one observer and wakes the other when a real request arrives', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const decision = manualTool({
      name: 'decision',
      description: '',
      parameters: z.object({}),
      result: z.string(),
    });
    const server = new ModelServer([
      async () => {
        entered.resolve();
        await release.promise;
        return [call('decision', {}, { callId: 'decision' })];
      },
      [message('done')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Ask.',
      model: 'gpt-5',
      provider,
      tools: [decision],
    }).session();
    try {
      await expect(session.wait({ until: 'manual_tool' })).rejects.toThrow(
        'Submit input before waiting',
      );
      const turn = await session.submit('begin');
      await entered.promise;
      const alreadyAborted = new AbortController();
      const earlyReason = new Error('already stopped');
      alreadyAborted.abort(earlyReason);
      await expect(
        turn.wait({ until: 'manual_tool', signal: alreadyAborted.signal }),
      ).rejects.toBe(earlyReason);
      const controller = new AbortController();
      const reason = new Error('observer stopped');
      const detached = signalListeners(controller.signal);
      const cancelled = turn.wait({
        until: 'manual_tool',
        signal: controller.signal,
      });
      const rejected = expect(cancelled).rejects.toBe(reason);
      const other = turn.wait({ until: 'manual_tool' });
      controller.abort(reason);
      await rejected;
      detached();
      release.resolve();
      const batch = await other;
      if (!('requests' in batch))
        throw new Error('Native work was cancelled with its observer');
      expect(batch.turn).toBe(turn);
      expect(batch.requests).toHaveLength(1);
      await session.respond(batch.requests[0].reply('yes'));
      expect((await turn.wait()).finalOutput).toBe('done');
      server.assertExhausted();
    } finally {
      release.resolve();
    }
  });

  it('publishes a snapshot-joined approval after the exact waiter aborts', async () => {
    const policyEntered = Promise.withResolvers<void>();
    const releasePolicy = Promise.withResolvers<void>();
    const execute = vi.fn(() => 'review executed');
    const onInteraction = vi.fn((request: Interaction) => {
      if (!isFunctionApprovalRequest(request))
        throw new Error('Expected a function approval');
      return request.approve();
    });
    const server = new ModelServer([
      [call('review', {}, { callId: 'review-held' })],
      [message('done')],
    ]);
    await using provider = await providerFor(server);
    const reader = await holdReader();
    const controller = new AbortController();
    const reason = new Error('exact waiter stopped');
    await using session = await new Agent({
      instructions: 'Use the review function.',
      model: 'gpt-5',
      provider,
      tools: [
        tool({
          name: 'review',
          parameters: z.object({}),
          async needsApproval() {
            policyEntered.resolve();
            await releasePolicy.promise;
            return true;
          },
          execute,
        }),
      ],
    }).session({ onInteraction });
    try {
      const native = await bounded(reader.entered, 'native reader entering');
      const turn = await bounded(session.submit('begin'), 'turn submission');
      await pendingCount(native, turn.turnId, 1);
      const waiting = turn.wait({
        until: 'manual_tool',
        signal: controller.signal,
      });
      void waiting.catch(() => {});
      await bounded(policyEntered.promise, 'approval policy entering');
      expect(
        await bounded(session.pendingInteractions(), 'issued snapshot'),
      ).toEqual([]);
      expect(onInteraction).not.toHaveBeenCalled();
      controller.abort(reason);
      await expect(bounded(waiting, 'exact waiter abort')).rejects.toBe(reason);

      releasePolicy.resolve();
      await expect
        .poll(() => onInteraction.mock.calls.length, {
          timeout: 5_000,
          message: 'Expected onInteraction approval before inbox release',
        })
        .toBe(1);
      const [request] = onInteraction.mock.calls[0];
      expect(isFunctionApprovalRequest(request)).toBe(true);
      expect(request).toMatchObject({
        callId: 'review-held',
        turnId: turn.turnId,
      });

      reader.release();
      await bounded(reader.delivered, 'late inbox delivery');
      expect((await bounded(turn.wait(), 'turn completion')).finalOutput).toBe(
        'done',
      );
      expect(onInteraction).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(server.requests).toHaveLength(2);
      expect(JSON.stringify(server.requests[1]?.input)).toContain(
        'review executed',
      );
      server.assertExhausted();
    } finally {
      controller.abort(reason);
      releasePolicy.resolve();
      reader.release();
    }
  }, 30_000);

  it('captures queued roots and the Session shortcut before later admission', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const decision = manualTool({
      name: 'decision',
      description: '',
      parameters: z.object({}),
      result: z.string(),
    });
    const server = new ModelServer([
      async () => {
        entered.resolve();
        await release.promise;
        return [call('decision', {}, { callId: 'a' })];
      },
      [message('A done')],
      [call('decision', {}, { callId: 'b' })],
      [message('B done')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Ask.',
      model: 'gpt-5',
      provider,
      tools: [decision],
    }).session();
    try {
      const a = await session.submit('A');
      await entered.promise;
      const anchored = session.wait({ until: 'manual_tool' });
      const b = await session.enqueue('B');
      expect(b.turnId).toBeNull();
      const waitingB = b.wait({ until: 'manual_tool' });
      release.resolve();
      const first = await anchored;
      if (!('requests' in first)) throw new Error('Missing A request');
      expect(first.turn).toBe(a);
      expect(first.requests.map((request) => request.callId)).toEqual(['a']);
      await session.respond(first.requests[0].reply('A reply'));
      const aCompleted = await a.wait();
      const second = await waitingB;
      if (!('requests' in second)) throw new Error('Missing B request');
      expect(second.turn).toBe(b);
      expect(second.requests.map((request) => request.callId)).toEqual(['b']);
      await session.respond(second.requests[0].reply('B reply'));
      expect((await b.wait()).finalOutput).toBe('B done');
      await session.close();
      expect(await a.wait({ until: 'manual_tool' })).toBe(aCompleted);
      server.assertExhausted();
    } finally {
      release.resolve();
    }
  });

  it('anchors the Session shortcut to dispatched B before native acceptance while C remains queued', async () => {
    const { NativeThread: Thread } = await binding();
    const submit = Thread.prototype._submit;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let submissions = 0;
    vi.spyOn(Thread.prototype, '_submit').mockImplementation(async function (
      this: NativeThread,
      raw,
    ) {
      if (++submissions === 2) {
        entered.resolve();
        await release.promise;
      }
      return submit.call(this, raw);
    });
    const decision = manualTool({
      name: 'decision',
      description: '',
      parameters: z.object({}),
      result: z.string(),
    });
    const server = new ModelServer([
      [message('A done')],
      [call('decision', {}, { callId: 'B' })],
      [message('B done')],
      [message('C done')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Ask.',
      model: 'gpt-5',
      provider,
      tools: [decision],
    }).session();
    try {
      const a = await session.submit('A');
      await a.wait();
      const b = await session.enqueue('B');
      await entered.promise;
      expect(b.turnId).toBeNull();
      const captured = session.wait({ until: 'manual_tool' });
      const c = await session.enqueue('C');
      expect(c.turnId).toBeNull();
      release.resolve();
      const batch = await captured;
      if (!('requests' in batch))
        throw new Error('Expected B rather than A completion');
      expect(batch.turn).toBe(b);
      expect(batch.requests.map((request) => request.callId)).toEqual(['B']);
      expect(c.turnId).toBeNull();
      await session.respond(batch.requests[0].reply('B reply'));
      expect((await b.wait()).finalOutput).toBe('B done');
      expect((await c.wait()).finalOutput).toBe('C done');
      server.assertExhausted();
    } finally {
      release.resolve();
    }
  });

  it('suppresses requests during a real portable seal and joins its InteractionRequired outcome', async () => {
    const { NativeThread: Thread } = await binding();
    const seal = Thread.prototype._seal_manual_checkpoint;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.spyOn(Thread.prototype, '_seal_manual_checkpoint').mockImplementation(
      async function (this: NativeThread, keys) {
        entered.resolve();
        await release.promise;
        return seal.call(this, keys);
      },
    );
    const decision = manualTool({
      name: 'decision',
      description: '',
      parameters: z.object({}),
      result: z.string(),
    });
    const server = new ModelServer([
      [call('decision', {}, { callId: 'decision' })],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Ask.',
      model: 'gpt-5',
      provider,
      tools: [decision],
    }).session();
    try {
      const turn = await session.submit('begin');
      const batch = await turn.wait({ until: 'manual_tool' });
      if (!('requests' in batch))
        throw new Error('Expected a portable pending request');
      const suspending = session.suspend();
      await entered.promise;
      let exposed = false;
      let settled = false;
      const waiting = turn.wait({ until: 'manual_tool' }).then(
        (outcome) => {
          exposed = 'requests' in outcome;
          settled = true;
          return outcome;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(exposed).toBe(false);
      expect(settled).toBe(false);
      release.resolve();
      const state = await suspending;
      expect(state.format_version).toBe(5);
      const failure = await waiting;
      expect(failure).toBeInstanceOf(InteractionRequired);
      expect(await turn.wait().catch((error: unknown) => error)).toBe(failure);
      expect(exposed).toBe(false);
      server.assertExhausted();
    } finally {
      release.resolve();
    }
  }, 15_000);

  it('uses a restored output-aware root and fresh grants for every pending call', async () => {
    const decision = manualTool({
      name: 'decision',
      description: '',
      parameters: z.object({}),
      result: z.string(),
    });
    const server = new ModelServer([
      [
        call('decision', {}, { callId: 'a' }),
        call('decision', {}, { callId: 'b' }),
      ],
      [message('restored done')],
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Ask.',
      model: 'gpt-5',
      provider,
      tools: [decision],
    });
    const original = await agent.session();
    let state;
    let oldReply;
    try {
      const turn = await original.submit('begin');
      await vi.waitFor(
        async () => {
          expect(await original.pendingInteractions()).toHaveLength(2);
        },
        { timeout: 5_000 },
      );
      const batch = await turn.wait({ until: 'manual_tool' });
      if (!('requests' in batch))
        throw new Error('Expected pending original root');
      expect(batch.requests).toHaveLength(2);
      oldReply = batch.requests[0].reply('old authority');
      state = await original.suspend();
      expect(state.format_version).toBe(5);
    } finally {
      await original.close();
    }
    await using restored = await agent.session({ state });
    const batch = await restored.wait({ until: 'manual_tool' });
    if (!('requests' in batch)) throw new Error('Expected restored exact root');
    expect(batch.requests).toHaveLength(2);
    expect(batch.turn.sessionId).toBe(restored.id);
    for (const request of batch.requests)
      expect(request.submissionId).toBe(batch.turn.submissionId);
    await expect(restored.respond(oldReply)).rejects.toThrow();
    for (const request of batch.requests)
      await restored.respond(request.reply('fresh authority'));
    const completed = await batch.turn.wait();
    expect(completed.finalOutput).toBe('restored done');
    expect(await restored.wait({ until: 'manual_tool' })).toBe(completed);
    server.assertExhausted();
  });

  it('requires an issued Turn for output overrides and preserves callback self-wait guards', async () => {
    const selfWait = tool({
      name: 'self_wait',
      parameters: z.object({}),
      async execute(_args, context) {
        const own = context.submission;
        if (!('wait' in own)) throw new Error('Expected root submission');
        await expect(
          Promise.resolve().then(() => own.wait({ until: 'manual_tool' })),
        ).rejects.toThrow();
        await expect(
          Promise.resolve().then(() => session.wait({ until: 'manual_tool' })),
        ).rejects.toThrow();
        return 'guarded';
      },
    });
    const server = new ModelServer([
      [call('self_wait', {}, { callId: 'self' })],
      [message('{"response":7}')],
    ]);
    await using provider = await providerFor(server);
    const session: Awaited<ReturnType<Agent['session']>> = await new Agent({
      instructions: 'Check.',
      model: 'gpt-5',
      provider,
      tools: [selfWait],
    }).session();
    try {
      const turn = await session.submit('begin', { outputType: z.number() });
      await expect(session.wait({ until: 'manual_tool' })).rejects.toThrow(
        'returned Turn',
      );
      const completed = await turn.wait({ until: 'manual_tool' });
      if ('requests' in completed)
        throw new Error('Callback tools are not manual requests');
      expect(completed.finalOutput).toBe(7);
      expect(await turn.wait()).toBe(completed);
      server.assertExhausted();
    } finally {
      await session.close();
    }
  });

  it('keeps exact child public waits behind accepted callback cleanup', async () => {
    const executor = await startPublicExecutor();
    const rootSettled = Promise.withResolvers<void>();
    const { NativeThread: Thread } = await binding();
    const respondTool = Thread.prototype._respond_python_tool;
    const replied = Promise.withResolvers<NativeThread>();
    const release = Promise.withResolvers<void>();
    vi.spyOn(Thread.prototype, '_respond_python_tool').mockImplementation(
      async function (this: NativeThread, raw) {
        const receipt = JSON.parse(raw);
        const accepted = await respondTool.call(this, raw);
        if (accepted && receipt.request._sdk_python_tool.thread !== this.id) {
          replied.resolve(this);
          // The real native sender already received the reply. Keep its SDK
          // callback task entered until the test releases its remaining cleanup.
          await release.promise;
        }
        return accepted;
      },
    );
    let rootId: string | undefined;
    const counts = new Map<string, number>();
    const respond = (request: Record<string, unknown>) => {
      const metadata = request.client_metadata as Record<string, string>;
      const id = String(
        JSON.parse(metadata['x-codex-turn-metadata']).thread_id,
      );
      rootId ??= id;
      const count = (counts.get(id) ?? 0) + 1;
      counts.set(id, count);
      if (id !== rootId)
        return count === 1
          ? [call('callback', {}, { callId: 'child-callback' })]
          : [message('child done')];
      return count === 1
        ? [
            call(
              'spawn_agent',
              { task_name: 'child', message: 'Use callback.' },
              { namespace: 'collaboration', callId: 'spawn' },
            ),
          ]
        : [message('root done')];
    };
    const server = new ModelServer(Array.from({ length: 4 }, () => respond));
    try {
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Delegate.',
        model: 'gpt-5.5',
        provider,
        tools: [
          new NativeAgents(),
          tool({
            name: 'callback',
            parameters: z.object({}),
            execute: async () => {
              await rootSettled.promise;
              return 'real reply';
            },
          }),
        ],
      }).session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
      });
      try {
        const root = await session.submit('begin');
        expect((await root.wait()).finalOutput).toBe('root done');
        rootSettled.resolve();
        const native = await replied.promise;
        const children = await Array.fromAsync(session.subagents());
        expect(children).toHaveLength(1);
        const turn = children[0].turn;
        if (!turn) throw new Error('Expected issued child Turn');
        const rawChild = await native._child_turn(children[0].id);
        if (!rawChild) throw new Error('Expected matching native child Turn');
        expect(rawChild.turn_id).toBe(turn.turnId);
        expect(rawChild.instance_id).toBe(turn.instanceId);
        let normalSettled = false;
        let requestSettled = false;
        const normal = turn.wait().then((result) => {
          normalSettled = true;
          return result;
        });
        const request = turn.wait({ until: 'manual_tool' }).then((result) => {
          requestSettled = true;
          return result;
        });
        const nativeCompletion = rawChild.wait_with_usage();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(normalSettled).toBe(false);
        expect(requestSettled).toBe(false);
        release.resolve();
        const raw = JSON.parse(await nativeCompletion);
        expect(raw.final_output).toBe('child done');
        const completed = await normal;
        expect(await request).toBe(completed);
        expect(completed.finalOutput).toBe('child done');
        expect(await turn.wait()).toBe(completed);
        expect(await turn.wait({ until: 'manual_tool' })).toBe(completed);
        server.assertExhausted();
      } finally {
        rootSettled.resolve();
        release.resolve();
      }
    } finally {
      await executor.close();
    }
  }, 20_000);

  it('excludes child prompts from the root and returns only the exact child owner', async () => {
    const executor = await startPublicExecutor();
    let rootId: string | undefined;
    const counts = new Map<string, number>();
    const respond = (request: Record<string, unknown>) => {
      const metadata = request.client_metadata as Record<string, string>;
      const id = String(
        JSON.parse(metadata['x-codex-turn-metadata']).thread_id,
      );
      rootId ??= id;
      const count = (counts.get(id) ?? 0) + 1;
      counts.set(id, count);
      if (id !== rootId)
        return count === 1
          ? [call('decision', { owner: id }, { callId: 'same-call-id' })]
          : [message(`child ${id} done`)];
      return count === 1
        ? [
            call(
              'spawn_agent',
              { task_name: 'alpha', message: 'Ask.' },
              { namespace: 'collaboration', callId: 'spawn-alpha' },
            ),
            call(
              'spawn_agent',
              { task_name: 'beta', message: 'Ask.' },
              { namespace: 'collaboration', callId: 'spawn-beta' },
            ),
          ]
        : [message('root done')];
    };
    const server = new ModelServer(Array.from({ length: 6 }, () => respond));
    const decision = manualTool({
      name: 'decision',
      description: '',
      parameters: z.object({ owner: z.string() }),
      result: z.string(),
    });
    try {
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Delegate.',
        model: 'gpt-5.5',
        provider,
        tools: [new NativeAgents(), decision],
      }).session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
      });
      const root = await session.submit('begin');
      const completed = await root.wait({ until: 'manual_tool' });
      if ('requests' in completed)
        throw new Error('Root exposed child-only requests');
      expect(completed.finalOutput).toBe('root done');
      // Requests and ordered child starts have independent publication paths.
      const observed = new Map<string, string>();
      for await (const event of session.events()) {
        if (event.type === 'action_requested' && event.subagentId)
          observed.set(event.subagentId, event.turnId);
        if (observed.size === 2) break;
      }
      const children = await vi.waitFor(
        async () => {
          // Subagent is a frozen snapshot; refresh it until these exact Turns
          // have been issued, rather than waiting on a stale null turn field.
          const children = await Array.fromAsync(session.subagents());
          expect(children).toHaveLength(2);
          expect(children.map((child) => child.id).sort()).toEqual(
            [...observed.keys()].sort(),
          );
          for (const child of children) {
            expect(child.isLive).toBe(true);
            expect(child.turn).not.toBeNull();
            expect(child.turn?.turnId).toBe(observed.get(child.id));
          }
          return children;
        },
        { timeout: 5_000 },
      );
      for (const child of children) {
        if (!child.turn) throw new Error('Expected a live issued child Turn');
        const batch = await child.turn.wait({ until: 'manual_tool' });
        if (!('requests' in batch))
          throw new Error('Expected child manual request');
        expect(batch.turn).toBe(child.turn);
        expect(batch.requests).toHaveLength(1);
        const request = decision.match(batch.requests[0]);
        if (!request) throw new Error('Expected child declaration');
        expect(request.subagentId).toBe(child.id);
        expect(request.arguments.owner).toBe(child.id);
        expect(request.turnId).toBe(child.turn.turnId);
        expect(await child.submit(request.reply('approved'))).toBe(child.turn);
        expect((await child.turn.wait()).finalOutput).toBe(
          `child ${child.id} done`,
        );
      }
      expect(await root.wait({ until: 'manual_tool' })).toBe(completed);
      server.assertExhausted();
    } finally {
      await executor.close();
    }
  }, 20_000);
});
