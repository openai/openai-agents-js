import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';
import {
  Agent,
  run,
  withTrace,
  Shell,
  ShellAction,
  ShellResult,
  ShellOutputResult,
  shellTool,
} from '@openai/agents';
import chalk from 'chalk';

const execAsync = promisify(exec);

class LocalShell implements Shell {
  constructor(private readonly cwd: string = process.cwd()) {}

  async run(action: ShellAction): Promise<ShellResult> {
    const output: ShellResult['output'] = [];

    for (const command of action.commands) {
      let stdout = '';
      let stderr = '';
      let exitCode: number | null = 0;
      let outcome: ShellOutputResult['outcome'] = {
        type: 'exit',
        exitCode: 0,
      };
      try {
        const { stdout: localStdout, stderr: localStderr } = await execAsync(
          command,
          {
            cwd: this.cwd,
            timeout: action.timeoutMs,
            maxBuffer: action.maxOutputLength,
          },
        );
        stdout = localStdout;
        stderr = localStderr;
      } catch (error: any) {
        exitCode = typeof error?.code === 'number' ? error.code : null;
        stdout = error?.stdout ?? '';
        stderr = error?.stderr ?? '';
        outcome =
          error?.killed || error?.signal === 'SIGTERM'
            ? { type: 'timeout' }
            : { type: 'exit', exitCode };
      }
      output.push({
        command,
        stdout,
        stderr,
        outcome,
      });
      if (outcome.type === 'timeout') {
        break;
      }
    }

    return {
      output,
      providerData: {
        working_directory: this.cwd,
      },
    };
  }
}

async function promptShellApproval(commands: string[]): Promise<boolean> {
  if (process.env.SHELL_AUTO_APPROVE === '1') {
    return true;
  }

  console.log(
    chalk.bold.bgYellow.black(' Shell command approval required: \n'),
  );
  commands.forEach((cmd) => console.log(chalk.dim(`  > ${cmd}`)));
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question('\nProceed? [y/N] ');
    const approved = answer.trim().toLowerCase();
    return approved === 'y' || approved === 'yes';
  } finally {
    rl.close();
  }
}

async function main() {
  const shell = new LocalShell();

  const agent = new Agent({
    name: 'Shell Assistant',
    model: 'gpt-5.2',
    instructions:
      'You can execute shell commands to inspect the repository. Keep responses concise and include command output when helpful.',
    tools: [
      shellTool({
        shell,
        // could also be a function for you to determine if approval is needed
        needsApproval: true,
        onApproval: async (_ctx, approvalItem) => {
          const commands =
            approvalItem.rawItem.type === 'shell_call'
              ? approvalItem.rawItem.action.commands
              : [];
          const approve = await promptShellApproval(commands);
          return { approve };
        },
      }),
    ],
  });

  await withTrace('shell-tool-example', async () => {
    const result = await run(agent, 'Show the Node.js version.');

    console.log(`${chalk.bold('Agent:')} ${chalk.cyan(result.finalOutput)}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
