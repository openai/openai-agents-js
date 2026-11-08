import { tool as classicTool } from '@openai/agents-core';
import { RealtimeAgent, RealtimeSession } from '@openai/agents-realtime';
import { z } from 'zod';
import { FakeTransport } from '../../agents-realtime/test/stubs';
import { describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { once } from 'node:events';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import type { Session, Turn } from '../src/runtime/session';
import {
  NativeSessionVoiceWorkflow,
  VoicePipeline,
  OpenAISpeechProvider,
  type AudioFrame,
  type SpeechProvider,
} from '../src/voice';

const frame = (samples = [1, -2]): AudioFrame => ({
  data: Int16Array.from(samples),
  sampleRate: 24000,
  channels: 1,
});
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fakeSession(finalOutput: unknown = 'Hello.', error?: Error) {
  const cancel = vi.fn(async () => {});
  const wait = vi.fn(async () => {
    if (error) throw error;
    return { finalOutput };
  });
  const events = vi.fn(async function* () {
    yield { type: 'output_text_delta', delta: 'secret. ' };
  });
  const turn = { events, wait, cancel } as unknown as Turn<string>;
  const submit = vi.fn(async (_text: string) => turn);
  return {
    session: { submit } as unknown as Session<string>,
    submit,
    turn,
    wait,
    cancel,
    events,
  };
}

describe('native voice workflow', () => {
  it('submits each transcription to the same caller Session and waits even for empty output', async () => {
    const peer = fakeSession();
    const workflow = new NativeSessionVoiceWorkflow(peer.session);
    expect(await collect(workflow.run('first'))).toEqual(['Hello.']);
    expect(await collect(workflow.run('second'))).toEqual(['Hello.']);
    expect(peer.submit.mock.calls).toEqual([['first'], ['second']]);
    expect(peer.wait).toHaveBeenCalledTimes(2);
    expect(peer.cancel).not.toHaveBeenCalled();
    const empty = fakeSession('');
    expect(
      await collect(new NativeSessionVoiceWorkflow(empty.session).run('empty')),
    ).toEqual(['']);
    expect(empty.wait).toHaveBeenCalledOnce();
  });
  it('preserves a terminal failure when cancellation cleanup also fails', async () => {
    const primary = new Error('native failure');
    const peer = fakeSession('ignored', primary);
    peer.cancel.mockRejectedValue(new Error('cleanup'));
    await expect(
      collect(new NativeSessionVoiceWorkflow(peer.session).run('input')),
    ).rejects.toBe(primary);
  });
  it('never sends rejected native text to speech', async () => {
    const primary = new Error('rejected final output');
    const peer = fakeSession('ignored', primary);
    const synthesize = vi.fn(async function* () {
      yield frame();
    });
    const provider: SpeechProvider = {
      transcribe: async function* () {
        yield 'question';
      },
      synthesize,
    };
    await expect(
      collect(
        new VoicePipeline({
          workflow: new NativeSessionVoiceWorkflow(peer.session),
          provider,
        }).run(frame()),
      ),
    ).rejects.toBe(primary);
    expect(synthesize).not.toHaveBeenCalled();
  });
  it('waits for accepted output without observing raw text and rejects concurrent speech', async () => {
    const peer = fakeSession();
    const completed = deferred<{ finalOutput: string }>();
    peer.wait.mockReturnValue(completed.promise);
    const workflow = new NativeSessionVoiceWorkflow(peer.session);
    const text: string[] = [];
    const run = (async () => {
      for await (const value of workflow.run('first')) text.push(value);
    })();
    await vi.waitFor(() => expect(peer.wait).toHaveBeenCalledOnce());
    expect(text).toEqual([]);
    expect(peer.events).not.toHaveBeenCalled();
    await expect(collect(workflow.run('second'))).rejects.toThrow('busy');
    completed.resolve({ finalOutput: 'Accepted answer.' });
    await run;
    expect(text).toEqual(['Accepted answer.']);
    expect(peer.cancel).not.toHaveBeenCalled();
  });
  it('rejects a settled non-string result without speech or cancelling completed work', async () => {
    const peer = fakeSession({ secret: 'private' });
    const synthesize = vi.fn(async function* () {
      yield frame();
    });
    const provider: SpeechProvider = {
      transcribe: async function* () {
        yield 'question';
      },
      synthesize,
    };
    const workflow = new NativeSessionVoiceWorkflow(peer.session);
    await expect(
      collect(new VoicePipeline({ workflow, provider }).run(frame())),
    ).rejects.toThrow('custom VoiceWorkflow');
    expect(synthesize).not.toHaveBeenCalled();
    expect(peer.cancel).not.toHaveBeenCalled();
    peer.wait.mockResolvedValueOnce({ finalOutput: 'next' });
    expect(await collect(workflow.run('next'))).toEqual(['next']);
  });
  it('does not cancel settled native work when the consumer exits after accepted text', async () => {
    const peer = fakeSession();
    const workflow = new NativeSessionVoiceWorkflow(peer.session);
    const first = workflow.run('first');
    expect(await first.next()).toMatchObject({ value: 'Hello.' });
    await first.return(undefined);
    await workflow.cancel();
    expect(peer.cancel).not.toHaveBeenCalled();
    expect(await collect(workflow.run('second'))).toEqual(['Hello.']);
  });
  it('cancels a turn published after cancellation and keeps busy until cancellation joins', async () => {
    const peer = fakeSession();
    const published = deferred<Turn<string>>();
    const cancelled = deferred<void>();
    peer.submit.mockReturnValue(published.promise);
    peer.cancel.mockReturnValue(cancelled.promise);
    const workflow = new NativeSessionVoiceWorkflow(peer.session);
    const controller = new AbortController();
    const run = collect(workflow.run('first', { signal: controller.signal }));
    await vi.waitFor(() => expect(peer.submit).toHaveBeenCalledOnce());
    controller.abort(new Error('stop'));
    published.resolve(peer.turn);
    await vi.waitFor(() => expect(peer.cancel).toHaveBeenCalledOnce());
    await expect(collect(workflow.run('second'))).rejects.toThrow('busy');
    cancelled.resolve();
    await expect(run).rejects.toThrow('stop');
  });
});

describe('voice pipeline', () => {
  it.each([
    ['The value is 3.', '14 meters.'],
    ['Visit https://example.', 'com/path.'],
  ])(
    'keeps chunk-ending punctuation inside text: %s + %s',
    async (first, second) => {
      async function synthesize(chunks: string[]) {
        const spoken: string[] = [];
        const provider: SpeechProvider = {
          transcribe: async function* () {
            yield 'question';
          },
          synthesize: async function* (text) {
            spoken.push(text);
            yield frame();
          },
        };
        const workflow = {
          run: async function* () {
            yield* chunks;
          },
        };
        await collect(new VoicePipeline({ provider, workflow }).run(frame()));
        return spoken;
      }
      const text = first + second;
      expect(await synthesize([first, second])).toEqual([text]);
      expect(await synthesize([text])).toEqual([text]);
    },
  );
  it('synthesizes sentences and trailing text serially across transcripts', async () => {
    const spoken: string[] = [];
    const provider: SpeechProvider = {
      transcribe: async function* () {
        yield 'first';
        yield 'second';
      },
      synthesize: async function* (text) {
        spoken.push(text);
        yield frame([spoken.length]);
      },
    };
    const workflow = {
      run: async function* (text: string) {
        yield `${text}. `;
        yield 'trailing';
      },
    };
    const events = await collect(
      new VoicePipeline({ provider, workflow }).run(frame()),
    );
    expect(spoken).toEqual(['first. ', 'trailing', 'second. ', 'trailing']);
    expect(events.map((event) => event.type)).toEqual([
      'turn_started',
      'audio',
      'audio',
      'turn_ended',
      'turn_started',
      'audio',
      'audio',
      'turn_ended',
      'session_ended',
    ]);
  });
  it('closes transcription without cancelling settled native work when the audio consumer exits', async () => {
    const peer = fakeSession();
    let transcriptionClosed = false;
    const provider: SpeechProvider = {
      transcribe: async function* () {
        try {
          yield 'input';
        } finally {
          transcriptionClosed = true;
        }
      },
      synthesize: async function* () {
        yield frame();
      },
    };
    const pipeline = new VoicePipeline({
      provider,
      workflow: new NativeSessionVoiceWorkflow(peer.session),
    });
    for await (const event of pipeline.run(frame())) {
      if (event.type === 'audio') break;
    }
    expect(peer.cancel).not.toHaveBeenCalled();
    expect(transcriptionClosed).toBe(true);
  });
});

describe('OpenAI speech provider', () => {
  it('encodes immutable static PCM as WAV and forwards speech settings', async () => {
    let body: FormData | undefined;
    const provider = new OpenAISpeechProvider({
      apiKey: 'synthetic',
      transcriptionModel: 'transcribe-test',
      client: new OpenAI({
        apiKey: 'synthetic',
        fetch: async (_url, init) => {
          body = init?.body as FormData;
          return Response.json({ text: 'recognized' });
        },
      }),
    });
    const input = frame();
    const original = input.data.slice();
    expect(
      await collect(
        provider.transcribe(input, { signal: new AbortController().signal }),
      ),
    ).toEqual(['recognized']);
    expect(input.data).toEqual(original);
    const bytes = Buffer.from(await (body!.get('file') as File).arrayBuffer());
    expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
    expect([...bytes.subarray(44)]).toEqual([1, 0, 254, 255]);
    expect(body!.get('model')).toBe('transcribe-test');
    await expect(
      collect(
        provider.transcribe(
          { ...input, sampleRate: 16000 } as unknown as AudioFrame,
          { signal: new AbortController().signal },
        ),
      ),
    ).rejects.toThrow('24000');
  });
  it('carries incomplete PCM samples across network chunks and rejects a final half sample', async () => {
    for (const odd of [false, true]) {
      const client = new OpenAI({
        apiKey: 'synthetic',
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(Uint8Array.from([1]));
                controller.enqueue(Uint8Array.from(odd ? [0, 2] : [0, 2, 0]));
                controller.close();
              },
            }),
          ),
      });
      const result = collect(
        new OpenAISpeechProvider({ client }).synthesize('hello', {
          signal: new AbortController().signal,
        }),
      );
      if (odd) await expect(result).rejects.toThrow('incomplete');
      else expect((await result).flatMap((f) => [...f.data])).toEqual([1, 2]);
    }
  });
  it('forwards configured client account headers to streaming transcription', async () => {
    let handshake: import('node:http').IncomingHttpHeaders | undefined;
    await withSocket(
      async (socket, _events, headers) => {
        handshake = headers;
        socket.on('message', () =>
          socket.send(JSON.stringify({ type: 'session.updated' })),
        );
      },
      async (provider) => {
        async function* source() {
          yield frame([]);
        }
        expect(
          await collect(
            provider.transcribe(source(), {
              signal: new AbortController().signal,
            }),
          ),
        ).toEqual([]);
        expect(handshake).toMatchObject({
          authorization: 'Bearer synthetic',
          'openai-organization': 'org-voice',
          'openai-project': 'proj-voice',
        });
      },
      { organization: 'org-voice', project: 'proj-voice' },
    );
  });
  it('commits explicit utterances and EOF, drains exact final items, and never commits empty input', async () => {
    await withSocket(
      async (socket, events) => {
        socket.on('message', (raw) => {
          const event = JSON.parse(raw.toString());
          events.push(event);
          if (event.type === 'session.update')
            socket.send(JSON.stringify({ type: 'session.updated' }));
          if (event.type === 'input_audio_buffer.commit') {
            const id = `item-${events.length}`;
            socket.send(
              JSON.stringify({
                type: 'input_audio_buffer.committed',
                item_id: id,
              }),
            );
            socket.send(
              JSON.stringify({
                type: 'conversation.item.input_audio_transcription.completed',
                item_id: id,
                transcript: id,
              }),
            );
          }
        });
      },
      async (provider, events) => {
        async function* source() {
          yield { type: 'commit' } as const;
          yield frame();
          yield { type: 'commit' } as const;
          yield frame();
        }
        expect(
          await collect(
            provider.transcribe(source(), {
              signal: new AbortController().signal,
            }),
          ),
        ).toHaveLength(2);
        expect(
          events.filter((e) => e.type === 'input_audio_buffer.commit'),
        ).toHaveLength(2);
        expect(events[0]).toMatchObject({
          session: {
            type: 'transcription',
            audio: {
              input: {
                turn_detection: null,
                transcription: { model: 'gpt-live-transcribe' },
              },
            },
          },
        });
      },
    );
  });
  it('reports failed setup, early closure, and mismatched final transcripts', async () => {
    for (const mode of ['setup', 'close', 'mismatch']) {
      await withSocket(
        async (socket) => {
          socket.on('message', (raw) => {
            const event = JSON.parse(raw.toString());
            if (mode === 'setup') {
              socket.send(JSON.stringify({ type: 'error' }));
              return;
            }
            if (event.type === 'session.update')
              socket.send(JSON.stringify({ type: 'session.updated' }));
            if (event.type === 'input_audio_buffer.commit') {
              if (mode === 'close') socket.close();
              else {
                socket.send(
                  JSON.stringify({
                    type: 'input_audio_buffer.committed',
                    item_id: 'owned',
                  }),
                );
                socket.send(
                  JSON.stringify({
                    type: 'conversation.item.input_audio_transcription.completed',
                    item_id: 'other',
                    transcript: 'wrong',
                  }),
                );
              }
            }
          });
        },
        async (provider) => {
          async function* source() {
            yield frame();
          }
          await expect(
            collect(
              provider.transcribe(source(), {
                signal: new AbortController().signal,
              }),
            ),
          ).rejects.toThrow();
        },
      );
    }
  });
  it('aborts idle application audio without waiting for its uncooperative iterator', async () => {
    await withSocket(
      async (socket) => {
        socket.on('message', () =>
          socket.send(JSON.stringify({ type: 'session.updated' })),
        );
      },
      async (provider) => {
        const controller = new AbortController();
        const next = vi.fn(
          () => new Promise<IteratorResult<AudioFrame>>(() => {}),
        );
        const returned = vi.fn(async () => ({
          done: true as const,
          value: undefined,
        }));
        const source = {
          [Symbol.asyncIterator]: () => ({ next, return: returned }),
        };
        const result = collect(
          provider.transcribe(source, { signal: controller.signal }),
        );
        await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
        controller.abort(new Error('idle stop'));
        await expect(result).rejects.toThrow('idle stop');
        await vi.waitFor(() => expect(returned).toHaveBeenCalledOnce());
      },
    );
  });
});

async function withSocket(
  setup: (
    socket: import('ws').WebSocket,
    events: Record<string, any>[],
    headers: import('node:http').IncomingHttpHeaders,
  ) => Promise<void>,
  test: (
    provider: OpenAISpeechProvider,
    events: Record<string, any>[],
  ) => Promise<void>,
  account: { organization?: string; project?: string } = {},
) {
  const server = createServer();
  const websocket = new WebSocketServer({ server });
  const events: Record<string, any>[] = [];
  websocket.on('connection', (socket, request) => {
    expect(request.url).toBe('/realtime?intent=transcription');
    void setup(socket, events, request.headers);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('missing address');
  const provider = new OpenAISpeechProvider({
    client: new OpenAI({
      apiKey: 'synthetic',
      baseURL: `http://127.0.0.1:${address.port}`,
      ...account,
    }),
    timeoutMs: 1000,
  });
  try {
    await test(provider, events);
  } finally {
    for (const socket of websocket.clients) socket.terminate();
    await new Promise<void>((resolve) => websocket.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

it('delegates an actual Realtime function call through an ordinary tool', async () => {
  const peer = fakeSession();
  const workflow = new NativeSessionVoiceWorkflow(peer.session);
  const nativeTool = classicTool({
    name: 'ask_native',
    description: 'Delegate work',
    parameters: z.object({ input: z.string() }),
    errorFunction: null,
    execute: async ({ input }) => (await collect(workflow.run(input))).join(''),
  });
  const transport = new FakeTransport();
  const realtime = new RealtimeSession(
    new RealtimeAgent({ name: 'Voice', tools: [nativeTool] }),
    { transport },
  );
  try {
    await realtime.connect({ apiKey: 'synthetic' });
    transport.emit('function_call', {
      type: 'function_call',
      name: 'ask_native',
      callId: 'call-1',
      responseId: 'response-1',
      arguments: '{"input":"native task"}',
    });
    await vi.waitFor(() =>
      expect(transport.sendFunctionCallOutputCalls).toHaveLength(1),
    );
    expect(peer.submit).toHaveBeenCalledExactlyOnceWith('native task');
    expect(transport.sendFunctionCallOutputCalls[0][1]).toContain('Hello.');
  } finally {
    try {
      realtime.close();
    } finally {
      await workflow.cancel();
    }
  }
});

// Exercise raw provider deltas as well as authoritative final output.
function streamedAnswer(text: string, id: string) {
  const item = {
    type: 'message',
    id: `message-${id}`,
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  };
  const events = [
    { type: 'response.created', response: { id } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, content: [] },
    },
    {
      type: 'response.output_text.delta',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id, output: [item] } },
  ];
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
  };
}

it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'retains native Session history over Realtime delegation and a chained speech turn',
  async () => {
    const { Agent, NativeProvider, tool, manualTool } = await import('../src');
    const { ModelServer, call } =
      await import('./native/fixtures/model-server');
    const applicationReply = deferred<void>();
    const asked = deferred<void>();
    const calls: string[] = [];
    const lookup = tool({
      name: 'lookup',
      parameters: z.object({ key: z.string() }),
      execute: ({ key }) => {
        calls.push(key);
        return 'blue';
      },
    });
    const confirm = manualTool({
      name: 'confirm',
      description: 'Ask the application to confirm native work.',
      parameters: z.object({}),
      result: z.object({ approved: z.boolean() }),
    });
    const server = new ModelServer([
      [
        call('lookup', { key: 'color' }, { callId: 'lookup-1' }),
        call('confirm', {}, { callId: 'confirm-1' }),
      ],
      streamedAnswer('First answer.', 'first'),
      streamedAnswer('Second answer.', 'second'),
    ]);
    try {
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-voice',
        supportsWebsockets: false,
      });
      const agent = new Agent({
        instructions: 'Answer.',
        tools: [lookup, confirm],
        model: 'gpt-5.5',
        provider,
      });
      await using session = await agent.session({
        onInteraction: async (request) => {
          if (request.type !== 'action_requested')
            throw new Error('Unexpected question');
          const match = confirm.match(request);
          if (!match) throw new Error('Unexpected manual tool');
          asked.resolve();
          await applicationReply.promise;
          return match.reply({ approved: true });
        },
      });
      const workflow = new NativeSessionVoiceWorkflow(session);
      const nativeTool = classicTool({
        name: 'ask_native',
        description: 'Delegate work',
        parameters: z.object({ input: z.string() }),
        errorFunction: null,
        execute: async ({ input }) =>
          (await collect(workflow.run(input))).join(''),
      });
      const transport = new FakeTransport();
      const realtime = new RealtimeSession(
        new RealtimeAgent({ name: 'Voice', tools: [nativeTool] }),
        { transport },
      );
      try {
        await realtime.connect({ apiKey: 'synthetic' });
        transport.emit('function_call', {
          type: 'function_call',
          name: 'ask_native',
          callId: 'realtime-call',
          responseId: 'realtime-response',
          arguments: '{"input":"Remember blue."}',
        });
        await asked.promise;
        await vi.waitFor(() => expect(calls).toEqual(['color']));
        expect(server.requests).toHaveLength(1);
        expect(transport.sendFunctionCallOutputCalls).toHaveLength(0);
        applicationReply.resolve();
        await vi.waitFor(() =>
          expect(transport.sendFunctionCallOutputCalls).toHaveLength(1),
        );
        expect(transport.sendFunctionCallOutputCalls[0][1]).toContain(
          'First answer.',
        );
        const manualOutput = (
          server.requests[1].input as Record<string, unknown>[]
        ).find(
          (item) =>
            item.call_id === 'confirm-1' &&
            item.type === 'function_call_output',
        );
        expect(JSON.stringify(manualOutput)).toContain('true');
        const spoken: string[] = [];
        const speech: SpeechProvider = {
          transcribe: async function* () {
            yield 'What color?';
          },
          synthesize: async function* (text) {
            spoken.push(text);
            yield frame();
          },
        };
        const events = await collect(
          new VoicePipeline({ workflow, provider: speech }).run(frame()),
        );
        expect(events.at(-1)).toEqual({ type: 'session_ended' });
        expect(spoken).toEqual(['Second answer.']);
        const history = JSON.stringify(await collect(session.items()));
        for (const text of [
          'Remember blue.',
          'First answer.',
          'What color?',
          'Second answer.',
        ])
          expect(history).toContain(text);
        expect(server.requests).toHaveLength(3);
        server.assertExhausted();
      } finally {
        applicationReply.resolve();
        try {
          realtime.close();
        } finally {
          await workflow.cancel();
        }
      }
    } finally {
      applicationReply.resolve();
      await ModelServer.closeAll();
    }
  },
  25000,
);

it
  .skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')
  .each(['rejected', 'repaired', 'normalized'] as const)(
  'speaks only validated native final output: %s',
  async (mode) => {
    const { Agent, NativeProvider, OutputValidationError } =
      await import('../src');
    const { ModelServer } = await import('./native/fixtures/model-server');
    const schema =
      mode === 'normalized'
        ? z.string().transform((text) => text.trim())
        : z.string().refine((text) => !text.includes('secret'));
    const server = new ModelServer([
      streamedAnswer(
        JSON.stringify(
          mode === 'normalized' ? '  accepted answer.  ' : 'secret. ',
        ),
        'original',
      ),
      ...(mode === 'repaired'
        ? [streamedAnswer(JSON.stringify('accepted answer.'), 'repair')]
        : []),
    ]);
    try {
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-voice',
        supportsWebsockets: false,
      });
      const agent = new Agent({
        instructions: 'Answer.',
        model: 'gpt-5.5',
        provider,
      });
      await using session = await agent
        .withOutputType({
          mode: 'prompted',
          schema,
          maxRetries: mode === 'repaired' ? 1 : 0,
        })
        .session();
      const spoken: string[] = [];
      const speech: SpeechProvider = {
        transcribe: async function* () {
          yield 'question';
        },
        synthesize: async function* (text) {
          spoken.push(text);
          yield frame();
        },
      };
      const result = collect(
        new VoicePipeline({
          workflow: new NativeSessionVoiceWorkflow(session),
          provider: speech,
        }).run(frame()),
      );
      if (mode === 'rejected') {
        await expect(result).rejects.toBeInstanceOf(OutputValidationError);
        expect(spoken).toEqual([]);
      } else {
        await result;
        expect(spoken).toEqual(['accepted answer.']);
      }
      server.assertExhausted();
    } finally {
      await ModelServer.closeAll();
    }
  },
  25000,
);

it('retains failed exact-turn cleanup for explicit retry before accepting new speech', async () => {
  const primary = new Error('primary');
  const peer = fakeSession('ignored', primary);
  peer.cancel.mockRejectedValueOnce(new Error('cleanup'));
  const workflow = new NativeSessionVoiceWorkflow(peer.session);
  await expect(collect(workflow.run('first'))).rejects.toBe(primary);
  await expect(collect(workflow.run('second'))).rejects.toThrow('busy');
  expect(peer.submit).toHaveBeenCalledOnce();
  await workflow.cancel();
  expect(peer.cancel).toHaveBeenCalledTimes(2);
  peer.wait.mockResolvedValueOnce({ finalOutput: 'ok' });
  await collect(workflow.run('third'));
  expect(peer.submit).toHaveBeenCalledTimes(2);
});

it('does not report success when aborted during final native settlement', async () => {
  const peer = fakeSession('');
  const finished = deferred<{ finalOutput: string }>();
  peer.wait.mockReturnValueOnce(finished.promise);
  const workflow = new NativeSessionVoiceWorkflow(peer.session);
  const controller = new AbortController();
  const result = collect(workflow.run('input', { signal: controller.signal }));
  await vi.waitFor(() => expect(peer.wait).toHaveBeenCalledOnce());
  controller.abort(new Error('cancel settling'));
  finished.resolve({ finalOutput: 'late' });
  await expect(result).rejects.toThrow('cancel settling');
});

it('reports a dropped transcription connection while application input is idle', async () => {
  const reading = deferred<void>();
  await withSocket(
    async (socket) => {
      socket.on('message', () => {
        socket.send(JSON.stringify({ type: 'session.updated' }));
        void reading.promise.then(() => socket.close());
      });
    },
    async (provider) => {
      const source = {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            reading.resolve();
            return new Promise<IteratorResult<AudioFrame>>(() => {});
          },
        }),
      };
      await expect(
        collect(
          provider.transcribe(source, { signal: new AbortController().signal }),
        ),
      ).rejects.toThrow('closed');
    },
  );
});

it('finishes empty streamed input without committing an empty utterance', async () => {
  await withSocket(
    async (socket, events) => {
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString());
        events.push(event);
        socket.send(JSON.stringify({ type: 'session.updated' }));
      });
    },
    async (provider, events) => {
      async function* source() {
        yield frame([]);
        yield { type: 'commit' } as const;
      }
      expect(
        await collect(
          provider.transcribe(source(), {
            signal: new AbortController().signal,
          }),
        ),
      ).toEqual([]);
      expect(events.map((e) => e.type)).toEqual(['session.update']);
    },
  );
});

it('aborts a pending synthesis body read and releases it', async () => {
  const ready = deferred<void>();
  const cancelled = vi.fn();
  const client = new OpenAI({
    apiKey: 'synthetic',
    fetch: async () => {
      return new Response(
        new ReadableStream(
          {
            pull() {
              ready.resolve();
            },
            cancel: cancelled,
          },
          { highWaterMark: 0 },
        ),
      );
    },
  });
  const controller = new AbortController();
  const result = collect(
    new OpenAISpeechProvider({ client }).synthesize('input', {
      signal: controller.signal,
    }),
  );
  await ready.promise;
  controller.abort(new Error('stop synthesis'));
  await expect(result).rejects.toThrow('stop synthesis');
  expect(cancelled).toHaveBeenCalledOnce();
});

it('records delayed delegated audio after a preamble instead of closing with finite input', async () => {
  const { recordDelegatedVoice } =
    await import('../../../examples/codex/realtime-voice');
  vi.useFakeTimers();
  const peer = fakeSession();
  const transport = new FakeTransport();
  transport.status = 'connected';
  const sent = deferred<void>();
  const originalSend = transport.sendMessage.bind(transport);
  vi.spyOn(transport, 'sendMessage').mockImplementation((...args) => {
    originalSend(...args);
    sent.resolve();
  });
  const audio: number[] = [];
  let settled = false;
  const recording = recordDelegatedVoice(
    peer.session,
    'one complete question',
    {
      apiKey: 'synthetic',
      durationMs: 10000,
      transport,
      onAudio: (data) => audio.push(...new Uint8Array(data)),
    },
  );
  void recording.then(() => {
    settled = true;
  });
  try {
    await sent.promise;
    transport.emit('audio', {
      type: 'audio',
      data: Uint8Array.from([1]).buffer,
      responseId: 'preamble',
    });
    transport.emit('turn_done', {
      type: 'response_done',
      response: { id: 'preamble', output: [], usage: {} as any },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(false);
    expect(transport.closeCalls).toBe(0);
    const returned = transport.waitForNextFunctionCallOutput();
    transport.emit('function_call', {
      type: 'function_call',
      name: 'ask_native',
      callId: 'recording-call',
      responseId: 'delegation',
      arguments: '{"input":"native work"}',
    });
    await returned;
    transport.emit('audio', {
      type: 'audio',
      data: Uint8Array.from([2, 3]).buffer,
      responseId: 'final-answer',
    });
    transport.emit('turn_done', {
      type: 'response_done',
      response: { id: 'final-answer', output: [], usage: {} as any },
    });
    expect(audio).toEqual([1, 2, 3]);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(9000);
    await recording;
    expect(transport.sendMessageCalls.map(([message]) => message)).toEqual([
      'one complete question',
    ]);
    expect(transport.closeCalls).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

it.each(['disconnect', 'error'] as const)(
  'joins pending native cancellation when recording ends through %s',
  async (mode) => {
    const { recordDelegatedVoice } =
      await import('../../../examples/codex/realtime-voice');
    const peer = fakeSession();
    const transport = new FakeTransport();
    transport.status = 'connected';
    const sent = deferred<void>();
    const started = deferred<void>();
    const released = deferred<void>();
    const cancellation = deferred<void>();
    vi.spyOn(transport, 'sendMessage').mockImplementation(() => sent.resolve());
    peer.wait.mockImplementation(async () => {
      started.resolve();
      await released.promise;
      return { finalOutput: 'late answer' };
    });
    peer.cancel.mockImplementation(async () => {
      expect(transport.closeCalls).toBe(1);
      released.resolve();
      await cancellation.promise;
    });
    let settled = false;
    const recording = recordDelegatedVoice(peer.session, 'question', {
      apiKey: 'synthetic',
      durationMs: 10000,
      transport,
      onAudio: () => {},
    });
    const outcome = recording.then(
      () => {
        settled = true;
        return undefined;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    await sent.promise;
    transport.emit('function_call', {
      type: 'function_call',
      name: 'ask_native',
      callId: 'pending-call',
      responseId: 'pending-response',
      arguments: '{"input":"pending work"}',
    });
    await started.promise;
    if (mode === 'disconnect') {
      transport.status = 'disconnected';
      transport.emit('connection_change', 'disconnected');
    } else
      transport.emit('error', {
        type: 'error',
        error: new Error('remote failure'),
      });
    await vi.waitFor(() => expect(peer.cancel).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    cancellation.resolve();
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(
      mode === 'disconnect' ? /disconnected/ : /remote failure/,
    );
    transport.emit('function_call', {
      type: 'function_call',
      name: 'ask_native',
      callId: 'late-call',
      responseId: 'late-response',
      arguments: '{"input":"late work"}',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(peer.submit).toHaveBeenCalledOnce();
    expect(transport.sendFunctionCallOutputCalls).toHaveLength(0);
  },
);

function holdFirstAudioWrite() {
  const written = deferred<void>();
  let held = false;
  let release = () => {};
  let fail: (error: Error) => void = () => {};
  const original = WebSocket.prototype.send;
  const spy = vi
    .spyOn(WebSocket.prototype, 'send')
    .mockImplementation(function (
      this: WebSocket,
      data: any,
      options: any,
      callback?: (error?: Error) => void,
    ) {
      const completed = typeof options === 'function' ? options : callback;
      const settings = typeof options === 'object' ? options : {};
      if (
        !held &&
        JSON.parse(String(data)).type === 'input_audio_buffer.append'
      ) {
        held = true;
        fail = (error) => {
          this.emit('error', error);
        };
        original.call(this, data, settings, (error?: Error) => {
          release = () => completed?.(error);
          written.resolve();
        });
      } else original.call(this, data, settings, completed);
    });
  return {
    written: written.promise,
    fail: (error: Error) => fail(error),
    release: () => release(),
    restore: () => {
      release();
      spy.mockRestore();
    },
  };
}

function acknowledgeTranscription(socket: WebSocket) {
  socket.on('message', (raw) => {
    const event = JSON.parse(raw.toString());
    if (event.type === 'session.update')
      socket.send(JSON.stringify({ type: 'session.updated' }));
    if (event.type === 'input_audio_buffer.commit') {
      socket.send(
        JSON.stringify({
          type: 'input_audio_buffer.committed',
          item_id: 'bounded-audio',
        }),
      );
      socket.send(
        JSON.stringify({
          type: 'conversation.item.input_audio_transcription.completed',
          item_id: 'bounded-audio',
          transcript: 'bounded',
        }),
      );
    }
  });
}

it('waits for an audio write before pulling the next input frame', async () => {
  const held = holdFirstAudioWrite();
  try {
    await withSocket(
      async (socket) => acknowledgeTranscription(socket),
      async (provider) => {
        const controller = new AbortController();
        const next = vi
          .fn<() => Promise<IteratorResult<AudioFrame>>>()
          .mockResolvedValueOnce({ done: false, value: frame() })
          .mockResolvedValueOnce({ done: true, value: undefined });
        const source = { [Symbol.asyncIterator]: () => ({ next }) };
        const result = collect(
          provider.transcribe(source, { signal: controller.signal }),
        );
        try {
          await held.written;
          expect(next).toHaveBeenCalledTimes(1);
          held.release();
          expect(await result).toEqual(['bounded']);
          expect(next).toHaveBeenCalledTimes(2);
        } finally {
          controller.abort();
          held.release();
          await result.catch(() => {});
        }
      },
    );
  } finally {
    held.restore();
  }
});

it('bounds encoded audio chunks from a large frame without changing samples', async () => {
  const samples = Int16Array.from(
    { length: 100000 },
    (_, i) => (i % 65536) - 32768,
  );
  const original = samples.slice();
  const packets: Buffer[] = [];
  await withSocket(
    async (socket) => {
      acknowledgeTranscription(socket);
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString());
        if (event.type === 'input_audio_buffer.append')
          packets.push(Buffer.from(event.audio, 'base64'));
      });
    },
    async (provider) => {
      async function* source() {
        yield { ...frame([]), data: samples };
      }
      expect(
        await collect(
          provider.transcribe(source(), {
            signal: new AbortController().signal,
          }),
        ),
      ).toEqual(['bounded']);
    },
  );
  expect(packets.length).toBeGreaterThan(1);
  expect(packets.every((packet) => packet.length <= 64 * 1024)).toBe(true);
  const expected = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++)
    expected.writeInt16LE(samples[i], i * 2);
  expect(Buffer.concat(packets)).toEqual(expected);
  expect(samples).toEqual(original);
});

it.each(['abort', 'disconnect', 'error'] as const)(
  'releases a stalled audio write on %s without pulling more input',
  async (mode) => {
    const held = holdFirstAudioWrite();
    let disconnect = () => {};
    const closed = deferred<void>();
    try {
      await withSocket(
        async (socket) => {
          acknowledgeTranscription(socket);
          socket.once('close', () => closed.resolve());
          disconnect = () => socket.terminate();
        },
        async (provider) => {
          const controller = new AbortController();
          const next = vi
            .fn<() => Promise<IteratorResult<AudioFrame>>>()
            .mockResolvedValueOnce({ done: false, value: frame() })
            .mockReturnValue(new Promise(() => {}));
          const returned = vi.fn(async () => ({
            done: true as const,
            value: undefined,
          }));
          const source = {
            [Symbol.asyncIterator]: () => ({ next, return: returned }),
          };
          const outcome = collect(
            provider.transcribe(source, { signal: controller.signal }),
          ).then(
            () => undefined,
            (error: unknown) => error,
          );
          try {
            await held.written;
            expect(next).toHaveBeenCalledTimes(1);
            if (mode === 'abort') controller.abort(new Error('stop write'));
            else if (mode === 'disconnect') disconnect();
            else held.fail(new Error('write failure'));
            expect(await outcome).toMatchObject({
              message:
                mode === 'abort'
                  ? 'stop write'
                  : mode === 'error'
                    ? 'write failure'
                    : 'Transcription connection closed before completion',
            });
            await closed.promise;
            await vi.waitFor(() => expect(returned).toHaveBeenCalledOnce());
            held.release();
            expect(next).toHaveBeenCalledTimes(1);
          } finally {
            controller.abort();
            held.release();
            await outcome;
          }
        },
      );
    } finally {
      held.restore();
    }
  },
);

it('rejects overflowing speech timers before constructing a client', () => {
  expect(() => new OpenAISpeechProvider({ timeoutMs: 2_147_483_648 })).toThrow(
    '2147483647',
  );
  expect(
    () =>
      new OpenAISpeechProvider({
        apiKey: 'synthetic',
        timeoutMs: 2_147_483_647,
      }),
  ).not.toThrow();
});
