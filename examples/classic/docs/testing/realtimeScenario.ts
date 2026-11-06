import {
  RealtimeAgent,
  type RealtimeItem,
  RealtimeSession,
} from '@openai/agents/realtime';
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

test('runs a two-turn Realtime conversation', async () => {
  const transport = new ScriptedRealtimeTransport();
  const session = new RealtimeSession(
    new RealtimeAgent({ name: 'Assistant' }),
    { transport },
  );
  const conversation: RealtimeItem[] = [
    {
      itemId: 'user_1',
      type: 'message',
      role: 'user',
      status: 'completed',
      content: [{ type: 'input_text', text: 'Hello' }],
    },
    {
      itemId: 'assistant_1',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Hi! How can I help?' }],
    },
    {
      itemId: 'user_2',
      type: 'message',
      role: 'user',
      status: 'completed',
      content: [{ type: 'input_text', text: 'What did I just say?' }],
    },
    {
      itemId: 'assistant_2',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'You said hello.' }],
    },
  ];
  const signal = AbortSignal.timeout(5_000);
  const firstTurnDelivered = createScenarioGate();
  let secondTurnDelivered: ReturnType<typeof createScenarioGate> | undefined;

  await transport.runScenario({
    // The application waits for each scripted turn. Bound that coordination
    // so a missing outbound call cannot leave both callbacks waiting forever.
    signal,
    // This side scripts the normalized transport-facing interaction.
    scenario: async ({ expectCall, emit }) => {
      try {
        await expectCall('connect');

        await expectCall('sendMessage', (call) => {
          assert.equal(call.message, 'Hello');
        });
        // Emit normalized history items to exercise RealtimeSession history.
        emit('item_update', conversation[0]);
        emit('item_update', conversation[1]);
        // Create the next gate before releasing the application to send again.
        secondTurnDelivered = createScenarioGate();
        firstTurnDelivered.release();

        await expectCall('sendMessage', (call) => {
          assert.equal(call.message, 'What did I just say?');
        });
        emit('item_update', conversation[2]);
        emit('item_update', conversation[3]);
        secondTurnDelivered.release();

        await expectCall('close');
      } catch (error) {
        // Forward scenario failures to whichever application wait is active.
        (secondTurnDelivered ?? firstTurnDelivered).fail(error);
        throw error;
      }
    },
    // This side drives the application through the public session API.
    exercise: async () => {
      try {
        await session.connect({ apiKey: 'test' });
        session.sendMessage('Hello');
        await firstTurnDelivered.promise;

        session.sendMessage('What did I just say?');
        assert(secondTurnDelivered);
        await secondTurnDelivered.promise;
      } finally {
        // Close the session after success, timeout, or scenario failure.
        session.close();
      }
    },
  });

  assert.deepEqual(session.history, conversation);
  transport.assertComplete();
  transport.assertClosed();
});
