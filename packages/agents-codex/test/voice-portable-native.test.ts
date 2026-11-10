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
          model: 'test-realtime',
          instructions: 'Help.',
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
          response: { id: 'first', status: 'cancelled', output: [] },
        });
        session.sendText('Continue.');
        await vi.waitFor(() =>
          expect(
            frames.filter((event) => event.type === 'response.create'),
          ).toHaveLength(2),
        );
        expect(
          frames.filter((event) => event.type === 'response.cancel'),
        ).toHaveLength(automatic ? 0 : 1);
        expect(onError).not.toHaveBeenCalled();
      } finally {
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
