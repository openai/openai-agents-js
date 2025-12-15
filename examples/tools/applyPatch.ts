import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
  Agent,
  run,
  withTrace,
  applyPatchTool,
  Editor,
  ApplyPatchOperation,
  ApplyPatchResult,
} from '@openai/agents';
import { applyDiff } from '@openai/agents';
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

class WorkspaceEditor implements Editor {
  constructor(private readonly root: string) {}

  async createFile(
    operation: Extract<ApplyPatchOperation, { type: 'create_file' }>,
  ): Promise<ApplyPatchResult | void> {
    const targetPath = await this.resolve(operation.path);
    await mkdir(path.dirname(targetPath), { recursive: true });
    const content = applyDiff('', operation.diff, 'create');
    await writeFile(targetPath, content, 'utf8');
    return { status: 'completed', output: `Created ${operation.path}` };
  }

  async updateFile(
    operation: Extract<ApplyPatchOperation, { type: 'update_file' }>,
  ): Promise<ApplyPatchResult | void> {
    const targetPath = await this.resolve(operation.path);
    const original = await readFile(targetPath, 'utf8').catch((error: any) => {
      if (error?.code === 'ENOENT') {
        throw new Error(`Cannot update missing file: ${operation.path}`);
      }
      throw error;
    });
    const patched = applyDiff(original, operation.diff);
    await writeFile(targetPath, patched, 'utf8');
    return { status: 'completed', output: `Updated ${operation.path}` };
  }

  async deleteFile(
    operation: Extract<ApplyPatchOperation, { type: 'delete_file' }>,
  ): Promise<ApplyPatchResult | void> {
    const targetPath = await this.resolve(operation.path);
    await rm(targetPath, { force: true });
    return { status: 'completed', output: `Deleted ${operation.path}` };
  }

  private async resolve(relativePath: string): Promise<string> {
    const resolved = path.resolve(this.root, relativePath);
    if (!resolved.startsWith(this.root)) {
      throw new Error(`Operation outside workspace: ${relativePath}`);
    }
    return resolved;
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

async function seedWorkspace(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
}

async function main() {
  const workspaceRoot = await mkdtemp(
    path.join(os.tmpdir(), 'apply-patch-example-'),
  );
  console.log(chalk.dim(`Temporary workspace: ${chalk.cyan(workspaceRoot)}`));
  await seedWorkspace(workspaceRoot);
  const editor = new WorkspaceEditor(workspaceRoot);

  const agent = new Agent({
    name: 'Patch Assistant',
    model: 'gpt-5.2',
    instructions: `You can edit files inside ${workspaceRoot} using the apply_patch tool.`,
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

  try {
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
        `<BEGIN_FILES>\n===== tasks.md\n${updatedNotes}\n\n<END_FILES>\nCheck off the last two items from the file.`,
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
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
