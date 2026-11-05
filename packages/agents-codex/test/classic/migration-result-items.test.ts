import { describe, expect, it } from 'vitest';
import {
  Agent,
  Usage,
  RunAgentUpdatedStreamEvent,
  RunToolCallOutputItem,
  type ModelResponse,
} from '@openai/agents-core';
import {
  assistantMessage,
  functionCall,
  ScriptedModel,
} from '@openai/agents-core/testing';
import { captureInput } from '../../src/migration/input';
import {
  migrationEvents,
  migrationHistory,
  migrationItems,
  type MigrationObservation,
} from '../../src/migration/result';
import { jsonValue } from '../../src/runtime/binding';
import { outputOf } from '../../src/runtime/tools';

const agent = new Agent<{ tag: string }>({
  name: 'Actual agent',
  instructions: 'Return text.',
  model: new ScriptedModel([]),
});
const call = functionCall('echo', ' { "text" : "hello" } ', {
  callId: 'actual-call',
});
const response = (
  ...output: ModelResponse['output']
): MigrationObservation => ({
  type: 'model',
  response: { output, usage: new Usage(), responseId: 'actual-response' },
});
const tool = (value = { text: 'HELLO' }): MigrationObservation => ({
  type: 'tool',
  call,
  value,
  response: outputOf(jsonValue.parse(value)),
});

describe('actual migration result observations', () => {
  it('uses SDK wrappers and actual call/output data in observed order', () => {
    const items = migrationItems(agent, [
      response(call),
      tool(),
      response(assistantMessage('Done.')),
    ]);
    expect(items.map((item) => item.type)).toEqual([
      'tool_call_item',
      'tool_call_output_item',
      'message_output_item',
    ]);
    expect(
      items.every(
        (item) => item.type !== 'handoff_output_item' && item.agent === agent,
      ),
    ).toBe(true);
    expect(items[0]!.rawItem).toEqual(call);
    expect(items[1]).toBeInstanceOf(RunToolCallOutputItem);
    expect(items[1]!.rawItem).toEqual({
      type: 'function_call_result',
      callId: 'actual-call',
      name: 'echo',
      status: 'completed',
      output: '{"text":"HELLO"}',
    });
    expect((items[1] as RunToolCallOutputItem).output).toEqual({
      text: 'HELLO',
    });
  });

  it('does not create an assistant message for terminal tool completion', () => {
    const items = migrationItems(agent, [response(call), tool()]);
    expect(items.map((item) => item.type)).toEqual([
      'tool_call_item',
      'tool_call_output_item',
    ]);
    const history = migrationHistory(captureInput('Input.'), items);
    expect(history.map((item) => item.type)).toEqual([
      'message',
      'function_call',
      'function_call_result',
    ]);
    expect(history).not.toContainEqual(
      expect.objectContaining({ role: 'assistant' }),
    );
  });

  it('preserves absent SDK identifiers instead of inventing native transport IDs', () => {
    const message = {
      type: 'message' as const,
      role: 'assistant' as const,
      status: 'completed' as const,
      content: [{ type: 'output_text' as const, text: 'Actual.' }],
    };
    const items = migrationItems(agent, [response(message)]);
    expect(items[0]!.rawItem).toEqual(message);
    expect(items[0]!.rawItem).not.toHaveProperty('id');
    expect(migrationHistory(captureInput('Input.'), items)[1]).toEqual(message);
  });

  it('exports detached history from captured input and actual SDK items', () => {
    const input = [{ role: 'user' as const, content: 'Original.' }];
    const captured = captureInput(input);
    input[0]!.content = 'Caller changed it.';
    const items = migrationItems(agent, [response(call), tool()]);
    const history = migrationHistory(captured, items);
    history.length = 0;
    expect(migrationHistory(captured, items)).toEqual([
      { type: 'message', role: 'user', content: 'Original.' },
      call,
      {
        type: 'function_call_result',
        callId: 'actual-call',
        name: 'echo',
        status: 'completed',
        output: '{"text":"HELLO"}',
      },
    ]);
  });

  it('retains actual tool completion order without sorting by declaration order', () => {
    const second = functionCall('echo', '{}', { callId: 'second-call' });
    const observations: MigrationObservation[] = [
      response(call, second),
      {
        type: 'tool',
        call: second,
        value: 'second',
        response: outputOf('second'),
      },
      tool(),
    ];
    const items = migrationItems(agent, observations);
    expect(
      items.map((item) =>
        'callId' in item.rawItem ? item.rawItem.callId : undefined,
      ),
    ).toEqual(['actual-call', 'second-call', 'second-call', 'actual-call']);
  });

  it('correlates the ordinary functions namespace without changing the SDK call', () => {
    const namespaced = { ...call, namespace: 'functions' };
    const items = migrationItems(agent, [response(namespaced), tool()]);
    expect(items[0]!.rawItem).toEqual(namespaced);
    expect(items[1]!.rawItem).toHaveProperty('namespace', 'functions');
  });

  it.each([
    ['unobserved tool', [tool()]],
    ['unpaired call', [response(call)]],
    ['duplicate call', [response(call), response(call)]],
    ['duplicate tool reply', [response(call), tool(), tool()]],
    [
      'mismatched tool',
      [
        response(call),
        { ...tool(), type: 'tool', call: { ...call, name: 'foreign' } },
      ],
    ],
  ])('rejects %s rather than fabricating history', (_name, observations) => {
    expect(() =>
      migrationItems(agent, observations as MigrationObservation[]),
    ).toThrow(TypeError);
  });

  it('yields only supported buffered semantic events followed by EOF', async () => {
    const items = migrationItems(agent, [
      response(call),
      tool(),
      response(assistantMessage('Done.')),
    ]);
    const events = await Array.fromAsync(migrationEvents(items));
    expect(
      events.map((event) => [
        event.type,
        event.type === 'run_item_stream_event' ? event.name : undefined,
      ]),
    ).toEqual([
      ['run_item_stream_event', 'tool_called'],
      ['run_item_stream_event', 'tool_output'],
      ['run_item_stream_event', 'message_output_created'],
    ]);
    expect(
      events
        .filter((event) => event.type === 'run_item_stream_event')
        .map((event) => event.item),
    ).toEqual(items);
    const replay = migrationEvents(items, { agent, afterItemCount: 2 });
    expect((await replay.next()).value).toMatchObject({ name: 'tool_called' });
    expect((await replay.next()).value).toMatchObject({ name: 'tool_output' });
    const update = (await replay.next()).value;
    expect(update).toBeInstanceOf(RunAgentUpdatedStreamEvent);
    if (!update || update.type !== 'agent_updated_stream_event')
      throw new Error('Missing actual Agent update.');
    expect(update.agent).toBe(agent);
    expect((await replay.next()).value).toMatchObject({
      name: 'message_output_created',
      item: items[2],
    });
    expect(await replay.next()).toEqual({ done: true, value: undefined });
    expect(await migrationEvents([]).next()).toEqual({
      done: true,
      value: undefined,
    });
  });
});
