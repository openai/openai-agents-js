import {
  RunContext,
  Usage,
  UserError,
  createCustomSpan,
  tool,
} from '@openai/agents';
import type {
  CustomSpanData,
  FunctionTool,
  Span,
  JsonObjectSchemaStrict,
} from '@openai/agents';
import type {
  Codex,
  CodexOptions,
  CommandExecutionItem,
  McpToolCallItem,
  ReasoningItem,
  RunStreamedResult,
  SandboxMode,
  Thread,
  ThreadItem,
  ThreadOptions,
  TurnOptions,
  Usage as CodexUsage,
  UserInput,
} from '@openai/codex-sdk';
import { z } from 'zod';

type CustomSpan = Span<CustomSpanData>;

type CodexToolCallArguments = {
  task: string;
  inputs?: UserInput[];
  threadId?: string;
  sandboxMode?: SandboxMode;
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
};

const SANDBOX_MODES = [
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const;

const JSON_PRIMITIVE_TYPES = [
  'string',
  'number',
  'integer',
  'boolean',
] as const;

const CodexToolInputItemSchema = z
  .object({
    type: z.enum(['text', 'local_image']),
    text: z.string(),
    path: z.string(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const textValue = value.text.trim();
    const pathValue = value.path.trim();

    if (value.type === 'text') {
      if (textValue.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Text inputs must include a non-empty "text" field.',
          path: ['text'],
        });
      }
      if (pathValue.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: '"path" is not allowed when type is "text".',
          path: ['path'],
        });
      }
      return;
    }

    if (pathValue.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Local image inputs must include a non-empty "path" field.',
        path: ['path'],
      });
    }
    if (textValue.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '"text" is not allowed when type is "local_image".',
        path: ['text'],
      });
    }
  });

const OutputSchemaPrimitiveSchema = z
  .object({
    type: z.enum(JSON_PRIMITIVE_TYPES),
    description: z.string().trim().optional(),
    enum: z.array(z.string().trim().min(1)).min(1).optional(),
  })
  .strict();

const OutputSchemaArraySchema = z
  .object({
    type: z.literal('array'),
    description: z.string().trim().optional(),
    items: OutputSchemaPrimitiveSchema,
  })
  .strict();

const OutputSchemaFieldSchema = z.union([
  OutputSchemaPrimitiveSchema,
  OutputSchemaArraySchema,
]);

const OutputSchemaPropertyDescriptorSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().trim().optional(),
    schema: OutputSchemaFieldSchema,
  })
  .strict();

const OutputSchemaDescriptorSchema = z
  .object({
    title: z.string().trim().optional(),
    description: z.string().trim().optional(),
    properties: z
      .array(OutputSchemaPropertyDescriptorSchema)
      .min(1)
      .describe(
        'Property descriptors for the Codex response. Each property name must be unique.',
      ),
    required: z.array(z.string().trim().min(1)).optional(),
  })
  .strict()
  .superRefine((descriptor, ctx) => {
    const seen = new Set<string>();
    for (const property of descriptor.properties) {
      if (seen.has(property.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate property name "${property.name}" in output_schema.`,
          path: ['properties'],
        });
        break;
      }
      seen.add(property.name);
    }
    if (descriptor.required) {
      for (const name of descriptor.required) {
        if (!seen.has(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Required property "${name}" must also be defined in "properties".`,
            path: ['required'],
          });
        }
      }
    }
  });

const codexParametersSchema = z
  .object({
    task: z
      .string()
      .trim()
      .min(1, 'Codex tool requires a non-empty "task" string.')
      .describe(
        'Detailed instruction for the Codex agent. Provide enough context for the agent to act.',
      ),
    thread_id: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .describe(
        'Resume an existing Codex thread by id. Provide null to start a new thread.',
      ),
    sandbox_mode: z
      .enum(SANDBOX_MODES)
      .nullable()
      .describe(
        'Sandbox permissions for the Codex task. Provide null to use Codex defaults.',
      ),
    working_directory: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .describe(
        'Absolute path used as the working directory for the Codex thread. Provide null to default to the current process working directory.',
      ),
    skip_git_repo_check: z
      .boolean()
      .nullable()
      .describe(
        'Allow Codex to run outside a Git repository when true. Provide null to use Codex defaults.',
      ),
    inputs: z
      .array(CodexToolInputItemSchema)
      .nullable()
      .describe(
        'Optional structured inputs appended after the task. Provide null when no additional inputs are needed.',
      ),
  })
  .strict();

type CodexToolParametersSchema = typeof codexParametersSchema;
type CodexToolParameters = z.infer<CodexToolParametersSchema>;
type OutputSchemaDescriptor = z.infer<typeof OutputSchemaDescriptorSchema>;
type OutputSchemaField = z.infer<typeof OutputSchemaFieldSchema>;

const codexParametersJsonSchema: JsonObjectSchemaStrict<{
  task: { type: 'string'; description: string };
  thread_id: { type: ['string', 'null']; description: string };
  sandbox_mode: {
    type: ['string', 'null'];
    description: string;
    enum: typeof SANDBOX_MODES extends readonly (infer U)[] ? U[] : string[];
  };
  working_directory: { type: ['string', 'null']; description: string };
  skip_git_repo_check: { type: ['boolean', 'null']; description: string };
  inputs: {
    type: ['array', 'null'];
    description: string;
    items: {
      type: 'object';
      additionalProperties: false;
      required: ['type', 'text', 'path'];
      properties: {
        type: { type: 'string'; enum: ['text', 'local_image'] };
        text: { type: 'string'; description: string };
        path: { type: 'string'; description: string };
      };
    };
  };
}> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'task',
    'thread_id',
    'sandbox_mode',
    'working_directory',
    'skip_git_repo_check',
    'inputs',
  ],
  properties: {
    task: {
      type: 'string',
      description:
        'Detailed instruction for the Codex agent. Provide enough context for the agent to act.',
    },
    thread_id: {
      type: ['string', 'null'],
      description:
        'Resume an existing Codex thread by id. Set to null when starting a new thread.',
    },
    sandbox_mode: {
      type: ['string', 'null'],
      enum: [...SANDBOX_MODES],
      description:
        'Sandbox permissions for the Codex task. Set to null to use Codex defaults.',
    },
    working_directory: {
      type: ['string', 'null'],
      description:
        'Absolute path used as the working directory for the Codex thread. Set to null to use the current process directory.',
    },
    skip_git_repo_check: {
      type: ['boolean', 'null'],
      description:
        'Allow Codex to run outside a Git repository when true. Set to null to use the Codex default (false).',
    },
    inputs: {
      type: ['array', 'null'],
      description:
        'Optional structured inputs appended after the task. Supports additional text snippets and local images.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'text', 'path'],
        properties: {
          type: {
            type: 'string',
            enum: ['text', 'local_image'],
          },
          text: {
            type: 'string',
            description:
              'Text content added to the Codex task. Provide a non-empty string when the input type is "text"; otherwise set this to an empty string.',
          },
          path: {
            type: 'string',
            description:
              'Absolute or relative path to an image on disk when the input type is "local_image"; otherwise set this to an empty string.',
          },
        },
      },
    },
  },
};

type CodexToolOptions = {
  /**
   * Name of the tool as exposed to the agent model.
   *
   * @defaultValue `'codex'`
   */
  name?: string;
  /**
   * Description surfaced to the agent model.
   */
  description?: string;
  /**
   * Explicit Zod parameter schema. When omitted, the default schema is used.
   */
  parameters?: CodexToolParametersSchema;
  /**
   * Optional descriptor or JSON schema used for Codex structured output.
   * This schema is applied to every Codex turn unless overridden at call time.
   */
  outputSchema?: OutputSchemaDescriptor | Record<string, unknown>;
  /**
   * Reuse an existing Codex instance. When omitted a new Codex instance will be created.
   */
  codex?: Codex;
  /**
   * Options passed to the Codex constructor when {@link CodexToolOptions.codex} is undefined.
   */
  codexOptions?: CodexOptions;
  /**
   * Default options applied to every Codex thread.
   */
  defaultThreadOptions?: ThreadOptions;
  /**
   * Default options applied to every Codex turn.
   */
  defaultTurnOptions?: TurnOptions;
};

type CodexModule = typeof import('@openai/codex-sdk');

let cachedCodexModulePromise: Promise<CodexModule> | null = null;

async function importCodexModule(): Promise<CodexModule> {
  if (!cachedCodexModulePromise) {
    // The Codex SDK only ships ESM. Wrapping dynamic import in a Function keeps the call site
    // as `import()` in both ESM and CommonJS builds so we avoid generating a `require()` call.
    cachedCodexModulePromise = new Function(
      'specifier',
      'return import(specifier);',
    )('@openai/codex-sdk') as Promise<CodexModule>;
  }
  return cachedCodexModulePromise;
}

function createCodexResolver(
  providedCodex: Codex | undefined,
  options: CodexOptions | undefined,
): () => Promise<Codex> {
  if (providedCodex) {
    return async () => providedCodex;
  }

  let codexInstance: Codex | null = null;
  return async () => {
    if (!codexInstance) {
      const { Codex } = await importCodexModule();
      codexInstance = new Codex(options);
    }
    return codexInstance;
  };
}

const defaultParameters = codexParametersSchema;

type CodexToolResult = {
  threadId: string | null;
  response: string;
  usage: CodexUsage | null;
};

/**
 * Wraps the Codex SDK in a function tool that can be consumed by the Agents SDK.
 *
 * The tool streams Codex events, creating child spans for reasoning items, command executions,
 * and MCP tool invocations. Those spans are nested under the Codex tool span automatically when
 * tracing is enabled.
 */
export function codexTool(
  options: CodexToolOptions = {},
): FunctionTool<unknown, typeof codexParametersJsonSchema, CodexToolResult> {
  const {
    name = 'codex',
    description = 'Executes an agentic Codex task against the current workspace.',
    parameters = defaultParameters,
    codex: providedCodex,
    codexOptions,
    defaultThreadOptions,
    defaultTurnOptions,
    outputSchema: outputSchemaOption,
  } = options;

  const resolveCodex = createCodexResolver(providedCodex, codexOptions);

  const validatedOutputSchema = resolveOutputSchema(outputSchemaOption);

  return tool<typeof codexParametersJsonSchema, unknown, CodexToolResult>({
    name,
    description,
    parameters: codexParametersJsonSchema,
    strict: true,
    execute: async (input, runContext = new RunContext()) => {
      const parsed = parameters.parse(input);
      const args = normalizeParameters(parsed);

      const codex = await resolveCodex();
      const thread = getThread(codex, args, defaultThreadOptions);
      const turnOptions = buildTurnOptions(
        args,
        defaultTurnOptions,
        validatedOutputSchema,
      );
      const codexInput = buildCodexInput(args);

      const streamResult = await thread.runStreamed(codexInput, turnOptions);

      const { response, usage } = await consumeEvents(streamResult, args);

      if (usage) {
        runContext.usage.add(
          new Usage({
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            total_tokens: usage.input_tokens + usage.output_tokens,
            requests: 1,
          }),
        );
      }

      return {
        threadId: thread.id,
        response,
        usage,
      };
    },
    needsApproval: false,
    isEnabled: true,
  });
}

export type CodexOutputSchemaDescriptor = OutputSchemaDescriptor;
export type CodexOutputSchema = Record<string, unknown>;

function resolveOutputSchema(
  option?: OutputSchemaDescriptor | Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!option) {
    return undefined;
  }

  if (isJsonObjectSchema(option)) {
    if (option.additionalProperties !== false) {
      throw new UserError(
        'Codex output schema must set "additionalProperties" to false.',
      );
    }
    return option;
  }

  const descriptor = OutputSchemaDescriptorSchema.parse(option);
  return buildCodexOutputSchema(descriptor);
}

function buildTurnOptions(
  args: CodexToolCallArguments,
  defaults: TurnOptions | undefined,
  outputSchema: Record<string, unknown> | undefined,
): TurnOptions | undefined {
  const hasOverrides =
    typeof args.sandboxMode !== 'undefined' ||
    typeof args.workingDirectory === 'string' ||
    typeof args.skipGitRepoCheck === 'boolean';

  if (!defaults && !hasOverrides && !outputSchema) {
    return undefined;
  }

  return {
    ...(defaults ?? {}),
    ...(outputSchema ? { outputSchema } : {}),
  };
}

function normalizeParameters(
  params: CodexToolParameters,
): CodexToolCallArguments {
  const inputs = params.inputs
    ? params.inputs.map<UserInput>((item) =>
        item.type === 'text'
          ? { type: 'text', text: item.text.trim() }
          : { type: 'local_image', path: item.path.trim() },
      )
    : undefined;

  const sandboxModeCandidate = params.sandbox_mode ?? undefined;
  const sandboxMode =
    sandboxModeCandidate && SANDBOX_MODES.includes(sandboxModeCandidate)
      ? sandboxModeCandidate
      : undefined;

  return {
    task: params.task.trim(),
    inputs: inputs && inputs.length > 0 ? inputs : undefined,
    threadId:
      typeof params.thread_id === 'string' && params.thread_id.trim().length > 0
        ? params.thread_id.trim()
        : undefined,
    sandboxMode,
    workingDirectory:
      typeof params.working_directory === 'string' &&
      params.working_directory.trim().length > 0
        ? params.working_directory.trim()
        : undefined,
    skipGitRepoCheck:
      typeof params.skip_git_repo_check === 'boolean'
        ? params.skip_git_repo_check
        : undefined,
  };
}

function buildCodexOutputSchema(
  descriptor: OutputSchemaDescriptor,
): Record<string, unknown> {
  const properties = Object.fromEntries(
    descriptor.properties.map((property) => [
      property.name,
      buildCodexOutputSchemaField(property.schema),
    ]),
  );

  const required = Array.from(
    new Set([
      ...descriptor.properties.map((property) => property.name),
      ...(descriptor.required ?? []),
    ]),
  );

  const schema: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    properties,
    required,
  };

  if (descriptor.title) {
    schema.title = descriptor.title;
  }

  if (descriptor.description) {
    schema.description = descriptor.description;
  }

  return schema;
}

function buildCodexOutputSchemaField(
  field: OutputSchemaField,
): Record<string, unknown> {
  if (field.type === 'array') {
    return {
      type: 'array',
      items: buildCodexOutputSchemaPrimitive(field.items),
    };
  }

  return buildCodexOutputSchemaPrimitive(field);
}

function buildCodexOutputSchemaPrimitive(
  field: z.infer<typeof OutputSchemaPrimitiveSchema>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    type: field.type,
  };

  if (field.enum) {
    result.enum = field.enum;
  }

  return result;
}

type JsonObjectSchemaCandidate = {
  type: string;
  additionalProperties?: unknown;
  [key: string]: unknown;
};

function isJsonObjectSchema(
  value: unknown,
): value is JsonObjectSchemaCandidate {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as JsonObjectSchemaCandidate;
  return record.type === 'object';
}

function getThread(
  codex: Codex,
  args: CodexToolCallArguments,
  defaults?: ThreadOptions,
): Thread {
  const hasOverrides =
    typeof args.sandboxMode !== 'undefined' ||
    typeof args.workingDirectory === 'string' ||
    typeof args.skipGitRepoCheck === 'boolean';

  const threadOptions: ThreadOptions | undefined =
    defaults || hasOverrides
      ? {
          ...(defaults ?? {}),
          ...(args.sandboxMode ? { sandboxMode: args.sandboxMode } : {}),
          ...(args.workingDirectory
            ? { workingDirectory: args.workingDirectory }
            : {}),
          ...(typeof args.skipGitRepoCheck === 'boolean'
            ? { skipGitRepoCheck: args.skipGitRepoCheck }
            : {}),
        }
      : undefined;

  if (args.threadId) {
    return codex.resumeThread(args.threadId, threadOptions);
  }
  return codex.startThread(threadOptions);
}

function buildCodexInput(args: CodexToolCallArguments): string | UserInput[] {
  if (args.inputs && args.inputs.length > 0) {
    const base: UserInput[] = args.task.trim().length
      ? [{ type: 'text', text: args.task }]
      : [];
    return base.concat(args.inputs);
  }
  return args.task;
}

async function consumeEvents(
  { events }: RunStreamedResult,
  args: CodexToolCallArguments,
): Promise<{ response: string; usage: CodexUsage | null }> {
  const activeSpans = new Map<string, CustomSpan>();
  let finalResponse = '';
  let usage: CodexUsage | null = null;

  try {
    for await (const event of events) {
      switch (event.type) {
        case 'item.started':
          handleItemStarted(event.item, activeSpans);
          break;
        case 'item.updated':
          handleItemUpdated(event.item, activeSpans);
          break;
        case 'item.completed':
          handleItemCompleted(event.item, activeSpans);
          if (
            event.item.type === 'agent_message' &&
            typeof event.item.text === 'string'
          ) {
            finalResponse = event.item.text;
          }
          break;
        case 'turn.completed':
          usage = event.usage ?? null;
          break;
        case 'turn.failed':
          throw new UserError(
            `Codex turn failed${event.error?.message ? `: ${event.error.message}` : ''}`,
          );
        case 'error':
          throw new UserError(`Codex stream error: ${event.message}`);
        default:
          // ignore other events
          break;
      }
    }
  } finally {
    for (const span of activeSpans.values()) {
      span.end();
    }
    activeSpans.clear();
  }

  if (!finalResponse) {
    finalResponse = buildDefaultResponse(args);
  }

  return { response: finalResponse, usage };
}

function handleItemStarted(item: ThreadItem, spans: Map<string, CustomSpan>) {
  if (isCommandExecutionItem(item)) {
    const span = createCustomSpan({
      data: {
        name: 'Codex command execution',
        data: {
          command: item.command,
          status: item.status,
          output: item.aggregated_output ?? '',
          exitCode: item.exit_code ?? null,
        },
      },
    });
    span.start();
    spans.set(item.id, span);
    return;
  }

  if (isMcpToolCallItem(item)) {
    const span = createCustomSpan({
      data: {
        name: `Codex MCP tool call`,
        data: {
          server: item.server,
          tool: item.tool,
          status: item.status,
          arguments: item.arguments ?? null,
        },
      },
    });
    span.start();
    spans.set(item.id, span);
    return;
  }

  if (isReasoningItem(item)) {
    const span = createCustomSpan({
      data: {
        name: 'Codex reasoning',
        data: {
          text: item.text,
        },
      },
    });
    span.start();
    spans.set(item.id, span);
  }
}

function handleItemUpdated(item: ThreadItem, spans: Map<string, CustomSpan>) {
  const span = item.id ? spans.get(item.id) : undefined;
  if (!span) {
    return;
  }

  if (isCommandExecutionItem(item)) {
    updateCommandSpan(span, item);
  } else if (isMcpToolCallItem(item)) {
    updateMcpToolSpan(span, item);
  } else if (isReasoningItem(item)) {
    updateReasoningSpan(span, item);
  }
}

function handleItemCompleted(item: ThreadItem, spans: Map<string, CustomSpan>) {
  const span = item.id ? spans.get(item.id) : undefined;
  if (!span) {
    return;
  }

  if (isCommandExecutionItem(item)) {
    updateCommandSpan(span, item);
    if (item.status === 'failed') {
      span.setError({
        message: 'Codex command execution failed.',
        data: {
          exitCode: item.exit_code ?? null,
          output: item.aggregated_output ?? '',
        },
      });
    }
  } else if (isMcpToolCallItem(item)) {
    updateMcpToolSpan(span, item);
    if (item.status === 'failed' && item.error?.message) {
      span.setError({
        message: item.error.message,
      });
    }
  } else if (isReasoningItem(item)) {
    updateReasoningSpan(span, item);
  }

  span.end();
  spans.delete(item.id);
}

function updateCommandSpan(span: CustomSpan, item: CommandExecutionItem) {
  const data = span.spanData.data;
  data.command = item.command;
  data.status = item.status;
  data.output = item.aggregated_output ?? '';
  data.exitCode = item.exit_code ?? null;
}

function updateMcpToolSpan(span: CustomSpan, item: McpToolCallItem) {
  const data = span.spanData.data;
  data.server = item.server;
  data.tool = item.tool;
  data.status = item.status;
  data.arguments = item.arguments ?? null;
  data.result = item.result ?? null;
  data.error = item.error ?? null;
}

function updateReasoningSpan(span: CustomSpan, item: ReasoningItem) {
  const data = span.spanData.data;
  data.text = item.text;
}

function buildDefaultResponse(args: CodexToolCallArguments): string {
  return `Codex task completed for "${args.task}".`;
}

function isCommandExecutionItem(
  item: ThreadItem,
): item is CommandExecutionItem {
  return item?.type === 'command_execution';
}

function isMcpToolCallItem(item: ThreadItem): item is McpToolCallItem {
  return item?.type === 'mcp_tool_call';
}

function isReasoningItem(item: ThreadItem): item is ReasoningItem {
  return item?.type === 'reasoning';
}
