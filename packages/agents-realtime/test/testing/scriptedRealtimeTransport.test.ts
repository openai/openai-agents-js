import { describe, expect, it, vi } from 'vitest';
import { RealtimeAgent } from '../../src/realtimeAgent';
import { RealtimeSession } from '../../src/realtimeSession';
import {
  IncompleteRealtimeScenarioError,
  RealtimeCallMatcherError,
  RealtimeTransportNotClosedError,
  ScriptedRealtimeScenarioCancelledError,
  ScriptedRealtimeTransport,
  UnexpectedRealtimeCallError,
  type RealtimeTransportCallFor,
  type ScriptedRealtimeScenarioContext,
} from '../../src/testing';

describe('ScriptedRealtimeTransport', () => {
  it('drives a session with ordered calls and typed events', async () => {
    const transport = new ScriptedRealtimeTransport();
    const outputDeltas: string[] = [];
    transport.on('output_text_delta', (event) => {
      outputDeltas.push(event.delta);
    });
    const session = new RealtimeSession(
      new RealtimeAgent({ name: 'Assistant' }),
      { transport },
    );

    await transport.runScenario({
      scenario: async ({ expectCall, emit }) => {
        await expectCall('connect', (call) => {
          expect(call.options.apiKeyProvided).toBe(true);
          expect(call.options).not.toHaveProperty('apiKey');
          expect(call.options.initialSessionConfig).toBeDefined();
        });
        await expectCall('sendMessage', (call) => {
          expect(call.message).toBe('Hello');
          expect(call.otherEventData).toEqual({ source: 'test' });
        });
        emit('turn_started', {
          type: 'response_started',
          providerData: { response: { id: 'response_1' } },
        });
        emit('output_text_delta', {
          type: 'output_text_delta',
          responseId: 'response_1',
          itemId: 'item_1',
          delta: 'Hi',
        });
        await expectCall('close');
      },
      exercise: async () => {
        await session.connect({ apiKey: 'test' });
        session.sendMessage('Hello', { source: 'test' });
        session.close();
      },
    });

    expect(outputDeltas).toEqual(['Hi']);
    expect(transport.calls.map((call) => call.method)).toEqual([
      'connect',
      'sendMessage',
      'close',
    ]);
    expect(() => transport.assertComplete()).not.toThrow();
    expect(() => transport.assertClosed()).not.toThrow();
  });

  it('matches calls that occurred before the expectation was registered', async () => {
    const transport = new ScriptedRealtimeTransport();
    transport.sendEvent({ type: 'session.update', session: {} });

    const call = await transport.expectCall('sendEvent');

    expect(call).toMatchObject({
      index: 0,
      event: { type: 'session.update' },
    });
    expect(() => transport.assertComplete()).not.toThrow();
  });

  it('rejects an unexpected call without a time-based wait', async () => {
    const transport = new ScriptedRealtimeTransport();
    await expect(
      transport.runScenario({
        scenario: async ({ expectCall }) => {
          await expectCall('sendMessage');
        },
        exercise: () => {
          expect(() =>
            transport.sendAudio(new ArrayBuffer(1), { commit: true }),
          ).toThrow(UnexpectedRealtimeCallError);
        },
      }),
    ).rejects.toMatchObject({
      name: 'UnexpectedRealtimeCallError',
      callIndex: 0,
      expectedMethod: 'sendMessage',
      actualMethod: 'sendAudio',
    });
  });

  it('fails when a call matcher returns false', async () => {
    const transport = new ScriptedRealtimeTransport();
    await expect(
      transport.runScenario({
        scenario: async ({ expectCall }) => {
          await expectCall('mute', () => false);
        },
        exercise: () => {
          expect(() => transport.mute(true)).toThrow(RealtimeCallMatcherError);
        },
      }),
    ).rejects.toMatchObject({
      name: 'RealtimeCallMatcherError',
      callIndex: 0,
      actualMethod: 'mute',
    });
  });

  it('finishes with pending expectation details when the exercise completes', async () => {
    const transport = new ScriptedRealtimeTransport();

    await expect(
      transport.runScenario({
        scenario: async ({ expectCall }) => {
          await expectCall('sendMessage');
        },
        exercise: () => {},
      }),
    ).rejects.toMatchObject({
      name: 'IncompleteRealtimeScenarioError',
      pendingExpectations: [{ order: 1, method: 'sendMessage' }],
    });

    expect(() => transport.assertComplete()).not.toThrow();
  });

  it('settles an unawaited expectation when completion is incomplete', async () => {
    const transport = new ScriptedRealtimeTransport();
    let expectationFailure: Promise<unknown> | undefined;
    let runFailure: unknown;

    try {
      await transport.runScenario({
        scenario: ({ expectCall }) => {
          expectationFailure = expectCall('mute').catch((error) => error);
        },
        exercise: () => {},
      });
    } catch (error) {
      runFailure = error;
    }

    expect(runFailure).toBeInstanceOf(IncompleteRealtimeScenarioError);
    await expect(expectationFailure).resolves.toBe(runFailure);
    expect(() => transport.assertComplete()).not.toThrow();
  });

  it.each(['awaited', 'unawaited'] as const)(
    'rejects an %s expectation registered after exercise completion',
    async (handling) => {
      const transport = new ScriptedRealtimeTransport();
      let markScenarioWaiting!: () => void;
      let markExerciseCalled!: () => void;
      let releaseScenario!: () => void;
      const scenarioWaiting = new Promise<void>((resolve) => {
        markScenarioWaiting = resolve;
      });
      const exerciseCalled = new Promise<void>((resolve) => {
        markExerciseCalled = resolve;
      });
      const scenarioGate = new Promise<void>((resolve) => {
        releaseScenario = resolve;
      });
      const run = transport.runScenario({
        scenario: async ({ expectCall }) => {
          markScenarioWaiting();
          await scenarioGate;
          const expectation = expectCall('mute');
          if (handling === 'awaited') {
            await expectation;
          } else {
            void expectation.catch(() => {});
          }
        },
        exercise: () => {
          markExerciseCalled();
        },
      });

      await Promise.all([scenarioWaiting, exerciseCalled]);
      await Promise.resolve();
      releaseScenario();

      await expect(run).rejects.toMatchObject({
        name: 'IncompleteRealtimeScenarioError',
        pendingExpectations: [{ order: 1, method: 'mute' }],
      });
      expect(() => transport.assertComplete()).not.toThrow();
    },
  );

  it('rejects when a scenario catches a late expectation and stays pending', async () => {
    const transport = new ScriptedRealtimeTransport();
    let markScenarioWaiting!: () => void;
    let markExerciseCalled!: () => void;
    let releaseScenario!: () => void;
    let expectationFailure: unknown;
    const scenarioWaiting = new Promise<void>((resolve) => {
      markScenarioWaiting = resolve;
    });
    const exerciseCalled = new Promise<void>((resolve) => {
      markExerciseCalled = resolve;
    });
    const scenarioGate = new Promise<void>((resolve) => {
      releaseScenario = resolve;
    });
    const neverSettles = new Promise<void>(() => {});
    const run = transport.runScenario({
      scenario: async ({ expectCall }) => {
        markScenarioWaiting();
        await scenarioGate;
        await expectCall('mute').catch((error) => {
          expectationFailure = error;
        });
        await neverSettles;
      },
      exercise: () => {
        markExerciseCalled();
      },
    });

    await Promise.all([scenarioWaiting, exerciseCalled]);
    await Promise.resolve();
    releaseScenario();

    let runFailure: unknown;
    try {
      await run;
    } catch (error) {
      runFailure = error;
    }
    expect(runFailure).toBeInstanceOf(IncompleteRealtimeScenarioError);
    expect(expectationFailure).toBe(runFailure);
    expect(() => transport.assertComplete()).not.toThrow();
  });

  it('lets a late expectation consume a call recorded by the exercise', async () => {
    const transport = new ScriptedRealtimeTransport();
    let markScenarioWaiting!: () => void;
    let releaseScenario!: () => void;
    const scenarioWaiting = new Promise<void>((resolve) => {
      markScenarioWaiting = resolve;
    });
    const scenarioGate = new Promise<void>((resolve) => {
      releaseScenario = resolve;
    });
    const run = transport.runScenario({
      scenario: async ({ expectCall }) => {
        markScenarioWaiting();
        await scenarioGate;
        await expectCall('mute', (call) => {
          expect(call.muted).toBe(true);
        });
      },
      exercise: () => {
        transport.mute(true);
      },
    });

    await scenarioWaiting;
    await Promise.resolve();
    releaseScenario();

    await expect(run).resolves.toBeUndefined();
    expect(() => transport.assertComplete()).not.toThrow();
  });

  it.each([
    {
      name: 'wrong method',
      expectLateCall: (
        expectCall: ScriptedRealtimeScenarioContext['expectCall'],
      ) => expectCall('sendMessage'),
      errorName: 'UnexpectedRealtimeCallError',
    },
    {
      name: 'failing matcher',
      expectLateCall: (
        expectCall: ScriptedRealtimeScenarioContext['expectCall'],
      ) => expectCall('mute', () => false),
      errorName: 'RealtimeCallMatcherError',
    },
  ])(
    'rejects an unawaited late $name expectation after exercise completion',
    async ({ expectLateCall, errorName }) => {
      const transport = new ScriptedRealtimeTransport();
      let markScenarioWaiting!: () => void;
      let releaseScenario!: () => void;
      const scenarioWaiting = new Promise<void>((resolve) => {
        markScenarioWaiting = resolve;
      });
      const scenarioGate = new Promise<void>((resolve) => {
        releaseScenario = resolve;
      });
      const run = transport.runScenario({
        scenario: async ({ expectCall }) => {
          markScenarioWaiting();
          await scenarioGate;
          void expectLateCall(expectCall).catch(() => {});
        },
        exercise: () => {
          transport.mute(true);
        },
      });

      await scenarioWaiting;
      await Promise.resolve();
      releaseScenario();

      await expect(run).rejects.toMatchObject({ name: errorName });
      expect(() => transport.assertComplete()).not.toThrow();
    },
  );

  it('settles pending expectations with the original exercise failure', async () => {
    const transport = new ScriptedRealtimeTransport();
    const exerciseFailure = new Error('exercise failed');

    await expect(
      transport.runScenario({
        scenario: async ({ expectCall }) => {
          await expectCall('sendMessage');
        },
        exercise: () => {
          throw exerciseFailure;
        },
      }),
    ).rejects.toBe(exerciseFailure);

    expect(() => transport.assertComplete()).not.toThrow();
  });

  it('settles pending expectations with the original scenario failure', async () => {
    const transport = new ScriptedRealtimeTransport();
    const scenarioFailure = new Error('scenario failed');

    await expect(
      transport.runScenario({
        scenario: async ({ expectCall }) => {
          void expectCall('sendMessage').catch(() => {});
          throw scenarioFailure;
        },
        exercise: () => {},
      }),
    ).rejects.toBe(scenarioFailure);

    expect(() => transport.assertComplete()).not.toThrow();
  });

  it('cancels a scenario explicitly without a default timer', async () => {
    const transport = new ScriptedRealtimeTransport();
    const controller = new AbortController();

    await expect(
      transport.runScenario({
        scenario: async ({ expectCall }) => {
          await expectCall('sendMessage');
        },
        exercise: () => controller.abort(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      name: 'AbortError',
      pendingExpectations: [{ order: 1, method: 'sendMessage' }],
    });

    expect(() => transport.assertComplete()).not.toThrow();
  });

  it('does not start callbacks for a pre-cancelled scenario', async () => {
    const transport = new ScriptedRealtimeTransport();
    const controller = new AbortController();
    const scenario = vi.fn();
    const exercise = vi.fn();
    controller.abort();

    await expect(
      transport.runScenario({ scenario, exercise, signal: controller.signal }),
    ).rejects.toBeInstanceOf(ScriptedRealtimeScenarioCancelledError);
    expect(scenario).not.toHaveBeenCalled();
    expect(exercise).not.toHaveBeenCalled();
  });

  it('preserves a matcher-thrown value unchanged', async () => {
    const transport = new ScriptedRealtimeTransport();
    const assertionFailure = new Error('assertion failed');

    await expect(
      transport.runScenario({
        scenario: async ({ expectCall }) => {
          await expectCall('mute', () => {
            throw assertionFailure;
          });
        },
        exercise: () => {
          try {
            transport.mute(true);
          } catch (error) {
            expect(error).toBe(assertionFailure);
          }
        },
      }),
    ).rejects.toBe(assertionFailure);
  });

  it('consumes an injected failure when matcher validation fails', async () => {
    const transport = new ScriptedRealtimeTransport();
    const injectedFailure = new Error('injected failure');
    const matcherFailure = new Error('matcher failure');
    transport.failNextCall('mute', injectedFailure);
    const firstCall = transport.expectCall('mute', () => {
      throw matcherFailure;
    });

    expect(() => transport.mute(true)).toThrow(matcherFailure);
    await expect(firstCall).rejects.toBe(matcherFailure);
    expect(() => transport.assertComplete()).not.toThrow();

    const secondCall = transport.expectCall('mute');
    expect(() => transport.mute(false)).not.toThrow();
    await expect(secondCall).resolves.toMatchObject({ muted: false });
    expect(() => transport.assertComplete()).not.toThrow();
  });

  it.each(['pending', 'already recorded'] as const)(
    'isolates canonical history from %s expectation consumers',
    async (registration) => {
      const transport = new ScriptedRealtimeTransport();
      const response = { nested: { value: 1 } };
      const matcher = (call: RealtimeTransportCallFor<'requestResponse'>) => {
        (call.response as typeof response).nested.value = 9;
      };
      let expectedCall: Promise<RealtimeTransportCallFor<'requestResponse'>>;

      if (registration === 'pending') {
        expectedCall = transport.expectCall('requestResponse', matcher);
        transport.requestResponse(response);
      } else {
        transport.requestResponse(response);
        expectedCall = transport.expectCall('requestResponse', matcher);
      }

      const exposedCall = await expectedCall;
      expect(exposedCall.response?.nested.value).toBe(1);
      exposedCall.response!.nested.value = 8;
      expect(
        (
          transport
            .calls[0] as unknown as RealtimeTransportCallFor<'requestResponse'>
        ).response?.nested.value,
      ).toBe(1);
      expect(() => transport.assertComplete()).not.toThrow();
    },
  );

  it('records invocation-time containers and immutable history indexes', async () => {
    class RuntimeToken {}
    const transport = new ScriptedRealtimeTransport();
    const runtimeToken = new RuntimeToken();
    const cycle: { value: number; self?: unknown } = { value: 1 };
    cycle.self = cycle;
    const ownProto = JSON.parse('{"__proto__":{"value":"snapshot"}}') as Record<
      string,
      unknown
    >;
    const response = { cycle, aliases: [cycle], runtimeToken, ownProto };
    const audio = new Uint8Array([1, 2, 3]).buffer;
    const responseCall = transport.expectCall('requestResponse');
    transport.requestResponse(response);
    const audioCall = transport.expectCall('sendAudio');
    transport.sendAudio(audio, { commit: true });

    cycle.value = 9;
    new Uint8Array(audio)[0] = 9;
    const recordedResponse = await responseCall;
    const recordedAudio = await audioCall;
    const recordedCycle = recordedResponse.response?.cycle as typeof cycle;

    expect(recordedCycle.value).toBe(1);
    expect(recordedCycle.self).toBe(recordedCycle);
    expect(recordedResponse.response?.aliases[0]).toBe(recordedCycle);
    expect(recordedResponse.response?.runtimeToken).toBe(runtimeToken);
    expect(Object.getPrototypeOf(recordedResponse.response?.ownProto)).toBe(
      Object.prototype,
    );
    expect(
      Object.prototype.hasOwnProperty.call(
        recordedResponse.response?.ownProto,
        '__proto__',
      ),
    ).toBe(true);
    expect(recordedResponse.response?.ownProto.__proto__).toEqual({
      value: 'snapshot',
    });
    expect(new Uint8Array(recordedAudio.audio)[0]).toBe(1);
    expect(() =>
      (transport.calls as Array<{ index: number; method: string }>).pop(),
    ).toThrow(TypeError);

    const nextCall = transport.expectCall('mute');
    transport.mute(true);
    await expect(nextCall).resolves.toMatchObject({ index: 2 });
    expect(() => transport.assertComplete()).not.toThrow();
  });

  it('injects a connect failure and restores disconnected state', async () => {
    const transport = new ScriptedRealtimeTransport();
    const error = new Error('connect failed');
    transport.failNextCall('connect', error);
    const expectedCall = transport.expectCall('connect');

    await expect(transport.connect({ apiKey: 'test' })).rejects.toBe(error);
    await expect(expectedCall).resolves.toMatchObject({ method: 'connect' });
    expect(transport.status).toBe('disconnected');
    expect(() => transport.assertComplete()).not.toThrow();
    expect(() => transport.assertClosed()).not.toThrow();
  });

  it('reserves a connect failure before a reentrant matcher call', async () => {
    const transport = new ScriptedRealtimeTransport();
    const injectedFailure = new Error('outer connect failed');
    let nestedConnect: Promise<void> | undefined;
    transport.failNextCall('connect', injectedFailure);
    const outerCall = transport.expectCall('connect', () => {
      nestedConnect = transport.connect({ apiKey: 'nested' });
    });

    await expect(transport.connect({ apiKey: 'outer' })).rejects.toBe(
      injectedFailure,
    );
    await outerCall;
    await expect(nestedConnect).resolves.toBeUndefined();
    await expect(transport.expectCall('connect')).resolves.toMatchObject({
      index: 1,
      method: 'connect',
    });
    expect(transport.status).toBe('connected');
    transport.disconnect();
    expect(() => transport.assertComplete()).not.toThrow();
  });

  it('reserves a close failure before a reentrant matcher call', async () => {
    const transport = new ScriptedRealtimeTransport();
    await transport.connect({ apiKey: 'test' });
    await transport.expectCall('connect');
    const injectedFailure = new Error('outer close failed');
    transport.failNextCall('close', injectedFailure);
    const outerCall = transport.expectCall('close', () => {
      transport.close();
    });

    expect(() => transport.close()).toThrow(injectedFailure);
    await outerCall;
    await expect(transport.expectCall('close')).resolves.toMatchObject({
      index: 2,
      method: 'close',
    });
    expect(transport.status).toBe('disconnected');
    expect(() => transport.assertComplete()).not.toThrow();
  });

  it.each(['connect matcher', 'connecting notification'] as const)(
    'restores disconnected state when a failed close supersedes an in-flight connection from the %s',
    async (trigger) => {
      const transport = new ScriptedRealtimeTransport();
      const injectedFailure = new Error('close failed');
      const statuses: string[] = [];
      let closeFailure: unknown;
      transport.failNextCall('close', injectedFailure);
      transport.on('connection_change', (status) => {
        statuses.push(status);
        if (trigger === 'connecting notification' && status === 'connecting') {
          try {
            transport.close();
          } catch (error) {
            closeFailure = error;
          }
        }
      });
      const connectCall = transport.expectCall('connect', () => {
        if (trigger === 'connect matcher') {
          try {
            transport.close();
          } catch (error) {
            closeFailure = error;
          }
        }
      });

      await expect(transport.connect({ apiKey: 'test' })).rejects.toMatchObject(
        {
          name: 'ScriptedRealtimeConnectionSupersededError',
        },
      );
      await connectCall;
      await expect(transport.expectCall('close')).resolves.toMatchObject({
        method: 'close',
      });

      expect(closeFailure).toBe(injectedFailure);
      expect(transport.status).toBe('disconnected');
      expect(statuses.at(-1)).toBe('disconnected');
      expect(() => transport.assertComplete()).not.toThrow();
      expect(() => transport.assertClosed()).not.toThrow();
    },
  );

  it('restores disconnected state when a failed close supersedes the connected notification', async () => {
    const transport = new ScriptedRealtimeTransport();
    const session = new RealtimeSession(
      new RealtimeAgent({ name: 'Assistant' }),
      { transport },
    );
    const injectedFailure = new Error('close failed');
    const statuses: string[] = [];
    let closeFailure: unknown;
    transport.failNextCall('close', injectedFailure);
    transport.on('connection_change', (status) => {
      statuses.push(status);
      if (status === 'connected') {
        try {
          transport.close();
        } catch (error) {
          closeFailure = error;
        }
      }
    });

    await expect(session.connect({ apiKey: 'test' })).rejects.toMatchObject({
      name: 'ScriptedRealtimeConnectionSupersededError',
    });
    await expect(transport.expectCall('connect')).resolves.toMatchObject({
      method: 'connect',
    });
    await expect(transport.expectCall('close')).resolves.toMatchObject({
      method: 'close',
    });

    expect(closeFailure).toBe(injectedFailure);
    expect(transport.status).toBe('disconnected');
    expect(statuses).toEqual(['connecting', 'connected', 'disconnected']);
    expect(() => transport.assertComplete()).not.toThrow();
    expect(() => transport.assertClosed()).not.toThrow();
  });

  it.each(['connecting', 'connected'] as const)(
    'preserves an uncaught close failure from the %s notification',
    async (trigger) => {
      const transport = new ScriptedRealtimeTransport();
      const injectedFailure = new Error('close failed');
      transport.failNextCall('close', injectedFailure);
      transport.on('connection_change', (status) => {
        if (status === trigger) {
          transport.close();
        }
      });

      await expect(transport.connect({ apiKey: 'test' })).rejects.toBe(
        injectedFailure,
      );
      await expect(transport.expectCall('connect')).resolves.toMatchObject({
        method: 'connect',
      });
      await expect(transport.expectCall('close')).resolves.toMatchObject({
        method: 'close',
      });

      expect(transport.status).toBe('disconnected');
      expect(() => transport.assertComplete()).not.toThrow();
      expect(() => transport.assertClosed()).not.toThrow();
    },
  );

  it('restores disconnected state when a nested failed close supersedes an outer close', async () => {
    const transport = new ScriptedRealtimeTransport();
    await transport.connect({ apiKey: 'test' });
    await transport.expectCall('connect');
    const injectedFailure = new Error('nested close failed');
    let closeFailure: unknown;
    const outerCloseCall = transport.expectCall('close', () => {
      transport.failNextCall('close', injectedFailure);
      try {
        transport.close();
      } catch (error) {
        closeFailure = error;
      }
    });

    transport.close();
    await outerCloseCall;
    await expect(transport.expectCall('close')).resolves.toMatchObject({
      index: 2,
      method: 'close',
    });

    expect(closeFailure).toBe(injectedFailure);
    expect(transport.status).toBe('disconnected');
    expect(() => transport.assertComplete()).not.toThrow();
    expect(() => transport.assertClosed()).not.toThrow();
  });

  it('restores an established connection when close fails', async () => {
    const transport = new ScriptedRealtimeTransport();
    await transport.connect({ apiKey: 'test' });
    await transport.expectCall('connect');
    const injectedFailure = new Error('close failed');
    transport.failNextCall('close', injectedFailure);

    expect(() => transport.close()).toThrow(injectedFailure);
    await expect(transport.expectCall('close')).resolves.toMatchObject({
      method: 'close',
    });

    expect(transport.status).toBe('connected');
    expect(() => transport.assertComplete()).not.toThrow();
    transport.disconnect();
    expect(() => transport.assertClosed()).not.toThrow();
  });

  it('reserves a synchronous failure before a reentrant matcher call', async () => {
    const transport = new ScriptedRealtimeTransport();
    const injectedFailure = new Error('outer mute failed');
    transport.failNextCall('mute', injectedFailure);
    const outerCall = transport.expectCall('mute', () => {
      transport.mute(false);
    });

    expect(() => transport.mute(true)).toThrow(injectedFailure);
    await outerCall;
    await expect(transport.expectCall('mute')).resolves.toMatchObject({
      index: 1,
      method: 'mute',
      muted: false,
    });
    expect(transport.muted).toBe(false);
    expect(() => transport.assertComplete()).not.toThrow();
  });

  it('preserves connect failures while completing state cleanup', async () => {
    const observerFailure = new Error('connecting observer failed');
    const observerTransport = new ScriptedRealtimeTransport();
    observerTransport.on('connection_change', (status) => {
      if (status === 'connecting') {
        throw observerFailure;
      }
    });

    await expect(observerTransport.connect({ apiKey: 'test' })).rejects.toBe(
      observerFailure,
    );
    expect(observerTransport.status).toBe('disconnected');

    const injectedFailure = new Error('injected connect failure');
    const cleanupFailure = new Error('cleanup observer failed');
    const injectedTransport = new ScriptedRealtimeTransport();
    injectedTransport.failNextCall('connect', injectedFailure);
    const connectCall = injectedTransport.expectCall('connect');
    injectedTransport.on('connection_change', (status) => {
      if (status === 'disconnected') {
        throw cleanupFailure;
      }
    });

    await expect(injectedTransport.connect({ apiKey: 'test' })).rejects.toBe(
      injectedFailure,
    );
    await connectCall;
    expect(injectedTransport.status).toBe('disconnected');
    expect(() => injectedTransport.assertComplete()).not.toThrow();
  });

  it('propagates observer failures without invoking later listeners', async () => {
    const transport = new ScriptedRealtimeTransport();
    const observerFailure = new Error('connecting observer failed');
    const laterObserver = vi.fn();
    transport.on('connection_change', (status) => {
      if (status === 'connecting') {
        throw observerFailure;
      }
    });
    transport.on('connection_change', laterObserver);

    await expect(transport.connect({ apiKey: 'test' })).rejects.toBe(
      observerFailure,
    );

    expect(laterObserver).toHaveBeenCalledOnce();
    expect(laterObserver).toHaveBeenCalledWith('disconnected');
    expect(transport.status).toBe('disconnected');
    expect(() => transport.assertClosed()).not.toThrow();
  });

  it('removes one-time observers before invoking them', async () => {
    const transport = new ScriptedRealtimeTransport();
    const observerFailure = new Error('connecting observer failed');
    const observer = vi.fn((status: string) => {
      if (status === 'connecting') {
        throw observerFailure;
      }
    });
    transport.once('connection_change', observer);

    await expect(transport.connect({ apiKey: 'test' })).rejects.toBe(
      observerFailure,
    );
    await expect(
      transport.connect({ apiKey: 'test' }),
    ).resolves.toBeUndefined();

    expect(observer).toHaveBeenCalledOnce();
    expect(transport.status).toBe('connected');
    transport.disconnect();
  });

  it('settles connect expectations before observer failures', async () => {
    const observerFailure = new Error('connecting observer failed');
    const injectedFailure = new Error('injected failure');
    const transport = new ScriptedRealtimeTransport();
    const connectCall = transport.expectCall('connect');
    transport.failNextCall('connect', injectedFailure);
    transport.on('connection_change', (status) => {
      if (status === 'connecting') {
        throw observerFailure;
      }
    });

    await expect(transport.connect({ apiKey: 'test' })).rejects.toBe(
      injectedFailure,
    );
    await expect(connectCall).resolves.toMatchObject({ method: 'connect' });
    expect(transport.status).toBe('disconnected');
    expect(() => transport.assertComplete()).not.toThrow();
  });

  it.each(['close', 'disconnect'] as const)(
    'preserves a reentrant %s during the connecting notification',
    async (operation) => {
      const transport = new ScriptedRealtimeTransport();
      transport.on('connection_change', (status) => {
        if (status !== 'connecting') {
          return;
        }
        if (operation === 'close') {
          transport.close();
        } else {
          transport.disconnect();
        }
      });

      await expect(
        transport.runScenario({
          scenario: async ({ expectCall }) => {
            await expectCall('connect');
            if (operation === 'close') {
              await expectCall('close');
            }
          },
          exercise: () => transport.connect({ apiKey: 'test' }),
        }),
      ).rejects.toMatchObject({
        name: 'ScriptedRealtimeConnectionSupersededError',
      });
      expect(transport.status).toBe('disconnected');
      expect(transport.calls.map((call) => call.method)).toEqual(
        operation === 'close' ? ['connect', 'close'] : ['connect'],
      );
      expect(() => transport.assertComplete()).not.toThrow();
      expect(() => transport.assertClosed()).not.toThrow();
    },
  );

  it.each(['close', 'disconnect'] as const)(
    'preserves a reentrant %s from a connect matcher',
    async (operation) => {
      const transport = new ScriptedRealtimeTransport();
      const connectCall = transport.expectCall('connect', () => {
        if (operation === 'close') {
          transport.close();
        } else {
          transport.disconnect();
        }
      });

      await expect(transport.connect({ apiKey: 'test' })).rejects.toMatchObject(
        { name: 'ScriptedRealtimeConnectionSupersededError' },
      );
      await connectCall;
      if (operation === 'close') {
        await expect(transport.expectCall('close')).resolves.toMatchObject({
          method: 'close',
        });
      }
      expect(transport.status).toBe('disconnected');
      expect(transport.calls.map((call) => call.method)).toEqual(
        operation === 'close' ? ['connect', 'close'] : ['connect'],
      );
      expect(() => transport.assertComplete()).not.toThrow();
      expect(() => transport.assertClosed()).not.toThrow();
    },
  );

  it('emits a controlled disconnect and transport error', async () => {
    const transport = new ScriptedRealtimeTransport();
    const statuses: string[] = [];
    const errors: unknown[] = [];
    transport.on('connection_change', (status) => statuses.push(status));
    transport.on('error', (event) => errors.push(event.error));
    const connectCall = transport.expectCall('connect');
    await transport.connect({ apiKey: 'test' });
    await connectCall;

    const error = new Error('disconnected');
    transport.disconnect(error);

    expect(statuses).toEqual(['connecting', 'connected', 'disconnected']);
    expect(errors).toEqual([error]);
    expect(() => transport.assertClosed()).not.toThrow();
  });

  it('closes idempotently and records only the effective close', async () => {
    const transport = new ScriptedRealtimeTransport();
    await transport.runScenario({
      scenario: async ({ expectCall }) => {
        await expectCall('connect');
        await expectCall('close');
      },
      exercise: async () => {
        await transport.connect({ apiKey: 'test' });
        transport.close();
        transport.close();
      },
    });

    expect(
      transport.calls.filter((call) => call.method === 'close'),
    ).toHaveLength(1);
    expect(() => transport.assertComplete()).not.toThrow();
  });

  it('keeps terminal state when close observers throw', async () => {
    const transport = new ScriptedRealtimeTransport();
    const connectCall = transport.expectCall('connect');
    await transport.connect({ apiKey: 'test' });
    await connectCall;
    const closeCall = transport.expectCall('close');
    const observerFailure = new Error('close observer failed');
    transport.on('connection_change', (status) => {
      if (status === 'disconnected') {
        throw observerFailure;
      }
    });

    expect(() => transport.close()).toThrow(observerFailure);
    await closeCall;
    expect(transport.status).toBe('disconnected');
    expect(() => transport.assertClosed()).not.toThrow();
  });

  it('preserves a reconnect started by a close matcher', async () => {
    const transport = new ScriptedRealtimeTransport();
    await transport.connect({ apiKey: 'test' });
    await transport.expectCall('connect');
    let reconnect: Promise<void> | undefined;
    const closeCall = transport.expectCall('close', () => {
      reconnect = transport.connect({ apiKey: 'test' });
    });
    const reconnectCall = transport.expectCall('connect');

    transport.close();
    await closeCall;
    await reconnectCall;
    await reconnect;

    expect(transport.status).toBe('connected');
    expect(transport.calls.map((call) => call.method)).toEqual([
      'connect',
      'close',
      'connect',
    ]);
    expect(() => transport.assertComplete()).not.toThrow();
  });

  it('preserves a matcher disconnect when close fails', async () => {
    const transport = new ScriptedRealtimeTransport();
    await transport.connect({ apiKey: 'test' });
    await transport.expectCall('connect');
    const injectedFailure = new Error('close failed');
    transport.failNextCall('close', injectedFailure);
    const closeCall = transport.expectCall('close', () => {
      transport.disconnect();
    });

    expect(() => transport.close()).toThrow(injectedFailure);
    await closeCall;

    expect(transport.status).toBe('disconnected');
    expect(() => transport.assertComplete()).not.toThrow();
    expect(() => transport.assertClosed()).not.toThrow();
  });

  it('attempts error notification after a disconnect observer throws', async () => {
    const transport = new ScriptedRealtimeTransport();
    const observerFailure = new Error('disconnect observer failed');
    const transportFailure = new Error('transport failed');
    const errors: unknown[] = [];
    const connectCall = transport.expectCall('connect');
    await transport.connect({ apiKey: 'test' });
    await connectCall;
    transport.on('connection_change', (status) => {
      if (status === 'disconnected') {
        throw observerFailure;
      }
    });
    transport.on('error', (event) => errors.push(event.error));

    expect(() => transport.disconnect(transportFailure)).toThrow(
      observerFailure,
    );
    expect(errors).toEqual([transportFailure]);
    expect(transport.status).toBe('disconnected');
  });

  it('propagates an undefined disconnect observer failure', async () => {
    const transport = new ScriptedRealtimeTransport();
    await transport.connect({ apiKey: 'test' });
    await transport.expectCall('connect');
    transport.on('connection_change', (status) => {
      if (status === 'disconnected') {
        throw undefined;
      }
    });
    let returned = true;
    let caught: unknown = Symbol('unset');

    try {
      transport.disconnect();
    } catch (error) {
      returned = false;
      caught = error;
    }

    expect(returned).toBe(false);
    expect(caught).toBeUndefined();
    expect(() => transport.assertClosed()).not.toThrow();
  });

  it('preserves a null disconnect observer failure over a later error observer failure', async () => {
    const transport = new ScriptedRealtimeTransport();
    await transport.connect({ apiKey: 'test' });
    await transport.expectCall('connect');
    const laterFailure = new Error('error observer failed');
    const errorObserver = vi.fn(() => {
      throw laterFailure;
    });
    transport.on('connection_change', (status) => {
      if (status === 'disconnected') {
        throw null;
      }
    });
    transport.on('error', errorObserver);
    let caught: unknown;

    try {
      transport.disconnect(new Error('transport failed'));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeNull();
    expect(errorObserver).toHaveBeenCalledOnce();
    expect(() => transport.assertClosed()).not.toThrow();
  });

  it('reports incomplete scenarios and open transports', async () => {
    const transport = new ScriptedRealtimeTransport();
    transport.sendEvent({ type: 'session.update' });

    expect(() => transport.assertComplete()).toThrow(
      IncompleteRealtimeScenarioError,
    );

    const connected = new ScriptedRealtimeTransport();
    const connectCall = connected.expectCall('connect');
    await connected.connect({ apiKey: 'test' });
    await connectCall;
    expect(() => connected.assertClosed()).toThrow(
      RealtimeTransportNotClosedError,
    );
  });

  it('supports assertions in matchers', async () => {
    const transport = new ScriptedRealtimeTransport();
    const matcher = vi.fn((call: { muted: boolean }) => {
      expect(call.muted).toBe(true);
    });
    const expectedCall = transport.expectCall('mute', matcher);

    transport.mute(true);
    await expectedCall;

    expect(matcher).toHaveBeenCalledOnce();
  });
});
