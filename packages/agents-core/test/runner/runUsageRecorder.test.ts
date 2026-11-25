import { describe, expect, it } from 'vitest';
import { Agent } from '../../src/agent';
import type { Model, ModelResponse } from '../../src/model';
import { Runner } from '../../src/run';
import {
  createRunUsageRecorder,
  finishRunnerSpan,
  startTaskSpan,
  startTurnSpan,
} from '../../src/runner/tracing';
import {
  getRunStateUsageRecorder,
  setRunnerParentUsageRecorder,
} from '../../src/runner/usageTracking';
import { Usage } from '../../src/usage';
import { withTrace } from '../../src/tracing';
import { fakeModelMessage } from '../stubs';

describe('retained run usage recorders', () => {
  it.each([false, true])(
    'keeps late usage on its original parent after a completed run (stream: %s)',
    async (stream) => {
      await withTrace('retained parent usage', async () => {
        const response = {
          usage: new Usage({
            requests: 1,
            inputTokens: 2,
            outputTokens: 3,
            totalTokens: 5,
          }),
          output: [fakeModelMessage('done')],
        } satisfies ModelResponse;
        const model: Model = {
          async getResponse() {
            return response;
          },
          async *getStreamedResponse() {
            yield {
              type: 'response_done',
              response: { ...response, id: 'response' },
            };
          },
        };
        const parent = startTaskSpan('parent');
        const parentTurn = startTurnSpan(1, 'parent agent', parent.span);
        const replacement = startTaskSpan('replacement');
        const runner = new Runner({ tracingDisabled: true });
        setRunnerParentUsageRecorder(
          runner,
          createRunUsageRecorder(parent, { current: parentTurn }, undefined),
        );
        const agent = new Agent({ name: 'child', model });
        const result = stream
          ? await runner.run(agent, 'hello', { stream: true })
          : await runner.run(agent, 'hello');
        if ('completed' in result) await result.completed;
        expect(result.finalOutput).toBe('done');
        finishRunnerSpan(parentTurn);
        setRunnerParentUsageRecorder(
          runner,
          createRunUsageRecorder(
            replacement,
            { current: undefined },
            undefined,
          ),
        );
        const recordLateUsage = getRunStateUsageRecorder(result.state)!;
        recordLateUsage(
          new Usage({
            requests: 1,
            inputTokens: 7,
            outputTokens: 11,
            totalTokens: 18,
          }),
        );
        expect(parent.ownedUsage.totalTokens).toBe(23);
        expect(parentTurn.ownedUsage.inputTokens).toBe(9);
        expect(replacement.ownedUsage.totalTokens).toBe(0);
        finishRunnerSpan(parent);
        finishRunnerSpan(replacement);
      });
    },
  );
});
