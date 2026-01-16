import {
  RunContext,
  Usage,
  UserError,
  createCustomSpan,
  tool,
} from '@openai/agents';
import { loadEnv } from '@openai/agents-core/_shims';
import { isZodObject, toSmartString } from '@openai/agents-core/utils';
import type {
  CustomSpanData,
  FunctionCallItem,
  FunctionTool,
  Span,
} from '@openai/agents';
import {
  Codex,
  type CodexOptions,
  type CommandExecutionItem,
  type ErrorItem,
  type FileChangeItem,
  type McpToolCallItem,
  type ReasoningItem,
  type RunStreamedResult,
  type SandboxMode,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
  type TodoListItem,
  type TurnOptions,
  type Usage as CodexUsage,
  type UserInput,
  type WebSearchItem,
} from '@openai/codex-sdk';
import { z } from 'zod';

type CustomSpan = Span<CustomSpanData>;

type CodexToolCallArguments = {
  inputs?: UserInput[];
};

const MAX_SPAN_TEXT_LENGTH = 2000;
const MAX_SPAN_LIST_ITEMS = 200;
const MAX_TODO_TEXT_LENGTH = 200;

const CodexToolInputTextSchema = z
  .object({
    type: z.literal('text'),
    text: z
      .string()
      .trim()
      .min(1, 'Text inputs must include a non-empty "text" field.'),
  })
  .strict();

const CodexToolInputImageSchema = z
  .object({
    type: z.literal('local_image'),
    path: z
      .string()
      .trim()
      .min(1, 'Local image inputs must include a non-empty "path" field.'),
  })
  .strict();

const CodexToolInputItemSchema = z.union([
  CodexToolInputTextSchema,
  CodexToolInputImageSchema,
]);

const OutputSchemaStringSchema = z
  .object({
    type: z.literal('string'),
    description: z.string().trim().optional(),
    enum: z.array(z.string().trim().min(1)).min(1).optional(),
  })
  .strict();

const OutputSchemaNumberSchema = z
  .object({
    type: z.literal('number'),
    description: z.string().trim().optional(),
    enum: z.array(z.number()).min(1).optional(),
  })
  .strict();

const OutputSchemaIntegerSchema = z
  .object({
    type: z.literal('integer'),
    description: z.string().trim().optional(),
    enum: z.array(z.number().int()).min(1).optional(),
  })
  .strict();

const OutputSchemaBooleanSchema = z
  .object({
    type: z.literal('boolean'),
    description: z.string().trim().optional(),
    enum: z.array(z.boolean()).min(1).optional(),
  })
  .strict();

const OutputSchemaPrimitiveSchema = z.union([
  OutputSchemaStringSchema,
  OutputSchemaNumberSchema,
  OutputSchemaIntegerSchema,
  OutputSchemaBooleanSchema,
]);

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

export type CodexToolStreamEvent = {
  event: ThreadEvent;
  threadId: string | null;
  toolCall?: FunctionCallItem;
};

export type CodexToolStreamHandler = (
  event: CodexToolStreamEvent,
) => void | Promise<void>;

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
   * Custom schemas must be compatible with the default `inputs` shape.
   */
  parameters?: CodexToolParametersSchema;
  /**
   * Optional descriptor or JSON schema used for Codex structured output.
   * This schema is applied to every Codex turn.
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
  /**
   * Optional hook to receive streamed Codex events during execution.
   */
  onStream?: CodexToolStreamHandler;
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
  return env.CODEX_API_KEY ?? env.OPENAI_API_KEY;
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
    onStream,
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
    execute: async (input, runContext = new RunContext(), details) => {
      const args = normalizeParameters(input as CodexToolParameters);

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

      const {
        response,
        usage,
        threadId: streamedThreadId,
      } = await consumeEvents(streamResult, {
        args,
        onStream,
        toolCall: details?.toolCall,
      });
      const resolvedThreadId = thread.id ?? streamedThreadId;

      if (usage) {
        const inputTokensDetails =
          typeof usage.cached_input_tokens === 'number'
            ? { cached_input_tokens: usage.cached_input_tokens }
            : undefined;
        runContext.usage.add(
          new Usage({
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            total_tokens: usage.input_tokens + usage.output_tokens,
            input_tokens_details: inputTokensDetails,
            requests: 1,
          }),
        );
      }

      return {
        threadId: resolvedThreadId,
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
    descriptor.properties.map((property) => {
      const schema = buildCodexOutputSchemaField(property.schema);
      if (property.description) {
        schema.description = property.description;
      }
      return [property.name, schema];
    }),
  );

  const required = descriptor.required
    ? Array.from(new Set(descriptor.required))
    : undefined;

  const schema: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    properties,
  };

  if (required && required.length > 0) {
    schema.required = required;
  }

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
    const schema: Record<string, unknown> = {
      type: 'array',
      items: buildCodexOutputSchemaPrimitive(field.items),
    };
    if (field.description) {
      schema.description = field.description;
    }
    return schema;
  }

  return buildCodexOutputSchemaPrimitive(field);
}

function buildCodexOutputSchemaPrimitive(
  field: z.infer<typeof OutputSchemaPrimitiveSchema>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    type: field.type,
  };

  if (field.description) {
    result.description = field.description;
  }

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

type JsonSchemaDefinitionEntry = Record<string, unknown>;

type LooseJsonObjectSchema = {
  type: 'object';
  properties: Record<string, JsonSchemaDefinitionEntry>;
  required?: string[];
  additionalProperties?: boolean;
  $schema?: string;
};

type ShapeCandidate = {
  shape?: Record<string, unknown> | (() => Record<string, unknown>);
};

type ZodDefinition = Record<string, unknown> | undefined;
type ZodLike = {
  _def?: Record<string, unknown>;
  def?: Record<string, unknown>;
  _zod?: { def?: Record<string, unknown> };
  shape?: Record<string, unknown> | (() => Record<string, unknown>);
};

const JSON_SCHEMA_DRAFT_07 = 'http://json-schema.org/draft-07/schema#';
const OPTIONAL_WRAPPERS = new Set(['optional']);
const DECORATOR_WRAPPERS = new Set([
  'brand',
  'branded',
  'catch',
  'default',
  'effects',
  'pipeline',
  'pipe',
  'prefault',
  'readonly',
  'refinement',
  'transform',
]);

const SIMPLE_TYPE_MAPPING: Record<string, JsonSchemaDefinitionEntry> = {
  string: { type: 'string' },
  number: { type: 'number' },
  bigint: { type: 'integer' },
  boolean: { type: 'boolean' },
  date: { type: 'string', format: 'date-time' },
};

function readZodDefinition(input: unknown): ZodDefinition {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }

  const candidate = input as ZodLike;
  return candidate._zod?.def || candidate._def || candidate.def;
}

function readZodType(input: unknown): string | undefined {
  const def = readZodDefinition(input);
  if (!def) {
    return undefined;
  }

  const rawType =
    (typeof def.typeName === 'string' && def.typeName) ||
    (typeof def.type === 'string' && def.type);

  if (typeof rawType !== 'string') {
    return undefined;
  }

  const lower = rawType.toLowerCase();
  return lower.startsWith('zod') ? lower.slice(3) : lower;
}

function zodJsonSchemaCompat(
  input: z.ZodTypeAny,
): Record<string, unknown> | undefined {
  const schema = buildObjectSchema(input);
  if (!schema) {
    return undefined;
  }

  if (!Array.isArray(schema.required)) {
    schema.required = [];
  }

  if (typeof schema.additionalProperties === 'undefined') {
    schema.additionalProperties = false;
  }

  if (typeof schema.$schema !== 'string') {
    schema.$schema = JSON_SCHEMA_DRAFT_07;
  }

  return schema as Record<string, unknown>;
}

function buildObjectSchema(value: unknown): LooseJsonObjectSchema | undefined {
  const shape = readShape(value);
  if (!shape) {
    return undefined;
  }

  const properties: Record<string, JsonSchemaDefinitionEntry> = {};
  const required: string[] = [];

  for (const [key, field] of Object.entries(shape)) {
    const { schema, optional } = convertProperty(field);
    if (!schema) {
      return undefined;
    }

    properties[key] = schema;
    if (!optional) {
      required.push(key);
    }
  }

  return { type: 'object', properties, required, additionalProperties: false };
}

function convertProperty(value: unknown): {
  schema?: JsonSchemaDefinitionEntry;
  optional: boolean;
} {
  let current = unwrapDecorators(value);
  let optional = false;

  while (OPTIONAL_WRAPPERS.has(readZodType(current) ?? '')) {
    optional = true;
    const def = readZodDefinition(current);
    const next = unwrapDecorators(def?.innerType);
    if (!next || next === current) {
      break;
    }
    current = next;
  }

  return { schema: convertSchema(current), optional };
}

function convertSchema(value: unknown): JsonSchemaDefinitionEntry | undefined {
  if (value === undefined) {
    return undefined;
  }

  const unwrapped = unwrapDecorators(value);
  const type = readZodType(unwrapped);
  const def = readZodDefinition(unwrapped);

  if (!type) {
    return undefined;
  }

  if (type in SIMPLE_TYPE_MAPPING) {
    return SIMPLE_TYPE_MAPPING[type];
  }

  switch (type) {
    case 'object':
      return buildObjectSchema(unwrapped);
    case 'array':
      return buildArraySchema(def);
    case 'tuple':
      return buildTupleSchema(def);
    case 'union':
      return buildUnionSchema(def);
    case 'intersection':
      return buildIntersectionSchema(def);
    case 'literal':
      return buildLiteral(def);
    case 'enum':
    case 'nativeenum':
      return buildEnum(def);
    case 'record':
      return buildRecordSchema(def);
    case 'map':
      return buildMapSchema(def);
    case 'set':
      return buildSetSchema(def);
    case 'nullable':
      return buildNullableSchema(def);
    default:
      return undefined;
  }
}

function buildArraySchema(
  def: Record<string, unknown> | undefined,
): JsonSchemaDefinitionEntry | undefined {
  const items = convertSchema(extractFirst(def, 'element', 'items', 'type'));
  return items ? { type: 'array', items } : undefined;
}

function buildTupleSchema(
  def: Record<string, unknown> | undefined,
): JsonSchemaDefinitionEntry | undefined {
  const items = coerceArray(def?.items)
    .map((item) => convertSchema(item))
    .filter(Boolean) as JsonSchemaDefinitionEntry[];
  if (!items.length) {
    return undefined;
  }
  const schema: JsonSchemaDefinitionEntry = {
    type: 'array',
    items,
    minItems: items.length,
  };
  if (!def?.rest) {
    schema.maxItems = items.length;
  }
  return schema;
}

function buildUnionSchema(
  def: Record<string, unknown> | undefined,
): JsonSchemaDefinitionEntry | undefined {
  const options = coerceArray(def?.options ?? def?.schemas)
    .map((option) => convertSchema(option))
    .filter(Boolean) as JsonSchemaDefinitionEntry[];
  return options.length ? { anyOf: options } : undefined;
}

function buildIntersectionSchema(
  def: Record<string, unknown> | undefined,
): JsonSchemaDefinitionEntry | undefined {
  const left = convertSchema(def?.left);
  const right = convertSchema(def?.right);
  return left && right ? { allOf: [left, right] } : undefined;
}

function buildRecordSchema(
  def: Record<string, unknown> | undefined,
): JsonSchemaDefinitionEntry | undefined {
  const valueSchema = convertSchema(def?.valueType ?? def?.values);
  return valueSchema
    ? { type: 'object', additionalProperties: valueSchema }
    : undefined;
}

function buildMapSchema(
  def: Record<string, unknown> | undefined,
): JsonSchemaDefinitionEntry | undefined {
  const valueSchema = convertSchema(def?.valueType ?? def?.values);
  return valueSchema ? { type: 'array', items: valueSchema } : undefined;
}

function buildSetSchema(
  def: Record<string, unknown> | undefined,
): JsonSchemaDefinitionEntry | undefined {
  const valueSchema = convertSchema(def?.valueType);
  return valueSchema
    ? { type: 'array', items: valueSchema, uniqueItems: true }
    : undefined;
}

function buildNullableSchema(
  def: Record<string, unknown> | undefined,
): JsonSchemaDefinitionEntry | undefined {
  const inner = convertSchema(def?.innerType ?? def?.type);
  return inner ? { anyOf: [inner, { type: 'null' }] } : undefined;
}

function unwrapDecorators(value: unknown): unknown {
  let current = value;
  while (DECORATOR_WRAPPERS.has(readZodType(current) ?? '')) {
    const def = readZodDefinition(current);
    const next =
      def?.innerType ??
      def?.schema ??
      def?.base ??
      def?.type ??
      def?.wrapped ??
      def?.underlying;
    if (!next || next === current) {
      return current;
    }
    current = next;
  }
  return current;
}

function extractFirst(
  def: Record<string, unknown> | undefined,
  ...keys: string[]
): unknown {
  if (!def) {
    return undefined;
  }
  for (const key of keys) {
    if (key in def && def[key] !== undefined) {
      return (def as Record<string, unknown>)[key];
    }
  }
  return undefined;
}

function coerceArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return value === undefined ? [] : [value];
}

function buildLiteral(
  def: Record<string, unknown> | undefined,
): JsonSchemaDefinitionEntry | undefined {
  if (!def) {
    return undefined;
  }
  const literal = extractFirst(def, 'value', 'literal') as
    | string
    | number
    | boolean
    | null
    | undefined;
  if (literal === undefined) {
    return undefined;
  }
  return {
    const: literal,
    type: literal === null ? 'null' : typeof literal,
  };
}

function buildEnum(
  def: Record<string, unknown> | undefined,
): JsonSchemaDefinitionEntry | undefined {
  if (!def) {
    return undefined;
  }
  if (Array.isArray(def.values)) {
    return { enum: def.values as unknown[] };
  }
  if (Array.isArray(def.options)) {
    return { enum: def.options as unknown[] };
  }
  if (def.values && typeof def.values === 'object') {
    return { enum: Object.values(def.values as Record<string, unknown>) };
  }
  if (def.enum && typeof def.enum === 'object') {
    return { enum: Object.values(def.enum as Record<string, unknown>) };
  }
  return undefined;
}

function readShape(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }

  const candidate = input as ShapeCandidate;
  if (candidate.shape && typeof candidate.shape === 'object') {
    return candidate.shape;
  }
  if (typeof candidate.shape === 'function') {
    try {
      return candidate.shape();
    } catch (_error) {
      return undefined;
    }
  }

  const def = readZodDefinition(candidate);
  const shape = def?.shape;
  if (shape && typeof shape === 'object') {
    return shape as Record<string, unknown>;
  }
  if (typeof shape === 'function') {
    try {
      return shape();
    } catch (_error) {
      return undefined;
    }
  }

  return undefined;
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

type ConsumeEventsOptions = {
  args: CodexToolCallArguments;
  onStream?: CodexToolStreamHandler;
  toolCall?: FunctionCallItem;
};

async function emitStreamEvent(
  handler: CodexToolStreamHandler | undefined,
  payload: CodexToolStreamEvent,
): Promise<void> {
  if (!handler) {
    return;
  }
  await Promise.allSettled([Promise.resolve().then(() => handler(payload))]);
}

async function consumeEvents(
  { events }: RunStreamedResult,
  options: ConsumeEventsOptions,
): Promise<{
  response: string;
  usage: CodexUsage | null;
  threadId: string | null;
}> {
  const { args, onStream, toolCall } = options;
  const activeSpans = new Map<string, CustomSpan>();
  let finalResponse = '';
  let usage: CodexUsage | null = null;
  let threadId: string | null = null;

  try {
    for await (const event of events) {
      if (event.type === 'thread.started') {
        threadId = event.thread_id;
      }

      await emitStreamEvent(onStream, {
        event,
        threadId,
        toolCall,
      });

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

  return { response: finalResponse, usage, threadId };
}

function handleItemStarted(item: ThreadItem, spans: Map<string, CustomSpan>) {
  if (isCommandExecutionItem(item)) {
    const span = createCustomSpan({
      data: {
        name: 'Codex command execution',
        data: buildCommandSpanData(item),
      },
    });
    span.start();
    spans.set(item.id, span);
    return;
  }

  if (isFileChangeItem(item)) {
    const span = createCustomSpan({
      data: {
        name: 'Codex file change',
        data: buildFileChangeSpanData(item),
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
        data: buildMcpToolSpanData(item),
      },
    });
    span.start();
    spans.set(item.id, span);
    return;
  }

  if (isWebSearchItem(item)) {
    const span = createCustomSpan({
      data: {
        name: 'Codex web search',
        data: buildWebSearchSpanData(item),
      },
    });
    span.start();
    spans.set(item.id, span);
    return;
  }

  if (isTodoListItem(item)) {
    const span = createCustomSpan({
      data: {
        name: 'Codex todo list',
        data: buildTodoListSpanData(item),
      },
    });
    span.start();
    spans.set(item.id, span);
    return;
  }

  if (isErrorItem(item)) {
    const span = createCustomSpan({
      data: {
        name: 'Codex error',
        data: buildErrorSpanData(item),
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
        data: buildReasoningSpanData(item),
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
  } else if (isFileChangeItem(item)) {
    updateFileChangeSpan(span, item);
  } else if (isMcpToolCallItem(item)) {
    updateMcpToolSpan(span, item);
  } else if (isWebSearchItem(item)) {
    updateWebSearchSpan(span, item);
  } else if (isTodoListItem(item)) {
    updateTodoListSpan(span, item);
  } else if (isErrorItem(item)) {
    updateErrorSpan(span, item);
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
  } else if (isFileChangeItem(item)) {
    updateFileChangeSpan(span, item);
    if (item.status === 'failed') {
      span.setError({
        message: 'Codex file change failed.',
        data: {
          changes: item.changes,
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
  } else if (isWebSearchItem(item)) {
    updateWebSearchSpan(span, item);
  } else if (isTodoListItem(item)) {
    updateTodoListSpan(span, item);
  } else if (isErrorItem(item)) {
    updateErrorSpan(span, item);
    span.setError({
      message: item.message,
    });
  } else if (isReasoningItem(item)) {
    updateReasoningSpan(span, item);
  }

  span.end();
  spans.delete(item.id);
}

function updateCommandSpan(span: CustomSpan, item: CommandExecutionItem) {
  replaceSpanData(span, buildCommandSpanData(item));
}

function updateFileChangeSpan(span: CustomSpan, item: FileChangeItem) {
  replaceSpanData(span, buildFileChangeSpanData(item));
}

function updateMcpToolSpan(span: CustomSpan, item: McpToolCallItem) {
  replaceSpanData(span, buildMcpToolSpanData(item));
}

function updateWebSearchSpan(span: CustomSpan, item: WebSearchItem) {
  replaceSpanData(span, buildWebSearchSpanData(item));
}

function updateTodoListSpan(span: CustomSpan, item: TodoListItem) {
  replaceSpanData(span, buildTodoListSpanData(item));
}

function updateErrorSpan(span: CustomSpan, item: ErrorItem) {
  replaceSpanData(span, buildErrorSpanData(item));
}

function updateReasoningSpan(span: CustomSpan, item: ReasoningItem) {
  replaceSpanData(span, buildReasoningSpanData(item));
}

function buildDefaultResponse(args: CodexToolCallArguments): string {
  const inputSummary = args.inputs?.length ? 'with inputs.' : 'with no inputs.';
  return `Codex task completed ${inputSummary}`;
}

function replaceSpanData(
  span: CustomSpan,
  next: Record<string, unknown>,
): void {
  const data = span.spanData.data as Record<string, unknown>;
  for (const key of Object.keys(data)) {
    delete data[key];
  }
  Object.assign(data, next);
}

function buildCommandSpanData(
  item: CommandExecutionItem,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    command: item.command,
    status: item.status,
    exitCode: item.exit_code ?? null,
  };
  const output = item.aggregated_output ?? '';
  applyTruncatedField(data, 'output', output, {
    maxLength: MAX_SPAN_TEXT_LENGTH,
    mode: 'tail',
  });
  return data;
}

function buildFileChangeSpanData(
  item: FileChangeItem,
): Record<string, unknown> {
  const changes = item.changes.slice(0, MAX_SPAN_LIST_ITEMS).map((change) => ({
    path: change.path,
    kind: change.kind,
  }));
  const data: Record<string, unknown> = {
    changes,
    status: item.status,
  };
  if (item.changes.length > changes.length) {
    data.changes_truncated = true;
    data.changes_total = item.changes.length;
  }
  return data;
}

function buildMcpToolSpanData(item: McpToolCallItem): Record<string, unknown> {
  const data: Record<string, unknown> = {
    server: item.server,
    tool: item.tool,
    status: item.status,
  };

  if (typeof item.arguments !== 'undefined') {
    applyTruncatedField(data, 'arguments', toSmartString(item.arguments), {
      maxLength: MAX_SPAN_TEXT_LENGTH,
      mode: 'head',
    });
  }

  if (item.result) {
    const resultSummary: Record<string, unknown> = {
      content_items: Array.isArray(item.result.content)
        ? item.result.content.length
        : 0,
    };
    if (typeof item.result.structured_content !== 'undefined') {
      applyTruncatedField(
        resultSummary,
        'structured_content',
        toSmartString(item.result.structured_content),
        { maxLength: MAX_SPAN_TEXT_LENGTH, mode: 'head' },
      );
    }
    data.result = resultSummary;
  }

  if (item.error?.message) {
    applyTruncatedField(data, 'error', item.error.message, {
      maxLength: MAX_SPAN_TEXT_LENGTH,
      mode: 'head',
    });
  }

  return data;
}

function buildWebSearchSpanData(item: WebSearchItem): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  applyTruncatedField(data, 'query', item.query, {
    maxLength: MAX_SPAN_TEXT_LENGTH,
    mode: 'head',
  });
  return data;
}

function buildTodoListSpanData(item: TodoListItem): Record<string, unknown> {
  const items = item.items.slice(0, MAX_SPAN_LIST_ITEMS).map((entry) => {
    const result: Record<string, unknown> = { completed: entry.completed };
    applyTruncatedField(result, 'text', entry.text, {
      maxLength: MAX_TODO_TEXT_LENGTH,
      mode: 'head',
    });
    return result;
  });
  const data: Record<string, unknown> = { items };
  if (item.items.length > items.length) {
    data.items_truncated = true;
    data.items_total = item.items.length;
  }
  return data;
}

function buildErrorSpanData(item: ErrorItem): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  applyTruncatedField(data, 'message', item.message, {
    maxLength: MAX_SPAN_TEXT_LENGTH,
    mode: 'head',
  });
  return data;
}

function buildReasoningSpanData(item: ReasoningItem): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  applyTruncatedField(data, 'text', item.text, {
    maxLength: MAX_SPAN_TEXT_LENGTH,
    mode: 'head',
  });
  return data;
}

type TruncateMode = 'head' | 'tail';
type TruncateOptions = {
  maxLength: number;
  mode: TruncateMode;
};

function applyTruncatedField(
  target: Record<string, unknown>,
  field: string,
  value: string,
  options: TruncateOptions,
): void {
  const { text, truncated, length } = truncateText(value, options);
  target[field] = text;
  if (truncated) {
    target[`${field}_truncated`] = true;
    target[`${field}_length`] = length;
  }
}

function truncateText(
  value: string,
  { maxLength, mode }: TruncateOptions,
): { text: string; truncated: boolean; length: number } {
  if (value.length <= maxLength) {
    return { text: value, truncated: false, length: value.length };
  }

  if (mode === 'tail') {
    return {
      text: `…${value.slice(-maxLength)}`,
      truncated: true,
      length: value.length,
    };
  }

  return {
    text: `${value.slice(0, maxLength)}…`,
    truncated: true,
    length: value.length,
  };
}

function isCommandExecutionItem(
  item: ThreadItem,
): item is CommandExecutionItem {
  return item?.type === 'command_execution';
}

function isFileChangeItem(item: ThreadItem): item is FileChangeItem {
  return item?.type === 'file_change';
}

function isMcpToolCallItem(item: ThreadItem): item is McpToolCallItem {
  return item?.type === 'mcp_tool_call';
}

function isWebSearchItem(item: ThreadItem): item is WebSearchItem {
  return item?.type === 'web_search';
}

function isTodoListItem(item: ThreadItem): item is TodoListItem {
  return item?.type === 'todo_list';
}

function isErrorItem(item: ThreadItem): item is ErrorItem {
  return item?.type === 'error';
}

function isReasoningItem(item: ThreadItem): item is ReasoningItem {
  return item?.type === 'reasoning';
}
