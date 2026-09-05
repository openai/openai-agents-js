import type {
  JSONSchema7,
  LanguageModelV2CallOptions,
  LanguageModelV2FunctionTool,
  LanguageModelV2Prompt,
  LanguageModelV2ToolChoice,
} from '@ai-sdk/provider';
import {
  createGenerationSpan,
  Model,
  ModelRetryAdvice,
  ModelRetryAdviceRequest,
  ModelRequest,
  ModelResponse,
  ModelSettings,
  protocol,
  resetCurrentSpan,
  ResponseStreamEvent,
  SerializedHandoff,
  SerializedOutputType,
  SerializedTool,
  setCurrentSpan,
  Usage,
  UserError,
  withGenerationSpan,
  getLogger,
  ModelSettingsToolChoice,
  HostedTool,
} from '@openai/agents';
import { snapshotRawUsage } from '@openai/agents-core/utils/internal';
import { isZodObject } from '@openai/agents/utils';
import { extractUsage, toTracingUsage } from './usage';
import type {
  LanguageModelV2ProviderToolCompat,
  LanguageModelV2CallOptionsCompat,
  LanguageModelCompatible,
  AiSdkSpecificationVersion,
} from './modelTypes';
import {
  itemsToLanguageV2Messages,
  getSpecVersion,
  getToolSearchExecution,
  isRecord,
  getAiSdkToolName,
  getModelIdentifier,
  toProviderOptions,
} from './messageConversion';
/** @internal */
export { itemsToLanguageV2Messages } from './messageConversion';
export { parseArguments } from './messageConversion';

type LanguageModelV2FunctionToolCompat = LanguageModelV2FunctionTool & {
  strict: boolean;
};

/**
 * Provider tool definition returned by an AI SDK provider tool factory.
 */
export type AiSdkProviderTool = {
  type?: string;
  id?: string;
  args?: Record<string, any>;
};

type AiSdkProviderToolConfig = {
  id: string;
  args: Record<string, any>;
};

const AI_SDK_PROVIDER_TOOL_KEY = 'aiSdkProviderTool';

/**
 * Adapts an AI SDK provider's server-executed tool-search definition for use
 * with an Agents SDK agent.
 *
 * @param providerTool - A provider tool returned by an AI SDK tool factory.
 * @returns A hosted tool-search tool understood by the AI SDK adapter.
 */
export function aiSdkToolSearchTool(
  providerTool: AiSdkProviderTool,
): HostedTool {
  if (
    !providerTool ||
    (providerTool.type !== 'provider' &&
      providerTool.type !== 'provider-defined')
  ) {
    throw new UserError(
      'aiSdkToolSearchTool() requires an AI SDK provider tool definition.',
    );
  }
  if (typeof providerTool.id !== 'string' || providerTool.id.trim() === '') {
    throw new UserError(
      'aiSdkToolSearchTool() requires a provider tool with a non-empty id.',
    );
  }
  if (providerTool.args !== undefined && !isRecord(providerTool.args)) {
    throw new UserError(
      'aiSdkToolSearchTool() requires provider tool args to be an object.',
    );
  }

  return {
    type: 'hosted_tool',
    name: 'tool_search',
    providerData: {
      type: 'tool_search',
      execution: 'server',
      [AI_SDK_PROVIDER_TOOL_KEY]: {
        id: providerTool.id,
        args: providerTool.args ?? {},
      } satisfies AiSdkProviderToolConfig,
    },
  };
}

type SerializedComputerTool = Extract<SerializedTool, { type: 'computer' }>;

function hasComputerDisplayMetadata(
  tool: SerializedComputerTool,
): tool is SerializedComputerTool & {
  environment: NonNullable<SerializedComputerTool['environment']>;
  dimensions: NonNullable<SerializedComputerTool['dimensions']>;
} {
  return (
    typeof tool.environment === 'string' &&
    Array.isArray(tool.dimensions) &&
    tool.dimensions.length === 2 &&
    tool.dimensions.every((value) => typeof value === 'number')
  );
}

function ensureSupportedModel(model: LanguageModelCompatible): void {
  const spec = getSpecVersion(model);
  if (spec === 'unknown') {
    throw new UserError(
      `Unsupported AI SDK specificationVersion: ${String(
        (model as any)?.specificationVersion,
      )}. Only v2, v3, and v4 are supported.`,
    );
  }
}

/**
 * @internal
 * Converts a handoff to a language model V2 tool.
 *
 * @param model - The model to use.
 * @param handoff - The handoff to convert.
 */
function handoffToLanguageV2Tool(
  model: LanguageModelCompatible,
  handoff: SerializedHandoff,
): LanguageModelV2FunctionTool {
  return {
    type: 'function',
    name: handoff.toolName,
    description: handoff.toolDescription,
    inputSchema: handoff.inputJsonSchema as JSONSchema7,
  };
}

function schemaAcceptsObject(schema: JSONSchema7 | undefined): boolean {
  if (!schema) {
    return false;
  }
  const schemaType = schema.type;
  if (Array.isArray(schemaType)) {
    if (schemaType.includes('object')) {
      return true;
    }
  } else if (schemaType === 'object') {
    return true;
  }
  return Boolean(schema.properties || schema.additionalProperties);
}

function expectsObjectArguments(
  tool: SerializedTool | SerializedHandoff | undefined,
): boolean {
  if (!tool) {
    return false;
  }
  if ('toolName' in tool) {
    return schemaAcceptsObject(tool.inputJsonSchema as JSONSchema7 | undefined);
  }
  if (tool.type === 'function') {
    return schemaAcceptsObject(tool.parameters as JSONSchema7 | undefined);
  }
  return false;
}

function resolveRequestedTools(
  request: Pick<ModelRequest, 'tools' | 'handoffs'> & {
    _internal?: { toolNameCollisionPolicy?: 'warn' | 'error' };
  },
  logger: ReturnType<typeof getLogger>,
): {
  tools: SerializedTool[];
  handoffs: SerializedHandoff[];
  toolsByName: Map<string, SerializedTool | SerializedHandoff>;
} {
  const toolsByName = new Map<string, SerializedTool | SerializedHandoff>();
  const retainedToolIndices = new Set(request.tools.map((_, index) => index));
  const retainedHandoffIndices = new Set(
    request.handoffs.map((_, index) => index),
  );
  const routableEntriesByName = new Map<
    string,
    {
      tool: SerializedTool | SerializedHandoff;
      kind: 'tool' | 'handoff';
      index: number;
    }
  >();
  const collisionPolicy = request._internal?.toolNameCollisionPolicy ?? 'warn';

  const addRequestedTool = (
    name: string,
    tool: SerializedTool | SerializedHandoff,
    entry: { kind: 'tool' | 'handoff'; index: number },
  ) => {
    const existing = toolsByName.get(name);
    const existingRoutableEntry = routableEntriesByName.get(name);
    if (
      name === 'tool_search' &&
      existing &&
      isHostedToolSearchTool(existing) !== isHostedToolSearchTool(tool)
    ) {
      throw new UserError(
        'AiSdkModel cannot disambiguate a hosted tool_search helper from a custom tool or handoff that is also named "tool_search". Rename the custom tool or use a different adapter.',
      );
    }
    if (
      existing &&
      isFunctionToolOrHandoff(existing) !== isFunctionToolOrHandoff(tool)
    ) {
      const remediation =
        'Assign unique tool names or toolNameOverride values, or use distinct namespaces.';
      throw new UserError(
        logger.dontLogToolData
          ? `AiSdkModel cannot disambiguate tools with the same flattened name. ${remediation}`
          : `AiSdkModel cannot disambiguate the flattened tool name '${name}'. ${remediation}`,
      );
    }
    if (
      existing &&
      !isFunctionToolOrHandoff(existing) &&
      !isFunctionToolOrHandoff(tool)
    ) {
      const remediation = 'Assign unique provider tool names.';
      throw new UserError(
        logger.dontLogToolData
          ? `AiSdkModel cannot disambiguate provider tools with the same flattened name. ${remediation}`
          : `AiSdkModel cannot disambiguate the flattened provider tool name '${name}'. ${remediation}`,
      );
    }
    if (existingRoutableEntry && isFunctionToolOrHandoff(tool)) {
      const remediation =
        'Assign unique tool names or toolNameOverride values, or use distinct namespaces.';
      const hasStructuredFunctionIdentity =
        isStructuredFunctionTool(existingRoutableEntry.tool) ||
        isStructuredFunctionTool(tool);
      if (hasStructuredFunctionIdentity || collisionPolicy === 'error') {
        throw new UserError(
          logger.dontLogToolData
            ? `AiSdkModel cannot disambiguate function tools and handoffs with the same flattened name. ${remediation}`
            : `AiSdkModel cannot disambiguate the flattened tool name '${name}'. ${remediation}`,
        );
      }
      logger.warn(
        logger.dontLogToolData
          ? `AI SDK tool name collision detected. ${remediation} Only the current dispatch winner will be exposed.`
          : `AI SDK tool name collision detected for '${name}'. ${remediation} Only the current dispatch winner will be exposed.`,
      );
      if (existingRoutableEntry.kind === 'tool') {
        retainedToolIndices.delete(existingRoutableEntry.index);
      } else {
        retainedHandoffIndices.delete(existingRoutableEntry.index);
      }
    }
    toolsByName.set(name, tool);
    if (isFunctionToolOrHandoff(tool)) {
      routableEntriesByName.set(name, { tool, ...entry });
    }
  };

  for (const [index, tool] of request.tools.entries()) {
    if (
      tool.type === 'function' &&
      typeof tool.namespace === 'string' &&
      tool.namespace === tool.name
    ) {
      const remediation =
        'Rename the namespace or tool, or use a Responses model for deferred top-level tools.';
      throw new UserError(
        logger.dontLogToolData
          ? `AiSdkModel cannot route a function tool whose namespace matches its name because that wire shape is reserved for deferred top-level tools. ${remediation}`
          : `AiSdkModel cannot route the function tool '${tool.name}' because its namespace matches its name and that wire shape is reserved for deferred top-level tools. ${remediation}`,
      );
    }
    addRequestedTool(
      tool.type === 'function'
        ? getSerializedFunctionToolName(tool)
        : tool.name,
      tool,
      { kind: 'tool', index },
    );
  }

  for (const [index, handoff] of request.handoffs.entries()) {
    addRequestedTool(handoff.toolName, handoff, { kind: 'handoff', index });
  }

  return {
    tools: request.tools.filter((_, index) => retainedToolIndices.has(index)),
    handoffs: request.handoffs.filter((_, index) =>
      retainedHandoffIndices.has(index),
    ),
    toolsByName,
  };
}

function isFunctionToolOrHandoff(
  tool: SerializedTool | SerializedHandoff,
): boolean {
  return 'toolName' in tool || tool.type === 'function';
}

function isStructuredFunctionTool(
  tool: SerializedTool | SerializedHandoff,
): tool is Extract<SerializedTool, { type: 'function' }> {
  return (
    !('toolName' in tool) &&
    tool.type === 'function' &&
    ((typeof tool.namespace === 'string' && tool.namespace.length > 0) ||
      tool.deferLoading === true)
  );
}

function isHostedToolSearchTool(
  tool: SerializedTool | SerializedHandoff | undefined,
): tool is Extract<SerializedTool, { type: 'hosted_tool' }> {
  return (
    !!tool &&
    !('toolName' in tool) &&
    tool.type === 'hosted_tool' &&
    tool.providerData?.type === 'tool_search'
  );
}

function getAiSdkProviderToolConfig(
  tool: SerializedTool | SerializedHandoff | undefined,
): AiSdkProviderToolConfig | undefined {
  if (!isHostedToolSearchTool(tool)) {
    return undefined;
  }

  const config = tool.providerData?.[AI_SDK_PROVIDER_TOOL_KEY];
  if (
    !isRecord(config) ||
    typeof config.id !== 'string' ||
    !isRecord(config.args)
  ) {
    return undefined;
  }

  return {
    id: config.id,
    args: config.args,
  };
}

function normalizeToolSearchArguments(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value ?? {};
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return {};
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function createProtocolToolCallItem(args: {
  requestedTool: SerializedTool | SerializedHandoff | undefined;
  toolCallId: string;
  toolName: string;
  input: unknown;
  providerData: Record<string, any> | undefined;
  providerExecuted?: boolean;
}): protocol.FunctionCallItem | protocol.ToolSearchCallItem {
  const {
    requestedTool,
    toolCallId,
    toolName,
    input,
    providerData,
    providerExecuted,
  } = args;

  if (isHostedToolSearchTool(requestedTool)) {
    const execution =
      providerExecuted || getToolSearchExecution(requestedTool) === 'server'
        ? 'server'
        : 'client';
    return {
      type: 'tool_search_call',
      id: toolCallId,
      ...(execution === 'server' ? { execution } : {}),
      arguments: normalizeToolSearchArguments(input),
      status: 'completed',
      providerData,
    };
  }

  let toolCallArguments: string;
  if (typeof input === 'string') {
    toolCallArguments =
      input === '' && expectsObjectArguments(requestedTool)
        ? JSON.stringify({})
        : input;
  } else {
    toolCallArguments = JSON.stringify(input ?? {});
  }
  const requestedFunctionTool =
    requestedTool &&
    !('toolName' in requestedTool) &&
    requestedTool.type === 'function'
      ? requestedTool
      : undefined;
  const namespace = requestedFunctionTool?.namespace;

  return {
    type: 'function_call',
    callId: toolCallId,
    name: namespace ? requestedFunctionTool.name : toolName,
    ...(namespace ? { namespace } : {}),
    arguments: toolCallArguments,
    status: 'completed',
    providerData,
  };
}

function getAiSdkToolResultValue(part: any): unknown {
  if ('result' in part) {
    return part.result;
  }

  if (isRecord(part.output) && part.output.type === 'json') {
    return part.output.value;
  }

  return undefined;
}

function createProtocolToolSearchOutputItem(args: {
  requestedTool: SerializedTool | SerializedHandoff | undefined;
  toolCallId: string;
  part: any;
  providerData: Record<string, any> | undefined;
}): protocol.ToolSearchOutputItem | undefined {
  const { requestedTool, toolCallId, part, providerData } = args;
  if (!getAiSdkProviderToolConfig(requestedTool)) {
    return undefined;
  }

  const result = getAiSdkToolResultValue(part);
  const isError = part.isError === true;
  let tools: protocol.ToolSearchOutputTool[];
  if (isError && isRecord(result)) {
    tools = [result];
  } else if (!isError && Array.isArray(result) && result.every(isRecord)) {
    tools = result;
  } else {
    throw new UserError(
      `AI SDK provider tool_search returned an invalid result for call "${toolCallId}". Expected an array of tool references or an error object.`,
    );
  }

  return {
    type: 'tool_search_output',
    callId: toolCallId,
    execution: 'server',
    status: isError ? 'failed' : 'completed',
    tools,
    providerData,
  };
}

function isPlainRecord(value: unknown): value is Record<string, any> {
  if (!isRecord(value) || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function getAiSdkProviderData(
  model: LanguageModelCompatible,
  modelSettings: ModelSettings,
): Record<string, any> {
  const providerData = modelSettings.providerData ?? {};
  const promptCacheRetention = modelSettings.promptCacheRetention;

  if (
    model.provider !== 'openai.responses' ||
    promptCacheRetention === undefined
  ) {
    return providerData;
  }

  if (getSpecVersion(model) === 'v2') {
    throw new UserError(
      'AI SDK prompt cache retention requires specificationVersion v3 or v4; v2 models do not support this option.',
    );
  }

  const providerOptions = providerData.providerOptions;
  if (providerOptions !== undefined && !isPlainRecord(providerOptions)) {
    return providerData;
  }

  const openaiOptions = providerOptions?.openai;
  if (openaiOptions !== undefined && !isPlainRecord(openaiOptions)) {
    return providerData;
  }

  const providerPromptCacheRetention = openaiOptions?.promptCacheRetention;

  return {
    ...providerData,
    providerOptions: {
      ...providerOptions,
      openai: {
        ...openaiOptions,
        promptCacheRetention:
          providerPromptCacheRetention === undefined
            ? promptCacheRetention === 'in-memory'
              ? 'in_memory'
              : promptCacheRetention
            : providerPromptCacheRetention,
      },
    },
  };
}

function getSerializedFunctionToolName(
  tool: Extract<SerializedTool, { type: 'function' }>,
): string {
  return getAiSdkToolName(tool);
}

function buildBaseProviderData(
  model: LanguageModelCompatible,
  responseId?: string,
): Record<string, any> {
  const base: Record<string, any> = { model: getModelIdentifier(model) };
  if (responseId) {
    base.responseId = responseId;
  }
  return base;
}

function mergeProviderData(
  base: Record<string, any> | undefined,
  ...sources: Array<Record<string, any> | undefined>
): Record<string, any> | undefined {
  const merged: Record<string, any> = {};
  if (isRecord(base)) {
    Object.assign(merged, base);
  }
  for (const src of sources) {
    if (isRecord(src)) {
      Object.assign(merged, src);
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeProviderMetadata(
  base: Record<string, any> | undefined,
  source: Record<string, any> | undefined,
): Record<string, any> | undefined {
  const merged = mergeProviderData(base, source);
  if (!merged || !isRecord(base) || !isRecord(source)) {
    return merged;
  }

  for (const provider of Object.keys(source)) {
    if (isRecord(base[provider]) && isRecord(source[provider])) {
      merged[provider] = {
        ...base[provider],
        ...source[provider],
      };
    }
  }
  return merged;
}

function shouldEmitReasoning(
  text: string,
  providerMetadata: Record<string, any> | undefined,
): boolean {
  return text.length > 0 || providerMetadata !== undefined;
}

function getHostedToolArgs(providerData: unknown): Record<string, any> {
  if (!isRecord(providerData)) {
    return {};
  }

  if (isRecord(providerData.args)) {
    return providerData.args;
  }

  const { type: _type, name: _name, args: _args, ...rest } = providerData;
  return rest;
}

/**
 * @internal
 * Converts a tool to a language model V2 tool.
 *
 * @param model - The model to use.
 * @param tool - The tool to convert.
 */
export function toolToLanguageV2Tool(
  model: LanguageModelCompatible,
  tool: SerializedTool,
): LanguageModelV2FunctionToolCompat | LanguageModelV2ProviderToolCompat {
  if (
    (tool.type === 'function' ||
      tool.type === 'shell' ||
      tool.type === 'apply_patch') &&
    tool.allowedCallers?.some((caller) => caller === 'programmatic')
  ) {
    throw new UserError(
      'The AI SDK adapter does not support Programmatic Tool Calling. Use a Responses API model directly.',
    );
  }
  if (tool.type === 'function') {
    if (tool.deferLoading) {
      throw new UserError(
        'The AI SDK adapter does not support deferred Responses function tools (`toolNamespace()` or `deferLoading: true`). Use a Responses API model directly.',
      );
    }
    const providerOptions = toProviderOptions(tool.providerData, model);
    if (tool.outputSchema) {
      throw new UserError(
        'The AI SDK adapter does not support Responses function outputSchema. Use a Responses API model directly.',
      );
    }
    return {
      type: 'function',
      name: getSerializedFunctionToolName(tool),
      description: tool.description,
      inputSchema: tool.parameters as JSONSchema7,
      strict: tool.strict,
      ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
    };
  }

  const specificationVersion = getSpecVersion(model);
  const providerToolType =
    specificationVersion === 'v3' || specificationVersion === 'v4'
      ? 'provider'
      : 'provider-defined';
  const providerToolPrefix = getProviderToolPrefix(model);

  if (tool.type === 'hosted_tool') {
    const providerToolConfig = getAiSdkProviderToolConfig(tool);
    if (providerToolConfig) {
      return {
        type: providerToolType,
        id: providerToolConfig.id,
        name: tool.name,
        args: providerToolConfig.args,
      };
    }

    if (
      tool.providerData?.type === 'programmatic_tool_calling' ||
      (Array.isArray(tool.providerData?.allowed_callers) &&
        tool.providerData.allowed_callers.includes('programmatic'))
    ) {
      throw new UserError(
        'The AI SDK adapter does not support Programmatic Tool Calling. Use a Responses API model directly.',
      );
    }
    return {
      type: providerToolType,
      id: `${providerToolPrefix}.${tool.name}`,
      name: tool.name,
      args: getHostedToolArgs(tool.providerData),
    };
  }

  if (tool.type === 'computer') {
    if (!hasComputerDisplayMetadata(tool)) {
      throw new UserError(
        'The AI SDK adapter requires computer tools to include environment and dimensions metadata.',
      );
    }

    return {
      type: providerToolType,
      id: `${providerToolPrefix}.${tool.name}`,
      name: tool.name,
      args: {
        environment: tool.environment,
        display_width: tool.dimensions[0],
        display_height: tool.dimensions[1],
      },
    };
  }

  throw new Error(`Unsupported tool type: ${JSON.stringify(tool)}`);
}

function getProviderToolPrefix(model: LanguageModelCompatible): string {
  const specificationVersion = getSpecVersion(model);
  if (specificationVersion !== 'v3' && specificationVersion !== 'v4') {
    return model.provider;
  }
  const providerLower = model.provider.toLowerCase();
  if (providerLower.startsWith('openai.')) {
    return 'openai';
  }
  return model.provider;
}

/**
 * @internal
 * Converts an output type to a language model V2 response format.
 *
 * @param outputType - The output type to convert.
 * @returns The language model V2 response format.
 */
export function getResponseFormat(
  outputType: SerializedOutputType,
): LanguageModelV2CallOptions['responseFormat'] {
  if (outputType === 'text') {
    return {
      type: 'text',
    };
  }

  return {
    type: 'json',
    name: outputType.name,
    schema: outputType.schema,
  };
}

export type AiSdkOutputTextTransformContext = {
  request: ModelRequest;
  provider: string;
  modelId: string;
  specificationVersion: AiSdkSpecificationVersion;
  stream: boolean;
};

export type AiSdkOutputTextTransform = (
  text: string,
  context: AiSdkOutputTextTransformContext,
) => string | Promise<string>;

export type AiSdkModelOptions = {
  /**
   * Optional hook to normalize finalized assistant text emitted by the adapter.
   * Runs on non-stream responses and on the final `response_done` event for
   * streams. Incremental `output_text_delta` events are not transformed.
   */
  transformOutputText?: AiSdkOutputTextTransform;
};

/**
 * Wraps a model from the AI SDK that adheres to the LanguageModel v2, v3, or v4
 * specification to be used as a model in the OpenAI Agents SDK.
 *
 * While you can use this with the OpenAI models, it is recommended to use the default OpenAI model
 * provider instead.
 *
 * If tracing is enabled, the model will send generation spans to your traces processor.
 *
 * ```ts
 * import { aisdk } from '@openai/agents-extensions/ai-sdk';
 * import { openai } from '@ai-sdk/openai';
 *
 * const model = aisdk(openai('gpt-4o'));
 *
 * const agent = new Agent({
 *   name: 'My Agent',
 *   model
 * });
 * ```
 *
 * @param model - The Vercel AI SDK model to wrap.
 * @returns The wrapped model.
 */
export class AiSdkModel implements Model {
  #model: LanguageModelCompatible;
  #options: AiSdkModelOptions;
  #logger = getLogger('openai-agents:extensions:ai-sdk');
  constructor(model: LanguageModelCompatible, options: AiSdkModelOptions = {}) {
    ensureSupportedModel(model);
    this.#model = model;
    this.#options = options;
  }

  getRetryAdvice(args: ModelRetryAdviceRequest): ModelRetryAdvice | undefined {
    const error = args.error;
    const isRetryable =
      typeof (error as any)?.isRetryable === 'boolean'
        ? (error as any).isRetryable
        : undefined;

    if (isRetryable === false) {
      return {
        suggested: false,
        reason: error instanceof Error ? error.message : undefined,
      };
    }

    if (isRetryable === true) {
      return {
        suggested: true,
        reason: error instanceof Error ? error.message : undefined,
      };
    }

    return undefined;
  }

  async #transformOutputText(
    text: string,
    request: ModelRequest,
    stream: boolean,
  ): Promise<string> {
    const transform = this.#options.transformOutputText;
    if (!transform) {
      return text;
    }

    const transformed = await transform(text, {
      request,
      provider: this.#model.provider,
      modelId: this.#model.modelId,
      specificationVersion: getSpecVersion(this.#model),
      stream,
    });

    if (typeof transformed !== 'string') {
      throw new UserError('transformOutputText must return a string');
    }

    return transformed;
  }

  async #transformOutputTextItems(
    items: ModelResponse['output'],
    request: ModelRequest,
    stream: boolean,
  ): Promise<void> {
    let parts: protocol.OutputText[] = [];
    const transformParts = async () => {
      if (parts.length === 0) {
        return;
      }

      const currentParts = parts;
      parts = [];
      const originalLengths = currentParts.map((part) => part.text.length);
      const transformedText = await this.#transformOutputText(
        currentParts.map((part) => part.text).join(''),
        request,
        stream,
      );
      let offset = 0;
      for (const [index, part] of currentParts.entries()) {
        const end =
          index === currentParts.length - 1
            ? transformedText.length
            : Math.min(transformedText.length, offset + originalLengths[index]);
        part.text = transformedText.slice(offset, end);
        offset = end;
      }
    };

    for (const item of items) {
      if (item.type === 'message' && item.role === 'assistant') {
        parts.push(
          ...item.content.filter(
            (content): content is protocol.OutputText =>
              content.type === 'output_text',
          ),
        );
      } else if (item.type !== 'reasoning') {
        await transformParts();
      }
    }
    await transformParts();
  }

  async getResponse(request: ModelRequest) {
    return withGenerationSpan(async (span) => {
      try {
        span.spanData.model = this.#model.provider + ':' + this.#model.modelId;
        span.spanData.model_config = {
          provider: this.#model.provider,
          model_impl: 'ai-sdk',
        };

        let input: LanguageModelV2Prompt =
          typeof request.input === 'string'
            ? [
                {
                  role: 'user',
                  content: [{ type: 'text', text: request.input }],
                },
              ]
            : itemsToLanguageV2Messages(
                this.#model,
                request.input,
                request.modelSettings,
              );

        if (request.systemInstructions) {
          input = [
            {
              role: 'system',
              content: request.systemInstructions,
            },
            ...input,
          ];
        }

        const resolvedRequestedTools = resolveRequestedTools(
          request,
          this.#logger,
        );
        const tools = [
          ...resolvedRequestedTools.tools.map((tool) =>
            toolToLanguageV2Tool(this.#model, tool),
          ),
          ...resolvedRequestedTools.handoffs.map((handoff) =>
            handoffToLanguageV2Tool(this.#model, handoff),
          ),
        ];

        if (span && request.tracing === true) {
          span.spanData.input = input;
        }

        if (isZodObject(request.outputType)) {
          throw new UserError('Zod output type is not yet supported');
        }

        const requestedToolsByName = resolvedRequestedTools.toolsByName;

        const responseFormat: LanguageModelV2CallOptions['responseFormat'] =
          getResponseFormat(request.outputType);

        const aiSdkRequest: LanguageModelV2CallOptionsCompat = {
          ...(tools.length ? { tools } : {}),
          toolChoice: toolChoiceToLanguageV2Format(
            request.modelSettings.toolChoice,
          ),
          prompt: input,
          temperature: request.modelSettings.temperature,
          topP: request.modelSettings.topP,
          frequencyPenalty: request.modelSettings.frequencyPenalty,
          presencePenalty: request.modelSettings.presencePenalty,
          maxOutputTokens: request.modelSettings.maxTokens,
          responseFormat,
          abortSignal: request.signal,

          ...getAiSdkProviderData(this.#model, request.modelSettings),
        };

        if (this.#logger.dontLogModelData) {
          this.#logger.debug('Request sent');
        } else {
          this.#logger.debug('Request:', JSON.stringify(aiSdkRequest, null, 2));
        }

        const result = await this.#model.doGenerate(aiSdkRequest);
        const rawUsage =
          request.modelSettings.preserveRawUsage === true
            ? snapshotRawUsage((result as any).usage)
            : undefined;
        const preservedUsage =
          rawUsage !== undefined
            ? extractUsage((result as any).usage)
            : undefined;
        const baseProviderData = buildBaseProviderData(
          this.#model,
          (result as any).response?.id,
        );

        const output: ModelResponse['output'] = [];

        const resultContent = (result as any).content ?? [];

        const hasToolCalls = resultContent.some(
          (c: any) => c && c.type === 'tool-call',
        );
        const requestedToolsByCallId = new Map<
          string,
          SerializedTool | SerializedHandoff
        >();
        let pendingTextParts: string[] = [];
        const flushPendingText = () => {
          if (pendingTextParts.length === 0) {
            return;
          }
          const textOutput: protocol.OutputText = {
            type: 'output_text',
            text: pendingTextParts.join(''),
          };
          output.push({
            type: 'message',
            content: [textOutput],
            role: 'assistant',
            status: 'completed',
            providerData: mergeProviderData(
              baseProviderData,
              (result as any).providerMetadata,
            ),
          });
          pendingTextParts = [];
        };
        for (const part of resultContent) {
          if (!part) {
            continue;
          }

          if (part.type === 'text' && typeof part.text === 'string') {
            pendingTextParts.push(part.text);
            continue;
          }

          if (part.type === 'reasoning') {
            const reasoningText =
              typeof part.text === 'string' ? part.text : '';
            const reasoningProviderMetadata = mergeProviderData(
              undefined,
              part.providerMetadata,
            );
            if (
              !shouldEmitReasoning(reasoningText, reasoningProviderMetadata)
            ) {
              continue;
            }
            flushPendingText();
            output.push({
              type: 'reasoning',
              content: [{ type: 'input_text', text: reasoningText }],
              rawContent: [{ type: 'reasoning_text', text: reasoningText }],
              providerData: mergeProviderData(
                baseProviderData,
                reasoningProviderMetadata,
              ),
            });
            continue;
          }

          if (part.type !== 'tool-call' && part.type !== 'tool-result') {
            continue;
          }

          const requestedTool =
            typeof part.toolName === 'string'
              ? (requestedToolsByName.get(part.toolName) ??
                requestedToolsByCallId.get(part.toolCallId))
              : requestedToolsByCallId.get(part.toolCallId);

          if (part.type === 'tool-call') {
            if (!requestedTool && part.toolName) {
              if (
                this.#logger.dontLogModelData ||
                this.#logger.dontLogToolData
              ) {
                this.#logger.warn(
                  'Received tool call for an unknown tool. Tool name is redacted.',
                );
              } else {
                this.#logger.warn(
                  `Received tool call for unknown tool '${part.toolName}'.`,
                );
              }
            }
            if (requestedTool && typeof part.toolCallId === 'string') {
              requestedToolsByCallId.set(part.toolCallId, requestedTool);
            }

            const toolCallItem = createProtocolToolCallItem({
              requestedTool,
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
              providerExecuted: part.providerExecuted,
              providerData: mergeProviderData(
                baseProviderData,
                part.providerMetadata ??
                  (hasToolCalls ? result.providerMetadata : undefined),
              ),
            });
            flushPendingText();
            output.push(toolCallItem);
            continue;
          }

          const toolSearchOutput = createProtocolToolSearchOutputItem({
            requestedTool,
            toolCallId: part.toolCallId,
            part,
            providerData: mergeProviderData(
              baseProviderData,
              part.providerMetadata ?? result.providerMetadata,
            ),
          });
          if (toolSearchOutput) {
            flushPendingText();
            output.push(toolSearchOutput);
          }
        }
        flushPendingText();
        await this.#transformOutputTextItems(output, request, false);
        const usage = preservedUsage ?? extractUsage((result as any).usage);

        if (span && request.tracing === true) {
          span.spanData.output = output;
        }

        const response = {
          responseId: (result as any).response?.id ?? 'FAKE_ID',
          usage: new Usage(usage),
          output,
          providerData: result,
          ...(request.modelSettings.preserveRawUsage === true
            ? { rawUsage }
            : {}),
        } as const;

        if (span && request.tracing === true) {
          span.spanData.usage = toTracingUsage(usage);
        }

        if (this.#logger.dontLogModelData) {
          this.#logger.debug('Response ready');
        } else {
          this.#logger.debug('Response:', JSON.stringify(response, null, 2));
        }

        return response;
      } catch (error) {
        if (error instanceof Error) {
          span.setError({
            message: request.tracing === true ? error.message : 'Unknown error',
            data: {
              error:
                request.tracing === true
                  ? {
                      name: error.name,
                      message: error.message,
                      // Include AI SDK specific error fields if they exist.
                      ...(typeof error === 'object' && error !== null
                        ? {
                            ...('responseBody' in error
                              ? { responseBody: (error as any).responseBody }
                              : {}),
                            ...('responseHeaders' in error
                              ? {
                                  responseHeaders: (error as any)
                                    .responseHeaders,
                                }
                              : {}),
                            ...('statusCode' in error
                              ? { statusCode: (error as any).statusCode }
                              : {}),
                            ...('cause' in error
                              ? { cause: (error as any).cause }
                              : {}),
                          }
                        : {}),
                    }
                  : error.name,
            },
          });
        } else {
          span.setError({
            message: 'Unknown error',
            data: {
              error: request.tracing === true ? String(error) : undefined,
            },
          });
        }
        throw error;
      }
    });
  }

  async *getStreamedResponse(
    request: ModelRequest,
  ): AsyncIterable<ResponseStreamEvent> {
    const span = request.tracing ? createGenerationSpan() : undefined;
    try {
      if (span) {
        span.start();
        setCurrentSpan(span);
      }

      if (span?.spanData) {
        span.spanData.model = this.#model.provider + ':' + this.#model.modelId;
        span.spanData.model_config = {
          provider: this.#model.provider,
          model_impl: 'ai-sdk',
        };
      }

      let input: LanguageModelV2Prompt =
        typeof request.input === 'string'
          ? [
              {
                role: 'user',
                content: [{ type: 'text', text: request.input }],
              },
            ]
          : itemsToLanguageV2Messages(
              this.#model,
              request.input,
              request.modelSettings,
            );

      if (request.systemInstructions) {
        input = [
          {
            role: 'system',
            content: request.systemInstructions,
          },
          ...input,
        ];
      }

      const resolvedRequestedTools = resolveRequestedTools(
        request,
        this.#logger,
      );
      const tools = [
        ...resolvedRequestedTools.tools.map((tool) =>
          toolToLanguageV2Tool(this.#model, tool),
        ),
        ...resolvedRequestedTools.handoffs.map((handoff) =>
          handoffToLanguageV2Tool(this.#model, handoff),
        ),
      ];

      if (span && request.tracing === true) {
        span.spanData.input = input;
      }

      const responseFormat: LanguageModelV2CallOptions['responseFormat'] =
        getResponseFormat(request.outputType);

      const aiSdkRequest: LanguageModelV2CallOptionsCompat = {
        ...(tools.length ? { tools } : {}),
        toolChoice: toolChoiceToLanguageV2Format(
          request.modelSettings.toolChoice,
        ),
        prompt: input,
        temperature: request.modelSettings.temperature,
        topP: request.modelSettings.topP,
        frequencyPenalty: request.modelSettings.frequencyPenalty,
        presencePenalty: request.modelSettings.presencePenalty,
        maxOutputTokens: request.modelSettings.maxTokens,
        responseFormat,
        abortSignal: request.signal,
        ...getAiSdkProviderData(this.#model, request.modelSettings),
      };
      const requestedToolsByName = resolvedRequestedTools.toolsByName;

      if (this.#logger.dontLogModelData) {
        this.#logger.debug('Request received (streamed)');
      } else {
        this.#logger.debug(
          'Request (streamed):',
          JSON.stringify(aiSdkRequest, null, 2),
        );
      }

      const { stream } = await this.#model.doStream(aiSdkRequest);
      const baseProviderData = buildBaseProviderData(this.#model);

      let started = false;
      let responseId: string | undefined;
      let usagePromptTokens = 0;
      let usageCompletionTokens = 0;
      let usageInputTokensDetails: Record<string, number> | undefined;
      let usageOutputTokensDetails: Record<string, number> | undefined;
      let rawUsage: Record<string, unknown> | undefined;
      const recordUsage = (usage: ReturnType<typeof extractUsage>) => {
        usagePromptTokens = usage.inputTokens;
        usageCompletionTokens = usage.outputTokens;
        usageInputTokensDetails = usage.inputTokensDetails;
        usageOutputTokensDetails = usage.outputTokensDetails;
      };
      type StreamOutputEntry =
        | { kind: 'reasoning'; reasoningId: string }
        | {
            kind: 'text';
            output: protocol.OutputText;
            itemId?: string;
          }
        | {
            kind: 'tool';
            item:
              | protocol.FunctionCallItem
              | protocol.ToolSearchCallItem
              | protocol.ToolSearchOutputItem;
          };
      const orderedOutputEntries: StreamOutputEntry[] = [];
      const toolCallEntryIndexById = new Map<string, number>();
      const requestedToolsByCallId = new Map<
        string,
        SerializedTool | SerializedHandoff
      >();
      let activeTextEntry:
        Extract<StreamOutputEntry, { kind: 'text' }> | undefined;

      const reasoningBlocks = new Map<
        string,
        {
          text: string;
          providerMetadata?: Record<string, any>;
        }
      >();
      const getReasoningBlock = (
        reasoningId: string,
        providerMetadata: Record<string, any> | undefined,
      ) => {
        let reasoningBlock = reasoningBlocks.get(reasoningId);
        if (!reasoningBlock) {
          reasoningBlock = { text: '' };
          reasoningBlocks.set(reasoningId, reasoningBlock);
          orderedOutputEntries.push({ kind: 'reasoning', reasoningId });
        }
        reasoningBlock.providerMetadata = mergeProviderMetadata(
          reasoningBlock.providerMetadata,
          providerMetadata,
        );
        return reasoningBlock;
      };
      const closeActiveTextForReasoning = (reasoningBlock: {
        text: string;
        providerMetadata?: Record<string, any>;
      }) => {
        if (
          shouldEmitReasoning(
            reasoningBlock.text,
            reasoningBlock.providerMetadata,
          )
        ) {
          activeTextEntry = undefined;
        }
      };

      const appendToolItem = (
        item:
          | protocol.FunctionCallItem
          | protocol.ToolSearchCallItem
          | protocol.ToolSearchOutputItem,
        toolCallId?: string,
      ) => {
        const existingIndex = toolCallId
          ? toolCallEntryIndexById.get(toolCallId)
          : undefined;
        if (existingIndex === undefined) {
          activeTextEntry = undefined;
          const entryIndex = orderedOutputEntries.length;
          orderedOutputEntries.push({ kind: 'tool', item });
          if (toolCallId) {
            toolCallEntryIndexById.set(toolCallId, entryIndex);
          }
        } else {
          orderedOutputEntries[existingIndex] = { kind: 'tool', item };
        }
      };

      for await (const part of stream) {
        const preservedFinishUsage =
          part.type === 'finish' &&
          request.modelSettings.preserveRawUsage === true
            ? snapshotRawUsage((part as any).usage)
            : undefined;
        if (part.type === 'finish') {
          rawUsage = preservedFinishUsage;
          if (preservedFinishUsage !== undefined) {
            recordUsage(extractUsage(preservedFinishUsage));
          }
        }

        if (!started) {
          started = true;
          yield { type: 'response_started' };
        }

        yield { type: 'model', event: part };

        switch (part.type) {
          case 'text-delta': {
            if (!activeTextEntry) {
              activeTextEntry = {
                kind: 'text',
                output: { type: 'output_text', text: '' },
                itemId:
                  typeof (part as any).id === 'string'
                    ? (part as any).id
                    : undefined,
              };
              orderedOutputEntries.push(activeTextEntry);
            }
            activeTextEntry.output.text += (part as any).delta;
            yield {
              type: 'output_text_delta',
              delta: (part as any).delta,
              ...(activeTextEntry.itemId
                ? { itemId: activeTextEntry.itemId }
                : {}),
            };
            break;
          }
          case 'reasoning-start': {
            // Start tracking a new reasoning block
            const reasoningId = (part as any).id ?? 'default';
            const reasoningBlock = getReasoningBlock(
              reasoningId,
              (part as any).providerMetadata,
            );
            closeActiveTextForReasoning(reasoningBlock);
            break;
          }
          case 'reasoning-delta': {
            // Accumulate reasoning text
            const reasoningId = (part as any).id ?? 'default';
            const reasoningBlock = getReasoningBlock(
              reasoningId,
              (part as any).providerMetadata,
            );
            reasoningBlock.text += (part as any).delta ?? '';
            closeActiveTextForReasoning(reasoningBlock);
            break;
          }
          case 'reasoning-end': {
            // Capture final provider metadata (may contain signature)
            const reasoningId = (part as any).id ?? 'default';
            const reasoningBlock = getReasoningBlock(
              reasoningId,
              (part as any).providerMetadata,
            );
            closeActiveTextForReasoning(reasoningBlock);
            break;
          }
          case 'tool-call': {
            const toolCallId = (part as any).toolCallId;
            if (toolCallId) {
              const requestedTool =
                typeof (part as any).toolName === 'string'
                  ? requestedToolsByName.get((part as any).toolName)
                  : undefined;
              if (requestedTool) {
                requestedToolsByCallId.set(toolCallId, requestedTool);
              }
              const toolCallItem = createProtocolToolCallItem({
                requestedTool,
                toolCallId,
                toolName: (part as any).toolName,
                input: (part as any).input,
                providerExecuted: (part as any).providerExecuted,
                providerData: mergeProviderData(
                  baseProviderData,
                  (part as any).providerMetadata,
                ),
              });
              appendToolItem(toolCallItem, toolCallId);
            }
            break;
          }
          case 'tool-result': {
            const toolCallId = (part as any).toolCallId;
            if (!toolCallId) {
              break;
            }
            const requestedTool =
              typeof (part as any).toolName === 'string'
                ? (requestedToolsByName.get((part as any).toolName) ??
                  requestedToolsByCallId.get(toolCallId))
                : requestedToolsByCallId.get(toolCallId);
            const toolSearchOutput = createProtocolToolSearchOutputItem({
              requestedTool,
              toolCallId,
              part,
              providerData: mergeProviderData(
                baseProviderData,
                (part as any).providerMetadata,
              ),
            });
            if (toolSearchOutput) {
              appendToolItem(toolSearchOutput);
            }
            break;
          }
          case 'response-metadata': {
            if ((part as any).id) {
              responseId = (part as any).id;
            }
            break;
          }
          case 'finish': {
            if (preservedFinishUsage === undefined) {
              recordUsage(extractUsage((part as any).usage));
            }
            break;
          }
          case 'error': {
            throw part.error;
          }
          default:
            break;
        }
      }

      const outputs: protocol.OutputModelItem[] = [];

      for (const entry of orderedOutputEntries) {
        if (entry.kind === 'reasoning') {
          const reasoningBlock = reasoningBlocks.get(entry.reasoningId);
          if (!reasoningBlock) {
            continue;
          }
          if (
            !shouldEmitReasoning(
              reasoningBlock.text,
              reasoningBlock.providerMetadata,
            )
          ) {
            continue;
          }
          outputs.push({
            type: 'reasoning',
            id: entry.reasoningId !== 'default' ? entry.reasoningId : undefined,
            content: [{ type: 'input_text', text: reasoningBlock.text }],
            rawContent: [{ type: 'reasoning_text', text: reasoningBlock.text }],
            // Preserve provider-specific metadata (including signature for Anthropic extended thinking)
            providerData: mergeProviderData(
              baseProviderData,
              reasoningBlock.providerMetadata,
              responseId ? { responseId } : undefined,
            ),
          });
          continue;
        }

        if (entry.kind === 'text') {
          outputs.push({
            type: 'message',
            ...(entry.itemId ? { id: entry.itemId } : {}),
            role: 'assistant',
            content: [entry.output],
            status: 'completed',
            providerData: mergeProviderData(
              baseProviderData,
              responseId ? { responseId } : undefined,
            ),
          });
          continue;
        }

        outputs.push({
          ...entry.item,
          providerData: mergeProviderData(
            baseProviderData,
            entry.item.providerData,
            responseId ? { responseId } : undefined,
          ),
        });
      }
      await this.#transformOutputTextItems(outputs, request, true);

      const finalEvent: protocol.StreamEventResponseCompleted = {
        type: 'response_done',
        response: {
          id: responseId ?? 'FAKE_ID',
          usage: {
            inputTokens: usagePromptTokens,
            outputTokens: usageCompletionTokens,
            totalTokens: usagePromptTokens + usageCompletionTokens,
            ...(usageInputTokensDetails
              ? {
                  inputTokensDetails: usageInputTokensDetails,
                }
              : {}),
            ...(usageOutputTokensDetails
              ? {
                  outputTokensDetails: usageOutputTokensDetails,
                }
              : {}),
          },
          ...(request.modelSettings.preserveRawUsage === true && rawUsage
            ? { rawUsage }
            : {}),
          output: outputs,
        },
      };

      if (span && request.tracing === true) {
        span.spanData.output = outputs;
        span.spanData.usage = toTracingUsage({
          inputTokens: usagePromptTokens,
          outputTokens: usageCompletionTokens,
          ...(usageInputTokensDetails
            ? {
                inputTokensDetails: usageInputTokensDetails,
              }
            : {}),
          ...(usageOutputTokensDetails
            ? {
                outputTokensDetails: usageOutputTokensDetails,
              }
            : {}),
        });
      }

      if (this.#logger.dontLogModelData) {
        this.#logger.debug('Response ready (streamed)');
      } else {
        this.#logger.debug(
          'Response (streamed):',
          JSON.stringify(finalEvent.response, null, 2),
        );
      }

      yield finalEvent;
    } catch (error) {
      if (span) {
        span.setError({
          message:
            request.tracing === true && error instanceof Error
              ? error.message
              : 'Unknown error',
          data: {
            error:
              request.tracing === true
                ? error instanceof Error
                  ? {
                      name: error.name,
                      message: error.message,
                      // Include AI SDK specific error fields if they exist.
                      ...(typeof error === 'object' && error !== null
                        ? {
                            ...('responseBody' in error
                              ? { responseBody: (error as any).responseBody }
                              : {}),
                            ...('responseHeaders' in error
                              ? {
                                  responseHeaders: (error as any)
                                    .responseHeaders,
                                }
                              : {}),
                            ...('statusCode' in error
                              ? { statusCode: (error as any).statusCode }
                              : {}),
                            ...('cause' in error
                              ? { cause: (error as any).cause }
                              : {}),
                          }
                        : {}),
                    }
                  : String(error)
                : error instanceof Error
                  ? error.name
                  : undefined,
          },
        });
      }
      throw error;
    } finally {
      if (span) {
        span.end();
        resetCurrentSpan();
      }
    }
  }
}

/**
 * Wraps a model from the AI SDK that adheres to the LanguageModel v2, v3, or v4
 * specification to be used as a model in the OpenAI Agents SDK.
 *
 * While you can use this with the OpenAI models, it is recommended to use the default OpenAI model
 * provider instead.
 *
 * If tracing is enabled, the model will send generation spans to your traces processor.
 *
 * ```ts
 * import { aisdk } from '@openai/agents-extensions/ai-sdk';
 * import { openai } from '@ai-sdk/openai';
 *
 * const model = aisdk(openai('gpt-4o'));
 *
 * const agent = new Agent({
 *   name: 'My Agent',
 *   model
 * });
 * ```
 *
 * @param model - The Vercel AI SDK model to wrap.
 * @param options - Optional AI SDK adapter behavior overrides.
 * @returns The wrapped model.
 */
export function aisdk(
  model: LanguageModelCompatible,
  options: AiSdkModelOptions = {},
) {
  return new AiSdkModel(model, options);
}

export function toolChoiceToLanguageV2Format(
  toolChoice: ModelSettingsToolChoice | undefined,
): LanguageModelV2ToolChoice | undefined {
  if (!toolChoice) {
    return undefined;
  }
  switch (toolChoice) {
    case 'auto':
      return { type: 'auto' };
    case 'required':
      return { type: 'required' };
    case 'none':
      return { type: 'none' };
    default:
      return { type: 'tool', toolName: toolChoice };
  }
}
