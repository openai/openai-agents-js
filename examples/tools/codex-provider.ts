import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent, Runner, tool } from '@openai/agents';
import { z } from 'zod';

async function codexProvider(workspace: string) {
  const { CodexProvider } =
    await import('@openai/agents-extensions/experimental/codex');
  return new CodexProvider({
    threadOptions: {
      workingDirectory: workspace,
      skipGitRepoCheck: true,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
    },
  });
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== 'openai' && mode !== 'codex') {
    throw new Error('Usage: tsx codex-provider.ts <openai|codex>');
  }

  const workspace = await mkdtemp(path.join(os.tmpdir(), 'codex-provider-'));
  const filename = path.join(workspace, 'hello.txt');
  const expected = 'Hello from Codex';

  try {
    const agent = new Agent({
      name: 'Workspace assistant',
      instructions: [
        `Work in ${workspace}.`,
        'Use your available tools to create and read files.',
        'Read the file after writing it before reporting the contents.',
      ].join(' '),
      tools:
        mode === 'openai'
          ? [
              tool({
                name: 'write_file',
                description:
                  'Write the contents of hello.txt in the workspace.',
                parameters: z.object({ contents: z.string() }),
                execute: async ({ contents }) => {
                  await writeFile(filename, contents, 'utf8');
                  return 'Wrote hello.txt';
                },
              }),
              tool({
                name: 'read_file',
                description: 'Read hello.txt from the workspace.',
                parameters: z.object({}),
                execute: async () => readFile(filename, 'utf8'),
              }),
            ]
          : [],
    });
    const runner = new Runner({
      tracingDisabled: true,
      model:
        mode === 'codex' ? process.env.CODEX_MODEL : process.env.OPENAI_MODEL,
      modelProvider:
        mode === 'codex' ? await codexProvider(workspace) : undefined,
    });
    const result = await runner.run(
      agent,
      `Create hello.txt with exactly this line:
${expected}

` +
        'Read hello.txt with your tools and return one sentence quoting its contents.',
    );
    const contents = (await readFile(filename, 'utf8')).trim();
    if (contents !== expected) {
      throw new Error(`Unexpected file contents: ${JSON.stringify(contents)}`);
    }
    const output = result.finalOutput;
    if (typeof output !== 'string' || !output.includes(expected)) {
      throw new Error(`Unexpected final output: ${JSON.stringify(output)}`);
    }
    console.log(`Provider: ${mode}`);
    console.log(output);
    console.log(`Verified hello.txt: ${contents}`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
