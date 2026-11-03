import { describe, expect, it } from 'vitest';
import { Agent, RunContext, Usage } from '@openai/agents-core';
import {
  assistantMessage,
  functionCall,
  ScriptedModel,
} from '@openai/agents-core/testing';
import { captureInput } from '../../src/migration/input';
import {
  migrationHistory,
  migrationItems,
  migrationResult,
  type MigrationObservation,
} from '../../src/migration/result';
import { outputOf } from '../../src/runtime/tools';

// Constructor contract only. Real handoff filtering belongs to its own helper;
// native execution and persistence are covered by migration-session.test.ts.
describe('Session input and consumer projection contract', () => {
  it('keeps a captured filtered view separate from accepted effect records', () => {
    const agent = new Agent({
      name: 'projection',
      model: new ScriptedModel([]),
    });
    const call = functionCall('effect', {}, { callId: 'accepted-call' });
    const response = {
      output: [call],
      usage: new Usage(),
    };
    const final = {
      output: [assistantMessage('done')],
      usage: new Usage(),
    };
    const observations: MigrationObservation[] = [
      { type: 'model', response },
      {
        type: 'tool',
        call,
        value: { checked: true },
        response: outputOf('accepted wire text'),
      },
      { type: 'model', response: final },
    ];
    const accepted = migrationItems(agent, observations);
    const projected = accepted.filter(
      (item) => item.type === 'message_output_item',
    );
    const input = [
      {
        type: 'message' as const,
        role: 'user' as const,
        content: 'filtered input',
      },
    ];
    const captured = captureInput('original input');
    const result = migrationResult(
      {
        finalOutput: 'done',
        modelResponses: [response, final],
        native: {
          sessionId: 'constructor-only',
          turnId: 'constructor-only',
          usage: null,
        },
      },
      agent,
      new RunContext({}),
      captured,
      observations,
      { input, items: projected },
    );
    input[0].content = 'later application mutation';
    expect(result.input).toEqual([
      { type: 'message', role: 'user', content: 'filtered input' },
    ]);
    expect(result.newItems).toBe(projected);
    expect(result.history).toEqual([
      { type: 'message', role: 'user', content: 'filtered input' },
      final.output[0],
    ]);
    expect(result.toInputList()).toEqual(result.history);
    expect(result.finalOutput).toBe('done');
    expect(accepted.map((item) => item.rawItem)).toEqual([
      call,
      {
        type: 'function_call_result',
        callId: 'accepted-call',
        name: 'effect',
        status: 'completed',
        output: 'accepted wire text',
      },
      final.output[0],
    ]);
    expect(
      migrationHistory(captured, projected, 'string projection')[0],
    ).toEqual({ type: 'message', role: 'user', content: 'string projection' });
  });
});
