import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import {
  Agent,
  run,
  withTrace,
  type Shell,
  type ShellAction,
  type ShellResult,
  type ShellOutputResult,
  shellTool,
} from '@openai/agents';
import chalk from 'chalk';

const execAsync = promisify(exec);

// Approved commands retain access to host files and the network. This is not a
// sandbox. For isolated execution, see container-shell-inline-skill.ts or
// container-shell-skill-ref.ts in this directory.
class LocalShell implements Shell {
  private readonly cwd: string;

  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
  }

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
        // Pass only command lookup and Windows system-directory settings, not
        // application credentials or shell startup hooks.
        const env: NodeJS.ProcessEnv = {
          // Node otherwise forwards this setting even with an explicit env.
          NODE_V8_COVERAGE: undefined,
        };
        for (const key of Object.keys(process.env)) {
          if (
            key === 'PATH' ||
            (process.platform === 'win32' &&
              ['PATH', 'SYSTEMROOT'].includes(key.toUpperCase()))
          ) {
            env[key] = process.env[key];
          }
        }
        const pending = execAsync(command, {
          cwd: this.cwd,
          timeout: action.timeoutMs,
          maxBuffer: action.maxOutputLength,
          env,
        });
        pending.child.stdin?.end();
        const { stdout: localStdout, stderr: localStderr } = await pending;
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
  if (
    commands.length === 0 ||
    process.env.EXAMPLES_INTERACTIVE_MODE?.toLowerCase() === 'auto' ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    process.stdin.readableEnded ||
    process.stdin.destroyed
  ) {
    return false;
  }

  console.log(
    chalk.bold.bgYellow.black(
      ' These commands will run on your host without sandbox isolation: \n',
    ),
  );
  console.log('For isolated execution, use the container-shell examples.');
  for (const command of commands) {
    // Escape every non-ASCII code unit as well as JSON control characters so
    // terminal controls and bidirectional formatting cannot hide command text.
    const display = JSON.stringify(command).replace(
      /[\u007f-\uffff]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
    console.log(`  ${display}`);
  }
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let deny: () => void = () => {};
  try {
    return await new Promise<boolean>((resolve) => {
      deny = () => resolve(false);
      rl.once('close', deny);
      rl.once('SIGINT', deny);
      rl.question('\nProceed? [y/N] ', (answer) => {
        const approved = answer.trim().toLowerCase();
        resolve(approved === 'y' || approved === 'yes');
      });
    });
  } finally {
    rl.off('close', deny);
    rl.off('SIGINT', deny);
    rl.close();
  }
}

export function createShellAgent() {
  const shell = new LocalShell();

  return new Agent({
    name: 'Shell Assistant',
    model: 'gpt-5.4',
    instructions:
      'You can execute shell commands to inspect the repository. Keep responses concise and include command output when helpful.',
    tools: [
      shellTool({
        shell,
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
}

async function main() {
  const agent = createShellAgent();
  await withTrace('local-shell-tool-example', async () => {
    const result = await run(agent, 'Show the Node.js version.');

    console.log(`${chalk.bold('Agent:')} ${chalk.cyan(result.finalOutput)}`);
  });
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
