import { type ModelSettings } from '@openai/agents';
import { Manifest, SandboxAgent, shell } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import { z } from 'zod';
import { exampleRunner } from './example-runner';

// UnixLocalSandboxClient runs generated commands as the current user.
// Use this example only on a trusted, disposable development host.
async function main() {
  const useCodex = process.argv.includes('--codex');
  const runner = await exampleRunner(useCodex);
  const client = new UnixLocalSandboxClient();
  const session = await client.create(new Manifest({ entries: {} }));
  const expected = Math.sqrt(273 * 312821 + 1782);
  const agent = new SandboxAgent({
    name: 'Local math tutor',
    instructions:
      'Use the SDK exec_command tool to execute Python 3 code for every numeric calculation. Print the result to at least 8 decimal places. Return the computed answer and the Python code you ran.',
    capabilities: [shell()],
    modelSettings: { toolChoice: 'required' } satisfies ModelSettings,
    outputType: z.object({ answer: z.number(), code: z.string() }),
  });

  try {
    const result = await runner.run(
      agent,
      'Calculate the square root of 273 * 312821 + 1782.',
      { sandbox: { session }, stream: true },
    );
    for await (const event of result) {
      if (event.type === 'run_item_stream_event') {
        console.log(`[${event.name}]`);
      }
    }
    const calls = result.newItems.filter(
      (item) => item.type === 'tool_call_item',
    );
    const outputs = result.newItems.filter(
      (item) => item.type === 'tool_call_output_item',
    );
    const numbers = JSON.stringify(outputs).match(/\d+\.\d+/g) ?? [];
    if (
      !calls.some(
        (item) =>
          'name' in item.rawItem && item.rawItem.name === 'exec_command',
      ) ||
      !numbers.some((value) => Math.abs(Number(value) - expected) < 1e-6) ||
      !result.finalOutput ||
      Math.abs(result.finalOutput.answer - expected) > 1e-6
    ) {
      throw new Error(
        'Expected a real SDK command, matching output, and final answer.',
      );
    }
    console.log(JSON.stringify(result.finalOutput, null, 2));
    console.log('Verified local computation.');
  } finally {
    await session.close?.();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
