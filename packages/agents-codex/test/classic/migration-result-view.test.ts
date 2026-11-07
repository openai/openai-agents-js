import { describe, expect, it } from 'vitest';
import {
  Agent,
  RunContext,
  Usage,
  type ModelResponse,
  type RunResult,
} from '@openai/agents-core';
import {
  assistantMessage,
  functionCall,
  ScriptedModel,
} from '@openai/agents-core/testing';
import { captureInput } from '../../src/migration/input';
import {
  migrationResult,
  type MigrationObservation,
} from '../../src/migration/result';
import { outputOf } from '../../src/runtime/tools';

function fixture() {
  const context = { tag: 'application' };
  const runContext = new RunContext(context);
  const agent = new Agent<typeof context>({
    name: 'Consumer',
    instructions: 'Return text.',
    model: new ScriptedModel([]),
  });
  const response: ModelResponse = {
    output: [assistantMessage('Done.', { id: 'sdk-message' })],
    usage: new Usage({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
    responseId: 'sdk-response',
    requestId: 'sdk-request',
  };
  runContext.usage.add(response.usage);
  // Pure projection fixture, not native execution or guard-acceptance evidence.
  const base = {
    finalOutput: 'Done.',
    modelResponses: [response],
    native: { sessionId: 'unit-session', turnId: 'unit-turn', usage: null },
    inputGuardrailResults: [],
    outputGuardrailResults: [],
  };
  return { context, runContext, agent, response, base };
}

describe('completed migration consumer view', () => {
  it('retains actual supplied owners, SDK responses, usage and native diagnostics', () => {
    const { context, runContext, agent, response, base } = fixture();
    const result = migrationResult(
      base,
      agent,
      runContext,
      captureInput('Input.'),
      [{ type: 'model', response }],
    );
    const consumer: Pick<
      RunResult<typeof context, Agent<typeof context, any>>,
      | 'input'
      | 'newItems'
      | 'rawResponses'
      | 'lastResponseId'
      | 'lastAgent'
      | 'runContext'
      | 'interruptions'
      | 'finalOutput'
    > = result;
    expect(consumer.finalOutput).toBe('Done.');
    expect(result.finalOutput).toBe(base.finalOutput);
    expect(Symbol.asyncIterator in result).toBe(false);
    expect(result).not.toHaveProperty('toStream');
    expect(result).not.toHaveProperty('toTextStream');
    expect(result.rawResponses).toEqual(base.modelResponses);
    expect(result.rawResponses[0]).toBe(base.modelResponses[0]);
    expect(result.modelResponses).toBe(base.modelResponses);
    expect(result.lastResponseId).toBe('sdk-response');
    expect(result.lastAgent).toBe(agent);
    expect(result.runContext).toBe(runContext);
    expect(result.runContext.context).toBe(context);
    expect(result.runContext.usage).toBe(runContext.usage);
    expect(result.runContext.usage.totalTokens).toBe(3);
    expect(result.native).toBe(base.native);
    expect(result.inputGuardrailResults).toBe(base.inputGuardrailResults);
    expect(result.outputGuardrailResults).toBe(base.outputGuardrailResults);
    expect(result.interruptions).toEqual([]);
  });

  it('provides history and toInputList without a fabricated classic state', () => {
    const { runContext, agent, response, base } = fixture();
    const result = migrationResult(
      base,
      agent,
      runContext,
      captureInput('Input.'),
      [{ type: 'model', response }],
    );
    expect(result.input).toBe('Input.');
    expect(result.toInputList()).toEqual(result.history);
    expect(result.output).toEqual(response.output);
    expect(result.history).toEqual([
      { type: 'message', role: 'user', content: 'Input.' },
      ...response.output,
    ]);
    const history = result.toInputList();
    history.length = 0;
    expect(result.toInputList()).toHaveLength(2);
    expect(result).not.toHaveProperty('state');
  });

  it('provides buffered semantic iteration and stream EOF after completed projection', async () => {
    const { runContext, agent, response, base } = fixture();
    const result = migrationResult(
      base,
      agent,
      runContext,
      captureInput('Input.'),
      [{ type: 'model', response }],
    );
    await expect(result.completed).resolves.toBeUndefined();
    const events = await Array.fromAsync(result.replayEvents());
    expect(
      events.map((event) => [
        event.type,
        event.type === 'run_item_stream_event' ? event.name : event.type,
      ]),
    ).toEqual([['run_item_stream_event', 'message_output_created']]);
    const reader = result.replayEvents().getReader();
    expect((await reader.read()).value).toMatchObject({
      name: 'message_output_created',
    });
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(result).not.toHaveProperty('toTextStream');
  });

  it('keeps terminal-tool output without adding a model message or response', () => {
    const { runContext, agent, base } = fixture();
    const call = functionCall('finish', '{}', { callId: 'terminal-call' });
    const response: ModelResponse = { output: [call], usage: new Usage() };
    const observations: MigrationObservation[] = [
      { type: 'model', response },
      {
        type: 'tool',
        call,
        value: 'Terminal text.',
        response: outputOf('Terminal text.'),
      },
    ];
    const result = migrationResult(
      { ...base, finalOutput: 'Terminal text.', modelResponses: [response] },
      agent,
      runContext,
      captureInput('Input.'),
      observations,
    );
    expect(result.finalOutput).toBe('Terminal text.');
    expect(result.rawResponses).toHaveLength(1);
    expect(result.newItems.map((item) => item.type)).toEqual([
      'tool_call_item',
      'tool_call_output_item',
    ]);
    expect(result.toInputList()).not.toContainEqual(
      expect.objectContaining({ role: 'assistant' }),
    );
    expect(result.lastResponseId).toBeUndefined();
  });
});
