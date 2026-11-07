import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import {
  Agent,
  run,
  withTrace,
  applyPatchTool,
  type ApplyPatchOperation,
} from '@openai/agents/classic';
import { Manifest } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import chalk from 'chalk';

function printDiff(diff: string) {
  const lines = diff.split('\n');
  for (const line of lines) {
    if (line.startsWith('+')) {
      console.log(chalk.green(line));
    } else if (line.startsWith('-')) {
      console.log(chalk.red(line));
    } else {
      console.log(chalk.dim(line));
    }
  }
}

async function promptApplyPatchApproval(
  operation: ApplyPatchOperation,
): Promise<boolean> {
  if (process.env.APPLY_PATCH_AUTO_APPROVE === '1') {
    return true;
  }

  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log(chalk.bold.bgYellow.black(' Apply patch approval required: '));
    console.log(`${chalk.bold(operation.type)}: ${operation.path}`);
    if ('diff' in operation && typeof operation.diff === 'string') {
      printDiff(operation.diff);
    }
    const answer = await rl.question(`Proceed? [y/N] `);
    const approved = answer.trim().toLowerCase();
    return approved === 'y' || approved === 'yes';
  } finally {
    rl.close();
  }
}

async function main() {
  const session = await new UnixLocalSandboxClient().create(new Manifest());
  const workspaceRoot = session.state.workspaceRootPath;
  console.log(chalk.dim(`Temporary workspace: ${chalk.cyan(workspaceRoot)}`));
  const editor = session.createEditor();

  try {
    const agent = new Agent({
      name: 'Patch Assistant',
      model: 'gpt-5.4',
      modelSettings: {
        reasoning: { effort: 'low' },
      },
      instructions: `You can edit files inside ${workspaceRoot} using the apply_patch tool. Use workspace-relative paths such as tasks.md.`,
      tools: [
        applyPatchTool({
          editor,
          // could also be a function for you to determine if approval is needed
          needsApproval: true,
          onApproval: async (_ctx, approvalItem) => {
            const op =
              approvalItem.rawItem.type === 'apply_patch_call'
                ? approvalItem.rawItem.operation
                : undefined;
            const approve = op ? await promptApplyPatchApproval(op) : false;
            return { approve };
          },
        }),
      ],
    });
    console.log(chalk.dim('Asking agent to create tasks.md …\n'));
    await withTrace('apply-patch-example', async () => {
      const result = await run(
        agent,
        'Create tasks.md with a shopping checklist of 5 entries.',
      );
      console.log(`${chalk.bold('Agent:')} ${chalk.cyan(result.finalOutput)}`);
      const updatedNotes = await readFile(
        path.join(workspaceRoot, 'tasks.md'),
        'utf8',
      );
      console.log(`\n\n${chalk.dim('tasks.md after creation:')}`);
      console.log(updatedNotes);
      console.log(
        `\n\n${chalk.dim('Asking agent to check off the last two items …')}\n`,
      );
      const result2 = await run(
        agent,
        `<BEGIN_FILES>\n===== tasks.md\n${updatedNotes}\n\n<END_FILES>\nUse the apply_patch tool to update tasks.md in place. Preserve the existing Markdown structure exactly, keep the \`- [ ]\` checklist prefix style consistent, and check off only the last two items.`,
      );
      console.log(`${chalk.bold('Agent:')} ${chalk.cyan(result2.finalOutput)}`);
    });

    console.log(`\n\n${chalk.dim('Final tasks.md:')}`);
    const finalNotes = await readFile(
      path.join(workspaceRoot, 'tasks.md'),
      'utf8',
    );
    console.log(finalNotes);
  } catch (err) {
    console.error(err);
  } finally {
    await session.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
