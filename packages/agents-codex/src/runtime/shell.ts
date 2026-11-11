import { z } from 'zod';
import {
  createShellTool,
  type tool,
  type FunctionTool,
  type ToolContext,
  type ToolDecision,
} from './tools';

export interface ShellSkill {
  readonly description: string;
  readonly name: string;
  readonly path: string;
}

export interface ShellCall {
  readonly type: 'shell_call';
  readonly call_id: string;
  readonly id?: string;
  readonly status?: string | null;
  readonly action: {
    readonly commands: readonly string[];
    readonly timeout_ms?: number | null;
    readonly max_output_length?: number | null;
  };
}

export interface ShellCommandOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly outcome:
    | { readonly type: 'exit'; readonly exit_code: number }
    | { readonly type: 'timeout' };
}

export interface ShellOutput {
  readonly output: readonly ShellCommandOutput[];
  readonly max_output_length?: number | null;
}

const shellCallSchema: z.ZodType<ShellCall> = z.looseObject({
  type: z.literal('shell_call'),
  call_id: z.string(),
  id: z.string().optional(),
  status: z.string().nullable().optional(),
  action: z.looseObject({
    commands: z.array(z.string()),
    timeout_ms: z.number().nullable().optional(),
    max_output_length: z.number().nullable().optional(),
  }),
});

const shellOutputSchema: z.ZodType<ShellOutput> = z.object({
  output: z.array(
    z.object({
      stdout: z.string(),
      stderr: z.string(),
      outcome: z.discriminatedUnion('type', [
        z.object({ type: z.literal('exit'), exit_code: z.number() }),
        z.object({ type: z.literal('timeout') }),
      ]),
    }),
  ),
  max_output_length: z.number().nullable().optional(),
});

type ShellPolicies<Context> = Pick<
  Parameters<
    typeof tool<typeof shellCallSchema, Context, typeof shellOutputSchema>
  >[0],
  | 'needsApproval'
  | 'runBeforeApproval'
  | 'callbackTimeout'
  | 'timeoutBehavior'
  | 'timeoutErrorFunction'
  | 'errorFunction'
>;

type ShellBeforeDecision = Exclude<
  ToolDecision,
  { action: 'replaceArguments' }
>;

export interface ShellToolOptions<
  Context = unknown,
> extends ShellPolicies<Context> {
  readonly skills?: readonly ShellSkill[];
  readonly before?: (
    context: ToolContext<Context>,
  ) => ShellBeforeDecision | Promise<ShellBeforeDecision>;
  readonly execute: (
    call: ShellCall,
    context: ToolContext<Context>,
  ) => ShellOutput | Promise<ShellOutput>;
}

/** Application-owned execution for modern Responses shell calls. */
export function shellTool<Context = unknown>(
  options: ShellToolOptions<Context>,
): FunctionTool<Context> {
  if (
    (options as ShellToolOptions<Context> & { after?: unknown }).after !==
    undefined
  )
    throw new TypeError('Shell output transformations belong in the executor');
  const skills = options.skills;
  return createShellTool<
    typeof shellCallSchema,
    Context,
    typeof shellOutputSchema
  >(
    {
      type: 'shell',
      ...(skills === undefined
        ? {}
        : { skills: skills.map((skill) => ({ ...skill })) }),
    },
    {
      execute: options.execute,
      needsApproval: options.needsApproval,
      runBeforeApproval: options.runBeforeApproval,
      before: options.before,
      callbackTimeout: options.callbackTimeout,
      timeoutBehavior: options.timeoutBehavior,
      timeoutErrorFunction: options.timeoutErrorFunction,
      errorFunction: options.errorFunction,
      name: 'shell',
      description: 'Execute commands using the application shell executor.',
      parameters: shellCallSchema,
      result: shellOutputSchema,
    },
  );
}
