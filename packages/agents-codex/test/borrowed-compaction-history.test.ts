import { expect, it } from 'vitest';
import {
  projectHistory,
  recordedTurnFromWire,
  recordedTurnToWire,
  type ThreadHistory,
} from '../src/runtime/history';

it.each([true, false])(
  'retains one endpoint occurrence and cold totals (measured=%s)',
  (measured) => {
    const report = {
      input_tokens: 3,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 2,
      reasoning_output_tokens: 0,
      total_tokens: 5,
    };
    const occurrence = {
      type: 'response_observation_record',
      payload: {
        id: 'native-compact',
        thread_id: 'thread',
        turn_id: 'turn',
        compaction: true,
        endpoint: 'responses.compact',
        response_id: null,
        status: measured ? 'completed' : 'failed',
        incomplete_reason: null,
        usage: measured
          ? { input_tokens: 4, output_tokens: 2, total_tokens: 6 }
          : null,
      },
    };
    const history: ThreadHistory = [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
      {
        type: 'event_msg',
        payload: {
          type: '_sdk_model_attempt',
          thread: 'thread',
          turn_id: 'turn',
          data: {
            owner_attempt_id: 'generation',
            attempt_id: 'generation',
            phase: 'finished',
            usage: {
              requests: 1,
              requests_without_token_usage: 0,
              token_usage: report,
            },
            terminal_attempt_id: 'generation',
          },
        },
      },
      occurrence,
      occurrence,
    ];
    const turn = projectHistory(history, 'thread').turns[0];
    const entries = turn.requestUsageEntries?.filter(
      (entry) => entry.endpoint === 'responses.compact',
    );
    expect(entries).toHaveLength(1);
    expect(entries?.[0]).toMatchObject({
      scope: 'compaction',
      attemptId: 'native-compact',
      tokenUsageKnown: measured,
      totalTokens: measured ? 6 : 0,
    });
    expect(turn.runUsage).toMatchObject({
      requests: 2,
      missingUsageRequests: measured ? 0 : 1,
      totalTokens: measured ? 11 : 5,
    });
    expect(
      recordedTurnFromWire(recordedTurnToWire(turn)).requestUsageEntries,
    ).toEqual(turn.requestUsageEntries);
  },
);
