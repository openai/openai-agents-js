import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import {
  Agent,
  RunItemStreamEvent,
  RunMessageOutputItem,
  RunRawModelStreamEvent,
} from '@openai/agents-core';
import { assistantMessage, ScriptedModel } from '@openai/agents-core/testing';
import { migrationStream } from '../../src/migration/stream';

// Pure producer-protocol fixtures; native acceptance has separate tests.
const agent = new Agent({ name: 'Unit stream', model: new ScriptedModel([]) });
const item = new RunItemStreamEvent(
  'message_output_created',
  new RunMessageOutputItem(assistantMessage('Accepted.'), agent),
);
const result = {
  replayEvents() {
    return ReadableStream.from([item]);
  },
};
const delta = (text: string) => ({
  type: 'output_text_delta' as const,
  delta: text,
});
const bytes = (text: string) =>
  Buffer.byteLength(JSON.stringify(new RunRawModelStreamEvent(delta(text))));
const settled = (promise: Promise<unknown>) => {
  const state = { done: false };
  void promise.then(
    () => {
      state.done = true;
    },
    () => {
      state.done = true;
    },
  );
  return state;
};

describe('migration stream delivery and producer ownership', () => {
  it('completes without readers, retains ordered raw data and replays accepted SDK semantics', async () => {
    const stream = migrationStream(async (_signal, publish) => {
      publish(delta('one'));
      publish(delta('two'));
      return result;
    });
    expect(await stream.completed).toBe(result);
    expect(
      (await Array.fromAsync(stream.unvalidatedRaw)).map((event) => event.data),
    ).toEqual([delta('one'), delta('two')]);
    expect(await Array.fromAsync(stream.replayEvents())).toEqual([item]);
    const reader = stream.replayEvents().getReader();
    expect((await reader.read()).value).toBe(item);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(stream).not.toHaveProperty('cancel');
    expect(Symbol.asyncIterator in stream).toBe(false);
    expect(stream).not.toHaveProperty('toStream');
  });

  it('does not emit semantic content before the guarded producer accepts', async () => {
    const release = Promise.withResolvers<void>();
    const stream = migrationStream(async (_signal, publish) => {
      publish(delta('tentative'));
      await release.promise;
      return result;
    });
    const reader = stream.replayEvents().getReader();
    const read = reader.read();
    const state = settled(read);
    expect(
      (await stream.unvalidatedRaw.getReader().read()).value?.data,
    ).toEqual(delta('tentative'));
    expect(state.done).toBe(false);
    release.resolve();
    expect((await read).value).toBe(item);
    expect(await stream.completed).toBe(result);
  });

  it('fails overflow promptly while completion waits for producer cleanup', async () => {
    const cleaning = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let ownerSignal: AbortSignal | undefined;
    const stream = migrationStream(
      async (signal, publish) => {
        ownerSignal = signal;
        try {
          publish(delta('one'));
          publish(delta('two'));
        } finally {
          cleaning.resolve();
          await release.promise;
        }
        return result;
      },
      undefined,
      bytes('one'),
    );
    const state = settled(stream.completed);
    await cleaning.promise;
    expect(ownerSignal?.aborted).toBe(true);
    expect(state.done).toBe(false);
    await expect(stream.unvalidatedRaw.getReader().read()).rejects.toThrow(
      'backlog',
    );
    release.resolve();
    await expect(stream.completed).rejects.toThrow('backlog');
    await expect(stream.replayEvents().getReader().read()).rejects.toThrow(
      'backlog',
    );
  });

  it('releases the pending byte budget after a read', async () => {
    const consumed = Promise.withResolvers<void>();
    const stream = migrationStream(
      async (_signal, publish) => {
        publish(delta('one'));
        await consumed.promise;
        publish(delta('two'));
        return result;
      },
      undefined,
      bytes('one'),
    );
    const reader = stream.unvalidatedRaw.getReader();
    expect((await reader.read()).value?.data).toEqual(delta('one'));
    consumed.resolve();
    expect((await reader.read()).value?.data).toEqual(delta('two'));
    expect(await stream.completed).toBe(result);
    expect((await reader.read()).done).toBe(true);
  });

  it('closes a pending semantic reader on cancellation without pretending to join work', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let ownerSignal: AbortSignal | undefined;
    const reason = new Error('semantic reader cancelled');
    const stream = migrationStream(async (signal) => {
      ownerSignal = signal;
      started.resolve();
      await release.promise;
      signal.throwIfAborted();
      return result;
    });
    const reader = stream.replayEvents().getReader();
    const read = reader.read();
    const state = settled(stream.completed);
    await started.promise;
    await reader.cancel(reason);
    expect(await read).toEqual({ done: true, value: undefined });
    expect(ownerSignal?.reason).toBe(reason);
    expect(state.done).toBe(false);
    release.resolve();
    await expect(stream.completed).rejects.toBe(reason);
  });

  it('preserves a cleanup failure after caller cancellation', async () => {
    const caller = new AbortController();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const failure = new Error('cleanup failed');
    const cleanup = async () => {
      throw failure;
    };
    const stream = migrationStream(async () => {
      started.resolve();
      try {
        await release.promise;
      } finally {
        await cleanup();
      }
      return result;
    }, caller.signal);
    await started.promise;
    caller.abort(new Error('cancel request'));
    release.resolve();
    await expect(stream.completed).rejects.toBe(failure);
    await expect(stream.replayEvents().getReader().read()).rejects.toBe(
      failure,
    );
  });

  it('does not replace a producer-confirmed successful outcome with a late cancel request', async () => {
    const caller = new AbortController();
    const stream = migrationStream(async () => {
      // Emulates a native outcome that won its cancellation race; the owner is authoritative.
      queueMicrotask(() => caller.abort(new Error('too late')));
      return result;
    }, caller.signal);
    expect(await stream.completed).toBe(result);
    expect(await Array.fromAsync(stream.replayEvents())).toEqual([item]);
  });

  it('keeps caught publication errors fatal and preserves undefined producer failures', async () => {
    const broken = migrationStream(async (_signal, publish) => {
      try {
        publish({ type: 'model', event: { value: 1n } });
      } catch {
        /* Producer cannot accept failed delivery. */
      }
      return result;
    });
    await expect(broken.completed).rejects.toBeInstanceOf(TypeError);
    const failed = migrationStream<typeof result>(async () => {
      throw undefined;
    });
    const outcome = await failed.completed.then(
      () => ({ rejected: false }),
      (error) => ({ rejected: true, error }),
    );
    expect(outcome).toEqual({ rejected: true, error: undefined });
    const delivery = await failed
      .replayEvents()
      .getReader()
      .read()
      .then(
        () => ({ rejected: false }),
        (error) => ({ rejected: true, error }),
      );
    expect(delivery).toEqual({ rejected: true, error: undefined });
  });

  it('detaches raw event snapshots and ignores late replay cancellation for other readers', async () => {
    const event = delta('original');
    const stream = migrationStream(async (_signal, publish) => {
      publish(event);
      event.delta = 'mutated';
      return result;
    });
    await stream.completed;
    await stream.replayEvents().getReader().cancel();
    expect((await Array.fromAsync(stream.unvalidatedRaw))[0]?.data).toEqual(
      delta('original'),
    );
    expect(await Array.fromAsync(stream.replayEvents())).toEqual([item]);
  });

  it('rejects invalid private byte budgets before producer effects', () => {
    let started = false;
    expect(() =>
      migrationStream(
        async () => {
          started = true;
          return result;
        },
        undefined,
        0,
      ),
    ).toThrow(RangeError);
    expect(started).toBe(false);
  });
});
