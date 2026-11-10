import { WebSocket, WebSocketServer } from 'ws';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NativeVoiceControl,
  PortableVoiceSession,
  connectPortableVoiceWebSocket,
  type PortableVoiceOptions,
} from '@openai/agents/voice/portable';

import { connectPortableVoiceReactNative } from '@openai/agents/voice/react-native';
afterEach(() => vi.unstubAllGlobals());

const enabled = process.env.OPENAI_AGENTS_PORTABLE_TESTS === '1';
function fixture(options: PortableVoiceOptions) {
  const modulePath = process.env.OPENAI_AGENTS_PORTABLE_CONTROL_WASM!;
  const control = new NativeVoiceControl(
    new WebAssembly.Module(Uint8Array.from(readFileSync(modulePath))),
  );
  const frames: any[] = [];
  const close = vi.fn();
  const session: PortableVoiceSession = new PortableVoiceSession(
    control,
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
        if (event.type === 'response.cancel')
          queueMicrotask(() =>
            session.receive({
              type: 'response.done',
              response: {
                id: event.response_id,
                status: 'cancelled',
                output: [],
              },
            }),
          );
      },
      close,
    },
    options,
  );
  return { session, frames, close };
}
function response(session: PortableVoiceSession, id: string) {
  session.receive({ type: 'response.created', response: { id } });
}
function completeTool(
  session: PortableVoiceSession,
  responseId: string,
  callId = 'call',
  name = 'lookup',
) {
  session.receive({
    type: 'response.done',
    response: {
      id: responseId,
      status: 'completed',
      output: [
        {
          type: 'function_call',
          id: `${callId}-item`,
          call_id: callId,
          name,
          arguments: '{"value":7}',
        },
      ],
    },
  });
}
const tool = {
  name: 'lookup',
  description: 'Look up',
  parameters: { type: 'object' },
};

describe.runIf(enabled)('direct client Rust authority', () => {
  it('isolates nested source history for approval predicates, approval UI, executions and sibling calls', async () => {
    const observations: any[] = [];
    function mutate(
      phase: string,
      history: readonly Readonly<Record<string, unknown>>[],
    ) {
      const source = history.find((item) => item.id === 'source') as any;
      observations.push({
        phase,
        text: source.content[0].text,
        length: history.length,
      });
      source.content[0].text = phase;
      (history as any[]).push({ id: phase });
    }
    const execute = vi.fn((_args, _signal, context) => {
      mutate('execute', context.history);
      return 'ok';
    });
    const { session, frames } = fixture({
      model: 'test',
      instructions: 'Test',
      tools: [
        {
          ...tool,
          needsApproval: (_args, context) => {
            mutate('predicate', context.history);
            return true;
          },
          execute,
        },
      ],
      onApproval: (_request, _signal, context) => {
        mutate('approval', context.history);
        return true;
      },
    });
    await session.start();
    session.receive({
      type: 'conversation.item.created',
      item: {
        id: 'source',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'original' }],
      },
    });
    response(session, 'siblings');
    session.receive({
      type: 'response.done',
      response: {
        id: 'siblings',
        status: 'completed',
        output: ['first', 'second'].map((id) => ({
          type: 'function_call',
          id,
          call_id: id,
          name: 'lookup',
          arguments: '{}',
        })),
      },
    });
    await vi.waitFor(() =>
      expect(
        frames.filter((frame) => frame.item?.type === 'function_call_output'),
      ).toHaveLength(2),
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(observations).toHaveLength(6);
    expect(
      observations.every(
        (entry) => entry.text === 'original' && entry.length === 3,
      ),
    ).toBe(true);
    expect((session.history[0].content as any[])[0].text).toBe('original');
    await session.close();
  });

  it.each([
    ['audio/pcmu', 'audio/pcmu'],
    ['audio/pcma', 'audio/pcma'],
    ['audio/pcm', 'audio/pcmu'],
    ['audio/pcmu', 'audio/pcm'],
  ])(
    'truncates retained %s session audio using accepted %s response format',
    async (sessionFormat, responseFormat) => {
      const { session } = fixture({
        model: 'test',
        instructions: 'Test',
        storeAudio: true,
        settings: { audio: { output: { format: { type: sessionFormat } } } },
      });
      await session.start();
      session.receive({
        type: 'response.created',
        response: {
          id: 'audio',
          audio: { output: { format: { type: responseFormat } } },
        },
      });
      const bytesPerMillisecond = responseFormat === 'audio/pcm' ? 48 : 8;
      const bytes = Buffer.from(
        Uint8Array.from(
          { length: bytesPerMillisecond * 10 },
          (_, i) => i % 256,
        ),
      );
      session.receive({
        type: 'response.output_item.added',
        response_id: 'audio',
        item: {
          id: 'audio-item',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_audio' }],
        },
      });
      session.receive({
        type: 'response.output_audio.delta',
        response_id: 'audio',
        item_id: 'audio-item',
        content_index: 0,
        delta: bytes.toString('base64'),
      });
      session.receive({
        type: 'conversation.item.truncated',
        item_id: 'audio-item',
        content_index: 0,
        audio_end_ms: 5,
      });
      expect(
        Buffer.from((session.history[0].content as any[])[0].audio, 'base64'),
      ).toEqual(bytes.subarray(0, bytesPerMillisecond * 5));
      await session.close();
    },
  );

  it('preserves an active response accepted audio format across live session format updates', async () => {
    const { session } = fixture({
      model: 'test',
      instructions: 'Test',
      storeAudio: true,
      settings: { audio: { output: { format: { type: 'audio/pcma' } } } },
    });
    await session.start();
    response(session, 'audio');
    await session.updateAgent({
      model: 'test',
      instructions: 'Updated',
      settings: {
        audio: { output: { format: { type: 'audio/pcm', rate: 24000 } } },
      },
    });
    session.receive({
      type: 'response.output_item.added',
      response_id: 'audio',
      item: {
        id: 'audio-item',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_audio' }],
      },
    });
    session.receive({
      type: 'response.output_audio.delta',
      response_id: 'audio',
      item_id: 'audio-item',
      content_index: 0,
      delta: Buffer.alloc(80, 7).toString('base64'),
    });
    session.receive({
      type: 'conversation.item.truncated',
      item_id: 'audio-item',
      content_index: 0,
      audio_end_ms: 5,
    });
    expect(
      Buffer.from((session.history[0].content as any[])[0].audio, 'base64'),
    ).toEqual(Buffer.alloc(40, 7));
    await session.close();
  });

  it('resolves instructions and preserves response-owned tools across live updates', async () => {
    const old = vi.fn(() => 'old');
    const replacement = vi.fn(() => 'new');
    const instructions = vi.fn(async () => 'Dynamic instructions');
    const { session, frames } = fixture({
      model: 'test',
      instructions,
      settings: { output_modalities: ['text'] },
      tools: [{ ...tool, execute: old }],
    });
    await session.start();
    expect(instructions).toHaveBeenCalledOnce();
    expect(frames[0].session).toMatchObject({
      instructions: 'Dynamic instructions',
      output_modalities: ['text'],
    });
    response(session, 'old-response');
    await session.updateAgent({
      model: 'test',
      instructions: 'New agent',
      tools: [{ ...tool, execute: replacement }],
    });
    completeTool(session, 'old-response');
    await vi.waitFor(() => expect(old).toHaveBeenCalledOnce());
    expect(replacement).not.toHaveBeenCalled();
    expect(old.mock.calls[0]).toEqual([
      { value: 7 },
      expect.any(AbortSignal),
      expect.objectContaining({
        agent: expect.objectContaining({ instructions }),
        history: [expect.objectContaining({ call_id: 'call' })],
      }),
    ]);
    await session.close();
  });

  it('runs custom source-owned handoffs and accepts the target catalog before continuation', async () => {
    const hook = vi.fn();
    const target = {
      name: 'Target',
      model: 'test',
      instructions: 'Target instructions',
      tools: [{ ...tool, execute: () => 'target' }],
    };
    const resolveTarget = vi.fn(async () => target);
    const { session, frames } = fixture({
      model: 'test',
      instructions: 'Root',
      handoffs: [
        {
          name: 'transfer_custom',
          description: 'Transfer',
          parameters: { type: 'object' },
          agent: resolveTarget,
          onHandoff: hook,
        },
      ],
    });
    await session.start();
    response(session, 'root-response');
    completeTool(session, 'root-response', 'handoff-call', 'transfer_custom');
    await vi.waitFor(() =>
      expect(
        frames.some((frame) => frame.item?.type === 'function_call_output'),
      ).toBe(true),
    );
    expect(hook).toHaveBeenCalledOnce();
    expect(resolveTarget).toHaveBeenCalledOnce();
    expect(
      frames.filter((frame) => frame.type === 'session.update')[1].session,
    ).toMatchObject({
      instructions: 'Target instructions',
      tools: [expect.objectContaining({ name: 'lookup' })],
    });
    expect(frames.map((frame) => frame.type)).toEqual([
      'session.update',
      'session.update',
      'conversation.item.create',
      'response.create',
    ]);
    await session.close();
  });

  it('revokes approval on cancel and keeps the same direct session usable', async () => {
    const decision = Promise.withResolvers<boolean>();
    let approvalSignal!: AbortSignal;
    const execute = vi.fn(() => 'output');
    const { session, close } = fixture({
      model: 'test',
      instructions: 'Help',
      tools: [{ ...tool, needsApproval: true, execute }],
      onApproval: (_request, signal) => {
        approvalSignal = signal;
        return decision.promise;
      },
    });
    await session.start();
    response(session, 'approval-response');
    completeTool(session, 'approval-response');
    await vi.waitFor(() => expect(approvalSignal).toBeDefined());
    session.cancel();
    expect(approvalSignal.aborted).toBe(true);
    decision.resolve(true);
    await Promise.resolve();
    session.sendText('Still connected');
    expect(close).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await session.close();
  });

  it('shares guardrail scheduling and publishes replacement only after cancellation', async () => {
    const guardrail = vi.fn(async () => ({ tripwireTriggered: true }));
    const { session, frames } = fixture({
      model: 'test',
      instructions: 'Help',
      guardrailTextThreshold: 1,
      outputGuardrails: [
        { name: 'block', callback: guardrail, feedback: 'Answer safely' },
      ],
    });
    await session.start();
    response(session, 'guarded-response');
    session.receive({
      type: 'response.output_text.delta',
      response_id: 'guarded-response',
      item_id: 'output-item',
      content_index: 0,
      delta: 'blocked',
    });
    await vi.waitFor(() =>
      expect(frames.some((frame) => frame.type === 'response.create')).toBe(
        true,
      ),
    );
    expect(guardrail).toHaveBeenCalledOnce();
    expect(frames.map((frame) => frame.type)).toEqual([
      'session.update',
      'response.cancel',
      'response.create',
    ]);
    expect(frames[2].response.instructions).toBe('Answer safely');
    await session.close();
  });

  it('multicasts raw provider events without granting observer control or retaining history after close', async () => {
    const { session } = fixture({ model: 'test', instructions: 'Help' });
    await session.start();
    const observer = vi.fn();
    session.on('provider_event', () => {
      throw new Error('passive observer');
    });
    const detach = session.on('provider_event', observer);
    const event = {
      type: 'conversation.item.created',
      item: {
        id: 'user-item',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Hello' }],
      },
    };
    session.receive(event);
    expect(observer).toHaveBeenCalledWith(event);
    expect(session.history).toEqual([event.item]);
    detach();
    session.receive({
      type: 'conversation.item.deleted',
      item_id: 'user-item',
    });
    expect(observer).toHaveBeenCalledOnce();
    expect(session.history).toEqual([]);
    await session.close();
    expect(session.history).toEqual([]);
  });
  it('executes direct callbacks through injected mobile peers without browser globals', async () => {
    const owner = new NativeVoiceControl(
      new WebAssembly.Module(
        Uint8Array.from(
          readFileSync(process.env.OPENAI_AGENTS_PORTABLE_CONTROL_WASM!),
        ),
      ),
    );
    vi.stubGlobal('WebAssembly', undefined);
    vi.stubGlobal('TextEncoder', undefined);
    vi.stubGlobal('TextDecoder', undefined);
    vi.stubGlobal('navigator', undefined);
    vi.stubGlobal('document', undefined);
    const track = Object.assign(new EventTarget(), {
      enabled: true,
      readyState: 'live',
      stop: vi.fn(),
    });
    const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
    const execute = vi.fn(() => 'mobile result');
    const credentials = vi.fn(async () => 'ek_synthetic-mobile');
    const remote = vi.fn();
    const channel = {
      readyState: 'open',
      onopen: null as (() => void) | null,
      onmessage: null as ((event: { data: string }) => void) | null,
      close: vi.fn(),
      send(frame: string) {
        const event = JSON.parse(frame);
        if (event.type === 'session.update')
          queueMicrotask(() =>
            channel.onmessage?.({
              data: JSON.stringify({
                type: 'session.updated',
                session: event.session,
              }),
            }),
          );
      },
    };
    const peer = {
      localDescription: { sdp: 'mobile-offer' },
      connectionState: 'connected',
      createDataChannel: () => channel,
      addTrack() {},
      async createOffer() {
        return { type: 'offer' as const, sdp: 'mobile-offer' };
      },
      async setLocalDescription() {},
      async setRemoteDescription() {},
      close: vi.fn(),
    };
    const fetch = vi.fn(async () => ({
      ok: true,
      text: async () => 'mobile-answer',
    }));
    vi.stubGlobal('fetch', fetch);
    const call = await connectPortableVoiceReactNative({
      control: owner,
      apiKey: credentials,
      agent: {
        model: 'test',
        instructions: 'Mobile 漢字 🎧 % help',
        tools: [{ ...tool, execute }],
      },
      media: {
        mediaStream: stream,
        createPeerConnection: () => peer,
        onRemoteStream: remote,
      },
    });
    response(call.session, 'mobile-response');
    completeTool(call.session, 'mobile-response');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await call.session.close();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(track.stop).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    expect(credentials).toHaveBeenCalledOnce();
  });
  it('executes a standalone direct agent over a real injected Node WebSocket', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    const execute = vi.fn(() => 'standalone result');
    const credentials = vi.fn(async () => 'synthetic-node-key');
    const frames: any[] = [];
    server.on('connection', (socket, request) => {
      expect(request.headers.authorization).toBe('Bearer synthetic-node-key');
      socket.on('message', (data) => {
        const event = JSON.parse(data.toString());
        frames.push(event);
        if (event.type === 'session.update') {
          socket.send(
            JSON.stringify({ type: 'session.updated', session: event.session }),
          );
          socket.send(
            JSON.stringify({
              type: 'response.created',
              response: { id: 'node-response' },
            }),
          );
          socket.send(
            JSON.stringify({
              type: 'response.done',
              response: {
                id: 'node-response',
                status: 'completed',
                output: [
                  {
                    type: 'function_call',
                    id: 'node-item',
                    call_id: 'node-call',
                    name: 'lookup',
                    arguments: '{}',
                  },
                ],
              },
            }),
          );
        }
      });
    });
    let session: PortableVoiceSession | undefined;
    try {
      const control = new NativeVoiceControl(
        new WebAssembly.Module(
          Uint8Array.from(
            readFileSync(process.env.OPENAI_AGENTS_PORTABLE_CONTROL_WASM!),
          ),
        ),
      );
      session = await connectPortableVoiceWebSocket({
        control,
        apiKey: credentials,
        agent: {
          model: 'test',
          instructions: async () => 'Standalone instructions',
          context: { tenant: 'synthetic' },
          tools: [{ ...tool, execute }],
        },
        createWebSocket: (url, headers) => {
          expect(url).toBe('wss://api.openai.com/v1/realtime?model=test');
          return new WebSocket(`ws://127.0.0.1:${port}`, { headers });
        },
      });
      await vi.waitFor(() =>
        expect(
          frames.some((frame) => frame.item?.call_id === 'node-call'),
        ).toBe(true),
      );
      expect(credentials).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledExactlyOnceWith(
        {},
        expect.any(AbortSignal),
        expect.objectContaining({ context: { tenant: 'synthetic' } }),
      );
    } finally {
      await session?.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('keeps managed detached execution separate while leaving unowned detached output passive', async () => {
    const execute = vi.fn(() => 'default');
    const guardrail = vi.fn(async () => ({ tripwireTriggered: false }));
    const { session, frames } = fixture({
      model: 'test',
      instructions: 'Help',
      tools: [{ ...tool, execute }],
      outputGuardrails: [{ name: 'observe', callback: guardrail }],
      guardrailTextThreshold: 1,
    });
    await session.start();
    response(session, 'default-response');
    session.createResponse({
      conversation: 'none',
      instructions: 'Detached',
      metadata: { purpose: 'test' },
    });
    await vi.waitFor(() =>
      expect(frames.some((frame) => frame.type === 'response.create')).toBe(
        true,
      ),
    );
    const detachedRequest = frames.find(
      (frame) => frame.type === 'response.create',
    ).response;
    session.receive({
      type: 'response.created',
      response: {
        id: 'detached-response',
        conversation_id: null,
        metadata: detachedRequest.metadata,
      },
    });
    session.receive({
      type: 'response.output_text.delta',
      response_id: 'detached-response',
      item_id: 'detached-text',
      content_index: 0,
      delta: 'Detached text',
    });
    completeTool(session, 'detached-response', 'detached-call');
    completeTool(session, 'default-response', 'default-call');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    session.receive({
      type: 'response.created',
      response: { id: 'external-detached', conversation_id: null },
    });
    completeTool(session, 'external-detached', 'external-call');
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(
      session.history.some((item) => item.call_id === 'detached-call'),
    ).toBe(false);
    await vi.waitFor(() => expect(guardrail).toHaveBeenCalledOnce());
    expect(guardrail).toHaveBeenCalledWith(
      expect.objectContaining({ outOfBand: true, text: 'Detached text' }),
    );
    await session.close();
  });

  it('approves hosted MCP through its response-owned source without local execution', async () => {
    const oldApproval = vi.fn(async () => true);
    const newApproval = vi.fn(async () => false);
    const hostedTools = [
      {
        type: 'mcp',
        server_label: 'catalog',
        server_url: 'https://mcp.example.test',
        require_approval: 'always',
      },
    ];
    const { session, frames } = fixture({
      model: 'test',
      instructions: 'Help',
      hostedTools,
      onApproval: oldApproval,
    });
    await session.start();
    response(session, 'mcp-response');
    await session.updateAgent({
      model: 'test',
      instructions: 'New',
      hostedTools,
      onApproval: newApproval,
    });
    session.receive({
      type: 'response.done',
      response: {
        id: 'mcp-response',
        status: 'completed',
        output: [
          {
            type: 'mcp_approval_request',
            id: 'approval-item',
            server_label: 'catalog',
            name: 'lookup',
            arguments: '{"value":7}',
          },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(
        frames.some((frame) => frame.item?.type === 'mcp_approval_response'),
      ).toBe(true),
    );
    expect(oldApproval).toHaveBeenCalledExactlyOnceWith(
      {
        callId: 'approval-item',
        kind: 'hosted_mcp',
        serverLabel: 'catalog',
        name: 'lookup',
        arguments: { value: 7 },
      },
      expect.any(AbortSignal),
      expect.objectContaining({
        agent: expect.objectContaining({ instructions: 'Help' }),
      }),
    );
    expect(newApproval).not.toHaveBeenCalled();
    expect(
      frames.find((frame) => frame.item?.type === 'mcp_approval_response').item,
    ).toMatchObject({ approval_request_id: 'approval-item', approve: true });
    await session.close();
  });
  it('evaluates context-aware enabled, instruction and approval predicates against the source profile', async () => {
    const execute = vi.fn(() => 'validated');
    const parseArguments = vi.fn((value: unknown) => {
      const args = value as { value: unknown };
      if (typeof args.value !== 'number')
        throw new TypeError('Expected numeric value');
      return { value: args.value };
    });
    const isEnabled = vi.fn(
      async ({ context }: any) => context.tenant === 'enabled',
    );
    const needsApproval = vi.fn(
      async (args: any, source: any) =>
        args.value > 5 && source.context.tenant === 'enabled',
    );
    const onApproval = vi.fn(
      async (_request: any, _signal: any, source: any) =>
        source.context.tenant === 'enabled',
    );
    const { session, frames } = fixture({
      model: 'test',
      context: { tenant: 'enabled' },
      instructions: async ({ context }: any) => 'Tenant ' + context.tenant,
      tools: [
        {
          ...tool,
          parameters: {
            type: 'object',
            properties: { value: { type: 'number' } },
            required: ['value'],
            additionalProperties: false,
          },
          parseArguments,
          isEnabled,
          needsApproval,
          execute,
        },
        {
          name: 'disabled',
          description: 'Disabled',
          parameters: { type: 'object' },
          isEnabled: false,
          execute: () => {
            throw new Error('Disabled callback');
          },
        },
      ],
      handoffs: [
        {
          name: 'disabled_handoff',
          description: 'Disabled handoff',
          isEnabled: async () => false,
          agent: { model: 'test', instructions: 'Disabled' },
        },
      ],
      onApproval,
    });
    await session.start();
    expect(frames[0].session).toMatchObject({
      instructions: 'Tenant enabled',
      tools: [expect.objectContaining({ name: 'lookup' })],
    });
    expect(frames[0].session.tools).toHaveLength(1);
    response(session, 'predicate-response');
    completeTool(session, 'predicate-response');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(parseArguments).toHaveBeenCalledOnce();
    expect(isEnabled).toHaveBeenCalledOnce();
    expect(needsApproval).toHaveBeenCalledOnce();
    expect(onApproval).toHaveBeenCalledOnce();
    await session.close();
  });

  it('preserves Classic structural parsing for plain JSON-schema declarations', async () => {
    const execute = vi.fn(() => 'structural');
    const { session } = fixture({
      model: 'test',
      instructions: 'Help',
      tools: [
        {
          ...tool,
          parameters: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
          execute,
        },
      ],
    });
    await session.start();
    response(session, 'plain-schema-response');
    completeTool(session, 'plain-schema-response');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(execute.mock.calls[0]).toEqual([
      { value: 7 },
      expect.any(AbortSignal),
      expect.anything(),
    ]);
    await session.close();
  });

  it('blocks invalid caller-schema arguments before approval or execution callbacks', async () => {
    const execute = vi.fn(() => 'unsafe');
    const onApproval = vi.fn(async () => true);
    const onError = vi.fn();
    const { session, close } = fixture({
      model: 'test',
      instructions: 'Help',
      onApproval,
      onError,
      tools: [
        {
          ...tool,
          parameters: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
          parseArguments: (value) => {
            const args = value as { value: unknown };
            if (typeof args.value !== 'string')
              throw new TypeError('Expected string value');
            return { value: args.value };
          },
          needsApproval: true,
          execute,
        },
      ],
    });
    await session.start();
    response(session, 'invalid-response');
    completeTool(session, 'invalid-response');
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(execute).not.toHaveBeenCalled();
    expect(onApproval).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    await session.close();
  });
  it('revokes suspended parsing before an approval predicate or tool callback starts', async () => {
    const parsing = Promise.withResolvers<Record<string, unknown>>();
    const execute = vi.fn(() => 'late');
    const needsApproval = vi.fn(async () => true);
    const onApproval = vi.fn(async () => true);
    const parseArguments = vi.fn(() => parsing.promise);
    const { session } = fixture({
      model: 'test',
      instructions: 'Help',
      onApproval,
      tools: [{ ...tool, parseArguments, needsApproval, execute }],
    });
    await session.start();
    response(session, 'parsing-response');
    completeTool(session, 'parsing-response');
    await vi.waitFor(() => expect(parseArguments).toHaveBeenCalledOnce());
    session.cancel();
    parsing.resolve({ value: 7 });
    await session.close();
    expect(needsApproval).not.toHaveBeenCalled();
    expect(onApproval).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
