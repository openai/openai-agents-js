import { Runner } from '@openai/agents';
import { SandboxAgent, shell } from '@openai/agents/sandbox';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  scriptedSandboxSession,
} from '@openai/agents/testing';
import assert from 'node:assert/strict';
import test from 'node:test';

test('runs a SandboxAgent shell workflow without a real sandbox', async (t) => {
  const sandbox = scriptedSandboxSession([
    {
      method: 'execCommand',
      match: ({ cmd }) => {
        // Assert the command at the sandbox boundary, after the shell tool has
        // validated and converted the model's function-call arguments.
        assert.equal(cmd, 'pwd');
      },
      result: '/workspace\n',
    },
  ]);
  const model = new ScriptedModel([
    [functionCall('exec_command', { cmd: 'pwd' }, { callId: 'call_1' })],
    [assistantMessage('The workspace is /workspace.')],
  ]);
  const agent = new SandboxAgent({
    name: 'Workspace assistant',
    model,
    capabilities: [shell()],
  });

  // Teardown assertions also report unused steps if the workflow exits early.
  t.after(() => {
    sandbox.assertComplete();
    model.assertComplete();
  });

  // The scripted boundaries do not disable the separate tracing exporter.
  const runner = new Runner({ tracingDisabled: true });
  const result = await runner.run(agent, 'Which directory are you in?', {
    // The real SandboxAgent runtime receives the in-memory session instead of
    // creating a Docker or remote sandbox.
    sandbox: { session: sandbox },
  });

  assert.equal(result.finalOutput, 'The workspace is /workspace.');
  assert.deepEqual(
    sandbox.calls.map((call) => call.method),
    ['execCommand'],
  );
  assert.equal(model.calls.length, 2);
});
