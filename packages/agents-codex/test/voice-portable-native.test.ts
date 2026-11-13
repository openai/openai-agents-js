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
  it('forwards provider response extensions within native response scope', async () => {
    const frames: Record<string, unknown>[] = [];
    const session: PortableVoiceSession = new PortableVoiceSession(
      control(),
      {
        send(frame) {
          const event = JSON.parse(frame);
          frames.push(event);
          if (event.type === 'session.update') {
            queueMicrotask(() =>
              session.receive({
                type: 'session.updated',
                session: event.session,
              }),
            );
          }
        },
        close() {},
      },
      { model: 'test-realtime', instructions: 'Help.' },
    );
    try {
      await session.start();
      session.createResponse({ vendor_feature: { enabled: true } });
      await vi.waitFor(() =>
        expect(frames.at(-1)).toMatchObject({
          type: 'response.create',
          response: { vendor_feature: { enabled: true } },
        }),
      );
      expect(frames.at(-1)?.response).not.toHaveProperty('conversation');
      expect(
        frames.filter((event) => event.type === 'response.create'),
      ).toHaveLength(1);
      expect(() =>
        session.createResponse({
          tools: [
            {
              type: 'function',
              name: 'unowned',
              parameters: { type: 'object' },
            },
          ],
        }),
      ).toThrow('outside accepted configuration');
    } finally {
      await session.close();
    }
  });

  it('sends raw provider events with history and response ownership', async () => {
    const frames: Record<string, any>[] = [];
    const message = {
      id: 'raw-input',
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Original' }],
    };
    const session: PortableVoiceSession = new PortableVoiceSession(
      control(),
      {
        send(frame) {
          const event = JSON.parse(frame);
          frames.push(event);
          queueMicrotask(() => {
            switch (event.type) {
              case 'session.update':
                session.receive({
                  type: 'session.updated',
                  session: event.session,
                });
                break;
              case 'conversation.item.create':
                session.receive({
                  type: 'conversation.item.created',
                  item: event.item,
                  previous_item_id: event.previous_item_id,
                });
                break;
              case 'conversation.item.retrieve':
                session.receive(
                  event.item_id === message.id
                    ? { type: 'conversation.item.retrieved', item: message }
                    : {
                        type: 'error',
                        error: {
                          type: 'invalid_request_error',
                          event_id: event.event_id,
                        },
                      },
                );
                break;
              case 'conversation.item.delete':
                session.receive({
                  type: 'conversation.item.deleted',
                  item_id: event.item_id,
                });
                break;
            }
          });
        },
        close() {},
      },
      { model: 'test-realtime', instructions: 'Help.' },
    );
    try {
      await session.start();
      await expect(
        session.sendEvent({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: 'unowned',
            output: 'Bad.',
          },
        }),
      ).rejects.toThrow('conversation message');
      const input = { ...message, content: [{ ...message.content[0] }] };
      const create = session.sendEvent({
        type: 'conversation.item.create',
        event_id: 'create-input',
        previous_item_id: null,
        item: input,
      });
      input.content[0].text = 'Changed after admission';
      await create;
      expect(
        await session.sendEvent({
          type: 'conversation.item.retrieve',
          event_id: 'read-input',
          item_id: message.id,
        }),
      ).toEqual(message);
      await expect(
        session.sendEvent({
          type: 'conversation.item.retrieve',
          event_id: 'read-missing',
          item_id: 'missing',
        }),
      ).rejects.toThrow('history retrieval');
      await session.sendEvent({
        type: 'conversation.item.delete',
        event_id: 'delete-input',
        item_id: message.id,
      });
      await vi.waitFor(() => expect(session.history).toEqual([]));
      expect(frames.slice(1)).toEqual([
        {
          type: 'conversation.item.create',
          event_id: 'create-input',
          previous_item_id: null,
          item: message,
        },
        {
          type: 'conversation.item.retrieve',
          event_id: 'read-input',
          item_id: message.id,
        },
        {
          type: 'conversation.item.retrieve',
          event_id: 'read-missing',
          item_id: 'missing',
        },
        {
          type: 'conversation.item.delete',
          event_id: 'delete-input',
          item_id: message.id,
        },
      ]);
      await session.sendEvent({
        type: 'response.create',
        event_id: 'raw-response',
      });
      await session.sendEvent({
        type: 'response.cancel',
        event_id: 'raw-cancel',
      });
      session.receive({
        type: 'response.created',
        response: { id: 'response-raw' },
      });
      await vi.waitFor(() =>
        expect(frames.slice(-2)).toEqual([
          { type: 'response.create', event_id: 'raw-response' },
          {
            type: 'response.cancel',
            event_id: 'raw-cancel',
            response_id: 'response-raw',
          },
        ]),
      );
    } finally {
      await session.close();
    }
  });

  it.each([
    { response: undefined, vadFirst: false, cancelled: false, late: false },
    { response: undefined, vadFirst: true, cancelled: false, late: false },
    { response: {}, vadFirst: false, cancelled: false, late: false },
    { response: {}, vadFirst: true, cancelled: false, late: false },
    { response: undefined, vadFirst: true, cancelled: true, late: false },
    { response: {}, vadFirst: true, cancelled: false, late: true },
    { response: undefined, vadFirst: true, cancelled: true, late: true },
    {
      response: {},
      vadFirst: true,
      cancelled: true,
      late: true,
      cancelAfterDone: true,
    },
    {
      response: {},
      vadFirst: true,
      cancelled: false,
      late: true,
      superseded: true,
    },
  ])(
    'settles a raw default create with response=$response, vadFirst=$vadFirst, cancelled=$cancelled, late=$late, cancelAfterDone=$cancelAfterDone, superseded=$superseded',
    async ({
      response,
      vadFirst,
      cancelled,
      late,
      cancelAfterDone,
      superseded,
    }) => {
      const frames: Record<string, unknown>[] = [];
      const onEvent = vi.fn();
      const onError = vi.fn();
      const session: PortableVoiceSession = new PortableVoiceSession(
        control(),
        {
          send(frame) {
            const event = JSON.parse(frame);
            frames.push(event);
            if (event.type === 'session.update') {
              queueMicrotask(() =>
                session.receive({
                  type: 'session.updated',
                  session: event.session,
                }),
              );
            }
          },
          close() {},
        },
        { model: 'test-realtime', instructions: 'Help.', onEvent, onError },
      );
      const creates = () =>
        frames.filter((frame) => frame.type === 'response.create');
      const event = {
        type: 'response.create',
        event_id: 'raw-race',
        ...(response === undefined ? {} : { response }),
      };
      const next = { type: 'response.create', event_id: 'next-request' };
      const created = {
        type: 'response.created',
        response: { id: 'vad-response' },
      };
      const rejection = {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: 'conversation_already_has_active_response',
          event_id: 'raw-race',
        },
      };
      try {
        await session.start();
        await session.sendEvent(event);
        await vi.waitFor(() => expect(creates()).toEqual([event]));
        if (vadFirst) {
          session.receive(created);
          await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith(created));
        }
        if (cancelled && !cancelAfterDone) {
          await session.sendEvent({ type: 'response.cancel' });
          await vi.waitFor(() =>
            expect(frames).toContainEqual(
              expect.objectContaining({
                type: 'response.cancel',
                response_id: 'vad-response',
              }),
            ),
          );
        }
        if (superseded) {
          await session.sendEvent(next);
          expect(creates()).toEqual([event]);
        }
        const done = {
          type: 'response.done',
          response: {
            id: 'vad-response',
            status: cancelled && !cancelAfterDone ? 'cancelled' : 'completed',
            output: [],
          },
        };
        if (late) {
          session.receive(done);
          await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith(done));
        }
        if (cancelAfterDone) {
          await session.sendEvent({ type: 'response.cancel' });
        }
        session.receive(rejection);
        if (!vadFirst) session.receive(created);
        await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith(rejection));
        if (!late) {
          expect(creates()).toEqual([event]);
          session.receive(done);
          await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith(done));
        }
        expect(onError).not.toHaveBeenCalled();
        if (superseded) {
          await vi.waitFor(() => expect(creates()).toEqual([event, next]));
          session.receive({
            ...rejection,
            error: { ...rejection.error, event_id: 'unknown-request' },
          });
          await vi.waitFor(() =>
            expect(onError).toHaveBeenCalledWith(
              expect.objectContaining({
                message: 'Realtime provider rejected the operation',
              }),
            ),
          );
        } else if (cancelled) {
          expect(creates()).toEqual([event]);
          await session.sendEvent(next);
          await vi.waitFor(() => expect(creates()).toEqual([event, next]));
        } else {
          await vi.waitFor(() => expect(creates()).toEqual([event, event]));
          const retried = {
            ...done,
            response: { ...done.response, id: 'retried-response' },
          };
          session.receive({
            type: 'response.created',
            response: { id: 'retried-response' },
          });
          session.receive(retried);
          await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith(retried));
          expect(onError).not.toHaveBeenCalled();
        }
      } finally {
        await session.close();
      }
    },
  );

  it('serializes raw settings updates and keeps the accepted profile after a rejection', async () => {
    const frames: Record<string, any>[] = [];
    const source = agent();
    const enabledTool = vi.fn(() => true);
    const session: PortableVoiceSession = new PortableVoiceSession(
      control(),
      {
        send(frame) {
          const event = JSON.parse(frame);
          frames.push(event);
          if (event.type !== 'session.update') return;
          queueMicrotask(() =>
            session.receive(
              event.event_id === 'rejected'
                ? {
                    type: 'error',
                    error: {
                      type: 'invalid_request_error',
                      event_id: event.event_id,
                    },
                  }
                : { type: 'session.updated', session: event.session },
            ),
          );
        },
        close() {},
      },
      {
        ...source.options,
        tools: [{ ...source.options.tools[0], isEnabled: enabledTool }],
        settings: {
          audio: { input: { format: { type: 'audio/pcm', rate: 24000 } } },
        },
      },
    );
    try {
      await session.start();
      const first = session.sendEvent({
        type: 'session.update',
        event_id: 'rejected',
        session: { instructions: 'Provider rejected this.' },
      });
      const next = session.sendEvent({
        type: 'session.update',
        event_id: 'accepted',
        session: {
          audio: {
            input: { transcription: { model: 'gpt-4o-mini-transcribe' } },
          },
        },
      });
      await expect(first).rejects.toThrow('settings update');
      await expect(next).resolves.toBeNull();
      expect(enabledTool).toHaveBeenCalledTimes(1);
      expect(frames[2]).toMatchObject({
        type: 'session.update',
        event_id: 'accepted',
        session: {
          instructions: 'Help.',
          tools: frames[0].session.tools,
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              transcription: { model: 'gpt-4o-mini-transcribe' },
            },
          },
        },
      });
    } finally {
      await session.close();
    }
  });

  it.each([
    'dispatch',
    'arguments',
    'needsApproval',
    'approval',
    'before',
  ] as const)(
    'rechecks live tool enablement after %s before portable execution',
    async (phase) => {
      const state = { enabled: true };
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const hold = async () => {
        entered.resolve();
        await release.promise;
      };
      const execute = vi.fn(() => 'accepted');
      const frames: any[] = [];
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
          context: state,
          tools: [
            {
              name: 'lookup',
              description: 'Look up a value.',
              parameters: { type: 'object' },
              isEnabled(context) {
                expect(context.context).toBe(state);
                return state.enabled;
              },
              async parseArguments(value) {
                if (phase === 'arguments') await hold();
                return value as Record<string, unknown>;
              },
              needsApproval:
                phase === 'needsApproval'
                  ? async () => {
                      await hold();
                      return true;
                    }
                  : phase === 'approval',
              before:
                phase === 'before'
                  ? async () => {
                      await hold();
                      return { action: 'allow' as const };
                    }
                  : undefined,
              execute,
            },
          ],
          async onApproval() {
            if (phase === 'approval') await hold();
            return true;
          },
        },
      );
      try {
        await session.start();
        if (phase === 'dispatch') state.enabled = false;
        for (const event of fixtureEvents({ tools: [] }).slice(1))
          session.receive(event);
        if (phase !== 'dispatch') {
          await entered.promise;
          state.enabled = false;
          release.resolve();
        }
        await vi.waitFor(() =>
          expect(
            frames.find((event) => event.item?.call_id === item.call_id),
          ).toBeDefined(),
        );
        expect(execute).not.toHaveBeenCalled();
        expect(
          frames.find((event) => event.item?.call_id === item.call_id).item,
        ).toMatchObject({ type: 'function_call_output' });
        await vi.waitFor(() =>
          expect(
            frames.filter((event) => event.type === 'response.create'),
          ).toHaveLength(1),
        );
        state.enabled = true;
        const next = { ...item, id: 'item-2', call_id: 'call-2' };
        session.receive({
          type: 'response.created',
          response: { id: 'response-2' },
        });
        session.receive({
          type: 'response.done',
          response: { id: 'response-2', status: 'completed', output: [next] },
        });
        await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      } finally {
        release.resolve();
        await session.close();
      }
    },
  );

  it('does not suspend an admitted tool when no before policy is installed', async () => {
    let enabled = true;
    let revokeAfterAdmission = false;
    const frames: any[] = [];
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
        tools: [
          {
            name: 'lookup',
            description: 'Lookup.',
            parameters: { type: 'object' },
            isEnabled() {
              if (revokeAfterAdmission) {
                revokeAfterAdmission = false;
                // Admission may await this callback; a missing policy must not add another yield.
                queueMicrotask(() =>
                  queueMicrotask(() => {
                    enabled = false;
                  }),
                );
              }
              return enabled;
            },
            execute: () => (enabled ? 'accepted' : 'executed after revocation'),
          },
        ],
      },
    );
    try {
      await session.start();
      revokeAfterAdmission = true;
      for (const event of fixtureEvents({ tools: [] }).slice(1))
        session.receive(event);
      await vi.waitFor(() =>
        expect(
          frames.find((event) => event.item?.call_id === item.call_id)?.item
            .output,
        ).toBe('accepted'),
      );
      expect(enabled).toBe(false);
    } finally {
      await session.close();
    }
  });

  it('keeps accepted tool and handoff callbacks during settings-only updates', async () => {
    const source = agent();
    const originalHandoff = vi.fn();
    const changedHandoff = vi.fn();
    const changedExecute = vi.fn(
      async (_args: Record<string, unknown>) => 'changed',
    );
    const changedApproval = vi.fn(async () => false);
    const target = { model: 'test-realtime', instructions: 'Transferred.' };
    const handoff = {
      name: 'transfer',
      description: 'Transfer.',
      agent: target,
      onHandoff: originalHandoff,
    };
    const options = { ...source.options, handoffs: [handoff] };
    const frames: any[] = [];
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
      options,
    );
    try {
      await session.start();
      options.tools[0].execute = changedExecute;
      options.onApproval = changedApproval;
      handoff.onHandoff = changedHandoff;
      handoff.agent = {
        model: 'test-realtime',
        instructions: 'Changed target.',
      };
      await session.sendEvent({
        type: 'session.update',
        session: { instructions: 'Revised.' },
      });
      for (const event of fixtureEvents({ tools: [] }).slice(1))
        session.receive(event);
      await vi.waitFor(() =>
        expect(
          frames.find((event) => event.item?.call_id === 'call-1')?.item.output,
        ).toBe('7'),
      );
      expect(source.execute).toHaveBeenCalledOnce();
      expect(source.onApproval).toHaveBeenCalledOnce();
      expect(changedExecute).not.toHaveBeenCalled();
      expect(changedApproval).not.toHaveBeenCalled();
      const transfer = {
        ...item,
        id: 'item-2',
        call_id: 'call-2',
        name: 'transfer',
        arguments: '{}',
      };
      session.receive({
        type: 'response.created',
        response: { id: 'response-2' },
      });
      session.receive({
        type: 'response.done',
        response: { id: 'response-2', status: 'completed', output: [transfer] },
      });
      await vi.waitFor(() =>
        expect(
          frames.find((event) => event.item?.call_id === 'call-2'),
        ).toBeDefined(),
      );
      expect(originalHandoff).toHaveBeenCalledOnce();
      expect(changedHandoff).not.toHaveBeenCalled();
      expect(
        frames.filter((event) => event.type === 'session.update').at(-1).session
          .instructions,
      ).toBe('Transferred.');
    } finally {
      await session.close();
    }
  });

  it('reuses accepted raw tool_choice in a subsequent agent update', async () => {
    const frames: any[] = [];
    const source = agent();
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
      source.options,
    );
    try {
      await session.start();
      await session.sendEvent({
        type: 'session.update',
        session: { tool_choice: 'none' },
      });
      // Reading the accepted options exercises the same captured profile reused by raw updates.
      await session.updateAgent({
        ...(session as any).options,
        instructions: 'Updated.',
      });
      expect(
        frames.filter((event) => event.type === 'session.update').at(-1)
          .session,
      ).toMatchObject({
        tool_choice: 'none',
        instructions: 'Updated.',
        tools: frames[0].session.tools,
      });
      await session.sendEvent({
        type: 'session.update',
        session: { tool_choice: 'auto' },
      });
      for (const event of fixtureEvents({ tools: [] }).slice(1))
        session.receive(event);
      await vi.waitFor(() => expect(source.execute).toHaveBeenCalledOnce());
    } finally {
      await session.close();
    }
  });

  it('discards a late portable tool allowance after close', async () => {
    const definition = agent();
    const entered = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    let hold = false;
    const frames: any[] = [];
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
        tools: [
          {
            ...definition.options.tools[0],
            async isEnabled(context) {
              if (hold) {
                entered.resolve(context.signal);
                await release.promise;
              }
              return true;
            },
          },
        ],
      },
    );
    try {
      await session.start();
      hold = true;
      for (const event of fixtureEvents({ tools: [] }).slice(1))
        session.receive(event);
      const signal = await entered.promise;
      const closing = session.close();
      expect(signal.aborted).toBe(true);
      release.resolve();
      await closing;
      expect(definition.execute).not.toHaveBeenCalled();
      expect(frames.map((event) => event.type)).toEqual(['session.update']);
    } finally {
      release.resolve();
      await session.close();
    }
  });

  it('counts provider usage once per response and retains it after close', async () => {
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
      { model: 'test-realtime', instructions: 'Help.' },
    );
    await session.start();
    expect(session.usage).toBeUndefined();
    expect(session.usageAccounting).toEqual({
      finishedResponses: 0,
      usageReports: 0,
    });
    vi.stubGlobal('structuredClone', undefined);
    for (const [id, usage] of [
      ['first', { input_tokens: 4, input_token_details: { audio_tokens: 2 } }],
      ['second', { input_tokens: 4, input_token_details: { audio_tokens: 2 } }],
      ['missing', undefined],
    ] as const) {
      session.receive({ type: 'response.created', response: { id } });
      const done = {
        type: 'response.done',
        response: {
          id,
          status: 'completed',
          output: [],
          ...(usage === undefined ? {} : { usage }),
        },
      };
      session.receive(done);
      session.receive(done);
    }
    session.receive({
      type: 'response.created',
      response: { id: 'cancelled' },
    });
    session.receive({ type: 'input_audio_buffer.speech_started' });
    const cancelled = {
      type: 'response.done',
      response: {
        id: 'cancelled',
        status: 'cancelled',
        output: [],
        usage: { input_tokens: 2 },
      },
    };
    session.receive(cancelled);
    session.receive(cancelled);
    await session.close();
    expect(session.usage).toEqual({
      input_tokens: 10,
      input_token_details: { audio_tokens: 4 },
    });
    expect(session.usageAccounting).toEqual({
      finishedResponses: 4,
      usageReports: 3,
    });
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
      expect.objectContaining({ callId: 'call-1', history: [item] }),
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
    'never invokes a callback from a %s provider response',
    async (status) => {
      const definition = agent();
      const close = vi.fn();
      const onError = vi.fn();
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
                  type: 'response.done',
                  response: { id: 'response-1', status, output: [item] },
                });
              });
          },
          close,
        },
        { ...definition.options, onError },
      );
      await expect(session.start()).rejects.toThrow(
        'Incomplete Realtime response cannot admit functions',
      );
      await session.close();
      expect(close).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Incomplete Realtime response cannot admit functions',
        }),
      );
      expect(definition.onApproval).not.toHaveBeenCalled();
      expect(definition.execute).not.toHaveBeenCalled();
    },
  );

  it.each(['response.cancelled', 'input_audio_buffer.speech_started'])(
    'aborts and joins callback work after %s without publishing its late result',
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
    { label: 'speech', event: { type: 'input_audio_buffer.speech_started' } },
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
