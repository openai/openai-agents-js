import { expect, it, vi } from 'vitest';
import { Agent, NativeProvider, type NativeRealtimeSession } from '../src';
import type { Session as CoreSession } from '../src/runtime/session';
import type { NativeRealtimeAdapter } from '../src/runtime/realtime-adapter';
import { ModelServer, message } from './native/fixtures/model-server';

// The adapter scripts provider frames; actual Session, binding and Core execute.
class Incoming {
  private readonly values: string[] = [];
  private waiting?: (value: IteratorResult<string>) => void;
  private ended = false;
  push(frame: object) {
    const value = JSON.stringify(frame);
    if (this.waiting) {
      const deliver = this.waiting;
      this.waiting = undefined;
      deliver({ done: false, value });
    } else this.values.push(value);
  }
  next(): Promise<IteratorResult<string>> {
    if (this.values.length)
      return Promise.resolve({ done: false, value: this.values.shift()! });
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
  async return(): Promise<IteratorResult<string>> {
    this.ended = true;
    this.waiting?.({ done: true, value: undefined });
    this.waiting = undefined;
    return { done: true, value: undefined };
  }
  [Symbol.asyncIterator]() {
    return this;
  }
}
function merge(current: Record<string, any>, update: Record<string, any>) {
  for (const [key, value] of Object.entries(update)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current[key] &&
      typeof current[key] === 'object' &&
      !Array.isArray(current[key])
    )
      merge(current[key], value);
    else current[key] = structuredClone(value);
  }
}
async function providerFor(model: ModelServer) {
  const config = await model.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-reentrancy',
    supportsWebsockets: false,
  });
}
const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');

nativeIt(
  'retries unpublished startup cleanup before opening a replacement owner',
  async () => {
    const model = new ModelServer([[message('usable after failed startup')]]);
    const retryEntered = Promise.withResolvers<void>();
    const releaseRetry = Promise.withResolvers<void>();
    let allowClose = false;
    try {
      await using provider = await providerFor(model);
      const agent = new Agent({
        instructions: 'Answer briefly.',
        model: 'gpt-5.5',
        provider,
      });
      await using session = await agent.session();
      const startupError = new Error('Synthetic startup send failure');
      const cleanupError = new Error('Synthetic startup cleanup failure');
      const incoming = new Incoming();
      let closed = false;
      const failedAdapter: NativeRealtimeAdapter = {
        async connect() {
          return {
            incoming,
            async send() {
              throw startupError;
            },
            async close() {
              if (!allowClose) throw cleanupError;
              retryEntered.resolve();
              await releaseRetry.promise;
              await incoming.return();
              closed = true;
            },
          };
        },
      };
      let replacementConnections = 0;
      const replacement: NativeRealtimeAdapter = {
        async connect(context) {
          expect(closed).toBe(true);
          replacementConnections++;
          const frames = new Incoming();
          const accepted: Record<string, any> = { model: context.model };
          return {
            incoming: frames,
            async send(raw) {
              const frame = JSON.parse(raw);
              if (frame.type === 'session.update') {
                merge(accepted, frame.session);
                frames.push({
                  type: 'session.updated',
                  session: { ...structuredClone(accepted), id: 'replacement' },
                });
              }
            },
            async close() {
              await frames.return();
            },
          };
        },
      };
      try {
        const failure = await session
          .realtime({ model: 'gpt-realtime', adapter: failedAdapter })
          .catch((error) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure.errors).toEqual([startupError, cleanupError]);
        expect(failure.cause).toBe(startupError);
        // A failed recovery must not detach the old connection or start another.
        await expect(
          session.realtime({ model: 'gpt-realtime', adapter: replacement }),
        ).rejects.toBe(cleanupError);
        expect(replacementConnections).toBe(0);
        expect(closed).toBe(false);
        allowClose = true;
        const opening = session.realtime({
          model: 'gpt-realtime',
          adapter: replacement,
        });
        await retryEntered.promise;
        expect(replacementConnections).toBe(0);
        releaseRetry.resolve();
        const voice = await opening;
        expect(replacementConnections).toBe(1);
        await voice.close();
        const turn = await session.submit('Check caller ownership.');
        expect((await turn.wait()).finalOutput).toBe(
          'usable after failed startup',
        );
      } finally {
        allowClose = true;
        releaseRetry.resolve();
      }
    } finally {
      await ModelServer.closeAll();
    }
  },
  20000,
);

nativeIt(
  'rejects adapter connect awaiting its owning Session.close before mutation',
  async () => {
    const model = new ModelServer([[message('usable after blocked connect')]]);
    try {
      await using provider = await providerFor(model);
      const agent = new Agent({
        instructions: 'Answer briefly.',
        model: 'gpt-5.5',
        provider,
      });
      await using session = await agent.session();
      let original: unknown;
      let entered = 0;
      const adapter: NativeRealtimeAdapter = {
        async connect() {
          entered++;
          try {
            await session.close();
          } catch (error) {
            original = error;
            throw error;
          }
          throw new Error('Reentrant close was unexpectedly admitted');
        },
      };
      const failure = await session
        .realtime({ model: 'gpt-realtime', adapter })
        .catch((error) => error);
      expect(entered).toBe(1);
      expect(original).toBeInstanceOf(Error);
      expect(failure).toBe(original);
      expect(await session.getActiveAgent()).toBe(agent);
      const turn = await session.submit('Check caller ownership.');
      expect((await turn.wait()).finalOutput).toBe(
        'usable after blocked connect',
      );
      await session.close();
    } finally {
      await ModelServer.closeAll();
    }
  },
  20000,
);

nativeIt(
  'rejects adapter close awaiting its owning Session.close and permits exact cleanup retry',
  async () => {
    const model = new ModelServer([[message('usable after blocked close')]]);
    try {
      await using provider = await providerFor(model);
      const agent = new Agent({
        instructions: 'Answer briefly.',
        model: 'gpt-5.5',
        provider,
      });
      await using session = await agent.session();
      const incoming = new Incoming();
      const accepted: Record<string, any> = {};
      let attempts = 0;
      let original: unknown;
      const adapter: NativeRealtimeAdapter = {
        async connect(context) {
          accepted.model = context.model;
          return {
            incoming,
            async send(raw) {
              const frame = JSON.parse(raw);
              if (frame.type === 'session.update') {
                merge(accepted, frame.session);
                incoming.push({
                  type: 'session.updated',
                  session: {
                    ...structuredClone(accepted),
                    id: 'guarded-session',
                  },
                });
              } else if (frame.type === 'response.create') {
                incoming.push({
                  type: 'response.created',
                  response: { id: 'empty-response' },
                });
                incoming.push({
                  type: 'response.done',
                  response: { id: 'empty-response', output: [] },
                });
              }
            },
            async close() {
              attempts++;
              if (attempts === 1) {
                try {
                  await session.close();
                } catch (error) {
                  original = error;
                  throw error;
                }
                throw new Error('Reentrant close was unexpectedly admitted');
              }
              await incoming.return();
            },
          };
        },
      };
      const voice = await session.realtime({ model: 'gpt-realtime', adapter });
      const failure = await voice.close().catch((error) => error);
      expect(original).toBeInstanceOf(Error);
      expect(failure).toBe(original);
      await voice.close();
      expect(attempts).toBe(2);
      expect(await session.getActiveAgent()).toBe(agent);
      const turn = await session.submit('Check caller ownership.');
      expect((await turn.wait()).finalOutput).toBe(
        'usable after blocked close',
      );
      await session.close();
    } finally {
      await ModelServer.closeAll();
    }
  },
  20000,
);

nativeIt.each(['update', 'approval'] as const)(
  'rejects adapter %s self-I/O before publication and keeps issued approval retryable',
  async (operation) => {
    const model = new ModelServer([[message('usable after adapter controls')]]);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Listen.',
        provider,
      }).session();
      const incoming = new Incoming();
      const accepted: Record<string, any> = {};
      const frames: Record<string, any>[] = [];
      const errors: unknown[] = [];
      const rejected = Promise.withResolvers<void>();
      const nestedText = Promise.withResolvers<void>();
      let request: import('../src/runtime/realtime').NativeRealtimeHostedMcpApprovalRequest;
      const control = () =>
        operation === 'update'
          ? voice.update({ instructions: 'Nested must not publish' })
          : voice.approveHostedMcp(request, { approve: true });
      const adapter: NativeRealtimeAdapter = {
        async connect(context) {
          accepted.model = context.model;
          return {
            incoming,
            async send(raw) {
              const frame = JSON.parse(raw);
              frames.push(frame);
              if (frame.type === 'session.update') {
                merge(accepted, frame.session);
                incoming.push({
                  type: 'session.updated',
                  session: {
                    ...structuredClone(accepted),
                    id: 'adapter-controls',
                  },
                });
              } else if (frame.item?.type === 'message') {
                const text = frame.item.content[0].text;
                if (text === 'nested admission') nestedText.resolve();
                else if (text === 'outer') {
                  await voice.sendText('nested admission');
                  try {
                    // The copied inner scope is inactive before control runs;
                    // its still-active adapter ancestor must remain authoritative.
                    const proceed = Promise.withResolvers<void>();
                    let pending!: Promise<void>;
                    await (
                      session as CoreSession<string, undefined>
                    )._runVoiceCallback(() => {
                      pending = proceed.promise.then(control);
                    });
                    proceed.resolve();
                    await pending;
                  } catch (error) {
                    errors.push(error);
                  }
                  rejected.resolve();
                }
              }
            },
            async close() {
              await incoming.return();
            },
          };
        },
      };
      const voice = await session.realtime({
        model: 'fixture-realtime',
        adapter,
        settings: {
          hostedMcpTools: [
            {
              serverLabel: 'docs',
              serverUrl: 'https://mcp.example.test/server',
              allowedTools: ['search'],
              requireApproval: 'always',
            },
          ],
        },
      });
      const events = voice.events();
      try {
        const item = {
          type: 'mcp_approval_request',
          id: 'approval-item',
          server_label: 'docs',
          name: 'search',
          arguments: '{}',
        };
        incoming.push({
          type: 'response.created',
          response: { id: 'hosted-response' },
        });
        incoming.push({
          type: 'response.output_item.added',
          response_id: 'hosted-response',
          output_index: 0,
          item,
        });
        incoming.push({ type: 'conversation.item.done', item });
        incoming.push({
          type: 'response.done',
          response: { id: 'hosted-response', output: [item] },
        });
        for (;;) {
          const result = await events.next();
          if (result.done) throw new Error('Approval event stream ended');
          const event = result.value;
          if (event?.type === 'hosted_mcp_approval_requested') {
            request = event;
            break;
          }
        }
        await voice.sendText('outer');
        await vi.waitFor(() => expect(errors).toHaveLength(1), {
          timeout: 2000,
        });
        await rejected.promise;
        expect(String(errors[0])).toContain('Realtime adapter callback cannot');
        await nestedText.promise;
        expect(
          frames.filter((frame) => frame.type === 'session.update'),
        ).toHaveLength(1);
        expect(
          frames.some((frame) => frame.item?.type === 'mcp_approval_response'),
        ).toBe(false);
        await (session as CoreSession<string, undefined>)._runVoiceCallback(
          async () => {
            await voice.update({ instructions: 'Ordinary callback update' });
            await voice.approveHostedMcp(request, { approve: true });
          },
        );
        expect(
          frames.filter((frame) => frame.type === 'session.update'),
        ).toHaveLength(2);
        expect(
          frames.filter(
            (frame) => frame.item?.type === 'mcp_approval_response',
          ),
        ).toHaveLength(1);
      } finally {
        await voice.close();
        await events.return(undefined);
      }
      expect(
        (await (await session.submit('Verify caller reuse.')).wait())
          .finalOutput,
      ).toBe('usable after adapter controls');
      model.assertExhausted();
    } finally {
      await ModelServer.closeAll();
    }
  },
  20000,
);

nativeIt.each(['session-close', 'voice-close', 'voice-interrupt'] as const)(
  'rejects nested adapter %s against an active ancestor before mutation',
  async (operation) => {
    const model = new ModelServer([[message('usable after nested adapter')]]);
    const nestedStop = new AbortController();
    const releaseRead = Promise.withResolvers<void>();
    const releaseControl = Promise.withResolvers<void>();
    let nestedOpening: Promise<unknown> | undefined;
    let delayedRead: Promise<unknown> | undefined;
    try {
      await using provider = await providerFor(model);
      const agent = new Agent({
        instructions: 'A',
        model: 'gpt-5.5',
        provider,
      });
      await using a = await agent.session();
      await using b = await new Agent({
        instructions: 'B',
        provider,
      }).session();
      await using unrelated = await new Agent({
        instructions: 'C',
        provider,
      }).session();
      const incoming = new Incoming();
      const accepted: Record<string, any> = {};
      let rejected: unknown;
      let unrelatedClosed = false;
      let callbackFinished = false;
      const adapter: NativeRealtimeAdapter = {
        async connect(context) {
          accepted.model = context.model;
          return {
            incoming,
            async send(raw) {
              const frame = JSON.parse(raw);
              if (frame.type === 'session.update') {
                merge(accepted, frame.session);
                incoming.push({
                  type: 'session.updated',
                  session: {
                    ...structuredClone(accepted),
                    id: 'nested-adapter',
                  },
                });
              } else if (frame.type === 'response.create') {
                incoming.push({
                  type: 'response.created',
                  response: { id: 'empty-response' },
                });
                incoming.push({
                  type: 'response.done',
                  response: { id: 'empty-response', output: [] },
                });
              } else if (frame.item?.content?.[0]?.text === 'outer') {
                nestedOpening = b.realtime({
                  model: 'fixture-realtime',
                  signal: nestedStop.signal,
                  adapter: {
                    async connect(nestedContext) {
                      // Neither active ancestor owns C. A blanket callback ban is wrong.
                      await unrelated.close();
                      unrelatedClosed = true;
                      // This task keeps B -> A scopes but runs after both retire.
                      delayedRead = releaseRead.promise.then(() =>
                        a.getActiveAgent(),
                      );
                      void delayedRead.catch(() => {});
                      const cancelled = Promise.withResolvers<never>();
                      void cancelled.promise.catch(() => {});
                      const abort = () =>
                        cancelled.reject(new Error('Nested adapter cleanup'));
                      nestedContext.signal.addEventListener('abort', abort, {
                        once: true,
                      });
                      if (nestedContext.signal.aborted) abort();
                      try {
                        // Cancellation releases the old broken cycle during teardown.
                        // The expected fix rejects synchronously before changing A.
                        const controlling =
                          operation === 'session-close'
                            ? a.close()
                            : operation === 'voice-close'
                              ? voice.close()
                              : voice.interrupt();
                        await Promise.race([
                          controlling,
                          cancelled.promise,
                          releaseControl.promise,
                        ]);
                        throw new Error(
                          'Ancestor lifecycle operation was unexpectedly admitted',
                        );
                      } catch (error) {
                        rejected = error;
                        throw error;
                      } finally {
                        nestedContext.signal.removeEventListener(
                          'abort',
                          abort,
                        );
                      }
                    },
                  },
                });
                await nestedOpening.catch(() => {});
                callbackFinished = true;
              }
            },
            async close() {
              await incoming.return();
            },
          };
        },
      };
      const voice = await a.realtime({ model: 'fixture-realtime', adapter });
      try {
        await voice.sendText('outer');
        await vi.waitFor(() => expect(callbackFinished).toBe(true), {
          timeout: 2000,
        });
        expect(unrelatedClosed).toBe(true);
        expect(String(rejected)).toContain('A tool callback cannot');
        // Its ACK proves A's physical send returned and retired the adapter scope.
        await voice.update({
          instructions: 'Still live after rejected nesting',
        });
        releaseRead.resolve();
        expect(await delayedRead).toBe(agent);
        await voice.close();
        expect(
          (await (await a.submit('Verify caller reuse.')).wait()).finalOutput,
        ).toBe('usable after nested adapter');
        model.assertExhausted();
      } finally {
        releaseControl.resolve();
        nestedStop.abort(new Error('Release nested adapter setup'));
        releaseRead.resolve();
        await Promise.allSettled([nestedOpening, delayedRead, voice.close()]);
      }
    } finally {
      nestedStop.abort();
      releaseRead.resolve();
      await ModelServer.closeAll();
    }
  },
  20000,
);

nativeIt(
  'retains ordinary nested text but rejects self-adapter input while committed audio is pending',
  async () => {
    const model = new ModelServer([]);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Listen.',
        provider,
      }).session();
      const incoming = new Incoming();
      const accepted: Record<string, any> = {};
      const frames: Record<string, any>[] = [];
      const held = Promise.withResolvers<void>();
      const proceed = Promise.withResolvers<void>();
      const ordinary: string[] = [];
      const blocked: string[] = [];
      const rejectOwn = async (
        phase: string,
        operation: () => Promise<void>,
      ) => {
        let rejection: unknown;
        void operation().catch((error: unknown) => {
          rejection = error;
        });
        await vi.waitFor(
          () =>
            expect(String(rejection)).toContain(
              'Realtime adapter callback cannot',
            ),
          { timeout: 2000 },
        );
        blocked.push(phase);
      };
      const adapter: NativeRealtimeAdapter = {
        async connect(context) {
          accepted.model = context.model;
          return {
            incoming,
            async send(raw) {
              const frame = JSON.parse(raw);
              frames.push(frame);
              if (frame.type === 'session.update') {
                merge(accepted, frame.session);
                incoming.push({
                  type: 'session.updated',
                  session: {
                    ...structuredClone(accepted),
                    id: 'committed-adapter',
                  },
                });
              } else if (frame.type === 'conversation.item.create') {
                const text = frame.item?.content?.[0]?.text;
                if (text === 'ordinary before' || text === 'ordinary after')
                  await voice.sendText(`nested ${text}`);
                else if (text?.startsWith('nested ordinary'))
                  ordinary.push(text);
                else if (text === 'held outer') {
                  held.resolve();
                  await proceed.promise;
                  await rejectOwn('queued-before-active', () =>
                    voice.sendText('blocked queued text'),
                  );
                }
              } else if (frame.type === 'input_audio_buffer.append') {
                await rejectOwn('append', () =>
                  voice.sendText('blocked append text'),
                );
              } else if (frame.type === 'input_audio_buffer.commit') {
                await rejectOwn('commit-input', () =>
                  voice.sendText('blocked commit text'),
                );
                await rejectOwn('commit-control', () =>
                  voice.sendAudio(new Int16Array(), { commit: true }),
                );
                await rejectOwn('delete-control', () =>
                  voice.deleteConversationItem('not-admitted'),
                );
              }
            },
            async close() {
              proceed.resolve();
              await incoming.return();
            },
          };
        },
      };
      const voice: NativeRealtimeSession = await session.realtime({
        model: 'fixture-realtime',
        adapter,
      });
      try {
        await voice.sendText('ordinary before');
        await vi.waitFor(() => expect(ordinary).toHaveLength(1));
        const outer = voice.sendText('held outer');
        await held.promise;
        const bulk = voice.sendAudio(new Int16Array(40000), { commit: true });
        void bulk.catch(() => {});
        proceed.resolve();
        await Promise.all([outer, bulk]);
        expect(blocked).toEqual([
          'queued-before-active',
          'append',
          'append',
          'commit-input',
          'commit-control',
          'delete-control',
        ]);
        expect(
          frames.filter((frame) => frame.type === 'input_audio_buffer.commit'),
        ).toHaveLength(1);
        expect(
          frames.some((frame) => frame.type === 'conversation.item.delete'),
        ).toBe(false);
        expect(
          frames.some((frame) =>
            frame.item?.content?.[0]?.text?.startsWith('blocked'),
          ),
        ).toBe(false);
        await voice.sendText('ordinary after');
        await vi.waitFor(() => expect(ordinary).toHaveLength(2));
        expect(model.requests).toEqual([]);
      } finally {
        proceed.resolve();
        await voice.close();
      }
    } finally {
      await ModelServer.closeAll();
    }
  },
  20000,
);
