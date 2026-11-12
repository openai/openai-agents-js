import { expect, it } from 'vitest';
import { Agent, NativeProvider, type ModelRequest } from '../../src';
import type { JsonObject } from '../../src/runtime/binding';

function added(): JsonObject {
  return {
    type: 'response.output_item.added',
    output_index: 0,
    item: { id: 'answer', type: 'message', role: 'assistant', content: [] },
  };
}
function delta(text: string): JsonObject {
  return {
    type: 'response.output_text.delta',
    item_id: 'answer',
    output_index: 0,
    content_index: 0,
    delta: text,
  };
}
function done(text: string): JsonObject {
  return {
    type: 'response.output_item.done',
    output_index: 0,
    item: {
      id: 'answer',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    },
  };
}

it.each([false, true])(
  'publishes an approved answer prefix during generation independently of final rejection=%s',
  async (rejectFinal) => {
    const release = Promise.withResolvers<void>();
    let providerSettled = false;
    await using provider = new NativeProvider({
      modelBackend: {
        complete() {
          throw new Error('Expected streaming');
        },
        async *stream(request: ModelRequest): AsyncGenerator<JsonObject> {
          yield added();
          yield delta('Approved.');
          await release.promise;
          request.signal.throwIfAborted();
          yield delta(' Private tail.');
          yield done('Approved. Private tail.');
          yield {
            type: 'response.completed',
            response: { id: 'response', status: 'completed' },
          };
          providerSettled = true;
        },
      },
    });
    await using session = await new Agent({
      instructions: 'Answer',
      model: 'fixture-stream-model',
      provider,
      beforeComplete: rejectFinal
        ? () => ({ action: 'stop' as const })
        : undefined,
    }).session();
    const turn = await session.submit('Begin');
    const reader = turn.acceptedText((pending) =>
      pending === 'Approved.' ? pending : undefined,
    );
    try {
      const first = await reader.next();
      expect(first).toMatchObject({
        done: false,
        value: { turnId: turn.turnId, itemId: 'answer', text: 'Approved.' },
      });
      expect(providerSettled).toBe(false);
      release.resolve();
      const remaining = [];
      for await (const chunk of reader) remaining.push(chunk.text);
      expect(remaining).toEqual([]);
      if (rejectFinal) await expect(turn.wait()).rejects.toThrow();
      else
        expect((await turn.wait()).finalOutput).toBe('Approved. Private tail.');
      const replay = turn.acceptedText(() => {
        throw new Error('Settled approval must not run');
      });
      expect(await replay.next()).toEqual({ done: true, value: undefined });
    } finally {
      release.resolve();
      await reader.return?.();
    }
  },
  20_000,
);

it('withholds an async approval after cancellation and joins the independent provider', async () => {
  const entered = Promise.withResolvers<void>();
  const releaseApproval = Promise.withResolvers<void>();
  let providerClosed = false;
  await using provider = new NativeProvider({
    modelBackend: {
      complete() {
        throw new Error('Expected streaming');
      },
      async *stream(request: ModelRequest): AsyncGenerator<JsonObject> {
        try {
          yield added();
          yield delta('Candidate');
          await new Promise<void>((resolve) =>
            request.signal.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          );
          request.signal.throwIfAborted();
        } finally {
          providerClosed = true;
        }
      },
    },
  });
  await using session = await new Agent({
    instructions: 'Answer',
    model: 'fixture-stream-model',
    provider,
  }).session();
  const turn = await session.submit('Begin');
  const reader = turn.acceptedText(async (pending) => {
    entered.resolve();
    await releaseApproval.promise;
    return pending;
  });
  const next = reader.next();
  try {
    await entered.promise;
    await turn.cancel();
    releaseApproval.resolve();
    expect(await next).toEqual({ done: true, value: undefined });
    await expect(turn.wait()).rejects.toThrow();
    expect(providerClosed).toBe(true);
  } finally {
    releaseApproval.resolve();
    await reader.return?.();
  }
}, 20_000);

it('excludes linked private repairs even when their output item IDs match the root item', async () => {
  const release = Promise.withResolvers<void>();
  let attempts = 0;
  await using provider = new NativeProvider({
    apiKey: 'synthetic-private-repair',
    modelBackend: {
      complete() {
        throw new Error('Expected streaming');
      },
      async *stream(): AsyncGenerator<JsonObject> {
        const root = ++attempts === 1;
        const value = root ? 'invalid' : '{"count":2}';
        yield added();
        yield delta(value);
        if (root) await release.promise;
        yield done(value);
        yield {
          type: 'response.completed',
          response: { id: `response-${attempts}`, status: 'completed' },
        };
      },
    },
  });
  await using session = await new Agent({
    instructions: 'Count',
    model: 'fixture-stream-model',
    provider,
  }).session();
  const { z } = await import('zod');
  const turn = await session.submit('Begin', {
    outputType: {
      mode: 'prompted',
      schema: z.object({ count: z.number() }),
      maxRetries: 1,
    },
  });
  const candidates: string[] = [];
  const published: string[] = [];
  try {
    for await (const chunk of turn.acceptedText((pending) => {
      candidates.push(pending);
      return pending;
    })) {
      published.push(chunk.text);
      release.resolve();
    }
    expect((await turn.wait()).finalOutput).toEqual({ count: 2 });
    expect(attempts).toBe(2);
    expect(candidates).toEqual(['invalid']);
    expect(published).toEqual(['invalid']);
  } finally {
    release.resolve();
  }
}, 20_000);

it('withholds async root approval after native settlement while private repair remains active', async () => {
  const approvalEntered = Promise.withResolvers<void>();
  const releaseApproval = Promise.withResolvers<void>();
  const releaseRoot = Promise.withResolvers<void>();
  const repairEntered = Promise.withResolvers<void>();
  const releaseRepair = Promise.withResolvers<void>();
  let attempts = 0;
  await using provider = new NativeProvider({
    apiKey: 'synthetic-prefix-lifetime',
    modelBackend: {
      complete() {
        throw new Error('Expected streaming');
      },
      async *stream(): AsyncGenerator<JsonObject> {
        const root = ++attempts === 1;
        const value = root ? 'invalid' : '{"count":2}';
        yield added();
        yield delta(value);
        if (root) await releaseRoot.promise;
        else {
          repairEntered.resolve();
          await releaseRepair.promise;
        }
        yield done(value);
        yield {
          type: 'response.completed',
          response: { id: `response-${attempts}`, status: 'completed' },
        };
      },
    },
  });
  await using session = await new Agent({
    instructions: 'Count',
    model: 'fixture-stream-model',
    provider,
  }).session();
  const { z } = await import('zod');
  const turn = await session.submit('Begin', {
    outputType: {
      mode: 'prompted',
      schema: z.object({ count: z.number() }),
      maxRetries: 1,
    },
  });
  const result = turn.wait();
  void result.catch(() => {});
  const reader = turn.acceptedText(async (pending) => {
    approvalEntered.resolve();
    await releaseApproval.promise;
    return pending;
  });
  const next = reader.next();
  try {
    await approvalEntered.promise;
    releaseRoot.resolve();
    await repairEntered.promise;
    releaseApproval.resolve();
    expect(await next).toEqual({ done: true, value: undefined });
    releaseRepair.resolve();
    expect((await result).finalOutput).toEqual({ count: 2 });
  } finally {
    releaseRoot.resolve();
    releaseApproval.resolve();
    releaseRepair.resolve();
    await reader.return?.();
  }
}, 20_000);

it.each(['approval', 'observation'] as const)(
  'retires accepted text while a %s wait remains pending without cancelling generation',
  async (mode) => {
    const providerStarted = Promise.withResolvers<void>();
    const releaseProvider = Promise.withResolvers<void>();
    const approvalEntered = Promise.withResolvers<void>();
    const releaseApproval = Promise.withResolvers<void>();
    await using provider = new NativeProvider({
      modelBackend: {
        complete() {
          throw new Error('Expected streaming');
        },
        async *stream(): AsyncGenerator<JsonObject> {
          providerStarted.resolve();
          if (mode === 'observation') await releaseProvider.promise;
          yield added();
          yield delta('Candidate');
          if (mode === 'approval') await releaseProvider.promise;
          yield done('Candidate');
          yield {
            type: 'response.completed',
            response: { id: 'reader-close', status: 'completed' },
          };
        },
      },
    });
    await using session = await new Agent({
      instructions: 'Answer',
      model: 'fixture-stream-model',
      provider,
    }).session();
    const turn = await session.submit('Begin');
    const reader = turn.acceptedText(async (pending) => {
      approvalEntered.resolve();
      await releaseApproval.promise;
      return pending;
    });
    const next = reader.next();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (mode === 'approval') await approvalEntered.promise;
      else await providerStarted.promise;
      const closing = reader.return!();
      releaseApproval.resolve();
      const [pendingRead, closed] = await Promise.race([
        Promise.all([next, closing]),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error('Reader retirement did not wake the pending read'),
              ),
            1000,
          );
        }),
      ]);
      expect(pendingRead).toEqual({ done: true, value: undefined });
      expect(closed).toEqual({ done: true, value: undefined });
      releaseProvider.resolve();
      expect((await turn.wait()).finalOutput).toBe('Candidate');
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      releaseApproval.resolve();
      releaseProvider.resolve();
      await reader.return?.();
    }
  },
  20_000,
);

it.each([false, true])(
  'has been starting accepted text at the admission cursor (queued=%s)',
  async (queued) => {
    const releaseFirst = Promise.withResolvers<void>();
    const releaseFresh = Promise.withResolvers<void>();
    let requests = 0;
    await using provider = new NativeProvider({
      modelBackend: {
        complete() {
          throw new Error('Expected streaming');
        },
        async *stream(): AsyncGenerator<JsonObject> {
          const first = ++requests === 1;
          yield added();
          if (first) {
            for (let i = 0; i < 300; i++) yield delta('x');
            yield delta('Past');
            await releaseFirst.promise;
          } else {
            yield delta('Fresh');
            await releaseFresh.promise;
          }
          yield done(first ? 'x'.repeat(300) + 'Past' : 'Fresh');
          yield {
            type: 'response.completed',
            response: { id: `response-${requests}`, status: 'completed' },
          };
        },
      },
    });
    await using session = await new Agent({
      instructions: 'Answer',
      model: 'fixture-stream-model',
      provider,
    }).session();
    const first = await session.submit('Old history');
    let reader: ReturnType<typeof first.acceptedText> | undefined;
    try {
      for await (const event of first.events()) {
        if (event.type === 'output_text_delta' && event.delta === 'Past') break;
      }
      if (!queued) {
        releaseFirst.resolve();
        await first.wait();
      }
      const fresh = queued
        ? await session.enqueue('Fresh')
        : await session.submit('Fresh');
      const raw = fresh.events();
      expect((await raw.next()).value?.type).toBe('gap');
      await raw.return?.();
      let callbacks = 0;
      reader = fresh.acceptedText((pending) => {
        callbacks++;
        return pending;
      });
      let settled = false;
      const next = reader.next().then(
        (value) => {
          settled = true;
          return { value };
        },
        (error: unknown) => {
          settled = true;
          return { error };
        },
      );
      if (queued) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(fresh.turnId).toBeNull();
        expect(settled).toBe(false);
        releaseFirst.resolve();
        await first.wait();
      }
      const outcome = await next;
      if ('error' in outcome) throw outcome.error;
      expect(outcome.value.done).toBe(false);
      expect(outcome.value.value?.text).toBe('Fresh');
      expect(callbacks).toBe(1);
      releaseFresh.resolve();
      await reader.return?.();
      expect((await fresh.wait()).finalOutput).toBe('Fresh');
    } finally {
      releaseFirst.resolve();
      releaseFresh.resolve();
      await reader?.return?.();
    }
  },
);

it('has been preserving gap errors for lost current turn observations', async () => {
  const release = Promise.withResolvers<void>();
  await using provider = new NativeProvider({
    modelBackend: {
      complete() {
        throw new Error('Expected streaming');
      },
      async *stream(): AsyncGenerator<JsonObject> {
        yield added();
        for (let i = 0; i < 300; i++) yield delta('x');
        yield delta('Last');
        await release.promise;
        yield done('x'.repeat(300) + 'Last');
        yield {
          type: 'response.completed',
          response: { id: 'response', status: 'completed' },
        };
      },
    },
  });
  await using session = await new Agent({
    instructions: 'Answer',
    model: 'fixture-stream-model',
    provider,
  }).session();
  const turn = await session.submit('Generate');
  let reader: ReturnType<typeof turn.acceptedText> | undefined;
  try {
    for await (const event of turn.events()) {
      if (event.type === 'output_text_delta' && event.delta === 'Last') break;
    }
    let callbacks = 0;
    reader = turn.acceptedText((pending) => {
      callbacks++;
      return pending;
    });
    await expect(reader.next()).rejects.toThrow(
      'Accepted text observations contain a gap',
    );
    expect(callbacks).toBe(0);
  } finally {
    release.resolve();
    await reader?.return?.();
  }
  expect((await turn.wait()).finalOutput).toBe('x'.repeat(300) + 'Last');
});
