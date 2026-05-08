import { run, type RunItem } from '@openai/agents';
import {
  Capabilities,
  Manifest,
  SandboxAgent,
  skills,
} from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MODEL,
  getStringArg,
  requireOpenAIKey,
  runExampleMain,
} from './support';

const TARGET_TEST_CMD = 'sh tests/test_credit_note.sh';
const TARGET_MODULE = 'repo/credit_note.sh';
const TARGET_TEST = 'repo/tests/test_credit_note.sh';
const DEFAULT_PROMPT =
  'Open `repo/task.md`, use the `$credit-note-fixer` skill, fix the bug, run `sh tests/test_credit_note.sh`, and summarize the change.';

const EXAMPLE_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_DIR = fileURLToPath(
  new URL('./data/coding-task/repo', import.meta.url),
);
const SKILLS_DIR = fileURLToPath(
  new URL('./data/coding-task/skills', import.meta.url),
);

function getToolCallInfo(items: RunItem[]): Array<{
  name: string;
  args: Record<string, unknown>;
}> {
  return items.flatMap((item) => {
    if (item.type !== 'tool_call_item') {
      return [];
    }

    const rawItem = item.rawItem as {
      name?: unknown;
      type?: unknown;
      arguments?: unknown;
      action?: unknown;
      operation?: unknown;
    };
    let args: Record<string, unknown> = {};

    if (typeof rawItem.arguments === 'string' && rawItem.arguments.length > 0) {
      try {
        const parsed = JSON.parse(rawItem.arguments);
        if (typeof parsed === 'object' && parsed !== null) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        args = { raw: rawItem.arguments };
      }
    } else if (typeof rawItem.action === 'object' && rawItem.action !== null) {
      args = rawItem.action as Record<string, unknown>;
    } else if (
      typeof rawItem.operation === 'object' &&
      rawItem.operation !== null
    ) {
      args = rawItem.operation as Record<string, unknown>;
    }

    if (typeof rawItem.name === 'string') {
      return [{ name: rawItem.name, args }];
    }

    if (rawItem.type === 'apply_patch_call') {
      return [{ name: 'apply_patch', args }];
    }

    return [];
  });
}

function sawTargetTestCommand(
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>,
) {
  return toolCalls.some(({ name, args }) => {
    if (name !== 'exec_command') {
      return false;
    }
    const cmd = args.cmd;
    const workdir = args.workdir;
    if (typeof cmd !== 'string') {
      return false;
    }

    return (
      cmd.includes(TARGET_TEST_CMD) ||
      cmd.includes('./tests/test_credit_note.sh') ||
      (cmd.includes('test_credit_note.sh') && workdir === 'repo')
    );
  });
}

async function main() {
  requireOpenAIKey();

  const model = getStringArg('--model', DEFAULT_MODEL);
  const prompt = getStringArg('--prompt', DEFAULT_PROMPT);

  const agent = new SandboxAgent({
    name: 'Sandbox engineer',
    model,
    instructions:
      'Inspect the repo, make the smallest correct change, run the most relevant checks, and summarize the file changes and risks. Read `repo/task.md` before editing files, stay grounded in the repository, use the `$credit-note-fixer` skill before editing files, prefer apply_patch for file edits when available, remember that apply_patch paths are relative to the sandbox workspace root, and use relative shell paths because the shell already starts in the workspace root.',
    defaultManifest: new Manifest({
      entries: {
        repo: {
          type: 'local_dir',
          src: REPO_DIR,
        },
      },
    }),
    capabilities: [
      ...Capabilities.default(),
      skills({
        lazyFrom: {
          source: {
            type: 'local_dir',
            src: SKILLS_DIR,
          },
          index: [
            {
              name: 'credit-note-fixer',
              description:
                'Fix the tiny credit-note formatting bug and rerun the exact targeted test command.',
            },
          ],
        },
      }),
    ],
  });

  const client = new UnixLocalSandboxClient();
  const session = await client.create(agent.defaultManifest!);

  try {
    const result = await run(agent, prompt, {
      maxTurns: 12,
      sandbox: { session },
    });

    const toolCalls = getToolCallInfo(result.newItems);
    const toolNames = toolCalls.map((toolCall) => toolCall.name);
    const agentRanTargetTest = sawTargetTestCommand(toolCalls);

    if (!toolNames.includes('load_skill')) {
      throw new Error(`Expected load_skill, saw: ${toolNames.join(', ')}`);
    }

    const verification = await session.execCommand!({
      cmd: TARGET_TEST_CMD,
      workdir: 'repo',
      yieldTimeMs: 1_000,
      maxOutputTokens: 400,
    });
    if (!verification.includes('Process exited with code 0')) {
      throw new Error(`Post-run verification failed:\n${verification}`);
    }
    if (!verification.includes('2 passed')) {
      throw new Error(
        `Expected "2 passed" in verification output:\n${verification}`,
      );
    }

    const originalModule = await readFile(join(REPO_DIR, 'credit_note.sh'), {
      encoding: 'utf8',
    });
    const originalTest = await readFile(
      join(REPO_DIR, 'tests/test_credit_note.sh'),
      {
        encoding: 'utf8',
      },
    );
    const updatedModule = await readFile(
      join(session.state.workspaceRootPath, TARGET_MODULE),
      'utf8',
    );
    const updatedTest = await readFile(
      join(session.state.workspaceRootPath, TARGET_TEST),
      'utf8',
    );

    if (updatedModule === originalModule) {
      throw new Error(`${TARGET_MODULE} was not changed by the agent.`);
    }
    if (updatedTest !== originalTest) {
      throw new Error(`${TARGET_TEST} must not be changed by this example.`);
    }

    console.log('=== Final summary ===');
    console.log(`example_dir: ${EXAMPLE_DIR}`);
    console.log(`tool_calls: ${toolNames.join(', ')}`);
    console.log(`agent_ran_target_test: ${agentRanTargetTest ? 'yes' : 'no'}`);
    console.log(`verification_command: ${TARGET_TEST_CMD}`);
    console.log(
      'verification_result: observed target test output with `2 passed`',
    );
    console.log('final_output:', result.finalOutput);
    console.log('updated_credit_note.sh:');
    process.stdout.write(updatedModule);
    if (!updatedModule.endsWith('\n')) {
      process.stdout.write('\n');
    }
  } finally {
    await session.close?.().catch(() => {});
  }
}

await runExampleMain(main);
