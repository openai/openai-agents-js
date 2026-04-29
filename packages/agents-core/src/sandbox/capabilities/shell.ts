import { z } from 'zod';
import { UserError } from '../../errors';
import { tool, type Tool } from '../../tool';
import type { ExecCommandArgs, WriteStdinArgs } from '../session';
import { withSandboxSpan } from '../runtime/spans';
import {
  Capability,
  type ConfigureCapabilityTools,
  requireBoundSession,
} from './base';

const DEFAULT_EXEC_YIELD_TIME_MS = 10_000;
const DEFAULT_WRITE_STDIN_YIELD_TIME_MS = 250;

const SHELL_INSTRUCTIONS = [
  'When using the shell:',
  '- Use `exec_command` for shell execution.',
  '- If available, use `write_stdin` to interact with or poll running sessions.',
  '- To interrupt a long-running process via `write_stdin`, start it with `tty=true` and send Ctrl-C (`\\u0003`).',
  '- Prefer `rg` and `rg --files` for text/file discovery when available.',
  '- Avoid using Python scripts just to print large file chunks.',
].join('\n');

export type ShellArgs = {
  configureTools?: ConfigureCapabilityTools;
};

class ShellCapability extends Capability {
  readonly type = 'shell';
  private readonly configureTools?: ConfigureCapabilityTools;

  constructor(args: ShellArgs = {}) {
    super();
    this.configureTools = args.configureTools;
  }

  override tools(): Tool<any>[] {
    const session = requireBoundSession(this.type, this._session);
    if (!session.execCommand) {
      throw new UserError('Shell sandbox sessions must provide execCommand().');
    }

    const tools: Tool<any>[] = [
      tool({
        name: 'exec_command',
        description:
          'Runs a command in a PTY, returning output or a session ID for ongoing interaction.',
        parameters: z.object({
          cmd: z.string().min(1).describe('Shell command to execute.'),
          workdir: z
            .string()
            .optional()
            .describe(
              'Optional working directory to run the command in; defaults to the turn cwd.',
            ),
          shell: z
            .string()
            .optional()
            .describe(
              "Shell binary to launch. Defaults to the user's default shell.",
            ),
          login: z
            .boolean()
            .default(true)
            .describe(
              'Whether to run the shell with -l/-i semantics. Defaults to true.',
            ),
          tty: z
            .boolean()
            .default(false)
            .describe(
              'Whether to allocate a TTY for the command. Defaults to false (plain pipes); set to true to open a PTY and access TTY process.',
            ),
          yield_time_ms: z
            .number()
            .int()
            .min(0)
            .default(DEFAULT_EXEC_YIELD_TIME_MS)
            .describe(
              'How long to wait (in milliseconds) for output before yielding.',
            ),
          max_output_tokens: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe(
              'Maximum number of tokens to return. Excess output will be truncated.',
            ),
        }),
        execute: async ({
          cmd,
          workdir,
          shell,
          login,
          tty,
          yield_time_ms,
          max_output_tokens,
        }: {
          cmd: string;
          workdir?: string;
          shell?: string;
          login: boolean;
          tty: boolean;
          yield_time_ms: number;
          max_output_tokens?: number;
        }): Promise<string> =>
          await withSandboxSpan(
            'sandbox.exec',
            {
              cmd,
              workdir,
              shell,
              login,
              tty,
              run_as: this._runAs,
            },
            async () =>
              await session.execCommand!({
                cmd,
                workdir,
                shell,
                login,
                tty,
                yieldTimeMs: yield_time_ms,
                maxOutputTokens: max_output_tokens,
                runAs: this._runAs,
              } satisfies ExecCommandArgs),
          ),
      }),
    ];

    if (session.supportsPty?.() && session.writeStdin) {
      tools.push(
        tool({
          name: 'write_stdin',
          description:
            'Writes characters to an existing unified exec session and returns recent output.',
          parameters: z.object({
            session_id: z
              .number()
              .int()
              .describe('Identifier of the running unified exec session.'),
            chars: z
              .string()
              .default('')
              .describe('Bytes to write to stdin (may be empty to poll).'),
            yield_time_ms: z
              .number()
              .int()
              .min(0)
              .default(DEFAULT_WRITE_STDIN_YIELD_TIME_MS)
              .describe(
                'How long to wait (in milliseconds) for output before yielding.',
              ),
            max_output_tokens: z
              .number()
              .int()
              .min(1)
              .optional()
              .describe(
                'Maximum number of tokens to return. Excess output will be truncated.',
              ),
          }),
          execute: async ({
            session_id,
            chars,
            yield_time_ms,
            max_output_tokens,
          }: {
            session_id: number;
            chars: string;
            yield_time_ms: number;
            max_output_tokens?: number;
          }): Promise<string> =>
            await withSandboxSpan(
              'sandbox.write_stdin',
              {
                session_id,
              },
              async () =>
                await session.writeStdin!({
                  sessionId: session_id,
                  chars,
                  yieldTimeMs: yield_time_ms,
                  maxOutputTokens: max_output_tokens,
                } satisfies WriteStdinArgs),
            ),
        }),
      );
    }

    return this.configureTools ? this.configureTools([...tools]) : tools;
  }

  override instructions(): string {
    return SHELL_INSTRUCTIONS;
  }
}

export type Shell = ShellCapability;

export function shell(args: ShellArgs = {}): Shell {
  return new ShellCapability(args);
}
