import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ScriptedModel } from '@openai/agents/testing';

const request = (attemptId: string) => ({
  body: {},
  context: {},
  sessionId: 'session',
  turnId: 'turn',
  signal: new AbortController().signal,
  attemptId,
});
const adviceRequest = (
  original: ReturnType<typeof request>,
  error: unknown,
) => ({
  request: original,
  error,
  attemptId: original.attemptId,
  attempt: 1,
  signal: new AbortController().signal,
});

test('same error keeps exact static occurrence advice without an error-only fallback', () => {
  const error = new Error('shared');
  const model = new ScriptedModel([
    { type: 'error', error, retryAdvice: { reason: 'first' } },
    { type: 'error', error, retryAdvice: { reason: 'second' } },
    { type: 'error', error },
  ]);
  const first = request('first'),
    second = request('second'),
    third = request('third');
  for (const value of [first, second, third])
    assert.throws(
      () => model.complete(value),
      (caught) => caught === error,
    );
  model.assertComplete();
  assert.equal(
    model.getRetryAdvice(adviceRequest(request('missing'), error)),
    undefined,
  );
  assert.equal(model.getRetryAdvice(adviceRequest(third, error)), undefined);
  assert.equal(
    model.getRetryAdvice({
      ...adviceRequest(second, error),
      attemptId: 'first',
    }),
    undefined,
  );
  assert.equal(
    model.getRetryAdvice(adviceRequest(second, new Error('shared'))),
    undefined,
  );
  assert.deepEqual(
    model.getRetryAdvice(adviceRequest({ ...second, body: {} }, error)),
    {
      reason: 'second',
    },
  );
  assert.deepEqual(model.getRetryAdvice(adviceRequest(first, error)), {
    reason: 'first',
  });
  assert.equal(model.getRetryAdvice(adviceRequest(first, error)), undefined);
});

test('captures response and static advice without cloning thrown error identity', () => {
  const response = {
    output: [{ type: 'message', text: 'captured' }],
    usage: { input_tokens: 3 },
  };
  const advice = { reason: 'captured' };
  const error = new Error('provider');
  const model = new ScriptedModel([
    response,
    { type: 'error', error, retryAdvice: advice },
  ]);
  response.output[0].text = 'changed';
  response.usage.input_tokens = 9;
  advice.reason = 'changed';
  assert.deepEqual(model.complete(request('response')), {
    output: [{ type: 'message', text: 'captured' }],
    usage: { input_tokens: 3 },
  });
  const failure = request('failure');
  assert.throws(
    () => model.complete(failure),
    (caught) => caught === error,
  );
  assert.deepEqual(model.getRetryAdvice(adviceRequest(failure, error)), {
    reason: 'captured',
  });
  model.assertComplete();
  assert.throws(() => model.complete(request('extra')), /Unexpected/);
  assert.throws(
    () => new ScriptedModel([response]).assertComplete(),
    /Unconsumed/,
  );
});
