import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { VoiceConversationHistory } from '../src/voice/conversation-history';
import { PortableVoiceHistory } from '../src/voice/portable-history';
import {
  NativeVoiceControl,
  PortableVoiceSession,
  type PortableVoiceOptions,
} from '../src/voice/portable';

const message = (id: string, text = id) => ({
  id,
  type: 'message',
  role: 'user',
  status: 'completed',
  content: [{ type: 'input_text', text }],
});

afterEach(() => vi.useRealTimers());

function fixture(items: Record<string, unknown>[] = [], autoAck = true) {
  const view = new VoiceConversationHistory();
  items.forEach((item, index) =>
    view.observe({
      type: 'conversation.item.created',
      item,
      previous_item_id: index ? items[index - 1].id : null,
    }),
  );
  const commands: any[] = [];
  const failure = vi.fn();
  let rejectPreflight: Error | undefined;
  const editor = new PortableVoiceHistory(
    () => view.providerSnapshot(),
    (command: any) => {
      commands.push(command);
      if (command.type === 'validate_history') {
        if (rejectPreflight) throw rejectPreflight;
        return;
      }
      editor.trackSend(
        command.type === 'delete'
          ? { type: 'conversation.item.delete', item_id: command.item_id }
          : { type: 'conversation.item.create', item: command.item },
        Promise.resolve(),
      );
      if (autoAck)
        queueMicrotask(() =>
          ack(
            command.type === 'delete'
              ? { type: 'conversation.item.deleted', item_id: command.item_id }
              : {
                  type: 'conversation.item.created',
                  item: command.item,
                  previous_item_id:
                    command.previous_item_id === 'root'
                      ? null
                      : command.previous_item_id,
                },
          ),
        );
    },
    failure,
  );
  function ack(event: Record<string, unknown>) {
    view.observe(event);
    editor.observe(event);
  }
  return {
    editor,
    view,
    commands,
    ack,
    failure,
    reject: (error: Error) => {
      rejectPreflight = error;
    },
  };
}

it('replaces and reorders messages through exact delete/create receipts without generating a response', async () => {
  const f = fixture([message('a'), message('b')], false);
  const editing = f.editor.update([message('b'), message('a', 'corrected')]);
  await vi.waitFor(() => expect(f.commands).toHaveLength(2));
  expect(f.commands[0]).toMatchObject({
    type: 'validate_history',
    delete_ids: ['a'],
  });
  f.ack({ type: 'conversation.item.deleted', item_id: 'unrelated' });
  await Promise.resolve();
  expect(f.commands).toHaveLength(2);
  f.ack({ type: 'conversation.item.deleted', item_id: 'a' });
  await vi.waitFor(() => expect(f.commands).toHaveLength(3));
  expect(f.commands[2]).toMatchObject({
    type: 'input',
    previous_item_id: 'b',
    create_response: false,
  });
  f.ack({
    type: 'conversation.item.created',
    item: message('a', 'corrected'),
    previous_item_id: 'b',
  });
  await editing;
  expect(f.view.providerSnapshot()).toEqual([
    message('b'),
    message('a', 'corrected'),
  ]);
  expect(f.failure).not.toHaveBeenCalled();
});

it('moves messages across unchanged tool anchors and captures caller input before waiting', async () => {
  const tool = {
    id: 'tool',
    type: 'function_call',
    call_id: 'call',
    name: 'lookup',
    arguments: '{}',
  };
  const f = fixture([message('a'), tool, message('b')]);
  const desired = [message('b'), tool, message('a')];
  const editing = f.editor.update(desired);
  desired[0] = message('mutated');
  await editing;
  expect(f.view.providerSnapshot()).toEqual([message('b'), tool, message('a')]);
  expect(
    f.commands
      .filter((command) => command.type === 'delete')
      .map((command) => command.item_id),
  ).toEqual(['a', 'b']);
});

it('evaluates queued history updaters after preceding edits have been acknowledged', async () => {
  const f = fixture([message('a')]);
  const seen: unknown[][] = [];
  const first = f.editor.update((history) => {
    seen.push(history.map((item) => item.id));
    return [...history, message('b')];
  });
  const second = f.editor.update((history) => {
    seen.push(history.map((item) => item.id));
    return [...history, message('c')];
  });
  await Promise.all([first, second]);
  expect(seen).toEqual([['a'], ['a', 'b']]);
  expect(f.view.providerSnapshot()).toEqual([
    message('a'),
    message('b'),
    message('c'),
  ]);
  expect(f.commands.filter((command) => command.type === 'delete')).toEqual([]);
});

it('rejects an updater that closes history before editing', async () => {
  const f = fixture([message('a')]);
  const reason = new Error('Closed by updater.');
  await expect(
    f.editor.update((history) => {
      f.editor.close(reason);
      return history;
    }),
  ).rejects.toBe(reason);
  expect(f.commands).toEqual([]);
});

it('charges deferred updater results against queued arrays before editing', async () => {
  const f = fixture();
  const text = 'x'.repeat(1_100_000);
  const editing = f.editor.update(() => [message('callback', text)]);
  const queued = f.editor.update([message('array', text)]);
  await expect(editing).rejects.toThrow('queue exceeds capacity');
  await queued;
  expect(f.view.providerSnapshot()).toEqual([message('array', text)]);
  expect(
    f.commands
      .filter((command) => command.type === 'input')
      .map((command) => command.item.id),
  ).toEqual(['array']);
  await f.editor.update((history) => history);
});

it('rejects invalid later rows and tool rewrites before any native preflight or provider edit', async () => {
  const tool = { id: 'tool', type: 'mcp_call', name: 'lookup' };
  const f = fixture([message('a'), tool]);
  await expect(
    f.editor.update([message('a', 'changed'), { ...tool, name: 'changed' }]),
  ).rejects.toThrow('unchanged');
  await expect(f.editor.update([message('tool')])).rejects.toThrow('unchanged');
  await expect(
    f.editor.update([
      message('a'),
      { ...message('bad'), content: [{ type: 'output_audio' }] },
    ]),
  ).rejects.toThrow('replayable');
  await expect(
    f.editor.update([message('same'), message('same')]),
  ).rejects.toThrow('unique');
  expect(f.commands).toEqual([]);
});

it('honors whole-plan native ownership denial before deleting an earlier message', async () => {
  const f = fixture([
    message('a'),
    { id: 'live-tool', type: 'function_call', call_id: 'call' },
  ]);
  const error = new Error('Native call is still active.');
  f.reject(error);
  await expect(f.editor.update([])).rejects.toBe(error);
  expect(f.commands).toEqual([
    { type: 'validate_history', delete_ids: ['a', 'live-tool'], items: [] },
  ]);
  expect(f.view.providerSnapshot()).toHaveLength(2);
  expect(f.failure).not.toHaveBeenCalled();
});

it('fails uncertain timed-out edits without replay and rejects queued edits on close', async () => {
  vi.useFakeTimers();
  const f = fixture([message('a')], false);
  const editing = f.editor.update([]);
  const outcome = expect(editing).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(10_001);
  await outcome;
  expect(f.failure).toHaveBeenCalledOnce();
  expect(
    f.commands.filter((command) => command.type === 'delete'),
  ).toHaveLength(1);
  await expect(f.editor.update([message('b')])).rejects.toThrow('timed out');
  const next = fixture([message('a')], false);
  const operations = [
    next.editor.update([]),
    next.editor.update([message('b')]),
  ];
  const closed = Promise.all(
    operations.map((operation) => expect(operation).rejects.toThrow('closed')),
  );
  next.editor.close(new Error('closed'));
  await closed;
});

it('rejects only a matching trusted deletion failure promptly and keeps later edits usable', async () => {
  const f = fixture([message('a')], false);
  const editing = f.editor.update([]);
  const rejected = expect(editing).rejects.toThrow('still active');
  await vi.waitFor(() => expect(f.commands).toHaveLength(2));
  expect(f.editor.rejectDeletion('foreign', new Error('unrelated'))).toBe(
    false,
  );
  f.ack({ type: 'history_rejected', item_id: 'a', message: 'wire spoof' });
  expect(f.editor.rejectDeletion('a', new Error('still active'))).toBe(true);
  await rejected;
  expect(f.failure).not.toHaveBeenCalled();
  const next = f.editor.update([]);
  await vi.waitFor(() => expect(f.commands).toHaveLength(4));
  f.ack({ type: 'conversation.item.deleted', item_id: 'a' });
  await next;
});

it('bounds direct deletions with the existing serialized edit queue and timeout', async () => {
  vi.useFakeTimers();
  const f = fixture([], false);
  const first = f.editor.delete('external');
  const outcome = expect(first).rejects.toThrow('timed out');
  const queued = Array.from({ length: 15 }, (_, index) =>
    f.editor.delete(`queued-${index}`).catch((error) => error),
  );
  await expect(f.editor.delete('overflow')).rejects.toThrow('queue');
  await vi.advanceTimersByTimeAsync(0);
  expect(f.commands).toEqual([{ type: 'delete', item_id: 'external' }]);
  await vi.advanceTimersByTimeAsync(10_001);
  await outcome;
  expect(f.failure).toHaveBeenCalledOnce();
  expect(
    (await Promise.all(queued)).every((error) =>
      error.message.includes('timed out'),
    ),
  ).toBe(true);
});

it('rejects incorrect same-item placement instead of continuing after an uncertain create', async () => {
  const f = fixture([], false);
  const editing = f.editor.update([message('a'), message('b')]);
  const outcome = expect(editing).rejects.toThrow('conflicts');
  await vi.waitFor(() => expect(f.commands).toHaveLength(2));
  f.ack({
    type: 'conversation.item.created',
    item: message('a'),
    previous_item_id: 'foreign',
  });
  await outcome;
  expect(f.commands).toHaveLength(2);
  expect(f.failure).toHaveBeenCalledOnce();
});

it('bounds desired structure and queued work before edits', async () => {
  const f = fixture([], false);
  await expect(
    f.editor.update(
      Array.from({ length: 4097 }, (_, index) => message(`${index}`)),
    ),
  ).rejects.toThrow('4096');
  await expect(
    f.editor.update([message('large', 'x'.repeat(8 * 1024 * 1024))]),
  ).rejects.toThrow('capacity');
  expect(f.commands).toEqual([]);
  const operations = Array.from({ length: 16 }, (_, index) =>
    f.editor.update([message(`${index}`)]).catch((error) => error),
  );
  await expect(f.editor.update([])).rejects.toThrow('queue');
  f.editor.close(new Error('closed'));
  expect(
    (await Promise.all(operations)).every(
      (error) => error.message === 'closed',
    ),
  ).toBe(true);
});

async function nativeFixture(
  options: Partial<PortableVoiceOptions> = {},
  provider: {
    lookupItem?: Record<string, unknown>;
    rejectDelete?: boolean;
    waitForSend?: (event: Record<string, unknown>) => Promise<void> | undefined;
  } = {},
) {
  const control = new NativeVoiceControl(
    new WebAssembly.Module(
      Uint8Array.from(
        readFileSync(process.env.OPENAI_AGENTS_PORTABLE_CONTROL_WASM!),
      ),
    ),
  );
  const frames: any[] = [];
  const session: PortableVoiceSession = new PortableVoiceSession(
    control,
    {
      send(frame) {
        const event = JSON.parse(frame);
        frames.push(event);
        queueMicrotask(() => {
          if (event.type === 'session.update')
            session.receive({
              type: 'session.updated',
              session: event.session,
            });
          if (
            event.type === 'conversation.item.retrieve' &&
            provider.lookupItem
          )
            session.receive({
              type: 'conversation.item.retrieved',
              item: provider.lookupItem,
            });
          if (event.type === 'conversation.item.delete') {
            if (provider.rejectDelete)
              session.receive({
                type: 'error',
                error: {
                  type: 'invalid_request_error',
                  message: 'private provider rejection',
                  event_id: event.event_id,
                },
              });
            else
              session.receive({
                type: 'conversation.item.deleted',
                item_id: event.item_id,
              });
          }
          if (event.type === 'conversation.item.create')
            session.receive({
              type: 'conversation.item.created',
              item: event.item,
              previous_item_id:
                event.previous_item_id === 'root'
                  ? null
                  : event.previous_item_id,
            });
        });
        return provider.waitForSend?.(event);
      },
      close() {},
    },
    { model: 'test', instructions: 'Help', storeAudio: true, ...options },
  );
  await session.start();
  return { session, frames };
}

const native = process.env.OPENAI_AGENTS_PORTABLE_TESTS === '1';
it.runIf(native)(
  'retains provider input and output audio through the portable public owner after close',
  async () => {
    for (const storeAudio of [false, true]) {
      const { session } = await nativeFixture({ storeAudio });
      const items = [
        {
          ...message('input'),
          content: [{ type: 'input_audio', audio: 'AQIDBA==' }],
        },
        {
          ...message('output'),
          role: 'assistant',
          content: [{ type: 'output_audio', audio: 'BQYHCA==' }],
        },
      ];
      for (const item of items)
        session.receive({ type: 'conversation.item.retrieved', item });
      const expected = items.map((item) => ({
        ...item,
        content: item.content.map(({ audio, ...part }) => ({
          ...part,
          ...(storeAudio ? { audio } : {}),
        })),
      }));
      expect(session.history).toEqual(expected);
      await session.close();
      expect(session.history).toEqual(expected);
      (session.history[0].content as any[])[0].audio = 'changed';
      expect(session.history).toEqual(expected);
    }
  },
);

it.runIf(native)(
  'truncates first-observed provider audio using the portable response format',
  async () => {
    const { session } = await nativeFixture();
    session.receive({
      type: 'response.created',
      response: {
        id: 'g711',
        audio: { output: { format: { type: 'audio/pcmu' } } },
      },
    });
    const audio = Buffer.alloc(24, 7);
    session.receive({
      type: 'response.output_item.done',
      response_id: 'g711',
      item: {
        ...message('output'),
        role: 'assistant',
        content: [{ type: 'output_audio', audio: audio.toString('base64') }],
      },
    });
    session.receive({
      type: 'conversation.item.truncated',
      item_id: 'output',
      content_index: 0,
      audio_end_ms: 1,
    });
    expect((session.history[0].content as any[])[0].audio).toBe(
      audio.subarray(0, 8).toString('base64'),
    );
    await session.close();
  },
);

it.runIf(native)(
  'reports direct deletion after closing synchronously without a provider request',
  async () => {
    const onError = vi.fn();
    const { session, frames } = await nativeFixture({ onError });
    await session.close();
    const frameCount = frames.length;

    expect(() => session.deleteItem('external')).toThrow(
      'Portable voice session is closed.',
    );
    expect(frames).toHaveLength(frameCount);
    expect(onError).not.toHaveBeenCalled();
  },
);

it.runIf(native)(
  'sends conversation commands after the preceding lookup and deletion',
  async () => {
    const { session, frames } = await nativeFixture(
      {},
      { lookupItem: message('external') },
    );
    try {
      const next = message('next');
      session.deleteItem('external');
      session.truncateItem('audio', 0, 100);
      session.sendMessage(next);
      session.createResponse();
      next.content[0].text = 'changed after sending';

      await vi.waitFor(() => expect(frames).toHaveLength(6));
      expect(frames.slice(1).map((frame) => frame.type)).toEqual([
        'conversation.item.retrieve',
        'conversation.item.delete',
        'conversation.item.truncate',
        'conversation.item.create',
        'response.create',
      ]);
      expect(frames[4].item.content[0].text).toBe('next');
    } finally {
      await session.close();
    }
  },
);

it.runIf(native)(
  'starts the deletion acknowledgement deadline after its transport send',
  async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stalled = Promise.withResolvers<void>();
    const onError = vi.fn();
    const { session, frames } = await nativeFixture(
      { onError },
      {
        waitForSend: (event) =>
          event.type === 'input_audio_buffer.append'
            ? stalled.promise
            : undefined,
      },
    );
    try {
      session.sendAudio('AAAA');
      session.deleteItem('unanswered');
      await vi.advanceTimersByTimeAsync(10_001);
      expect(frames.map((frame) => frame.type)).toEqual([
        'session.update',
        'input_audio_buffer.append',
      ]);
      expect(onError).not.toHaveBeenCalled();

      stalled.resolve();
      await vi.advanceTimersByTimeAsync(9_999);
      expect(frames.at(-1)?.type).toBe('conversation.item.retrieve');
      expect(onError).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Provider history acknowledgement timed out.',
        }),
      );
      expect(onError).toHaveBeenCalledOnce();
    } finally {
      stalled.resolve();
      await session.close();
    }
  },
);

it.runIf(native)(
  'expires an unanswered direct lookup through the shared edit timeout and reports once',
  async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const onError = vi.fn();
    const { session, frames } = await nativeFixture({ onError });
    session.deleteItem('unanswered');
    await vi.advanceTimersByTimeAsync(0);
    expect(
      frames.some((frame) => frame.type === 'conversation.item.retrieve'),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(onError).toHaveBeenCalledOnce();
    expect(() => session.sendMessage(message('closed'))).toThrow('closed');
    await session.close();
  },
);

it.runIf(native)(
  'pauses the acknowledgement deadline while a retrieved item waits to be deleted',
  async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stalled = Promise.withResolvers<void>();
    const onError = vi.fn();
    const { session, frames } = await nativeFixture(
      { onError },
      {
        waitForSend: (event) =>
          event.type === 'input_audio_buffer.append'
            ? stalled.promise
            : undefined,
      },
    );
    try {
      session.deleteItem('external');
      await vi.advanceTimersByTimeAsync(0);
      expect(frames.at(-1)?.type).toBe('conversation.item.retrieve');

      session.sendAudio('AAAA');
      session.receive({
        type: 'conversation.item.retrieved',
        item: message('external'),
      });
      await vi.advanceTimersByTimeAsync(10_001);
      expect(frames.at(-1)?.type).toBe('input_audio_buffer.append');
      expect(onError).not.toHaveBeenCalled();

      stalled.resolve();
      await vi.advanceTimersByTimeAsync(10_001);
      expect(frames.at(-1)?.type).toBe('conversation.item.delete');
      expect(onError).not.toHaveBeenCalled();
    } finally {
      stalled.resolve();
      await session.close();
    }
  },
);

it.runIf(native)(
  'rejects a pre-attachment active tool lookup without deleting or closing the session',
  async () => {
    const onError = vi.fn();
    const { session, frames } = await nativeFixture(
      { onError },
      {
        lookupItem: {
          id: 'external',
          type: 'function_call',
          status: 'in_progress',
        },
      },
    );
    session.deleteItem('external');
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(
      frames.some((frame) => frame.type === 'conversation.item.retrieve'),
    ).toBe(true);
    expect(
      frames.some((frame) => frame.type === 'conversation.item.delete'),
    ).toBe(false);
    session.sendMessage(message('continuing'));
    await vi.waitFor(() =>
      expect(frames.some((frame) => frame.item?.id === 'continuing')).toBe(
        true,
      ),
    );
    await session.close();
  },
);

it.runIf(native)(
  'retrieves and deletes a valid external status-less MCP result',
  async () => {
    const onError = vi.fn();
    const { session, frames } = await nativeFixture(
      { onError },
      { lookupItem: { id: 'external', type: 'mcp_call', output: 'done' } },
    );
    session.deleteItem('external');
    await vi.waitFor(() =>
      expect(
        frames.some((frame) => frame.type === 'conversation.item.delete'),
      ).toBe(true),
    );
    expect(
      frames
        .filter((frame) => frame.type.startsWith('conversation.item.'))
        .map((frame) => frame.type),
    ).toEqual(['conversation.item.retrieve', 'conversation.item.delete']);
    expect(onError).not.toHaveBeenCalled();
    await session.close();
  },
);

it.runIf(native)(
  'rejects an exact managed deletion error promptly and permits a later acknowledged edit',
  async () => {
    const onError = vi.fn();
    const provider = { rejectDelete: true };
    const { session } = await nativeFixture({ onError }, provider);
    session.receive({
      type: 'conversation.item.created',
      item: message('a'),
      previous_item_id: null,
    });
    await expect(session.updateHistory([])).rejects.toThrow(
      'settled provider item',
    );
    expect(onError).toHaveBeenCalledOnce();
    provider.rejectDelete = false;
    await session.updateHistory([]);
    expect(session.history).toEqual([]);
    await session.close();
  },
);

it.runIf(native)(
  'runs ordered inert edits through Rust and retains detached history/audio after close',
  async () => {
    const { session, frames } = await nativeFixture();
    session.receive({
      type: 'conversation.item.created',
      item: message('a'),
      previous_item_id: null,
    });
    session.receive({
      type: 'conversation.item.created',
      item: message('b'),
      previous_item_id: 'a',
    });
    await session.updateHistory([message('b'), message('a', 'corrected')]);
    expect(session.history).toEqual([message('b'), message('a', 'corrected')]);
    expect(frames.some((event) => event.type === 'response.create')).toBe(
      false,
    );
    session.createResponse();
    await vi.waitFor(() =>
      expect(frames.some((event) => event.type === 'response.create')).toBe(
        true,
      ),
    );
    session.receive({
      type: 'response.created',
      response: { id: 'audio-response' },
    });
    session.receive({
      type: 'response.output_item.added',
      response_id: 'audio-response',
      output_index: 0,
      item: {
        id: 'audio',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_audio' }],
      },
    });
    session.receive({
      type: 'response.output_audio.delta',
      response_id: 'audio-response',
      item_id: 'audio',
      content_index: 0,
      delta: 'AQACAA==',
    });
    const beforeClose = session.history;
    expect(beforeClose.at(-1)).toMatchObject({
      id: 'audio',
      content: [{ type: 'output_audio', audio: 'AQACAA==' }],
    });
    await session.close();
    expect(session.history).toEqual(beforeClose);
    (beforeClose[0].content as any[])[0].text = 'caller mutation';
    expect(session.history[0]).toEqual(message('b'));
    await expect(session.updateHistory([])).rejects.toThrow('closed');
  },
);

it.runIf(native)(
  'preflights actual Rust live-call ownership before deleting an earlier message',
  async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const { session, frames } = await nativeFixture({
      tools: [
        {
          name: 'lookup',
          description: 'Look up',
          parameters: { type: 'object' },
          execute: async () => {
            entered = true;
            await gate;
            return 'accepted-result';
          },
        },
      ],
    });
    try {
      session.receive({
        type: 'conversation.item.created',
        item: message('a'),
        previous_item_id: null,
      });
      session.createResponse();
      await vi.waitFor(() =>
        expect(frames.some((event) => event.type === 'response.create')).toBe(
          true,
        ),
      );
      session.receive({
        type: 'response.created',
        response: { id: 'live-response' },
      });
      session.receive({
        type: 'response.done',
        response: {
          id: 'live-response',
          status: 'completed',
          output: [
            {
              id: 'live-item',
              type: 'function_call',
              call_id: 'live-call',
              name: 'lookup',
              arguments: '{}',
            },
          ],
        },
      });
      await vi.waitFor(() => expect(entered).toBe(true));
      const before = frames.length;
      await expect(session.updateHistory([])).rejects.toThrow();
      expect(
        frames
          .slice(before)
          .some((event) => event.type === 'conversation.item.delete'),
      ).toBe(false);
      expect(session.history.some((item) => item.id === 'a')).toBe(true);
      release();
      await vi.waitFor(() =>
        expect(
          frames.some(
            (event) =>
              event.type === 'conversation.item.create' &&
              event.item?.call_id === 'live-call' &&
              event.item?.output === 'accepted-result',
          ),
        ).toBe(true),
      );
    } finally {
      release();
      await session.close();
    }
  },
);
