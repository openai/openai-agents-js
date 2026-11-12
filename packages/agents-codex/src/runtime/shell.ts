import { z } from 'zod';
import { losslessJsonObjectSchema, type JsonObject } from './binding';
import {
  createShellTool,
  ToolOutput,
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
  /** Application-only command label retained with the accepted result. */
  readonly command?: string;
  /** Application-only metadata for this command's result. */
  readonly providerData?: JsonObject;
  readonly stdout: string;
  readonly stderr: string;
  readonly outcome:
    | { readonly type: 'exit'; readonly exit_code: number }
    | { readonly type: 'timeout' };
}

export interface ShellOutput {
  /** Application-only metadata for the Shell executor's result. */
  readonly providerData?: JsonObject;
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

const shellCommandOutputSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  outcome: z.discriminatedUnion('type', [
    z.object({ type: z.literal('exit'), exit_code: z.number() }),
    z.object({ type: z.literal('timeout') }),
  ]),
});

/** @internal The same structured output contract applies to external reconciliation. */
export const shellOutputSchema: z.ZodType<ShellOutput> = z.object({
  output: z.array(shellCommandOutputSchema),
  max_output_length: z.number().nullable().optional(),
});

const shellExecutorOutputSchema: z.ZodType<ToolOutput> = z
  .object({
    output: z.array(
      shellCommandOutputSchema.extend({
        command: z.string().optional(),
        providerData: losslessJsonObjectSchema.optional(),
      }),
    ),
    max_output_length: z.number().nullable().optional(),
    providerData: losslessJsonObjectSchema.optional(),
  })
  .transform((value) => {
    const metadata: JsonObject = {};
    if (value.providerData !== undefined)
      metadata.providerData = value.providerData;
    const entries = value.output.map((entry) => {
      const data: JsonObject = {};
      if (entry.command !== undefined) data.command = entry.command;
      if (entry.providerData !== undefined)
        data.providerData = entry.providerData;
      return data;
    });
    if (entries.some((entry) => Object.keys(entry).length > 0))
      metadata.shellOutput = entries;
    return new ToolOutput(
      [
        {
          type: 'inputText',
          text: JSON.stringify(shellOutputSchema.parse(value)),
        },
      ],
      true,
      metadata,
    );
  });

type ShellPolicies<Context> = Pick<
  Parameters<
    typeof tool<typeof shellCallSchema, Context, z.ZodType<ShellOutput>>
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
    typeof shellExecutorOutputSchema
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
      result: shellExecutorOutputSchema,
    },
    shellOutputSchema,
  );
}
