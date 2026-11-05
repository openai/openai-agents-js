import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, Environment } from '@openai/agents';
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';

/** Quote an application-selected path for the example's POSIX commands. */
function shellPath(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Verify actual local file effects and replacement of an extra write grant. */
export async function runLocalExecution() {
  const directory = await mkdtemp(join(tmpdir(), 'agents-local-example-'));
  try {
    const root = await realpath(directory);
    const cwd = join(root, 'workspace');
    const first = join(root, 'first-output');
    const second = join(root, 'second-output');
    await Promise.all([cwd, first, second].map((path) => mkdir(path)));
    const firstFile = join(first, 'marker.txt');
    const secondFile = join(second, 'marker.txt');
    return await withScriptedResponses(
      [
        [
          toolCall(
            'exec_command',
            {
              cmd: `printf workspace > proof.txt && printf first > ${shellPath(firstFile)}`,
            },
            { callId: 'first-write' },
          ),
        ],
        [text('First write finished.')],
        [
          toolCall(
            'exec_command',
            {
              cmd:
                `if (printf forbidden > ${shellPath(firstFile)}) 2>/dev/null; then exit 11; fi; ` +
                `printf second > ${shellPath(secondFile)}`,
            },
            { callId: 'replacement-write' },
          ),
        ],
        [text('Replacement write finished.')],
      ],
      async (peer) => {
        const agent = new Agent({
          instructions: 'Perform the requested workspace checks.',
          model: 'gpt-5.5',
          provider: peer.provider,
        });
        await using session = await agent.session({
          environment: Environment.local({
            cwd,
            tools: ['exec_command'],
            writableRoots: [first],
          }),
        });
        await (await session.submit('Write the first markers.')).wait();
        assert.match(
          peer.toolOutput('first-write') ?? '',
          /Process exited with code 0/,
        );
        assert.equal(
          await readFile(join(cwd, 'proof.txt'), 'utf8'),
          'workspace',
        );
        assert.equal(await readFile(firstFile, 'utf8'), 'first');

        await (
          await session.submit(
            'Replace the extra write directory and check it.',
            {
              writableRoots: [second],
            },
          )
        ).wait();
        assert.match(
          peer.toolOutput('replacement-write') ?? '',
          /Process exited with code 0/,
        );
        assert.equal(await readFile(firstFile, 'utf8'), 'first');
        assert.equal(await readFile(secondFile, 'utf8'), 'second');
        const turns = await Array.fromAsync(session.turns());
        const roots = turns.at(-1)?.receipt?.executors?.[0]?.writableRoots;
        assert(roots?.some((path) => path.endsWith('/second-output')));
        assert(!roots?.some((path) => path.endsWith('/first-output')));
        return 'Verified local writes and replacement roots.';
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  runLocalExecution().then(console.log, (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
