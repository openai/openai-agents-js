import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('honors the tracing policy with a CJS Runner and an ESM Codex tool', async () => {
  // A native Node child bypasses Vitest's source aliases and exercises the
  // package export conditions from the distribution built by pnpm build.
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      '--input-type=commonjs',
      '--eval',
      `
const assert = require('node:assert/strict');
const { Agent, Runner, setTraceProcessors, setTracingDisabled } = require('@openai/agents');
const { ScriptedModel, functionCall } = require('@openai/agents-core/testing');

(async () => {
  const { codexTool } = await import('@openai/agents-extensions/experimental/codex');
  const snapshots = [];
  setTracingDisabled(false);
  setTraceProcessors([{
    async onTraceStart() {}, async onTraceEnd() {},
    async onSpanStart(span) { snapshots.push(span.toJSON()); },
    async onSpanEnd(span) { snapshots.push(span.toJSON()); },
    async forceFlush() {}, async shutdown() {},
  }]);
  const secret = 'private-mixed-module-payload';
  const codex = {
    startThread() {
      return {
        id: 'mixed-thread',
        async runStreamed() {
          return { events: (async function* () {
            for (const phase of ['started', 'completed']) {
              yield { type: 'item.' + phase, item: {
                id: 'command', type: 'command_execution', command: secret,
                aggregated_output: secret, status: phase === 'completed' ? 'completed' : 'in_progress', exit_code: 0,
              } };
            }
            yield { type: 'item.completed', item: {
              id: 'message', type: 'agent_message', text: secret,
            } };
            yield { type: 'turn.completed', usage: {
              input_tokens: 1, cached_input_tokens: 0, output_tokens: 1,
            } };
          })() };
        },
      };
    },
  };
  for (const traceIncludeSensitiveData of [false, true]) {
    snapshots.length = 0;
    const tool = codexTool({ codex });
    const agent = new Agent({
      name: 'Mixed module agent', tools: [tool],
      toolUseBehavior: 'stop_on_first_tool',
      model: new ScriptedModel([[functionCall(tool.name, {
        inputs: [{ type: 'text', text: 'Run the command.' }],
      }, { callId: 'mixed-call' })]]),
    });
    const result = await new Runner({ traceIncludeSensitiveData }).run(agent, 'Run.');
    assert.ok(String(result.finalOutput).includes(secret));
    const custom = snapshots.filter(span => span?.span_data.type === 'custom');
    assert.ok(custom.length > 0, 'The ESM tool must emit Codex spans');
    assert.equal(JSON.stringify(snapshots).includes(secret), traceIncludeSensitiveData);
    assert.ok(custom.some(span => span.span_data.data.exitCode === 0));
  }
  process.stdout.write('mixed-module policy verified');
})().catch(error => { console.error(error); process.exitCode = 1; });
`,
    ],
    { cwd: packageRoot, timeout: 15_000 },
  );
  expect(stdout).toBe('mixed-module policy verified');
});
