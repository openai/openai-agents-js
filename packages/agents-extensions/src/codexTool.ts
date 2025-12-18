import {
  RunContext,
  Usage,
  UserError,
  createCustomSpan,
  tool,
  getDefaultOpenAIKey,
} from '@openai/agents';
import { loadEnv } from '@openai/agents-core/_shims';
import { isZodObject, zodJsonSchemaCompat } from '@openai/agents-core/utils';
import type { CustomSpanData, FunctionTool, Span } from '@openai/agents';
import {
  Codex,
  type CodexOptions,
  type CommandExecutionItem,
  type McpToolCallItem,
  type ReasoningItem,
  type RunStreamedResult,
  type SandboxMode,
  type Thread,
  type ThreadItem,
  type ThreadOptions,
  type TurnOptions,
  type Usage as CodexUsage,
  type UserInput,
} from '@openai/codex-sdk';
import { z } from 'zod';

type CustomSpan = Span<CustomSpanData>;

type CodexToolCallArguments = {
  inputs?: UserInput[];
};

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
    inputs: z
      .array(CodexToolInputItemSchema)
      .min(1, 'Codex tool requires at least one input item.')
      .describe(
        'Structured inputs appended to the Codex task. Provide at least one input item.',
      ),
  })
  .strict();

type CodexToolParametersSchema = typeof codexParametersSchema;
type CodexToolParameters = z.infer<CodexToolParametersSchema>;
type OutputSchemaDescriptor = z.infer<typeof OutputSchemaDescriptorSchema>;
type OutputSchemaField = z.infer<typeof OutputSchemaFieldSchema>;

export type CodexToolOptions = {
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
  outputSchema?:
    | OutputSchemaDescriptor
    | Record<string, unknown>
    | z.ZodTypeAny;
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
   * Resume a specific Codex thread by id.
   */
  threadId?: string;
  /**
   * Sandbox permissions for the Codex task.
   */
  sandboxMode?: SandboxMode;
  /**
   * Absolute path used as the working directory for the Codex thread.
   */
  workingDirectory?: string;
  /**
   * Allow Codex to run outside a Git repository when true.
   */
  skipGitRepoCheck?: boolean;
  /**
   * Default options applied to every Codex turn.
   */
  defaultTurnOptions?: TurnOptions;
  /**
   * Reuse a single Codex thread across tool invocations.
   */
  persistSession?: boolean;
};

function resolveDefaultCodexApiKey(options?: CodexOptions): string | undefined {
  if (options?.apiKey) {
    return options.apiKey;
  }

  const envOverride = options?.env;
  if (envOverride?.CODEX_API_KEY) {
    return envOverride.CODEX_API_KEY;
  }
  if (envOverride?.OPENAI_API_KEY) {
    return envOverride.OPENAI_API_KEY;
  }

  const env = loadEnv();
  return env.CODEX_API_KEY ?? getDefaultOpenAIKey();
}

function resolveCodexOptions(
  options: CodexOptions | undefined,
): CodexOptions | undefined {
  if (options?.apiKey) {
    return options;
  }

  const apiKey = resolveDefaultCodexApiKey(options);
  if (!apiKey) {
    return options;
  }

  if (!options) {
    return { apiKey };
  }

  return { ...options, apiKey };
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
): FunctionTool<unknown, typeof codexParametersSchema, CodexToolResult> {
  const {
    name = 'codex',
    description = 'Executes an agentic Codex task against the current workspace.',
    parameters = defaultParameters,
    codex: providedCodex,
    codexOptions,
    defaultThreadOptions,
    defaultTurnOptions,
    outputSchema: outputSchemaOption,
    threadId: defaultThreadId,
    sandboxMode,
    workingDirectory,
    skipGitRepoCheck,
    persistSession = false,
  } = options;

  const resolvedCodexOptions = resolveCodexOptions(codexOptions);
  const resolveCodex = createCodexResolver(providedCodex, resolvedCodexOptions);

  const validatedOutputSchema = resolveOutputSchema(outputSchemaOption);
  const resolvedThreadOptions: ThreadOptions | undefined =
    defaultThreadOptions ||
    sandboxMode ||
    workingDirectory ||
    typeof skipGitRepoCheck === 'boolean'
      ? {
          ...(defaultThreadOptions ?? {}),
          ...(sandboxMode ? { sandboxMode } : {}),
          ...(workingDirectory ? { workingDirectory } : {}),
          ...(typeof skipGitRepoCheck === 'boolean'
            ? { skipGitRepoCheck }
            : {}),
        }
      : undefined;
  let persistedThread: Thread | null = null;

  return tool<typeof codexParametersSchema, unknown, CodexToolResult>({
    name,
    description,
    parameters,
    strict: true,
    execute: async (input, runContext = new RunContext()) => {
      const parsed = parameters.parse(input);
      const args = normalizeParameters(parsed);

      const codex = await resolveCodex();
      const thread = persistSession
        ? getOrCreatePersistedThread(
            codex,
            defaultThreadId,
            resolvedThreadOptions,
            persistedThread,
          )
        : getThread(codex, defaultThreadId, resolvedThreadOptions);
      if (persistSession && !persistedThread) {
        persistedThread = thread;
      }
      const turnOptions = buildTurnOptions(
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
  option?: OutputSchemaDescriptor | Record<string, unknown> | z.ZodTypeAny,
): Record<string, unknown> | undefined {
  if (!option) {
    return undefined;
  }

  if (isZodObject(option)) {
    const schema = zodJsonSchemaCompat(option);
    if (!schema) {
      throw new UserError(
        'Codex output schema must be a Zod object that can be converted to JSON Schema.',
      );
    }
    return schema;
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
  defaults: TurnOptions | undefined,
  outputSchema: Record<string, unknown> | undefined,
): TurnOptions | undefined {
  if (!defaults && !outputSchema) {
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
  const inputs = params.inputs.map<UserInput>((item) =>
    item.type === 'text'
      ? { type: 'text', text: item.text.trim() }
      : { type: 'local_image', path: item.path.trim() },
  );

  return {
    inputs: inputs && inputs.length > 0 ? inputs : undefined,
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
  threadId: string | undefined,
  defaults?: ThreadOptions,
): Thread {
  if (threadId) {
    return codex.resumeThread(threadId, defaults);
  }
  return codex.startThread(defaults);
}

function getOrCreatePersistedThread(
  codex: Codex,
  threadId: string | undefined,
  threadOptions: ThreadOptions | undefined,
  existingThread: Thread | null,
): Thread {
  if (existingThread) {
    if (threadId) {
      const existingId = existingThread.id;
      if (existingId && existingId !== threadId) {
        throw new UserError(
          'Codex tool is configured with persistSession=true and already has an active thread.',
        );
      }
    }

    return existingThread;
  }

  return getThread(codex, threadId, threadOptions);
}

function buildCodexInput(args: CodexToolCallArguments): string | UserInput[] {
  if (args.inputs && args.inputs.length > 0) {
    return args.inputs;
  }
  return '';
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
  const inputSummary = args.inputs?.length ? 'with inputs.' : 'with no inputs.';
  return `Codex task completed ${inputSummary}`;
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
