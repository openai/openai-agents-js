import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
  Agent,
  MemorySession,
  withTrace,
  applyPatchTool,
  type Editor,
  type ApplyPatchOperation,
  type ApplyPatchResult,
} from '@openai/agents';
import { exampleRunner } from './example-runner.ts';
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

export class WorkspaceEditor implements Editor {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

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
    const relative = path.relative(this.root, resolved);
    if (
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
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
  const useCodex = process.argv.includes('--codex');
  const runner = await exampleRunner(useCodex);
  const session = useCodex ? new MemorySession() : undefined;
  const workspaceRoot = await mkdtemp(
    path.join(os.tmpdir(), 'apply-patch-example-'),
  );
  console.log(chalk.dim(`Temporary workspace: ${chalk.cyan(workspaceRoot)}`));
  await seedWorkspace(workspaceRoot);
  const editor = new WorkspaceEditor(workspaceRoot);

  const agent = new Agent({
    name: 'Patch Assistant',
    model: useCodex ? process.env.CODEX_MODEL : 'gpt-5.4',
    modelSettings: {
      reasoning: { effort: 'low' },
    },
    instructions: `You can edit files inside ${workspaceRoot} using the apply_patch tool.
      For create_file, operation.diff contains only file-content lines prefixed with '+'.
      For update_file, use @@ hunks and context/+/- lines. Do not wrap operation.diff in
      *** Begin Patch, *** End Patch, filename headers, Markdown fences, or <BEGIN_FILES>.
      Use '- [ ] ' for unchecked items and '- [x] ' for checked items.
      Only perform the edit requested in the current user message.`,
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
      const result = await runner.run(
        agent,
        'Create tasks.md with exactly 5 unchecked shopping items. Do not check off any items.',
        { session },
      );
      console.log(`${chalk.bold('Agent:')} ${chalk.cyan(result.finalOutput)}`);
      const updatedNotes = await readFile(
        path.join(workspaceRoot, 'tasks.md'),
        'utf8',
      );
      console.log(`\n\n${chalk.dim('tasks.md after creation:')}`);
      console.log(updatedNotes);
      const originalItems = updatedNotes
        .split('\n')
        .map((line) => line.trimStart())
        .filter((line) => line.startsWith('- ['));
      if (
        originalItems.length !== 5 ||
        !originalItems.every((line) => line.startsWith('- [ ] '))
      ) {
        throw new Error(
          'Expected five unchecked shopping items after creation.',
        );
      }
      console.log(
        `\n\n${chalk.dim('Asking agent to check off the last two items …')}\n`,
      );
      const result2 = await runner.run(
        agent,
        `<BEGIN_FILES>\n===== tasks.md\n${updatedNotes}\n\n<END_FILES>\nUse the apply_patch tool to update tasks.md in place. Preserve the existing Markdown structure exactly, keep the \`- [ ]\` checklist prefix style consistent, and check off only the last two items.`,
        { session },
      );
      console.log(`${chalk.bold('Agent:')} ${chalk.cyan(result2.finalOutput)}`);
      const finalNotes = await readFile(
        path.join(workspaceRoot, 'tasks.md'),
        'utf8',
      );
      const finalItems = finalNotes
        .split('\n')
        .map((line) => line.trimStart())
        .filter((line) => line.startsWith('- ['));
      const expected = originalItems.map((line, index) =>
        index >= 3 ? line.replace('- [ ] ', '- [x] ') : line,
      );
      if (JSON.stringify(finalItems) !== JSON.stringify(expected)) {
        throw new Error(
          'Expected the same five checklist items with only the final two checked.',
        );
      }
      let itemIndex = 0;
      const expectedLines = updatedNotes
        .split('\n')
        .map((line) =>
          line.trimStart().startsWith('- [') ? expected[itemIndex++] : line,
        );
      const finalLines = finalNotes
        .split('\n')
        .map((line) =>
          line.trimStart().startsWith('- [') ? line.trimStart() : line,
        );
      if (JSON.stringify(finalLines) !== JSON.stringify(expectedLines)) {
        throw new Error(
          'The update changed content outside the two checkbox markers.',
        );
      }
    });

    console.log(`\n\n${chalk.dim('Final tasks.md:')}`);
    const finalNotes = await readFile(
      path.join(workspaceRoot, 'tasks.md'),
      'utf8',
    );
    console.log(finalNotes);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
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
