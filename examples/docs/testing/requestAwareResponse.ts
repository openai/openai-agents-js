import { Agent, Runner } from '@openai/agents';
import {
  ScriptedModel,
  assistantMessage,
  modelResponder,
} from '@openai/agents/testing';
import assert from 'node:assert/strict';
import test from 'node:test';

test('derives a response from the recorded request', async () => {
  const model = new ScriptedModel([
    modelResponder((call) => {
      // The responder receives the normalized request at the Model boundary.
      assert.equal(call.index, 0);
      assert.equal(call.streamed, false);
      assert.deepEqual(call.request.input, [
        {
          type: 'message',
          role: 'user',
          content: 'Summarize this',
        },
      ]);
      return [assistantMessage(`Handled model call ${call.index}.`)];
    }),
  ]);
  const agent = new Agent({ name: 'Assistant', model });

  // ScriptedModel replaces model I/O; disable tracing separately so this test
  // makes no network requests.
  const runner = new Runner({ tracingDisabled: true });
  const result = await runner.run(agent, 'Summarize this');

  assert.equal(result.finalOutput, 'Handled model call 0.');
  model.assertComplete();
});
