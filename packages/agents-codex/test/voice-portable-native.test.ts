import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NativeVoiceControl,
  PortableVoiceSession,
} from '@openai/agents/voice/portable';
import { connectPortableVoiceWorker } from '@openai/agents/voice/workerd';
import { connectPortableVoiceBrowser } from '@openai/agents/voice/browser';

// These tests execute the real reviewed Rust Wasm artifact, never a JS control double.
const enabled = process.env.OPENAI_AGENTS_PORTABLE_TESTS === '1';
function control() {
  const path = process.env.OPENAI_AGENTS_PORTABLE_CONTROL_WASM;
  if (!path)
    throw new Error(
      'Set OPENAI_AGENTS_PORTABLE_CONTROL_WASM to the built native module.',
    );
  return new NativeVoiceControl(
    new WebAssembly.Module(Uint8Array.from(readFileSync(path))),
  );
}
const item = {
  type: 'function_call',
  id: 'item-1',
  call_id: 'call-1',
  name: 'lookup',
  arguments: '{"value":7}',
};
function fixtureEvents(session: { tools: unknown[] }) {
  return [
    { type: 'session.updated', session },
    { type: 'response.created', response: { id: 'response-1' } },
    { type: 'response.output_item.done', response_id: 'response-1', item },
    {
      type: 'response.done',
      response: { id: 'response-1', status: 'completed', output: [item] },
    },
  ];
}
function agent() {
  const execute = vi.fn(async (args: Record<string, unknown>) =>
    String(args.value),
  );
  const onApproval = vi.fn(async () => true);
  return {
    execute,
    onApproval,
    options: {
      model: 'test-realtime',
      instructions: 'Help.',
      tools: [
        {
          name: 'lookup',
          description: 'Look up a value',
          parameters: { type: 'object' },
          needsApproval: true,
          execute,
        },
      ],
      onApproval,
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe.runIf(enabled)('portable Rust control', () => {
  it('aggregates reported usage without inventing missing counts or exposing mutable totals', async () => {
    const frames: { type: string }[] = [];
    const events: { type: string; response?: { usage?: unknown } }[] = [];
    const session: PortableVoiceSession = new PortableVoiceSession(
      control(),
      {
        send(frame) {
          const event = JSON.parse(frame);
          frames.push(event);
          if (event.type === 'session.update')
            queueMicrotask(() =>
              session.receive({
                type: 'session.updated',
                session: event.session,
              }),
            );
        },
        close() {},
      },
      {
        model: 'test-realtime',
        instructions: 'Help.',
        onEvent(event) {
          events.push(event as (typeof events)[number]);
        },
      },
    );
    const first = {
      input_tokens: 10,
      output_tokens: 4,
      total_tokens: 14,
      input_token_details: {
        text_tokens: 3,
        audio_tokens: 7,
        cached_tokens: 2,
        cached_tokens_details: { text_tokens: 1, audio_tokens: 1 },
      },
      output_token_details: { audio_tokens: 4 },
      vendor_meter: 9,
    };
    try {
      await session.start();
      expect(session.usage).toBeUndefined();
      const reports = [
        first,
        {
          input_tokens: 2,
          total_tokens: 2,
          input_token_details: { text_tokens: 2 },
        },
        undefined,
      ];
      for (let index = 0; index < reports.length; index++) {
        session.requestResponse();
        await vi.waitFor(() =>
          expect(
            frames.filter((event) => event.type === 'response.create'),
          ).toHaveLength(index + 1),
        );
        const id = `usage-${index}`;
        session.receive({ type: 'response.created', response: { id } });
        session.receive({
          type: 'response.done',
          response: {
            id,
            status: index === 1 ? 'cancelled' : 'completed',
            output: [],
            usage: reports[index],
          },
        });
        await vi.waitFor(() =>
          expect(
            events.filter((event) => event.type === 'response.done'),
          ).toHaveLength(index + 1),
        );
      }
      const expected = {
        input_tokens: 12,
        output_tokens: 4,
        total_tokens: 16,
        input_token_details: {
          text_tokens: 5,
          audio_tokens: 7,
          cached_tokens: 2,
          cached_tokens_details: { text_tokens: 1, audio_tokens: 1 },
        },
        output_token_details: { audio_tokens: 4 },
      };
      expect(session.usage).toEqual(expected);
      const copy = session.usage as {
        input_tokens: number;
        input_token_details: { text_tokens: number };
      };
      copy.input_tokens = 999;
      copy.input_token_details.text_tokens = 999;
      expect(session.usage).toEqual(expected);
      expect(
        events.find((event) => event.type === 'response.done')?.response?.usage,
      ).toEqual(first);
    } finally {
      await session.close();
    }
    expect(session.usage?.input_tokens).toBe(12);
  });

  it('closes on invalid reported usage without publishing corrupt totals', async () => {
    const frames: { type: string }[] = [];
    const onError = vi.fn();
    const session: PortableVoiceSession = new PortableVoiceSession(
      control(),
      {
        send(frame) {
          const event = JSON.parse(frame);
          frames.push(event);
          if (event.type === 'session.update')
            queueMicrotask(() =>
              session.receive({
                type: 'session.updated',
                session: event.session,
              }),
            );
        },
        close() {},
      },
      { model: 'test-realtime', instructions: 'Help.', onError },
    );
    try {
      await session.start();
      session.requestResponse();
      await vi.waitFor(() =>
        expect(frames.some((event) => event.type === 'response.create')).toBe(
          true,
        ),
      );
      session.receive({
        type: 'response.created',
        response: { id: 'invalid-usage' },
      });
      session.receive({
        type: 'response.done',
        response: {
          id: 'invalid-usage',
          status: 'completed',
          output: [],
          usage: { input_tokens: -1 },
        },
      });
      await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
      expect(session.usage).toBeUndefined();
      expect(() => session.sendText('After invalid usage.')).toThrow('closed');
    } finally {
      await session.close();
    }
  });

  it.each([true, false])(
    'keeps the session after speech with automatic interruption %s',
    async (automatic) => {
      const definition = agent();
      const frames: { type: string; response_id?: string }[] = [];
      const onError = vi.fn();
      const session: PortableVoiceSession = new PortableVoiceSession(
        control(),
        {
          send(frame) {
            const event = JSON.parse(frame);
            frames.push(event);
            if (event.type === 'session.update')
              queueMicrotask(() =>
                session.receive({
                  type: 'session.updated',
                  session: event.session,
                }),
              );
          },
          close() {},
        },
        {
          ...definition.options,
          sessionSettings: {
            audio: {
              input: {
                turn_detection: {
                  type: 'server_vad',
                  interrupt_response: automatic,
                },
              },
            },
          },
          onError,
        },
      );
      try {
        await session.start();
        session.requestResponse();
        await vi.waitFor(() =>
          expect(
            frames.filter((event) => event.type === 'response.create'),
          ).toHaveLength(1),
        );
        session.receive({
          type: 'response.created',
          response: { id: 'first' },
        });
        session.receive({ type: 'input_audio_buffer.speech_started' });
        session.receive({
          type: 'response.done',
          response: {
            id: 'first',
            status: automatic ? 'cancelled' : 'completed',
            output: automatic ? [] : [item],
          },
        });
        session.sendText('Continue.');
        await vi.waitFor(() =>
          expect(
            frames.filter((event) => event.type === 'response.create'),
          ).toHaveLength(2),
        );
        expect(
          frames.filter((event) => event.type === 'response.cancel'),
        ).toHaveLength(0);
        expect(definition.execute).toHaveBeenCalledTimes(automatic ? 0 : 1);
        expect(definition.onApproval).toHaveBeenCalledTimes(automatic ? 0 : 1);
        expect(onError).not.toHaveBeenCalled();
      } finally {
        await session.close();
      }
    },
  );

  it.each([
    { status: 'cancelled', interrupt: true },
    { status: 'failed', interrupt: false },
    { status: 'incomplete', interrupt: false },
    { status: 'completed', interrupt: true },
    { status: 'completed', interrupt: false },
  ])(
    'rejects a retired $status response identity with interrupt $interrupt',
    async ({ status, interrupt }) => {
      const definition = agent();
      const onError = vi.fn();
      const frames: { type: string; item?: { type: string } }[] = [];
      const session: PortableVoiceSession = new PortableVoiceSession(
        control(),
        {
          send(frame) {
            const event = JSON.parse(frame);
            frames.push(event);
            if (event.type === 'session.update')
              queueMicrotask(() =>
                session.receive({
                  type: 'session.updated',
                  session: event.session,
                }),
              );
          },
          close() {},
        },
        { ...definition.options, onError },
      );
      try {
        await session.start();
        session.receive({
          type: 'response.created',
          response: { id: 'retired' },
        });
        if (interrupt) session.interrupt();
        session.receive({
          type: 'response.done',
          response: { id: 'retired', status, output: [] },
        });
        session.receive({
          type: 'response.created',
          response: { id: 'retired' },
        });
        session.receive({
          type: 'response.done',
          response: { id: 'retired', status: 'completed', output: [item] },
        });
        await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
        expect(definition.execute).not.toHaveBeenCalled();
        expect(definition.onApproval).not.toHaveBeenCalled();
        expect(
          frames.some((frame) => frame.item?.type === 'function_call_output'),
        ).toBe(false);
        expect(() => session.requestResponse()).toThrow('closed');
      } finally {
        await session.close();
      }
    },
  );

  it.each(
    ['cancelled', 'failed', 'incomplete', 'completed'].flatMap((status) =>
      [false, true].map((queued) => ({ status, queued })),
    ),
  )(
    'continues a published callback after $status with queued input $queued',
    async ({ status, queued }) => {
      const definition = agent();
      const result = Promise.withResolvers<string>();
      const execute = vi.fn(() => result.promise);
      const onError = vi.fn();
      const frames: { type: string; item?: { type: string } }[] = [];
      const session: PortableVoiceSession = new PortableVoiceSession(
        control(),
        {
          send(frame) {
            const event = JSON.parse(frame);
            frames.push(event);
            if (event.type === 'session.update')
              queueMicrotask(() =>
                session.receive({
                  type: 'session.updated',
                  session: event.session,
                }),
              );
          },
          close() {},
        },
        {
          ...definition.options,
          tools: [{ ...definition.options.tools[0], execute }],
          onError,
        },
      );
      try {
        await session.start();
        session.receive({
          type: 'response.created',
          response: { id: 'first' },
        });
        session.receive({
          type: 'response.done',
          response: { id: 'first', status: 'completed', output: [item] },
        });
        await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
        session.receive({
          type: 'response.created',
          response: { id: 'second' },
        });
        result.resolve('Authorized result.');
        await vi.waitFor(() =>
          expect(
            frames.some((frame) => frame.item?.type === 'function_call_output'),
          ).toBe(true),
        );
        // The serialized clear frame follows the output's physical send receipt.
        session.clearAudio();
        await vi.waitFor(() =>
          expect(
            frames.some((frame) => frame.type === 'input_audio_buffer.clear'),
          ).toBe(true),
        );
        if (queued) session.sendText('Next input.');
        expect(
          frames.filter((frame) => frame.type === 'response.create'),
        ).toHaveLength(0);
        session.receive({
          type: 'response.done',
          response: { id: 'second', status, output: [] },
        });
        await vi.waitFor(() =>
          expect(
            frames.filter((frame) => frame.type === 'response.create'),
          ).toHaveLength(1),
        );
        expect(execute).toHaveBeenCalledOnce();
        expect(onError).not.toHaveBeenCalled();
      } finally {
        result.resolve('Cleanup.');
        await session.close();
      }
    },
  );

  it('retains unfinished callbacks while older terminal identities leave the window', async () => {
    const definition = agent();
    const result = Promise.withResolvers<string>();
    const execute = vi.fn(() => result.promise);
    const onError = vi.fn();
    const frames: { type: string; item?: { type: string } }[] = [];
    const session: PortableVoiceSession = new PortableVoiceSession(
      control(),
      {
        send(frame) {
          const event = JSON.parse(frame);
          frames.push(event);
          if (event.type === 'session.update')
            queueMicrotask(() =>
              session.receive({
                type: 'session.updated',
                session: event.session,
              }),
            );
        },
        close() {},
      },
      {
        ...definition.options,
        tools: [{ ...definition.options.tools[0], execute }],
        onError,
      },
    );
    try {
      await session.start();
      session.receive({ type: 'response.created', response: { id: 'first' } });
      session.receive({
        type: 'response.done',
        response: { id: 'first', status: 'completed', output: [item] },
      });
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      for (let index = 0; index < 288; index++) {
        const id = `newer-${index}`;
        session.receive({ type: 'response.created', response: { id } });
        session.receive({
          type: 'response.done',
          response: { id, status: 'completed', output: [] },
        });
      }
      result.resolve('Still authorized.');
      await vi.waitFor(() =>
        expect(
          frames.filter((frame) => frame.type === 'response.create'),
        ).toHaveLength(1),
      );
      expect(
        frames.filter((frame) => frame.item?.type === 'function_call_output'),
      ).toHaveLength(1);
      expect(execute).toHaveBeenCalledOnce();
      expect(onError).not.toHaveBeenCalled();
    } finally {
      result.resolve('Cleanup.');
      await session.close();
    }
  });

  it('keeps a healthy session beyond the response identity window', () => {
    const native = control();
    const started = native.apply({
      type: 'start',
      config: { model: 'test-realtime', instructions: 'Help.', tools: [] },
    });
    const send = started[0];
    if (send.type !== 'send') throw new Error('Missing session update.');
    const update = send.event as { session: unknown };
    native.apply({ type: 'sent', id: send.id });
    native.apply({
      type: 'provider',
      event: { type: 'session.updated', session: update.session },
    });
    for (let index = 0; index < 288; index++) {
      const id = `response-${index}`;
      native.apply({
        type: 'provider',
        event: { type: 'response.created', response: { id } },
      });
      // Repeated creation for the current identity is harmless before settlement.
      native.apply({
        type: 'provider',
        event: { type: 'response.created', response: { id } },
      });
      native.apply({
        type: 'provider',
        event: {
          type: 'response.done',
          response: { id, status: 'completed', output: [] },
        },
      });
    }
    // An old identity outside the replay window is not permanently blacklisted.
    expect(() =>
      native.apply({
        type: 'provider',
        event: { type: 'response.created', response: { id: 'response-0' } },
      }),
    ).not.toThrow();
    native.apply({
      type: 'provider',
      event: {
        type: 'response.done',
        response: { id: 'response-0', status: 'completed', output: [] },
      },
    });
    expect(() =>
      native.apply({
        type: 'provider',
        event: { type: 'response.created', response: { id: 'response-287' } },
      }),
    ).toThrow('already retired');
  });

  async function queuedResponseSession(
    automatic = false,
    execute?: () => Promise<string>,
  ) {
    const gate = Promise.withResolvers<void>();
    const frames: { type: string; item?: { type?: string } }[] = [];
    const onError = vi.fn();
    const session: PortableVoiceSession = new PortableVoiceSession(
      control(),
      {
        send(frame) {
          const event = JSON.parse(frame);
          frames.push(event);
          if (event.type === 'session.update')
            queueMicrotask(() =>
              session.receive({
                type: 'session.updated',
                session: event.session,
              }),
            );
          if (event.type === 'input_audio_buffer.append') return gate.promise;
        },
        close() {},
      },
      {
        model: 'test-realtime',
        instructions: 'Help.',
        onError,
        sessionSettings: {
          audio: {
            input: {
              turn_detection: {
                type: 'server_vad',
                interrupt_response: automatic,
              },
            },
          },
        },
        tools: execute
          ? [
              {
                name: 'lookup',
                description: 'Lookup',
                parameters: { type: 'object' },
                needsApproval: false,
                execute,
              },
            ]
          : [],
      },
    );
    await session.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { session, frames, onError, gate };
  }
  it.each(
    [false, true].flatMap((automatic) =>
      [false, true].flatMap((requestBeforeTerminal) =>
        [false, true].map((newerRequest) => ({
          automatic,
          requestBeforeTerminal,
          newerRequest,
        })),
      ),
    ),
  )(
    'cancels the deferred caller request at arrival automatic=$automatic beforeTerminal=$requestBeforeTerminal newer=$newerRequest',
    async ({ automatic, requestBeforeTerminal, newerRequest }) => {
      const f = await queuedResponseSession(automatic);
      try {
        f.session.requestResponse();
        await vi.waitFor(() =>
          expect(
            f.frames.filter((x) => x.type === 'response.create'),
          ).toHaveLength(1),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        f.session.receive({
          type: 'response.created',
          response: { id: 'old' },
        });
        f.session.sendAudio(new ArrayBuffer(2));
        await vi.waitFor(() =>
          expect(f.frames.at(-1)?.type).toBe('input_audio_buffer.append'),
        );
        if (requestBeforeTerminal) f.session.requestResponse();
        f.session.receive({
          type: 'response.done',
          response: { id: 'old', status: 'completed', output: [] },
        });
        if (!requestBeforeTerminal) f.session.requestResponse();
        if (automatic)
          f.session.receive({ type: 'input_audio_buffer.speech_started' });
        else f.session.interrupt();
        if (newerRequest) f.session.requestResponse();
        f.gate.resolve();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(
          f.frames.filter((x) => x.type === 'response.create'),
        ).toHaveLength(newerRequest ? 2 : 1);
        expect(f.onError).not.toHaveBeenCalled();
        if (!newerRequest) {
          f.session.requestResponse();
          await vi.waitFor(() =>
            expect(
              f.frames.filter((x) => x.type === 'response.create'),
            ).toHaveLength(2),
          );
        }
      } finally {
        f.gate.resolve();
        await f.session.close();
      }
    },
  );
  it.each(
    [false, true].flatMap((parked) =>
      ['request', 'text'].map((method) => ({ parked, method })),
    ),
  )(
    'defers caller $method behind an already received creation parked=$parked',
    async ({ parked, method }) => {
      const f = await queuedResponseSession();
      try {
        if (parked) {
          f.session.sendAudio(new ArrayBuffer(2));
          await vi.waitFor(() =>
            expect(f.frames.at(-1)?.type).toBe('input_audio_buffer.append'),
          );
        }
        f.session.receive({
          type: 'response.created',
          response: { id: 'vad' },
        });
        if (method === 'request') f.session.requestResponse();
        else f.session.sendText('Next.');
        f.gate.resolve();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(
          f.frames.filter((x) => x.type === 'response.create'),
        ).toHaveLength(0);
        f.session.receive({
          type: 'response.done',
          response: { id: 'vad', status: 'completed', output: [] },
        });
        await vi.waitFor(() =>
          expect(
            f.frames.filter((x) => x.type === 'response.create'),
          ).toHaveLength(1),
        );
        expect(f.onError).not.toHaveBeenCalled();
      } finally {
        f.gate.resolve();
        await f.session.close();
      }
    },
  );
  it.each(
    [false, true].flatMap((automatic) =>
      [false, true].map((processedCreation) => ({
        automatic,
        processedCreation,
      })),
    ),
  )(
    'retains completed tool continuation across caller cancellation automatic=$automatic processed=$processedCreation',
    async ({ automatic, processedCreation }) => {
      const result = Promise.withResolvers<string>();
      const execute = vi.fn(() => result.promise);
      const f = await queuedResponseSession(automatic, execute);
      try {
        if (processedCreation) {
          f.session.requestResponse();
          await vi.waitFor(() =>
            expect(
              f.frames.filter((x) => x.type === 'response.create'),
            ).toHaveLength(1),
          );
          await new Promise((resolve) => setTimeout(resolve, 0));
          f.session.receive({
            type: 'response.created',
            response: { id: 'old' },
          });
        }
        f.session.sendAudio(new ArrayBuffer(2));
        await vi.waitFor(() =>
          expect(f.frames.at(-1)?.type).toBe('input_audio_buffer.append'),
        );
        if (!processedCreation)
          f.session.receive({
            type: 'response.created',
            response: { id: 'old' },
          });
        f.session.receive({
          type: 'response.done',
          response: { id: 'old', status: 'completed', output: [item] },
        });
        f.session.requestResponse();
        if (automatic)
          f.session.receive({ type: 'input_audio_buffer.speech_started' });
        else f.session.interrupt();
        f.gate.resolve();
        await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce(), {
          timeout: 500,
        });
        expect(
          f.frames.filter((x) => x.type === 'response.create'),
        ).toHaveLength(processedCreation ? 1 : 0);
        expect(
          f.frames.filter((x) => x.item?.type === 'function_call_output'),
        ).toHaveLength(0);
        result.resolve('Completed.');
        await vi.waitFor(() =>
          expect(
            f.frames.filter((x) => x.type === 'response.create'),
          ).toHaveLength(processedCreation ? 2 : 1),
        );
        expect(
          f.frames.filter((x) => x.item?.type === 'function_call_output'),
        ).toHaveLength(1);
        expect(execute).toHaveBeenCalledOnce();
        expect(f.onError).not.toHaveBeenCalled();
      } finally {
        f.gate.resolve();
        result.resolve('Cleanup.');
        await f.session.close();
      }
    },
  );

  it.each([false, true])(
    'defers admitted continuation behind queued creation with another send=%s',
    async (extra) => {
      const output = Promise.withResolvers<void>();
      const frames: { type: string; item?: { type?: string } }[] = [];
      const execute = vi.fn(async () => '7');
      const onError = vi.fn();
      const session: PortableVoiceSession = new PortableVoiceSession(
        control(),
        {
          send(frame) {
            const event = JSON.parse(frame);
            frames.push(event);
            if (event.type === 'session.update')
              queueMicrotask(() =>
                session.receive({
                  type: 'session.updated',
                  session: event.session,
                }),
              );
            if (event.item?.type === 'function_call_output')
              return output.promise;
          },
          close() {},
        },
        {
          model: 'test-realtime',
          instructions: 'Help.',
          tools: [
            {
              name: 'lookup',
              description: 'Lookup',
              parameters: { type: 'object' },
              needsApproval: false,
              execute,
            },
          ],
          onError,
        },
      );
      try {
        await session.start();
        await new Promise((resolve) => setTimeout(resolve, 0));
        session.receive({ type: 'response.created', response: { id: 'old' } });
        session.receive({
          type: 'response.done',
          response: { id: 'old', status: 'completed', output: [item] },
        });
        await vi.waitFor(() =>
          expect(
            frames.some((x) => x.item?.type === 'function_call_output'),
          ).toBe(true),
        );
        if (extra) session.sendAudio(new ArrayBuffer(2));
        session.receive({
          type: 'response.created',
          response: { id: 'new-vad' },
        });
        output.resolve();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(frames.filter((x) => x.type === 'response.create')).toHaveLength(
          0,
        );
        session.receive({
          type: 'response.done',
          response: { id: 'new-vad', status: 'completed', output: [] },
        });
        await vi.waitFor(() =>
          expect(
            frames.filter((x) => x.type === 'response.create'),
          ).toHaveLength(1),
        );
        expect(
          frames.filter((x) => x.item?.type === 'function_call_output'),
        ).toHaveLength(1);
        expect(execute).toHaveBeenCalledOnce();
        expect(onError).not.toHaveBeenCalled();
      } finally {
        output.resolve();
        await session.close();
      }
    },
  );

  async function inputSession(hold = false) {
    const gate = Promise.withResolvers<void>();
    const frames: {
      type: string;
      item?: { content: Record<string, unknown>[] };
    }[] = [];
    const onError = vi.fn();
    const close = vi.fn();
    let items = 0;
    const session: PortableVoiceSession = new PortableVoiceSession(
      control(),
      {
        send(frame) {
          const event = JSON.parse(frame);
          frames.push(event);
          if (event.type === 'session.update')
            queueMicrotask(() =>
              session.receive({
                type: 'session.updated',
                session: event.session,
              }),
            );
          if (
            event.type === 'conversation.item.create' &&
            ++items === 1 &&
            hold
          )
            return gate.promise;
        },
        close,
      },
      { model: 'test-realtime', instructions: 'Help.', onError },
    );
    await session.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { session, frames, onError, close, gate };
  }

  it.each(['text', 'image', 'sendText'])(
    'rejects oversized %s before UTF8 encoding without retiring the owner',
    async (kind) => {
      const f = await inputSession();
      const huge = 'x'.repeat(32 * 1024 * 1024);
      const encode = vi.spyOn(TextEncoder.prototype, 'encode');
      try {
        expect(() => {
          if (kind === 'sendText') f.session.sendText(huge);
          else
            f.session.sendMessage(
              [
                kind === 'text'
                  ? { type: 'input_text', text: huge }
                  : { type: 'input_image', image_url: huge },
              ],
              { triggerResponse: false },
            );
        }).toThrow('Portable voice input exceeds capacity');
        expect(encode).not.toHaveBeenCalled();
        expect(f.onError).not.toHaveBeenCalled();
        expect(f.close).not.toHaveBeenCalled();
        f.session.sendMessage([{ type: 'input_text', text: 'usable' }], {
          triggerResponse: false,
        });
        await vi.waitFor(() =>
          expect(f.frames.at(-1)?.type).toBe('conversation.item.create'),
        );
      } finally {
        encode.mockRestore();
        await f.session.close();
      }
    },
  );

  it.each(['sendText', 'message-response'])(
    'accepts the exact default-response boundary for %s',
    async (kind) => {
      const f = await inputSession();
      const frame = JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '' }],
        },
      });
      const length =
        4 * 1024 * 1024 -
        frame.length -
        JSON.stringify({ type: 'response.create' }).length;
      const text = 'x'.repeat(length);
      try {
        if (kind === 'sendText') f.session.sendText(text);
        else f.session.sendMessage([{ type: 'input_text', text }]);
        await vi.waitFor(() =>
          expect(f.frames.at(-1)?.type).toBe('response.create'),
        );
        expect(
          f.frames.find((frame) => frame.type === 'conversation.item.create')
            ?.item?.content[0]?.text,
        ).toBe(text);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(() => {
          if (kind === 'sendText') f.session.sendText(text + 'x');
          else
            f.session.sendMessage([{ type: 'input_text', text: text + 'x' }]);
        }).toThrow('Portable voice input exceeds capacity');
        expect(f.onError).not.toHaveBeenCalled();
        expect(f.close).not.toHaveBeenCalled();
      } finally {
        await f.session.close();
      }
    },
  );
  it('rejects an oversized escaped image key before encoding without retirement', async () => {
    const f = await inputSession();
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    try {
      expect(() =>
        f.session.sendMessage(
          [
            {
              type: 'input_image',
              image_url: 'image',
              ['\n'.repeat(8 * 1024 * 1024)]: 1,
            },
          ],
          { triggerResponse: false },
        ),
      ).toThrow('Portable voice input exceeds capacity');
      expect(encode).not.toHaveBeenCalled();
      expect(f.onError).not.toHaveBeenCalled();
      expect(f.close).not.toHaveBeenCalled();
      f.session.sendText('usable');
      await vi.waitFor(() =>
        expect(f.frames.at(-1)?.type).toBe('response.create'),
      );
    } finally {
      encode.mockRestore();
      await f.session.close();
    }
  });

  it.each(['x', '"', '\\', '\n', '€', '🙂'])(
    'preserves the exact message byte/character boundary for %s',
    async (unit) => {
      const f = await inputSession();
      const empty = [{ type: 'input_text', text: '' }];
      const command = JSON.stringify({
        type: 'message',
        content: empty,
        trigger_response: false,
      });
      const frame = JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: empty },
      });
      const fragment = JSON.stringify(unit).slice(1, -1);
      const length = Math.min(
        Math.floor((4 * 1024 * 1024 - frame.length) / fragment.length),
        Math.floor(
          (8 * 1024 * 1024 - new TextEncoder().encode(command).length) /
            new TextEncoder().encode(fragment).length,
        ),
      );
      const text = unit.repeat(length);
      try {
        f.session.sendMessage([{ type: 'input_text', text }], {
          triggerResponse: false,
        });
        await vi.waitFor(() =>
          expect(f.frames.at(-1)?.item?.content[0]?.text).toBe(text),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(() =>
          f.session.sendMessage([{ type: 'input_text', text: text + unit }], {
            triggerResponse: false,
          }),
        ).toThrow('Portable voice input exceeds capacity');
        expect(f.onError).not.toHaveBeenCalled();
        expect(f.close).not.toHaveBeenCalled();
        f.session.sendText('still usable');
        await vi.waitFor(() =>
          expect(f.frames.at(-1)?.type).toBe('response.create'),
        );
      } finally {
        await f.session.close();
      }
    },
  );

  it('captures image fields and getters/toJSON once with escaped keys and nested arrays', async () => {
    const f = await inputSession();
    let reads = 0;
    let jsonCalls = 0;
    const image = {
      type: 'input_image' as const,
      get image_url() {
        reads++;
        return 'data:image/png;base64,AA==';
      },
      detail: 'high',
      'escaped"\\\n€': {
        a: [null, true, 1e21, 1e-6, Number.MIN_VALUE, undefined, '🙂'],
      },
      custom: {
        toJSON() {
          jsonCalls++;
          return { label: 'kept', nested: [['x']] };
        },
      },
    };
    try {
      f.session.sendMessage([image], { triggerResponse: false });
      await vi.waitFor(() =>
        expect(f.frames.at(-1)?.item?.content).toHaveLength(1),
      );
      expect(reads).toBe(1);
      expect(jsonCalls).toBe(1);
      expect(f.frames.at(-1)?.item?.content[0]).toEqual({
        type: 'input_image',
        image_url: 'data:image/png;base64,AA==',
        detail: 'high',
        'escaped"\\\n€': {
          a: [null, true, 1e21, 1e-6, Number.MIN_VALUE, null, '🙂'],
        },
        custom: { label: 'kept', nested: [['x']] },
      });
      expect(f.onError).not.toHaveBeenCalled();
    } finally {
      await f.session.close();
    }
  });

  it.each(['bytes', 'frames'])(
    'rejects messages against pending %s then retries after drain',
    async (kind) => {
      const f = await inputSession(true);
      try {
        f.session.sendMessage([{ type: 'input_text', text: 'held' }], {
          triggerResponse: false,
        });
        await vi.waitFor(() =>
          expect(f.frames.at(-1)?.type).toBe('conversation.item.create'),
        );
        if (kind === 'frames')
          for (let index = 1; index < 256; index++)
            f.session.sendMessage([{ type: 'input_text', text: '' }], {
              triggerResponse: false,
            });
        const empty = JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '' }],
          },
        });
        const text =
          kind === 'bytes'
            ? 'x'.repeat(4 * 1024 * 1024 - empty.length)
            : 'small';
        expect(() =>
          f.session.sendMessage([{ type: 'input_text', text }], {
            triggerResponse: false,
          }),
        ).toThrow('Portable voice input exceeds capacity');
        expect(f.onError).not.toHaveBeenCalled();
        expect(f.close).not.toHaveBeenCalled();
        f.gate.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        f.session.sendMessage([{ type: 'input_text', text }], {
          triggerResponse: false,
        });
        await vi.waitFor(() =>
          expect(f.frames.at(-1)?.item?.content[0]?.text).toBe(text),
        );
        expect(f.onError).not.toHaveBeenCalled();
      } finally {
        f.gate.resolve();
        await f.session.close();
      }
    },
  );

  it.each(['invalid-unicode', 'cycle', 'deep-array', 'sparse-array'])(
    'rejects unsupported/bounded %s without mutating the owner',
    async (kind) => {
      const f = await inputSession();
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      let nested: unknown = 'x';
      for (let index = 0; index < 10000; index++) nested = [nested];
      const value =
        kind === 'cycle'
          ? circular
          : kind === 'deep-array'
            ? nested
            : kind === 'sparse-array'
              ? new Array(5_000_000)
              : '\ud800';
      try {
        expect(() =>
          f.session.sendMessage(
            [{ type: 'input_image', image_url: 'image', extra: value }],
            { triggerResponse: false },
          ),
        ).toThrow();
        expect(f.onError).not.toHaveBeenCalled();
        expect(f.close).not.toHaveBeenCalled();
        f.session.sendText('usable');
        await vi.waitFor(() =>
          expect(f.frames.at(-1)?.type).toBe('response.create'),
        );
      } finally {
        await f.session.close();
      }
    },
  );

  it.each(['idle', 'pending', 'queued-created', 'queued-terminal'])(
    'binds automatic speech interruption to arrival ownership: %s',
    async (owner) => {
      const gate = Promise.withResolvers<void>();
      const definition = agent();
      const frames: { type: string }[] = [];
      const terminals: string[] = [];
      const onError = vi.fn();
      const session: PortableVoiceSession = new PortableVoiceSession(
        control(),
        {
          send(frame) {
            const event = JSON.parse(frame);
            frames.push(event);
            if (event.type === 'session.update')
              queueMicrotask(() =>
                session.receive({
                  type: 'session.updated',
                  session: event.session,
                }),
              );
            if (event.type === 'input_audio_buffer.append') return gate.promise;
          },
          close() {},
        },
        {
          ...definition.options,
          sessionSettings: {
            audio: {
              input: {
                turn_detection: {
                  type: 'server_vad',
                  interrupt_response: true,
                },
              },
            },
          },
          onError,
          onEvent(event) {
            const value = event as { type: string; response?: { id: string } };
            if (value.type === 'response.done')
              terminals.push(value.response!.id);
          },
        },
      );
      try {
        await session.start();
        await new Promise((resolve) => setTimeout(resolve, 0));
        session.sendAudio(new Uint8Array([1]).buffer);
        await vi.waitFor(() =>
          expect(frames.at(-1)?.type).toBe('input_audio_buffer.append'),
        );
        if (owner === 'queued-created')
          session.receive({
            type: 'response.created',
            response: { id: 'target' },
          });
        if (owner === 'queued-terminal') {
          session.receive({
            type: 'response.created',
            response: { id: 'old' },
          });
          session.receive({
            type: 'response.done',
            response: { id: 'old', status: 'completed', output: [] },
          });
        }
        if (owner === 'pending' || owner === 'queued-terminal')
          session.requestResponse();
        session.receive({ type: 'input_audio_buffer.speech_started' });
        if (owner === 'idle') session.requestResponse();
        gate.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (owner === 'queued-terminal') {
          // The queued caller intent was cancelled before any physical create.
          expect(
            frames.filter((frame) => frame.type === 'response.create'),
          ).toHaveLength(0);
          session.requestResponse();
          await vi.waitFor(() =>
            expect(
              frames.filter((frame) => frame.type === 'response.create'),
            ).toHaveLength(1),
          );
        }
        if (owner !== 'queued-created')
          session.receive({
            type: 'response.created',
            response: { id: 'target' },
          });
        session.receive({
          type: 'response.output_item.done',
          response_id: 'target',
          item,
        });
        session.receive({
          type: 'response.done',
          response: { id: 'target', status: 'completed', output: [item] },
        });
        await vi.waitFor(() => expect(terminals).toContain('target'));
        if (owner === 'idle' || owner === 'queued-terminal')
          await vi.waitFor(() =>
            expect(definition.execute).toHaveBeenCalledTimes(1),
          );
        else {
          expect(definition.onApproval).not.toHaveBeenCalled();
          expect(definition.execute).not.toHaveBeenCalled();
          const fresh = { ...item, id: 'fresh-item', call_id: 'fresh-call' };
          session.receive({
            type: 'response.created',
            response: { id: 'fresh' },
          });
          session.receive({
            type: 'response.done',
            response: { id: 'fresh', status: 'completed', output: [fresh] },
          });
          await vi.waitFor(() =>
            expect(definition.execute).toHaveBeenCalledTimes(1),
          );
        }
        expect(onError).not.toHaveBeenCalled();
      } finally {
        gate.resolve();
        await session.close();
      }
    },
  );

  it.each(
    ['cancelled', 'failed', 'incomplete', 'interrupt', 'automatic'].flatMap(
      (kind) => ['', '{"value":'].map((arguments_) => ({ kind, arguments_ })),
    ),
  )(
    'discards unadmitted partial arguments for $kind: $arguments_',
    async ({ kind, arguments_ }) => {
      const gate = Promise.withResolvers<string>();
      const definition = agent();
      const onError = vi.fn();
      let admittedSignal: AbortSignal | undefined;
      const execute = vi.fn(
        async (_args: Record<string, unknown>, signal: AbortSignal) => {
          admittedSignal = signal;
          return await gate.promise;
        },
      );
      const frames: {
        type: string;
        item?: { call_id: string; output: string };
      }[] = [];
      const session: PortableVoiceSession = new PortableVoiceSession(
        control(),
        {
          send(frame) {
            const event = JSON.parse(frame);
            frames.push(event);
            if (event.type === 'session.update')
              queueMicrotask(() =>
                session.receive({
                  type: 'session.updated',
                  session: event.session,
                }),
              );
          },
          close() {},
        },
        {
          ...definition.options,
          tools: [{ ...definition.options.tools[0], execute }],
          sessionSettings: {
            audio: {
              input: {
                turn_detection: {
                  type: 'server_vad',
                  interrupt_response: true,
                },
              },
            },
          },
          onError,
        },
      );
      try {
        await session.start();
        await new Promise((resolve) => setTimeout(resolve, 0));
        session.receive({
          type: 'response.created',
          response: { id: 'admitted' },
        });
        session.receive({
          type: 'response.done',
          response: { id: 'admitted', status: 'completed', output: [item] },
        });
        await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
        session.receive({
          type: 'response.created',
          response: { id: 'partial' },
        });
        if (kind === 'interrupt') session.interrupt();
        if (kind === 'automatic')
          session.receive({ type: 'input_audio_buffer.speech_started' });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const partial = {
          ...item,
          id: 'partial-item',
          call_id: 'partial-call',
          arguments: arguments_,
        };
        session.receive({
          type: 'response.output_item.done',
          response_id: 'partial',
          item: partial,
        });
        expect(onError).not.toHaveBeenCalled();
        session.receive({
          type: 'response.done',
          response: {
            id: 'partial',
            status: ['interrupt', 'automatic'].includes(kind)
              ? 'completed'
              : kind,
            output: [partial],
          },
        });
        expect(onError).not.toHaveBeenCalled();
        expect(admittedSignal?.aborted).toBe(false);
        expect(definition.onApproval).toHaveBeenCalledTimes(1);
        expect(execute).toHaveBeenCalledTimes(1);
        gate.resolve('preserved');
        await vi.waitFor(() =>
          expect(
            frames.filter(
              (frame) =>
                frame.item?.call_id === 'call-1' &&
                frame.item.output === 'preserved',
            ),
          ).toHaveLength(1),
        );
        session.sendText('Still usable');
        expect(onError).not.toHaveBeenCalled();
      } finally {
        gate.resolve('cleanup');
        await session.close();
      }
    },
  );

  it.each(['', '{"value":'])(
    'validates malformed arguments only at successful admission: %s',
    async (arguments_) => {
      const definition = agent();
      const onError = vi.fn();
      const session: PortableVoiceSession = new PortableVoiceSession(
        control(),
        {
          send(frame) {
            const event = JSON.parse(frame);
            if (event.type === 'session.update')
              queueMicrotask(() =>
                session.receive({
                  type: 'session.updated',
                  session: event.session,
                }),
              );
          },
          close() {},
        },
        { ...definition.options, onError },
      );
      try {
        await session.start();
        await new Promise((resolve) => setTimeout(resolve, 0));
        const partial = { ...item, arguments: arguments_ };
        session.receive({
          type: 'response.created',
          response: { id: 'partial' },
        });
        session.receive({
          type: 'response.output_item.done',
          response_id: 'partial',
          item: partial,
        });
        expect(onError).not.toHaveBeenCalled();
        session.receive({
          type: 'response.done',
          response: { id: 'partial', status: 'completed', output: [partial] },
        });
        expect(onError).toHaveBeenCalledTimes(1);
        expect(definition.onApproval).not.toHaveBeenCalled();
        expect(definition.execute).not.toHaveBeenCalled();
      } finally {
        await session.close();
      }
    },
  );

  it.each([false, true])(
    'enforces audio capacity through transport with commit %s',
    async (commit) => {
      const frames: { type: string; audio?: string }[] = [];
      const onError = vi.fn();
      const close = vi.fn();
      const session: PortableVoiceSession = new PortableVoiceSession(
        control(),
        {
          send(frame) {
            const event = JSON.parse(frame);
            frames.push(event);
            if (event.type === 'session.update')
              queueMicrotask(() =>
                session.receive({
                  type: 'session.updated',
                  session: event.session,
                }),
              );
          },
          close,
        },
        { model: 'test-realtime', instructions: 'Help.', onError },
      );
      try {
        await session.start();
        await new Promise((resolve) => setTimeout(resolve, 0));
        // The existing host budget counts two bytes per frame character,
        // including the optional36-character commit frame.
        const largestSegment = commit ? 3_145_665 : 3_145_692;
        const audio = new Uint8Array(largestSegment);
        audio[0] = 1;
        audio[audio.length - 1] = 255;
        session.sendAudio(audio.buffer, { commit });
        await vi.waitFor(() =>
          expect(
            frames.filter((frame) =>
              frame.type.startsWith('input_audio_buffer.'),
            ),
          ).toHaveLength(commit ? 2 : 1),
        );
        const appended = frames.find(
          (frame) => frame.type === 'input_audio_buffer.append',
        );
        const decoded = Buffer.from(appended!.audio!, 'base64');
        expect(decoded.byteLength).toBe(largestSegment);
        expect(decoded[0]).toBe(1);
        expect(decoded[decoded.length - 1]).toBe(255);
        if (commit)
          expect(frames.at(-1)?.type).toBe('input_audio_buffer.commit');
        await new Promise((resolve) => setTimeout(resolve, 0));
        const encode = vi
          .spyOn(String, 'fromCharCode')
          .mockImplementation(() => {
            throw new Error('Encoding started.');
          });
        try {
          expect(() =>
            session.sendAudio(new ArrayBuffer(largestSegment + 1), { commit }),
          ).toThrow('Audio input exceeds capacity');
          expect(encode).not.toHaveBeenCalled();
        } finally {
          encode.mockRestore();
        }
        session.requestResponse();
        await vi.waitFor(() =>
          expect(frames.at(-1)?.type).toBe('response.create'),
        );
        expect(onError).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
      } finally {
        await session.close();
      }
    },
  );

  it.each([false, true])(
    'enforces audio capacity against pending bytes with commit %s',
    async (commit) => {
      const held = Promise.withResolvers<void>();
      const frames: { type: string; audio?: string }[] = [];
      const onError = vi.fn();
      const close = vi.fn();
      const session: PortableVoiceSession = new PortableVoiceSession(
        control(),
        {
          send(frame) {
            const event = JSON.parse(frame);
            frames.push(event);
            if (event.type === 'session.update')
              queueMicrotask(() =>
                session.receive({
                  type: 'session.updated',
                  session: event.session,
                }),
              );
            if (
              event.type === 'input_audio_buffer.append' &&
              frames.filter(
                (frame) => frame.type === 'input_audio_buffer.append',
              ).length === 1
            )
              return held.promise;
          },
          close,
        },
        { model: 'test-realtime', instructions: 'Help.', onError },
      );
      try {
        await session.start();
        await new Promise((resolve) => setTimeout(resolve, 0));
        session.sendAudio(new ArrayBuffer(3));
        await vi.waitFor(() =>
          expect(frames.at(-1)?.type).toBe('input_audio_buffer.append'),
        );
        const largestSegment = commit ? 3_145_665 : 3_145_692;
        const encode = vi
          .spyOn(String, 'fromCharCode')
          .mockImplementation(() => {
            throw new Error('Encoding started.');
          });
        try {
          expect(() =>
            session.sendAudio(new ArrayBuffer(largestSegment), { commit }),
          ).toThrow('Audio input exceeds capacity');
          expect(encode).not.toHaveBeenCalled();
        } finally {
          encode.mockRestore();
        }
        expect(onError).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
        held.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        session.sendAudio(new ArrayBuffer(largestSegment), { commit });
        await vi.waitFor(() =>
          expect(
            frames.filter(
              (frame) => frame.type === 'input_audio_buffer.append',
            ),
          ).toHaveLength(2),
        );
        if (commit)
          await vi.waitFor(() =>
            expect(frames.at(-1)?.type).toBe('input_audio_buffer.commit'),
          );
        await new Promise((resolve) => setTimeout(resolve, 0));
        session.requestResponse();
        await vi.waitFor(() =>
          expect(frames.at(-1)?.type).toBe('response.create'),
        );
        expect(onError).not.toHaveBeenCalled();
      } finally {
        held.resolve();
        await session.close();
      }
    },
  );

  it.each([false, true])(
    'enforces audio capacity against queued sends with commit %s',
    async (commit) => {
      const held = Promise.withResolvers<void>();
      const frames: { type: string }[] = [];
      const onError = vi.fn();
      const close = vi.fn();
      let appends = 0;
      const session: PortableVoiceSession = new PortableVoiceSession(
        control(),
        {
          send(frame) {
            const event = JSON.parse(frame);
            frames.push(event);
            if (event.type === 'session.update')
              queueMicrotask(() =>
                session.receive({
                  type: 'session.updated',
                  session: event.session,
                }),
              );
            if (event.type === 'input_audio_buffer.append' && ++appends === 1)
              return held.promise;
          },
          close,
        },
        { model: 'test-realtime', instructions: 'Help.', onError },
      );
      try {
        await session.start();
        await new Promise((resolve) => setTimeout(resolve, 0));
        for (let index = 0; index < (commit ? 254 : 255); index++)
          session.sendAudio(new ArrayBuffer(0));
        // Exactly256 pending physical frames remain supported in both modes.
        session.sendAudio(new ArrayBuffer(0), { commit });
        const encode = vi
          .spyOn(String, 'fromCharCode')
          .mockImplementation(() => {
            throw new Error('Encoding started.');
          });
        try {
          expect(() =>
            session.sendAudio(new ArrayBuffer(1), { commit }),
          ).toThrow('Audio input exceeds capacity');
          expect(encode).not.toHaveBeenCalled();
        } finally {
          encode.mockRestore();
        }
        expect(onError).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
        held.resolve();
        await vi.waitFor(() =>
          expect(
            frames.filter((frame) =>
              frame.type.startsWith('input_audio_buffer.'),
            ),
          ).toHaveLength(256),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        session.sendAudio(new Uint8Array([7]).buffer, { commit });
        await vi.waitFor(() =>
          expect(
            frames.filter((frame) =>
              frame.type.startsWith('input_audio_buffer.'),
            ),
          ).toHaveLength(commit ? 258 : 257),
        );
        expect(onError).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
      } finally {
        held.resolve();
        await session.close();
      }
    },
  );

  it.each(
    [false, true].flatMap((requested) =>
      [false, true].map((older) => ({ requested, older })),
    ),
  )(
    'remembers interruption for queued provider creation with requested $requested and older $older',
    async ({ requested, older }) => {
      const definition = agent();
      const audio = Promise.withResolvers<void>();
      const frames: {
        type: string;
        response_id?: string;
        item?: { type: string };
      }[] = [];
      const events: { type?: string; response?: { id?: string } }[] = [];
      const onError = vi.fn();
      const session: PortableVoiceSession = new PortableVoiceSession(
        control(),
        {
          send(frame) {
            const event = JSON.parse(frame);
            frames.push(event);
            if (event.type === 'session.update')
              queueMicrotask(() =>
                session.receive({
                  type: 'session.updated',
                  session: event.session,
                }),
              );
            if (event.type === 'input_audio_buffer.append')
              return audio.promise;
          },
          close() {},
        },
        {
          ...definition.options,
          onError,
          onEvent(event) {
            events.push(event as (typeof events)[number]);
          },
        },
      );
      try {
        await session.start();
        session.interrupt();
        expect(frames).toHaveLength(1);
        session.sendAudio(new Uint8Array([1, 2]).buffer);
        await vi.waitFor(() =>
          expect(
            frames.some((frame) => frame.type === 'input_audio_buffer.append'),
          ).toBe(true),
        );
        if (requested) session.requestResponse();
        if (older) {
          session.receive({
            type: 'response.created',
            response: { id: 'older' },
          });
          session.receive({
            type: 'response.done',
            response: { id: 'older', status: 'completed', output: [] },
          });
        }
        session.receive({
          type: 'response.created',
          response: { id: 'queued' },
        });
        session.interrupt();
        session.receive({
          type: 'response.done',
          response: { id: 'queued', status: 'completed', output: [item] },
        });
        audio.resolve();
        await vi.waitFor(() =>
          expect(
            events.some(
              (event) =>
                event.type === 'response.done' &&
                event.response?.id === 'queued',
            ),
          ).toBe(true),
        );
        expect(
          frames.filter(
            (frame) =>
              frame.type === 'response.cancel' &&
              frame.response_id === 'queued',
          ),
        ).toHaveLength(1);
        expect(definition.onApproval).not.toHaveBeenCalled();
        expect(definition.execute).not.toHaveBeenCalled();
        expect(
          frames.some((frame) => frame.item?.type === 'function_call_output'),
        ).toBe(false);
        expect(onError).not.toHaveBeenCalled();
      } finally {
        audio.resolve();
        await session.close();
      }
    },
  );

  it('waits for the response identity when interrupting a pending creation', async () => {
    const frames: { type: string; response_id?: string }[] = [];
    const onError = vi.fn();
    const session: PortableVoiceSession = new PortableVoiceSession(
      control(),
      {
        send(frame) {
          const event = JSON.parse(frame);
          frames.push(event);
          if (event.type === 'session.update')
            queueMicrotask(() =>
              session.receive({
                type: 'session.updated',
                session: event.session,
              }),
            );
        },
        close() {},
      },
      { model: 'test-realtime', instructions: 'Help.', onError },
    );
    try {
      await session.start();
      session.requestResponse();
      session.interrupt();
      await vi.waitFor(() =>
        expect(
          frames.filter((event) => event.type === 'response.create'),
        ).toHaveLength(1),
      );
      expect(frames.some((event) => event.type === 'response.cancel')).toBe(
        false,
      );
      session.receive({
        type: 'response.created',
        response: { id: 'pending' },
      });
      await vi.waitFor(() =>
        expect(frames).toContainEqual({
          type: 'response.cancel',
          response_id: 'pending',
        }),
      );
      session.receive({
        type: 'response.done',
        response: { id: 'pending', status: 'cancelled', output: [] },
      });
      session.requestResponse();
      await vi.waitFor(() =>
        expect(
          frames.filter((event) => event.type === 'response.create'),
        ).toHaveLength(2),
      );
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });

  it('interrupts three responses and continues through the same native owner', async () => {
    const frames: Record<string, unknown>[] = [];
    const close = vi.fn();
    const onError = vi.fn();
    const session: PortableVoiceSession = new PortableVoiceSession(
      control(),
      {
        send(frame) {
          const event = JSON.parse(frame);
          frames.push(event);
          if (event.type === 'session.update')
            queueMicrotask(() =>
              session.receive({
                type: 'session.updated',
                session: event.session,
              }),
            );
        },
        close,
      },
      { model: 'test-realtime', instructions: 'Help.', onError },
    );
    try {
      await session.start();
      for (let index = 0; index < 3; index++) {
        session.requestResponse();
        await vi.waitFor(() =>
          expect(
            frames.filter((event) => event.type === 'response.create'),
          ).toHaveLength(index + 1),
        );
        const id = `response-${index}`;
        session.receive({ type: 'response.created', response: { id } });
        session.interrupt();
        session.interrupt();
        await vi.waitFor(() =>
          expect(
            frames.filter((event) => event.type === 'response.cancel'),
          ).toHaveLength(index + 1),
        );
        session.receive({
          type: 'response.done',
          response: { id, status: 'cancelled', output: [] },
        });
      }
      session.sendText('Continue.');
      await vi.waitFor(() =>
        expect(
          frames.filter((event) => event.type === 'response.create'),
        ).toHaveLength(4),
      );
      expect(close).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps already admitted tool work when interrupting response generation', async () => {
    const definition = agent();
    const result = Promise.withResolvers<string>();
    let signal: AbortSignal | undefined;
    const execute = vi.fn((_args: unknown, callbackSignal: AbortSignal) => {
      signal = callbackSignal;
      return result.promise;
    });
    const frames: { type: string; item?: { type: string } }[] = [];
    const session: PortableVoiceSession = new PortableVoiceSession(
      control(),
      {
        send(frame) {
          const event = JSON.parse(frame);
          frames.push(event);
          if (event.type === 'session.update')
            queueMicrotask(() =>
              fixtureEvents(event.session).forEach((incoming) =>
                session.receive(incoming),
              ),
            );
        },
        close() {},
      },
      {
        ...definition.options,
        tools: [{ ...definition.options.tools[0], execute }],
      },
    );
    try {
      await session.start();
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      session.interrupt();
      expect(signal?.aborted).toBe(false);
      result.resolve('Kept the authorized result.');
      await vi.waitFor(() =>
        expect(
          frames.some((event) => event.item?.type === 'function_call_output'),
        ).toBe(true),
      );
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      result.resolve('Cleanup.');
      await session.close();
    }
  });

  it('captures ordered image/text input and audio bytes through native send receipts', async () => {
    const frames: Record<string, unknown>[] = [];
    const session: PortableVoiceSession = new PortableVoiceSession(
      control(),
      {
        send(frame) {
          const event = JSON.parse(frame);
          frames.push(event);
          if (event.type === 'session.update')
            queueMicrotask(() =>
              session.receive({
                type: 'session.updated',
                session: event.session,
              }),
            );
        },
        close() {},
      },
      { model: 'test-realtime', instructions: 'Help.' },
    );
    try {
      await session.start();
      const textPart = {
        type: 'input_text' as const,
        text: 'Describe this image.',
      };
      const imagePart = {
        type: 'input_image' as const,
        image_url: 'https://example.test/image.png',
        detail: 'low',
      };
      const content = [textPart, imagePart];
      const captured = structuredClone(content);
      session.sendMessage(content, { triggerResponse: false });
      textPart.text = 'changed after submission';
      imagePart.image_url = 'https://example.test/other.png';
      const bytes = Uint8Array.from(
        { length: 32768 },
        (_, index) => index % 256,
      );
      const expectedBytes = Buffer.from(bytes);
      session.sendAudio(bytes.buffer, { commit: true });
      bytes.fill(0);
      session.clearAudio();
      session.commitAudio();
      session.requestResponse();
      await vi.waitFor(() => expect(frames).toHaveLength(7));
      expect(frames.map((frame) => frame.type)).toEqual([
        'session.update',
        'conversation.item.create',
        'input_audio_buffer.append',
        'input_audio_buffer.commit',
        'input_audio_buffer.clear',
        'input_audio_buffer.commit',
        'response.create',
      ]);
      expect(frames[1].item).toEqual({
        type: 'message',
        role: 'user',
        content: captured,
      });
      expect(Buffer.from(String(frames[2].audio), 'base64')).toEqual(
        expectedBytes,
      );
    } finally {
      await session.close();
    }
  });

  it('rejects startup after close without leaving a readiness timer', async () => {
    vi.useFakeTimers();
    const owner = control();
    const apply = vi.spyOn(owner, 'apply');
    const send = vi.fn();
    const session = new PortableVoiceSession(
      owner,
      { send, close: vi.fn() },
      {
        model: 'test-realtime',
        instructions: 'Help.',
      },
    );
    await session.close();
    apply.mockClear();
    await expect(session.start()).rejects.toThrow(/closed/);
    expect(vi.getTimerCount()).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    null,
    17,
    '',
    ' ',
    'sk-synthetic-private',
    'ek_',
    ' ek_test',
    'ek_test\n',
    'ek_\u0000test',
  ])(
    'rejects unsafe browser credentials before control, media or fetch (%j)',
    async (apiKey) => {
      const owner = control();
      const apply = vi.spyOn(owner, 'apply');
      const getUserMedia = vi.fn(async () => {
        throw new Error('media acquired');
      });
      const createPeerConnection = vi.fn();
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      await expect(
        connectPortableVoiceBrowser({
          control: owner,
          apiKey: apiKey as string,
          agent: { model: 'test', instructions: 'Help.' },
          media: { getUserMedia, createPeerConnection },
        }),
      ).rejects.toThrow(/ephemeral client key|credential/);
      expect(apply).not.toHaveBeenCalled();
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(createPeerConnection).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each([
    { apiKey: '', useInsecureApiKey: true },
    { apiKey: 'sk_test\n', useInsecureApiKey: true },
    {
      apiKey: 'sk-synthetic-private',
      useInsecureApiKey: 'true' as unknown as boolean,
    },
  ])(
    'keeps malformed credentials and nonboolean opt-in rejected',
    async (credential) => {
      const getUserMedia = vi.fn();
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const failure = await connectPortableVoiceBrowser({
        control: control(),
        ...credential,
        agent: { model: 'test', instructions: 'Help.' },
        media: { getUserMedia },
      }).catch((error: Error) => error);
      expect(failure).toBeInstanceOf(TypeError);
      expect(String(failure)).not.toContain('sk-synthetic-private');
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each([
    { apiKey: 'ek_synthetic-browser', useInsecureApiKey: false },
    { apiKey: 'sk-synthetic-explicit', useInsecureApiKey: true },
  ])(
    'accepts the intended browser credential mode before media acquisition',
    async (credential) => {
      const failure = new Error('synthetic media boundary');
      const getUserMedia = vi.fn(async () => {
        throw failure;
      });
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      await expect(
        connectPortableVoiceBrowser({
          control: control(),
          ...credential,
          agent: { model: 'test', instructions: 'Help.' },
          media: { getUserMedia },
        }),
      ).rejects.toBe(failure);
      expect(getUserMedia).toHaveBeenCalledOnce();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { cleanupThrows: false, apiKey: 'ek_synthetic', useInsecureApiKey: false },
    { cleanupThrows: true, apiKey: 'ek_synthetic', useInsecureApiKey: false },
    {
      cleanupThrows: false,
      apiKey: 'sk-synthetic-explicit',
      useInsecureApiKey: true,
    },
  ])(
    'preserves browser configuration failure across owned media cleanup (credential mode and cleanup=%j)',
    async ({ cleanupThrows, apiKey, useInsecureApiKey }) => {
      const cleanup = new Error('injected peer cleanup failure');
      const stop = vi.fn();
      const track = Object.assign(new EventTarget(), {
        readyState: 'live',
        enabled: true,
        stop,
      });
      const stream = {
        getAudioTracks: () => [track],
        getTracks: () => [track],
      };
      const channel = {
        readyState: 'open',
        close: vi.fn(),
        onmessage: null as ((event: MessageEvent<string>) => void) | null,
        send(frame: string) {
          if (JSON.parse(frame).type === 'session.update') {
            queueMicrotask(() =>
              channel.onmessage?.(
                new MessageEvent('message', {
                  data: JSON.stringify({
                    type: 'session.updated',
                    session: {},
                  }),
                }),
              ),
            );
          }
        },
      };
      const close = vi.fn(() => {
        if (cleanupThrows) throw cleanup;
      });
      const peer = {
        connectionState: 'new',
        localDescription: null as RTCSessionDescriptionInit | null,
        createDataChannel: () => channel,
        addTrack() {},
        async createOffer() {
          return { type: 'offer' as const, sdp: 'offer' };
        },
        async setLocalDescription(description: RTCSessionDescriptionInit) {
          peer.localDescription = description;
        },
        async setRemoteDescription() {},
        close,
      };
      const fetch = vi.fn(async (url: URL, init: RequestInit) => {
        const request = new Request(url, init);
        if (apiKey.startsWith('ek_')) {
          expect(request.headers.get('Content-Type')).toBe('application/sdp');
          expect(await request.text()).toBe('offer');
        } else {
          expect(request.headers.get('Content-Type')).toMatch(
            /^multipart\/form-data; boundary=/,
          );
          const parts = await request.formData();
          expect(parts.get('sdp')).toBe('offer');
          expect(JSON.parse(parts.get('session') as string)).toEqual({
            type: 'realtime',
            model: 'test',
          });
        }
        return new Response('answer', { status: 200 });
      });
      vi.stubGlobal('fetch', fetch);
      const options = {
        control: control(),
        apiKey,
        useInsecureApiKey,
        agent: { model: 'test', instructions: 'test' },
        media: {
          getUserMedia: async () => {
            // Later caller mutation cannot replace the credential already validated.
            options.apiKey = 'sk-synthetic-late-mutation';
            return stream as unknown as MediaStream;
          },
          createPeerConnection: async () =>
            peer as unknown as RTCPeerConnection,
        },
      };
      await expect(connectPortableVoiceBrowser(options)).rejects.toThrow(
        'Provider accepted another tool configuration',
      );
      expect(fetch).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${apiKey}`,
          }),
        }),
      );
      expect(close).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
    },
  );

  it('preserves session settings through real Rust acceptance', async () => {
    const settings = {
      audio: {
        input: { transcription: { model: 'transcribe' }, turn_detection: null },
        output: { voice: 'verse', speed: 1.1 },
      },
      tracing: 'auto',
      tool_choice: 'required',
      max_output_tokens: 128,
    };
    const requested = structuredClone(settings);
    const frames: { type: string; session: Record<string, unknown> }[] = [];
    const session: PortableVoiceSession = new PortableVoiceSession(
      control(),
      {
        send(frame) {
          const event = JSON.parse(frame);
          frames.push(event);
          queueMicrotask(() =>
            session.receive({
              type: 'session.updated',
              session: event.session,
            }),
          );
        },
        close() {},
      },
      { ...agent().options, sessionSettings: settings },
    );
    const ready = session.start();
    settings.audio.output.voice = 'later-caller-mutation';
    await ready;
    expect(frames).toHaveLength(1);
    expect(frames[0].session).toMatchObject(requested);
    expect(frames[0].session).toMatchObject({
      model: 'test-realtime',
      instructions: 'Help.',
      tools: [{ type: 'function', name: 'lookup' }],
    });
    await session.close();
  });

  it('rejects provider acceptance that changes a requested voice', async () => {
    const close = vi.fn();
    const session: PortableVoiceSession = new PortableVoiceSession(
      control(),
      {
        send(frame) {
          const event = JSON.parse(frame);
          event.session.audio.output.voice = 'another-voice';
          queueMicrotask(() =>
            session.receive({
              type: 'session.updated',
              session: event.session,
            }),
          );
        },
        close,
      },
      {
        ...agent().options,
        sessionSettings: { audio: { output: { voice: 'verse' } } },
      },
    );
    await expect(session.start()).rejects.toThrow(
      'Provider accepted another tool configuration',
    );
    await session.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('retires a provider connection that never acknowledges configuration', async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    const session = new PortableVoiceSession(
      control(),
      { send() {}, close },
      agent().options,
    );
    const connecting = session.start();
    const rejected = expect(connecting).rejects.toThrow('acceptance timed out');
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    await session.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('requires approval and physical output publication before one continuation', async () => {
    const definition = agent();
    const frames: { type: string; item?: unknown }[] = [];
    let outputSent!: () => void;
    const outputHandoff = new Promise<void>((resolve) => {
      outputSent = resolve;
    });
    const close = vi.fn();
    const session: PortableVoiceSession = new PortableVoiceSession(
      control(),
      {
        async send(frame) {
          const event = JSON.parse(frame);
          frames.push(event);
          if (event.type === 'session.update')
            queueMicrotask(() => {
              for (const incoming of fixtureEvents(event.session))
                session.receive(incoming);
            });
          if (event.type === 'conversation.item.create') await outputHandoff;
        },
        close,
      },
      definition.options,
    );
    await session.start();
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(definition.onApproval).toHaveBeenCalledOnce();
    expect(definition.execute).toHaveBeenCalledExactlyOnceWith(
      { value: 7 },
      expect.any(AbortSignal),
    );
    expect(frames[1].item).toEqual({
      type: 'function_call_output',
      call_id: 'call-1',
      output: '7',
    });
    outputSent();
    await vi.waitFor(() =>
      expect(frames.map((event) => event.type)).toEqual([
        'session.update',
        'conversation.item.create',
        'response.create',
      ]),
    );
    await session.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects a changed provider function before invoking the host callback', async () => {
    const definition = agent();
    const onError = vi.fn();
    const close = vi.fn();
    const session: PortableVoiceSession = new PortableVoiceSession(
      control(),
      {
        send(frame) {
          const event = JSON.parse(frame);
          if (event.type === 'session.update')
            queueMicrotask(() => {
              for (const incoming of fixtureEvents(event.session).slice(0, 3))
                session.receive(incoming);
              session.receive({
                type: 'response.output_item.done',
                response_id: 'response-1',
                item: { ...item, arguments: '{"value":99}' },
              });
            });
        },
        close,
      },
      { ...definition.options, onError },
    );
    await expect(session.start()).rejects.toThrow(
      'Realtime function identity changed',
    );
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Realtime function identity changed',
      }),
    );
    expect(definition.execute).not.toHaveBeenCalled();
    expect(definition.onApproval).not.toHaveBeenCalled();
    await session.close();
  });

  it.each(['cancelled', 'failed', 'incomplete'])(
    'keeps the session after a %s response without admitting its callbacks',
    async (status) => {
      const definition = agent();
      const close = vi.fn();
      const onError = vi.fn();
      const frames: { type: string }[] = [];
      const session: PortableVoiceSession = new PortableVoiceSession(
        control(),
        {
          send(frame) {
            const event = JSON.parse(frame);
            frames.push(event);
            if (event.type === 'session.update')
              queueMicrotask(() => {
                for (const incoming of fixtureEvents(event.session).slice(0, 3))
                  session.receive(incoming);
                session.receive({
                  type: 'response.done',
                  response: { id: 'response-1', status, output: [item] },
                });
              });
          },
          close,
        },
        { ...definition.options, onError },
      );
      await session.start();
      session.sendText('Continue after the terminal response.');
      await vi.waitFor(() => expect(frames).toHaveLength(3));
      expect(frames.map((frame) => frame.type)).toEqual([
        'session.update',
        'conversation.item.create',
        'response.create',
      ]);
      await session.close();
      expect(close).toHaveBeenCalledOnce();
      expect(onError).not.toHaveBeenCalled();
      expect(definition.onApproval).not.toHaveBeenCalled();
      expect(definition.execute).not.toHaveBeenCalled();
    },
  );

  it.each(['response.cancelled', 'input_audio_buffer.speech_started'])(
    'close aborts and joins callback work after %s without publishing its late result',
    async (type) => {
      const definition = agent();
      const result = Promise.withResolvers<string>();
      let callbackSignal!: AbortSignal;
      const execute = vi.fn(
        (_args: Record<string, unknown>, signal: AbortSignal) => {
          callbackSignal = signal;
          return result.promise;
        },
      );
      const frames: { type: string }[] = [];
      const close = vi.fn();
      const session: PortableVoiceSession = new PortableVoiceSession(
        control(),
        {
          send(frame) {
            const event = JSON.parse(frame);
            frames.push(event);
            if (event.type === 'session.update')
              queueMicrotask(() => {
                for (const incoming of fixtureEvents(event.session))
                  session.receive(incoming);
              });
          },
          close,
        },
        {
          ...definition.options,
          tools: [{ ...definition.options.tools[0], execute }],
        },
      );
      await session.start();
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      session.receive({ type, response_id: 'response-1', item_id: 'speech-1' });
      let joined = false;
      const closing = session.close().then(() => {
        joined = true;
      });
      await Promise.resolve();
      expect(callbackSignal.aborted).toBe(true);
      expect(joined).toBe(false);
      result.resolve('Late output');
      await closing;
      expect(close).toHaveBeenCalledOnce();
      expect(frames.map((event) => event.type)).toEqual(['session.update']);
    },
  );

  it('revokes a pending approval before a late positive answer can execute', async () => {
    const definition = agent();
    const decision = Promise.withResolvers<boolean>();
    let approvalSignal!: AbortSignal;
    const onApproval = vi.fn((_request: unknown, signal: AbortSignal) => {
      approvalSignal = signal;
      return decision.promise;
    });
    const session: PortableVoiceSession = new PortableVoiceSession(
      control(),
      {
        send(frame) {
          const event = JSON.parse(frame);
          if (event.type === 'session.update')
            queueMicrotask(() => {
              for (const incoming of fixtureEvents(event.session))
                session.receive(incoming);
            });
        },
        close() {},
      },
      { ...definition.options, onApproval },
    );
    await session.start();
    await vi.waitFor(() => expect(onApproval).toHaveBeenCalledOnce());
    session.receive({ type: 'response.cancelled', response_id: 'response-1' });
    const closing = session.close();
    expect(approvalSignal.aborted).toBe(true);
    decision.resolve(true);
    await closing;
    expect(definition.execute).not.toHaveBeenCalled();
  });

  it('rejects duplicate provider tool names before declaring the session ready', async () => {
    const definition = agent();
    const close = vi.fn();
    const session: PortableVoiceSession = new PortableVoiceSession(
      control(),
      {
        send(frame) {
          const event = JSON.parse(frame);
          if (event.type === 'session.update')
            queueMicrotask(() => {
              session.receive({
                type: 'session.updated',
                session: {
                  ...event.session,
                  tools: [event.session.tools[0], event.session.tools[0]],
                },
              });
            });
        },
        close,
      },
      {
        ...definition.options,
        tools: [
          definition.options.tools[0],
          { ...definition.options.tools[0], name: 'other' },
        ],
      },
    );
    await expect(session.start()).rejects.toThrow('another tool configuration');
    await session.close();
    expect(close).toHaveBeenCalledOnce();
    expect(definition.execute).not.toHaveBeenCalled();
  });

  it('opens a provider-connected Worker socket and runs the Rust-authorized callback locally', async () => {
    const definition = agent();
    const frames: { type: string; item?: unknown }[] = [];
    class Socket extends EventTarget {
      accept = vi.fn();
      close = vi.fn();
      send(frame: string) {
        const event = JSON.parse(frame);
        frames.push(event);
        if (event.type === 'session.update')
          queueMicrotask(() => {
            for (const incoming of fixtureEvents(event.session))
              this.dispatchEvent(
                new MessageEvent('message', { data: JSON.stringify(incoming) }),
              );
          });
      }
    }
    const socket = new Socket();
    const fetch = vi.fn(async () => ({ webSocket: socket }));
    vi.stubGlobal('fetch', fetch);
    const session = await connectPortableVoiceWorker({
      control: control(),
      apiKey: 'synthetic-worker-key',
      agent: definition.options,
    });
    await vi.waitFor(() => expect(frames).toHaveLength(3));
    expect(socket.accept).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      new URL('https://api.openai.com/v1/realtime?model=test-realtime'),
      expect.objectContaining({
        redirect: 'manual',
        headers: {
          Authorization: 'Bearer synthetic-worker-key',
          Upgrade: 'websocket',
        },
      }),
    );
    expect(definition.execute).toHaveBeenCalledOnce();
    await session.close();
    expect(socket.close).toHaveBeenCalledOnce();
  });
  it.each([true, false])(
    'coalesces text queued before completion=%s behind approval and output receipts',
    async (beforeCompletion) => {
      const approval = Promise.withResolvers<boolean>();
      const output = Promise.withResolvers<void>();
      const definition = agent();
      const frames: { type: string; item?: { type: string } }[] = [];
      const session: PortableVoiceSession = new PortableVoiceSession(
        control(),
        {
          async send(frame) {
            const event = JSON.parse(frame);
            frames.push(event);
            if (event.type === 'session.update')
              session.receive({
                type: 'session.updated',
                session: event.session,
              });
            if (event.item?.type === 'function_call_output')
              await output.promise;
          },
          close() {},
        },
        { ...definition.options, onApproval: () => approval.promise },
      );
      await session.start();
      session.receive({
        type: 'response.created',
        response: { id: 'response-1' },
      });
      if (beforeCompletion) {
        session.sendText('queued before completion');
        await vi.waitFor(() => expect(frames).toHaveLength(2));
      }
      session.receive(fixtureEvents({ tools: [] })[3]);
      if (!beforeCompletion) session.sendText('queued during approval');
      await vi.waitFor(() => expect(frames).toHaveLength(2));
      expect(definition.execute).not.toHaveBeenCalled();
      expect(frames.some((event) => event.type === 'response.create')).toBe(
        false,
      );
      approval.resolve(true);
      await vi.waitFor(() => expect(frames).toHaveLength(3));
      expect(frames[2].item?.type).toBe('function_call_output');
      expect(frames.some((event) => event.type === 'response.create')).toBe(
        false,
      );
      output.resolve();
      await vi.waitFor(() => expect(frames).toHaveLength(4));
      expect(frames.map((event) => event.type)).toEqual([
        'session.update',
        'conversation.item.create',
        'conversation.item.create',
        'response.create',
      ]);
      expect(definition.execute).toHaveBeenCalledOnce();
      await session.close();
    },
  );

  it.each([
    {
      label: 'cancellation',
      event: { type: 'response.cancelled', response_id: 'response-1' },
    },
    ...['cancelled', 'failed', 'incomplete'].map((status) => ({
      label: status,
      event: {
        type: 'response.done',
        response: { id: 'response-1', status, output: [] },
      },
    })),
    { label: 'provider error', event: { type: 'error' } },
    {
      label: 'changed configuration',
      event: { type: 'session.updated', session: {} },
    },
  ])(
    'revokes approval immediately on $label while another output send waits',
    async ({ event }) => {
      const output = Promise.withResolvers<void>();
      const approval = Promise.withResolvers<boolean>();
      const guarded = vi.fn(() => 'late');
      let approvalSignal!: AbortSignal;
      const frames: {
        type: string;
        item?: { type: string; call_id: string };
      }[] = [];
      const session: PortableVoiceSession = new PortableVoiceSession(
        control(),
        {
          async send(frame) {
            const outgoing = JSON.parse(frame);
            frames.push(outgoing);
            if (outgoing.type === 'session.update')
              session.receive({
                type: 'session.updated',
                session: outgoing.session,
              });
            if (outgoing.item?.type === 'function_call_output')
              await output.promise;
          },
          close() {},
        },
        {
          model: 'test-realtime',
          instructions: 'Help.',
          tools: [
            {
              name: 'fast',
              description: 'Fast',
              parameters: {},
              execute: () => 'fast',
            },
            {
              name: 'guarded',
              description: 'Guarded',
              parameters: {},
              needsApproval: true,
              execute: guarded,
            },
          ],
          onApproval(_request, signal) {
            approvalSignal = signal;
            return approval.promise;
          },
        },
      );
      await session.start();
      session.receive({
        type: 'response.created',
        response: { id: 'response-1' },
      });
      session.receive({
        type: 'response.done',
        response: {
          id: 'response-1',
          status: 'completed',
          output: [
            { ...item, id: 'fast-item', call_id: 'fast-call', name: 'fast' },
            {
              ...item,
              id: 'guarded-item',
              call_id: 'guarded-call',
              name: 'guarded',
            },
          ],
        },
      });
      await vi.waitFor(() => {
        expect(approvalSignal).toBeDefined();
        expect(frames[1].item?.call_id).toBe('fast-call');
      });
      session.receive(event);
      expect(approvalSignal.aborted).toBe(true);
      approval.resolve(true);
      output.resolve();
      await session.close();
      expect(guarded).not.toHaveBeenCalled();
      expect(frames).toHaveLength(2);
    },
  );

  it.each([false, true])(
    'closes an acquired Worker socket on constructor rejection (cleanup throws=%s)',
    async (cleanupThrows) => {
      const socket = Object.assign(new EventTarget(), {
        accept: vi.fn(),
        send: vi.fn(),
        close: vi.fn(() => {
          if (cleanupThrows) throw new Error('cleanup failed');
        }),
      });
      const fetch = vi.fn(async () => ({ status: 101, webSocket: socket }));
      vi.stubGlobal('fetch', fetch);
      const options = agent().options;
      await expect(
        connectPortableVoiceWorker({
          control: control(),
          apiKey: 'synthetic-key',
          agent: { ...options, tools: [options.tools[0], options.tools[0]] },
        }),
      ).rejects.toThrow('Duplicate portable voice tool.');
      expect(fetch).toHaveBeenCalledOnce();
      expect(socket.close).toHaveBeenCalledOnce();
      expect(socket.accept).not.toHaveBeenCalled();
    },
  );
});
