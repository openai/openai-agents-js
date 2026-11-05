import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@openai/agents';
import { text, withScriptedResponses } from '@openai/agents/testing';

/** Load application-owned instructions and inspect the recorded sampling settings. */
export async function inspectSessionConfiguration() {
  const directory = await mkdtemp(
    join(tmpdir(), 'agents-instruction-example-'),
  );
  const contents = [
    'Use the synthetic catalog.',
    'Return a color in lowercase.',
  ];
  const paths = contents.map((_, index) =>
    join(directory, `policy-${index}.md`),
  );
  try {
    for (const [index, path] of paths.entries())
      await writeFile(path, contents[index], { encoding: 'utf8', mode: 0o600 });
    return await withScriptedResponses([[text('violet')]], async (peer) => {
      const agent = new Agent({
        instructions: 'Answer the question.',
        model: 'gpt-5.5',
        provider: peer.provider,
        modelSettings: { reasoningEffort: 'low', serviceTier: 'flex' },
      });
      await using session = await agent.session({
        instructionFiles: paths,
        modelSettings: { reasoningSummary: 'concise', serviceTier: null },
      });
      const turn = await session.submit('What color is A?');
      assert.equal((await turn.wait()).finalOutput, 'violet');
      const recorded = [];
      for await (const item of session.turns()) recorded.push(item);
      const receipt = recorded.find((item) => item.id === turn.turnId)?.receipt;
      assert(receipt, 'Expected the current native turn receipt.');
      assert.equal(receipt.threadId, session.id);
      assert.equal(receipt.turnId, turn.turnId);
      assert.equal(receipt.model, 'gpt-5.5');
      assert.equal(receipt.reasoningEffort, 'low');
      assert.equal(receipt.userConfigApplied, false);
      assert.deepEqual(
        receipt.instructionFiles,
        await Promise.all(
          paths.map(async (path, index) => ({
            path: await realpath(path),
            source: 'application_file',
            sha256: createHash('sha256').update(contents[index]).digest('hex'),
          })),
        ),
      );
      const wire = peer.requests[0];
      assert.equal(wire.service_tier, undefined);
      assert.deepEqual(wire.reasoning, { effort: 'low', summary: 'concise' });
      const sampled = JSON.stringify(wire.input);
      assert(sampled.includes('Use the synthetic catalog.'));
      assert(sampled.includes('Return a color in lowercase.'));
      assert(sampled.indexOf(contents[0]) < sampled.indexOf(contents[1]));
      return receipt;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  inspectSessionConfiguration().then(
    (receipt) => console.log(JSON.stringify(receipt)),
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
