import { Agent, Runner } from '@openai/agents';
import { ScriptedModel, assistantMessage } from '@openai/agents/testing';
import assert from 'node:assert/strict';
import test from 'node:test';

test('returns a deterministic final answer', async () => {
  const model = new ScriptedModel([
    [assistantMessage('Paris is the capital of France.')],
  ]);
  const agent = new Agent({
    name: 'Geography assistant',
    model,
  });

  // ScriptedModel replaces model I/O; disable tracing separately so this test
  // makes no network requests.
  const runner = new Runner({ tracingDisabled: true });
  const result = await runner.run(agent, 'What is the capital of France?');

  assert.equal(result.finalOutput, 'Paris is the capital of France.');
  assert.equal(model.calls.length, 1);
  // Also fail if a later agent change stops before using the whole script.
  model.assertComplete();
});
