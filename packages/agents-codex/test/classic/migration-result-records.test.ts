import { describe, expect, it } from 'vitest';
import { Usage } from '@openai/agents-core';
import { functionCall } from '@openai/agents-core/testing';
import { SelectedModelInvocation } from '../../src/migration/model';
import { outputOf } from '../../src/runtime/tools';

function fixture() {
  const invocation = new SelectedModelInvocation([], {}, 'response', {
    usage: new Usage(),
  });
  const first = functionCall('lookup', '{"key":1}', { callId: 'first' });
  const second = functionCall('lookup', '{"key":2}', { callId: 'second' });
  invocation.responses.push({ output: [first, second], usage: new Usage() });
  return { invocation, first, second };
}

describe('checked values joined to accepted tool receipts', () => {
  it('keeps values pending until accepted and preserves model-batch call order', () => {
    const { invocation, first, second } = fixture();
    const value = { checked: 1 };
    const returned = invocation.toolValue(first.callId, first.name, value);
    value.checked = 9;
    invocation.toolValue(second.callId, second.name, '{"kept":"as text"}');
    expect(() => invocation.getObservations()).toThrow('missing an accepted');
    invocation.toolResult(
      second.callId,
      second.name,
      outputOf('accepted text two'),
    );
    invocation.toolResult(first.callId, first.name, outputOf(returned));
    const observations = invocation.getObservations();
    expect(observations.map((item) => item.type)).toEqual([
      'model',
      'tool',
      'tool',
    ]);
    expect(observations[1]).toMatchObject({
      call: first,
      value: { checked: 1 },
    });
    expect(observations[2]).toMatchObject({
      call: second,
      value: '{"kept":"as text"}',
      response: outputOf('accepted text two'),
    });
  });

  it('does not reconstruct missing values from accepted JSON-looking text', () => {
    const { invocation, first, second } = fixture();
    for (const call of [first, second])
      invocation.toolResult(
        call.callId,
        call.name,
        outputOf('{"not":"a raw value"}'),
      );
    expect(() => invocation.getObservations()).toThrow(
      'missing an accepted checked tool value',
    );
    expect(invocation.getOutputItems()).toHaveLength(4);
  });

  it('retains true-ACK facts after cancellation without exposing mutable snapshots', () => {
    const { invocation, first, second } = fixture();
    for (const call of [first, second]) {
      invocation.toolValue(call.callId, call.name, { answer: 7 });
      const response = outputOf('accepted');
      invocation.toolResult(call.callId, call.name, response);
      response.contentItems.length = 0;
    }
    invocation.fail(new Error('post-ACK cancellation'));
    const observations = invocation.getObservations();
    expect(observations[1]).toMatchObject({
      value: { answer: 7 },
      response: outputOf('accepted'),
    });
    const record = observations[1];
    if (record?.type === 'tool') record.response.contentItems.length = 0;
    expect(invocation.getObservations()[1]).toMatchObject({
      response: outputOf('accepted'),
    });
  });
});
