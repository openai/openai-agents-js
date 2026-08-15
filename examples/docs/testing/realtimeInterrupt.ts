import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';
import { ScriptedRealtimeTransport } from '@openai/agents/realtime/testing';
import assert from 'node:assert/strict';
import test from 'node:test';

function createScenarioGate() {
  let release!: () => void;
  let fail!: (reason: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  // Observe a scenario failure that happens before exercise reaches its await.
  // Awaiting the original promise still receives the same rejection.
  void promise.catch(() => undefined);
  return { promise, release, fail };
}

function createSession() {
  const transport = new ScriptedRealtimeTransport();
  const session = new RealtimeSession(
    new RealtimeAgent({ name: 'Assistant' }),
    { transport },
  );
  return { session, transport };
}

test('sends an interrupt request through the transport', async () => {
  const { session, transport } = createSession();
  const signal = AbortSignal.timeout(5_000);
  const readyToInterrupt = createScenarioGate();
  let sessionObservedAudio = false;
  session.once('audio_start', () => {
    sessionObservedAudio = true;
  });

  await transport.runScenario({
    signal,
    scenario: async ({ expectCall, emit }) => {
      try {
        await expectCall('connect');
        await expectCall('sendMessage');

        // Simulate the beginning of an assistant utterance. RealtimeSession
        // emits audio_start when it receives the first audio chunk.
        emit('turn_started', {
          type: 'response_started',
          providerData: { response: { id: 'response_1' } },
        });
        emit('audio', {
          type: 'audio',
          responseId: 'response_1',
          data: new Uint8Array([1, 2, 3]).buffer,
        });
        // emit() delivers events synchronously. Verify that RealtimeSession saw
        // the chunk before releasing the concurrently running application side.
        assert.equal(sessionObservedAudio, true);
        readyToInterrupt.release();

        await expectCall('interrupt');
        await expectCall('close');
      } catch (error) {
        readyToInterrupt.fail(error);
        throw error;
      }
    },
    exercise: async () => {
      try {
        await session.connect({ apiKey: 'test' });
        session.sendMessage('Tell me a long story');
        await readyToInterrupt.promise;

        // Application code, such as a stop button, interrupts active playback.
        session.interrupt();
      } finally {
        session.close();
      }
    },
  });

  transport.assertComplete();
  transport.assertClosed();
});

test('forwards an interruption notification to the application', async () => {
  const { session, transport } = createSession();
  let interruptionObserved = false;
  session.once('audio_interrupted', () => {
    interruptionObserved = true;
  });

  const connectCall = transport.expectCall('connect');
  await session.connect({ apiKey: 'test' });
  await connectCall;

  // Independently, the transport can notify the session of an interruption.
  transport.emit('audio_interrupted');
  assert.equal(interruptionObserved, true);

  const closeCall = transport.expectCall('close');
  session.close();
  await closeCall;
  transport.assertComplete();
  transport.assertClosed();
});
