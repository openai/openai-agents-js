import {
  Model,
  Usage,
  withResponseSpan,
  createResponseSpan,
  setCurrentSpan,
  resetCurrentSpan,
  protocol,
  UserError,
  ModelBehaviorError,
} from '@openai/agents-core';
import type {
  ModelRetryAdvice,
  ModelRetryAdviceRequest,
  SerializedHandoff,
  SerializedTool,
  ModelRequest,
  ModelResponse,
  ModelSettingsContextManagement,
  ModelSettingsToolChoice,
  ResponseStreamEvent,
  SerializedOutputType,
} from '@openai/agents-core';
import OpenAI from 'openai';
import logger from './logger';
import { OPENAI_RESPONSES_RAW_MODEL_EVENT_SOURCE } from './rawModelEvents';
import { getOpenAIRetryAdvice } from './retryAdvice';
import {
  ToolChoiceFunction,
  ToolChoiceOptions,
  ToolChoiceTypes,
} from 'openai/resources/responses/responses';
import { z } from 'zod';
import { HEADERS } from './defaults';
import {
  ResponsesWebSocketConnection,
  ResponsesWebSocketInternalError,
  isWebSocketNotOpenError,
  shouldWrapNoEventWebSocketError,
  throwIfAborted,
  webSocketFrameToText,
  withAbortSignal,
  withTimeout,
  type ResponsesWebSocketKeepAliveOptions,
  type WebSocketMessageValue,
} from './responsesWebSocketConnection';
import {
  applyHeadersToAccumulator,
  createHeaderAccumulator,
  ensureResponsesWebSocketPath,
  headerAccumulatorToRecord,
  headerAccumulatorToSDKHeaders,
  mergeQueryParamsIntoURL,
  splitResponsesTransportOverrides,
} from './responsesTransportUtils';
import type { OpenAIClient } from './openaiClient';
import { camelOrSnakeToSnakeCase } from './utils/providerData';
import { normalizePromptCacheRetention } from './utils/modelSettings';
import {
  normalizeInstructions,
  searchParamsToAuthHeaderQuery,
  toRequestUsageEntry,
} from './responsesUtils';
import { ProviderData } from '@openai/agents-core/types';
import { normalizeHostedMcpRequireApproval } from '@openai/agents-core/utils';
import {
  reportModelFailureUsage,
  snapshotRawUsage,
} from '@openai/agents-core/utils/internal';
import {
  getInputItems,
  convertToOutputItem,
  getPrompt,
  isRecord,
} from './openaiResponsesConverter';
import type { ResponseOutputItemWithFunctionResult } from './openaiResponsesConverter';

type ModelTracingParent = Parameters<typeof createResponseSpan>[1];

type ResponsesEndpointTransport = 'http' | 'websocket';

function isOfficialOpenAIEndpoint(
  baseURL: string | URL | undefined,
  transport: ResponsesEndpointTransport,
): boolean {
  if (!baseURL) {
    return false;
  }

  try {
    const parsedURL = new URL(baseURL);
    if (parsedURL.hostname !== 'api.openai.com' || parsedURL.port.length > 0) {
      return false;
    }

    if (transport === 'http') {
      return parsedURL.protocol === 'https:';
    }

    return parsedURL.protocol === 'https:' || parsedURL.protocol === 'wss:';
  } catch {
    return false;
  }
}

function getModelTracingParent(request: ModelRequest): ModelTracingParent {
  return (
    request as ModelRequest & {
      _internal?: { tracingParent?: ModelTracingParent };
    }
  )._internal?.tracingParent;
}

type ToolChoice =
  | ToolChoiceOptions
  | ToolChoiceTypes
  // TODO: remove this once the underlying ToolChoiceTypes include this.
  | { type: 'web_search' }
  // TODO: remove this once the underlying ToolChoiceTypes include this.
  | { type: 'tool_search' }
  | ToolChoiceFunction;

type ResponsesCreateRequestSDKHeaders = ReturnType<
  typeof headerAccumulatorToSDKHeaders
>;

type BuiltResponsesCreateRequest = {
  requestData: Record<string, any>;
  sdkRequestHeaders: ResponsesCreateRequestSDKHeaders;
  signal: AbortSignal | undefined;
  transportExtraHeaders?: Record<string, unknown>;
  transportExtraQuery?: Record<string, unknown>;
};

type WebSocketRequestTimeoutDeadline = {
  configuredTimeoutMs: number;
  deadlineAtMs: number;
};

type EnsuredResponsesWebSocketConnection = {
  connection: ResponsesWebSocketConnection;
  reused: boolean;
};

type ResponsesTool = OpenAI.Responses.Tool | Record<string, any>;

type SerializedComputerTool = Extract<SerializedTool, { type: 'computer' }>;

type SerializedShellTool = Extract<SerializedTool, { type: 'shell' }>;

type SerializedShellEnvironment = NonNullable<
  SerializedShellTool['environment']
>;

type OpenAIShellEnvironment = NonNullable<
  OpenAI.Responses.FunctionShellTool['environment']
>;

type OpenAIShellNetworkPolicy =
  | OpenAI.Responses.ContainerNetworkPolicyAllowlist
  | OpenAI.Responses.ContainerNetworkPolicyDisabled;

type OpenAINamespaceMemberTool =
  OpenAI.Responses.NamespaceTool['tools'][number];

type SerializedShellContainerAutoEnvironment = Extract<
  SerializedShellEnvironment,
  { type: 'container_auto' }
>;

type SerializedShellContainerSkill = NonNullable<
  SerializedShellContainerAutoEnvironment['skills']
>[number];

type SerializedShellContainerNetworkPolicy =
  SerializedShellContainerAutoEnvironment['networkPolicy'];

const replaySafeWebSocketErrors = new WeakSet<object>();

const transientNeverSentWebSocketErrors = new WeakSet<object>();

function markReplaySafeWebSocketError(error: unknown): void {
  if (typeof error === 'object' && error !== null) {
    replaySafeWebSocketErrors.add(error);
  }
}

function markTransientNeverSentWebSocketError(error: unknown): void {
  if (typeof error === 'object' && error !== null) {
    transientNeverSentWebSocketErrors.add(error);
  }
}

function isNeverSentWebSocketError(error: unknown): boolean {
  if (
    typeof error === 'object' &&
    error !== null &&
    transientNeverSentWebSocketErrors.has(error)
  ) {
    return true;
  }

  if (
    error instanceof ResponsesWebSocketInternalError &&
    error.code === 'connection_closed_before_opening'
  ) {
    return true;
  }

  const errorCause =
    error instanceof Error
      ? (error as Error & { cause?: unknown }).cause
      : undefined;

  return (
    errorCause instanceof ResponsesWebSocketInternalError &&
    errorCause.code === 'connection_closed_before_opening'
  );
}

function isReplaySafeWebSocketError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    replaySafeWebSocketErrors.has(error)
  );
}

function isTransientConnectionSetupError(error: unknown): boolean {
  return (
    (error instanceof ResponsesWebSocketInternalError &&
      error.code === 'connection_closed_before_opening') ||
    (error instanceof Error &&
      error.message.startsWith(
        'Responses websocket connection timed out before opening after ',
      ))
  );
}

function isAmbiguousWebSocketReplayError(error: unknown): boolean {
  if (
    error instanceof ResponsesWebSocketInternalError &&
    (error.code === 'connection_closed_before_terminal_response_event' ||
      error.code === 'pong_timeout')
  ) {
    return true;
  }

  const errorCause =
    error instanceof Error
      ? (error as Error & { cause?: unknown }).cause
      : undefined;

  return (
    errorCause instanceof ResponsesWebSocketInternalError &&
    (errorCause.code === 'connection_closed_before_terminal_response_event' ||
      errorCause.code === 'pong_timeout')
  );
}

function markUnsafeWebSocketReplayError(
  error: unknown,
  responseStarted: boolean,
): void {
  if (!(error instanceof Error)) {
    return;
  }

  const replayError = error as Error & {
    unsafeToReplay?: boolean;
    responseStarted?: boolean;
  };
  if (replayError.unsafeToReplay !== true) {
    replayError.unsafeToReplay = true;
  }
  if (responseStarted && replayError.responseStarted !== true) {
    replayError.responseStarted = true;
  }
}

function hasSerializedComputerDisplayMetadata(
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

const HostedToolChoice = z.enum([
  'file_search',
  'web_search',
  'web_search_preview',
  'code_interpreter',
  'image_generation',
  'mcp',
  'programmatic_tool_calling',
  // Specialized local tools
  'shell',
  'apply_patch',
]);

const DefaultToolChoice = z.enum(['auto', 'required', 'none']);

const BuiltinComputerToolChoice = z.enum([
  'computer',
  'computer_use',
  'computer_use_preview',
]);

function getToolChoice(
  toolChoice?: ModelSettingsToolChoice,
  options?: {
    tools?: Array<{ type?: unknown }>;
    model?: string;
    allowPromptSuppliedComputerTool?: boolean;
  },
): ToolChoice | undefined {
  if (typeof toolChoice === 'undefined') {
    return undefined;
  }

  const resultDefaultCheck = DefaultToolChoice.safeParse(toolChoice);
  if (resultDefaultCheck.success) {
    return resultDefaultCheck.data;
  }

  const builtinComputerToolChoice =
    BuiltinComputerToolChoice.safeParse(toolChoice);
  if (builtinComputerToolChoice.success) {
    if (
      hasBuiltinComputerTool(options?.tools) ||
      options?.allowPromptSuppliedComputerTool === true
    ) {
      return getBuiltinComputerToolChoice(builtinComputerToolChoice.data, {
        model: options?.model,
      });
    }

    if (builtinComputerToolChoice.data === 'computer_use_preview') {
      return { type: 'computer_use_preview' };
    }

    return { type: 'function', name: builtinComputerToolChoice.data };
  }

  const result = HostedToolChoice.safeParse(toolChoice);
  if (result.success) {
    return { type: result.data as any };
  }

  return { type: 'function', name: toolChoice };
}

function hasBuiltinComputerTool(tools?: Array<{ type?: unknown }>): boolean {
  return (tools ?? []).some(
    (tool) =>
      tool.type === 'computer' ||
      tool.type === 'computer_use' ||
      tool.type === 'computer_use_preview',
  );
}

function isPreviewComputerModel(model?: string): boolean {
  return typeof model === 'string' && model.startsWith('computer-use-preview');
}

function shouldUsePreviewComputerTool(options?: {
  model?: string;
  toolChoice?: ModelSettingsToolChoice;
}): boolean {
  if (isPreviewComputerModel(options?.model)) {
    return true;
  }

  if (typeof options?.model === 'string') {
    return false;
  }

  if (
    options?.toolChoice === 'computer' ||
    options?.toolChoice === 'computer_use'
  ) {
    return false;
  }

  return true;
}

function getBuiltinComputerToolChoice(
  toolChoice: z.infer<typeof BuiltinComputerToolChoice>,
  options?: {
    model?: string;
  },
): ToolChoice {
  if (
    shouldUsePreviewComputerTool({
      model: options?.model,
      toolChoice,
    })
  ) {
    return { type: 'computer_use_preview' };
  }

  if (toolChoice === 'computer_use') {
    return { type: 'computer_use' };
  }

  return { type: 'computer' };
}

function isBuiltinComputerToolType(type: string): boolean {
  return (
    type === 'computer' ||
    type === 'computer_use' ||
    type === 'computer_use_preview'
  );
}

function isCompatibleBuiltinComputerToolChoice(
  toolChoiceType: string,
  toolType: string,
): boolean {
  if (!isBuiltinComputerToolType(toolChoiceType)) {
    return false;
  }

  if (toolChoiceType === 'computer_use_preview') {
    return toolType === 'computer_use_preview';
  }

  return toolType === 'computer';
}

function isToolChoiceAvailable(
  toolChoice: ToolChoice,
  tools: ResponsesTool[],
): boolean {
  if (toolChoice === 'auto' || toolChoice === 'none') {
    return true;
  }

  if (toolChoice === 'required') {
    return tools.length > 0;
  }

  if (toolChoice.type === 'function') {
    return hasFunctionToolChoiceName(toolChoice.name, tools);
  }

  return tools.some((tool) =>
    isCompatibleBuiltinComputerToolChoice(toolChoice.type, tool.type)
      ? true
      : tool.type === toolChoice.type,
  );
}

function hasFunctionToolChoiceName(
  toolChoiceName: string,
  tools: ResponsesTool[],
  namespacePrefix?: string,
): boolean {
  return (
    findFunctionToolChoice(toolChoiceName, tools, namespacePrefix) !== undefined
  );
}

function findFunctionToolChoice(
  toolChoiceName: string,
  tools: ResponsesTool[],
  namespacePrefix?: string,
):
  | (Extract<ResponsesTool, { type: 'function' }> & { name: string })
  | undefined {
  for (const tool of tools) {
    if (isNamedFunctionTool(tool)) {
      const qualifiedName = namespacePrefix
        ? `${namespacePrefix}.${tool.name}`
        : tool.name;
      if (toolChoiceName === qualifiedName) {
        return tool;
      }
      continue;
    }

    if (isNamespaceTool(tool)) {
      const nestedNamespace = namespacePrefix
        ? `${namespacePrefix}.${tool.name}`
        : tool.name;
      const matchedTool = findFunctionToolChoice(
        toolChoiceName,
        tool.tools,
        nestedNamespace,
      );
      if (matchedTool) {
        return matchedTool;
      }
    }
  }

  return undefined;
}

function collectAvailableToolChoiceNames(
  tools: ResponsesTool[],
  namespacePrefix?: string,
): string[] {
  const availableToolChoices: string[] = [];

  for (const tool of tools) {
    if (isNamedFunctionTool(tool)) {
      availableToolChoices.push(
        namespacePrefix ? `${namespacePrefix}.${tool.name}` : tool.name,
      );
      continue;
    }

    if (isNamespaceTool(tool)) {
      const nestedNamespace = namespacePrefix
        ? `${namespacePrefix}.${tool.name}`
        : tool.name;
      availableToolChoices.push(
        ...collectAvailableToolChoiceNames(tool.tools, nestedNamespace),
      );
      continue;
    }

    availableToolChoices.push(tool.type);
  }

  return availableToolChoices;
}

function isNamedFunctionTool(
  tool: ResponsesTool,
): tool is Extract<ResponsesTool, { type: 'function' }> & { name: string } {
  return (
    tool.type === 'function' &&
    typeof (tool as { name?: unknown }).name === 'string'
  );
}

function isNamespaceTool(tool: ResponsesTool): tool is ResponsesTool & {
  type: 'namespace';
  name: string;
  tools: ResponsesTool[];
} {
  const candidate = tool as { name?: unknown; tools?: unknown };
  return (
    tool.type === 'namespace' &&
    typeof candidate.name === 'string' &&
    Array.isArray(candidate.tools)
  );
}

function getExtraBodyToolsForToolChoiceValidation(
  extraBody: Record<string, unknown> | undefined,
): ResponsesTool[] {
  if (!extraBody || !Array.isArray(extraBody.tools)) {
    return [];
  }

  return extraBody.tools as ResponsesTool[];
}

function assertSupportedToolChoice(
  toolChoice: ToolChoice | undefined,
  tools: ResponsesTool[],
  options?: {
    allowPromptSuppliedTools?: boolean;
  },
): void {
  const allowPromptSuppliedTools = options?.allowPromptSuppliedTools === true;
  if (
    !toolChoice ||
    toolChoice === 'auto' ||
    toolChoice === 'required' ||
    toolChoice === 'none' ||
    toolChoice.type !== 'function'
  ) {
    return;
  }

  const matchedFunctionTool = findFunctionToolChoice(toolChoice.name, tools);

  if (
    !matchedFunctionTool &&
    allowPromptSuppliedTools &&
    toolChoice.name !== 'tool_search'
  ) {
    return;
  }

  if (
    (matchedFunctionTool as { defer_loading?: unknown } | undefined)
      ?.defer_loading === true
  ) {
    throw new UserError(
      `modelSettings.toolChoice="${toolChoice.name}" cannot force a deferred function tool in Responses. Use "auto" so tool_search can load it.`,
    );
  }

  if (
    toolChoice.name === 'tool_search' &&
    !hasFunctionToolChoiceName(toolChoice.name, tools)
  ) {
    throw new UserError(
      'modelSettings.toolChoice="tool_search" is only supported for a custom function named "tool_search". Responses does not support forcing the built-in tool_search tool. Use "auto" instead.',
    );
  }
}

function collectProgrammaticToolConfiguration(tools: ResponsesTool[]): {
  hasProgrammaticToolCalling: boolean;
  hasToolSearch: boolean;
  programmaticEligibleTools: ResponsesTool[];
  programmaticOnlyTools: ResponsesTool[];
} {
  let hasProgrammaticToolCalling = false;
  let hasToolSearch = false;
  const programmaticEligibleTools: ResponsesTool[] = [];
  const programmaticOnlyTools: ResponsesTool[] = [];

  const visit = (tool: ResponsesTool) => {
    if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
      for (const nestedTool of tool.tools) {
        visit(nestedTool);
      }
      return;
    }

    if (tool.type === 'programmatic_tool_calling') {
      hasProgrammaticToolCalling = true;
      return;
    }

    if (tool.type === 'tool_search') {
      hasToolSearch = true;
    }

    const allowedCallers = (tool as { allowed_callers?: unknown })
      .allowed_callers;
    if (
      !Array.isArray(allowedCallers) ||
      !allowedCallers.includes('programmatic')
    ) {
      return;
    }

    programmaticEligibleTools.push(tool);
    if (!allowedCallers.includes('direct')) {
      programmaticOnlyTools.push(tool);
    }
  };

  for (const tool of tools) {
    visit(tool);
  }

  return {
    hasProgrammaticToolCalling,
    hasToolSearch,
    programmaticEligibleTools,
    programmaticOnlyTools,
  };
}

function describeResponsesTool(tool: ResponsesTool): string {
  const name = (tool as { name?: unknown }).name;
  return typeof name === 'string' ? name : String(tool.type);
}

function assertValidProgrammaticToolCallingConfiguration(
  toolChoice: ToolChoice | undefined,
  tools: ResponsesTool[],
  options?: { allowPromptSuppliedTools?: boolean },
): void {
  const allowPromptSuppliedTools = options?.allowPromptSuppliedTools === true;
  const {
    hasProgrammaticToolCalling,
    hasToolSearch,
    programmaticEligibleTools,
    programmaticOnlyTools,
  } = collectProgrammaticToolConfiguration(tools);
  const forcesProgrammaticToolCalling =
    typeof toolChoice === 'object' &&
    (toolChoice as { type?: unknown }).type === 'programmatic_tool_calling';

  if (
    forcesProgrammaticToolCalling &&
    !hasProgrammaticToolCalling &&
    !allowPromptSuppliedTools
  ) {
    throw new UserError(
      'modelSettings.toolChoice="programmatic_tool_calling" requires programmaticToolCallingTool() in the agent tools.',
    );
  }

  if (programmaticOnlyTools.length > 0 && !hasProgrammaticToolCalling) {
    throw new UserError(
      `Tools restricted to programmatic callers require programmaticToolCallingTool(). Affected tools: ${programmaticOnlyTools.map(describeResponsesTool).join(', ')}.`,
    );
  }

  if (
    hasProgrammaticToolCalling &&
    !hasToolSearch &&
    programmaticEligibleTools.length === 0 &&
    !allowPromptSuppliedTools
  ) {
    throw new UserError(
      'programmaticToolCallingTool() requires at least one tool whose allowedCallers includes "programmatic".',
    );
  }
}

function getCompatibleToolChoice(
  toolChoice: ToolChoice | undefined,
  tools: ResponsesTool[],
  options?: {
    allowPromptSuppliedTools?: boolean;
  },
): ToolChoice | undefined {
  const allowPromptSuppliedTools = options?.allowPromptSuppliedTools === true;
  if (typeof toolChoice === 'undefined') {
    return undefined;
  }

  if (isToolChoiceAvailable(toolChoice, tools) || allowPromptSuppliedTools) {
    return toolChoice;
  }

  const availableToolChoices = [
    ...new Set(collectAvailableToolChoiceNames(tools)),
  ];
  const availableToolChoicesMessage =
    availableToolChoices.length > 0
      ? ` Available tools: ${availableToolChoices.join(', ')}.`
      : ' No tools are available in the outgoing Responses request.';

  if (toolChoice === 'required') {
    throw new UserError(
      `modelSettings.toolChoice="required" requires at least one available tool in the outgoing Responses request.${availableToolChoicesMessage}`,
    );
  }

  if (toolChoice === 'auto' || toolChoice === 'none') {
    throw new Error(
      `Unexpected unavailable tool choice: ${JSON.stringify(toolChoice)}`,
    );
  }

  if (toolChoice.type === 'function') {
    throw new UserError(
      `modelSettings.toolChoice="${toolChoice.name}" does not match any available tool in the outgoing Responses request.${availableToolChoicesMessage}`,
    );
  }

  throw new UserError(
    `modelSettings.toolChoice="${toolChoice.type}" is unavailable in the outgoing Responses request.${availableToolChoicesMessage}`,
  );
}

function getResponseFormat(
  outputType: SerializedOutputType,
  otherProperties: Record<string, any> | undefined,
): OpenAI.Responses.ResponseTextConfig | undefined {
  if (outputType === 'text') {
    return otherProperties;
  }

  return {
    ...otherProperties,
    format: outputType,
  };
}

function getContextManagement(
  contextManagement: ModelSettingsContextManagement | undefined,
): unknown {
  if (!contextManagement) {
    return undefined;
  }

  return contextManagement.map((entry) => camelOrSnakeToSnakeCase(entry));
}

function toOpenAIShellSkill(
  skill: SerializedShellContainerSkill,
): OpenAI.Responses.SkillReference | OpenAI.Responses.InlineSkill {
  if (skill.type === 'skill_reference') {
    const skillId = skill.skillId;
    if (typeof skillId !== 'string' || skillId.length === 0) {
      throw new UserError('shell skill_reference requires skillId.');
    }

    return {
      type: 'skill_reference',
      skill_id: skillId,
      version: skill.version,
    };
  }

  if (skill.type === 'inline') {
    if (!skill.source) {
      throw new UserError('shell inline skill requires a source.');
    }
    const mediaType = skill.source.mediaType;
    if (mediaType !== 'application/zip') {
      throw new UserError(
        'shell inline skill source.mediaType must be application/zip.',
      );
    }
    if (
      typeof skill.source.data !== 'string' ||
      skill.source.data.length === 0
    ) {
      throw new UserError('shell inline skill source.data is required.');
    }
    if (typeof skill.name !== 'string' || skill.name.length === 0) {
      throw new UserError('shell inline skill requires name.');
    }
    if (
      typeof skill.description !== 'string' ||
      skill.description.length === 0
    ) {
      throw new UserError('shell inline skill requires description.');
    }

    return {
      type: 'inline',
      name: skill.name,
      description: skill.description,
      source: {
        type: 'base64',
        media_type: 'application/zip',
        data: skill.source.data,
      },
    };
  }

  throw new UserError(
    `Unsupported shell skill type: ${String(
      (skill as { type?: unknown }).type,
    )}`,
  );
}

function toOpenAIShellNetworkPolicy(
  policy: SerializedShellContainerNetworkPolicy,
): OpenAIShellNetworkPolicy | undefined {
  if (!policy) {
    return undefined;
  }

  if (policy.type === 'disabled') {
    return { type: 'disabled' };
  }

  if (policy.type === 'allowlist') {
    if (!Array.isArray(policy.allowedDomains)) {
      throw new UserError(
        'shell allowlist networkPolicy requires allowedDomains.',
      );
    }

    const allowedDomains = policy.allowedDomains.filter(
      (domain): domain is string =>
        typeof domain === 'string' && domain.length > 0,
    );

    const domainSecrets = policy.domainSecrets?.map((secret) => ({
      domain: secret.domain,
      name: secret.name,
      value: secret.value,
    }));

    return {
      type: 'allowlist',
      allowed_domains: allowedDomains,
      domain_secrets: domainSecrets,
    };
  }

  throw new UserError(
    `Unsupported shell networkPolicy type: ${String(
      (policy as { type?: unknown }).type,
    )}`,
  );
}

function toOpenAIShellEnvironment(
  environment: SerializedShellEnvironment | undefined,
): OpenAIShellEnvironment {
  if (!environment) {
    return { type: 'local' };
  }

  if (environment.type === 'local') {
    const localSkills = environment.skills?.map((skill) => {
      if (
        typeof skill.name !== 'string' ||
        typeof skill.description !== 'string' ||
        typeof skill.path !== 'string'
      ) {
        throw new UserError(
          'Local shell skill requires name, description, and path.',
        );
      }
      return {
        name: skill.name,
        description: skill.description,
        path: skill.path,
      };
    });

    return {
      type: 'local',
      skills: localSkills,
    };
  }

  if (environment.type === 'container_auto') {
    const skills = environment.skills?.map(toOpenAIShellSkill);

    return {
      type: 'container_auto',
      file_ids: environment.fileIds,
      memory_limit: environment.memoryLimit,
      network_policy: toOpenAIShellNetworkPolicy(environment.networkPolicy),
      skills,
    };
  }

  if (environment.type === 'container_reference') {
    const containerId = environment.containerId;
    if (typeof containerId !== 'string' || containerId.length === 0) {
      throw new UserError(
        'shell container_reference environment requires containerId.',
      );
    }

    return {
      type: 'container_reference',
      container_id: containerId,
    };
  }

  throw new UserError(
    `Unsupported shell environment type: ${String(
      (environment as Record<string, any>).type,
    )}`,
  );
}

function getTools<_TContext = unknown>(
  tools: SerializedTool[],
  handoffs: SerializedHandoff[],
  options?: {
    model?: string;
    toolChoice?: ModelSettingsToolChoice;
  },
): {
  tools: ResponsesTool[];
  include: OpenAI.Responses.ResponseIncludable[];
} {
  const openaiTools: ResponsesTool[] = [];
  const include: OpenAI.Responses.ResponseIncludable[] = [];
  const namespaceStateByName = new Map<
    string,
    {
      index: number;
      description: string;
      functionNames: Set<string>;
      tools: OpenAINamespaceMemberTool[];
    }
  >();
  let hasDeferredSearchableTool = false;
  let hasToolSearch = false;
  const usePreviewComputerTool = shouldUsePreviewComputerTool({
    model: options?.model,
    toolChoice: options?.toolChoice,
  });
  for (const tool of tools) {
    if (tool.type === 'function') {
      const isDeferredFunction = tool.deferLoading === true;
      hasDeferredSearchableTool ||= isDeferredFunction;

      const namespaceName =
        typeof tool.namespace === 'string' ? tool.namespace.trim() : '';
      if (namespaceName.length > 0) {
        const namespaceDescription =
          typeof tool.namespaceDescription === 'string'
            ? tool.namespaceDescription.trim()
            : '';
        if (namespaceDescription.length === 0) {
          throw new UserError(
            `All tools in namespace "${namespaceName}" must provide a non-empty description.`,
          );
        }

        let namespaceState = namespaceStateByName.get(namespaceName);
        if (!namespaceState) {
          namespaceState = {
            index: openaiTools.length,
            description: namespaceDescription,
            functionNames: new Set(),
            tools: [],
          };
          namespaceStateByName.set(namespaceName, namespaceState);
          openaiTools.push({});
        } else if (namespaceState.description !== namespaceDescription) {
          throw new UserError(
            `All tools in namespace "${namespaceName}" must share the same description.`,
          );
        }

        const { tool: openaiTool, include: openaiIncludes } = convertTool(
          tool,
          {
            usePreviewComputerTool,
          },
        );
        if (namespaceState.functionNames.has(tool.name)) {
          throw new UserError(
            `Namespace "${namespaceName}" cannot contain duplicate function tool name "${tool.name}".`,
          );
        }
        namespaceState.functionNames.add(tool.name);
        namespaceState.tools.push(openaiTool as OpenAINamespaceMemberTool);
        if (openaiIncludes && openaiIncludes.length > 0) {
          for (const item of openaiIncludes) {
            include.push(item);
          }
        }
        continue;
      }
    }

    if (
      tool.type === 'hosted_tool' &&
      tool.providerData?.type === 'tool_search'
    ) {
      hasToolSearch = true;
    }

    if (
      tool.type === 'hosted_tool' &&
      tool.providerData?.type === 'mcp' &&
      tool.providerData.defer_loading === true
    ) {
      hasDeferredSearchableTool = true;
    }

    const { tool: openaiTool, include: openaiIncludes } = convertTool(tool, {
      usePreviewComputerTool,
    });
    openaiTools.push(openaiTool);
    if (openaiIncludes && openaiIncludes.length > 0) {
      for (const item of openaiIncludes) {
        include.push(item);
      }
    }
  }

  if (hasDeferredSearchableTool && !hasToolSearch) {
    throw new UserError(
      'Deferred function tools and hosted MCP tools with deferLoading: true require toolSearchTool() in the same request.',
    );
  }

  for (const [
    namespaceName,
    namespaceState,
  ] of namespaceStateByName.entries()) {
    openaiTools[namespaceState.index] = {
      type: 'namespace',
      name: namespaceName,
      description: namespaceState.description,
      tools: namespaceState.tools,
    };
  }

  return {
    tools: [...openaiTools, ...handoffs.map(getHandoffTool)],
    include,
  };
}

function convertTool<_TContext = unknown>(
  tool: SerializedTool,
  options?: {
    usePreviewComputerTool?: boolean;
  },
): {
  tool: ResponsesTool;
  include?: OpenAI.Responses.ResponseIncludable[];
} {
  if (tool.type === 'function') {
    const openaiTool: Record<string, any> = {
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: tool.strict,
      ...(tool.allowedCallers
        ? { allowed_callers: [...tool.allowedCallers] }
        : {}),
      ...(tool.outputSchema ? { output_schema: tool.outputSchema } : {}),
    };
    if (tool.deferLoading) {
      openaiTool.defer_loading = true;
    }
    return {
      tool: openaiTool,
      include: undefined,
    };
  } else if (tool.type === 'computer') {
    if (options?.usePreviewComputerTool) {
      if (!hasSerializedComputerDisplayMetadata(tool)) {
        throw new UserError(
          'Preview computer tools require environment and dimensions. Provide them on your Computer implementation or target a GA computer model such as gpt-5.4.',
        );
      }

      return {
        tool: {
          type: 'computer_use_preview',
          environment: tool.environment,
          display_width: tool.dimensions[0],
          display_height: tool.dimensions[1],
        },
        include: undefined,
      };
    }

    return {
      tool: {
        type: 'computer',
      },
      include: undefined,
    };
  } else if (tool.type === 'shell') {
    return {
      tool: {
        type: 'shell',
        environment: toOpenAIShellEnvironment(tool.environment),
        ...(tool.allowedCallers
          ? { allowed_callers: [...tool.allowedCallers] }
          : {}),
      } as OpenAI.Responses.FunctionShellTool,
      include: undefined,
    };
  } else if (tool.type === 'apply_patch') {
    return {
      tool: {
        type: 'apply_patch',
        ...(tool.allowedCallers
          ? { allowed_callers: [...tool.allowedCallers] }
          : {}),
      } as OpenAI.Responses.ApplyPatchTool,
      include: undefined,
    };
  } else if (tool.type === 'hosted_tool') {
    if (tool.providerData?.type === 'web_search') {
      const webSearchTool: OpenAI.Responses.WebSearchTool & {
        external_web_access?: boolean;
      } = {
        type: 'web_search',
        user_location: tool.providerData.user_location,
        filters: tool.providerData.filters,
        search_context_size: tool.providerData.search_context_size,
      };
      if (tool.providerData.external_web_access !== undefined) {
        webSearchTool.external_web_access =
          tool.providerData.external_web_access;
      }
      return {
        tool: webSearchTool,
        include: undefined,
      };
    } else if (tool.providerData?.type === 'web_search_preview') {
      return {
        tool: {
          type: 'web_search_preview',
          user_location: tool.providerData.user_location,
          search_context_size: tool.providerData.search_context_size,
        },
        include: undefined,
      };
    } else if (tool.providerData?.type === 'file_search') {
      return {
        tool: {
          type: 'file_search',
          vector_store_ids:
            tool.providerData.vector_store_ids ||
            // for backwards compatibility
            (typeof tool.providerData.vector_store_id === 'string'
              ? [tool.providerData.vector_store_id]
              : tool.providerData.vector_store_id),
          max_num_results: tool.providerData.max_num_results,
          ranking_options: tool.providerData.ranking_options,
          filters: tool.providerData.filters,
        },
        include: tool.providerData.include_search_results
          ? ['file_search_call.results']
          : undefined,
      };
    } else if (tool.providerData?.type === 'code_interpreter') {
      return {
        tool: {
          type: 'code_interpreter',
          container: tool.providerData.container,
          allowed_callers: tool.providerData.allowed_callers,
        },
        include: tool.providerData.include_outputs
          ? ['code_interpreter_call.outputs']
          : undefined,
      };
    } else if (tool.providerData?.type === 'tool_search') {
      return {
        tool: {
          type: 'tool_search',
          execution: tool.providerData.execution,
          description: tool.providerData.description,
          parameters: tool.providerData.parameters,
        },
        include: undefined,
      };
    } else if (tool.providerData?.type === 'programmatic_tool_calling') {
      return {
        tool: {
          type: 'programmatic_tool_calling',
        },
        include: undefined,
      };
    } else if (tool.providerData?.type === 'image_generation') {
      return {
        tool: {
          type: 'image_generation',
          background: tool.providerData.background,
          input_fidelity: tool.providerData.input_fidelity,
          input_image_mask: tool.providerData.input_image_mask,
          model: tool.providerData.model,
          moderation: tool.providerData.moderation,
          output_compression: tool.providerData.output_compression,
          output_format: tool.providerData.output_format,
          partial_images: tool.providerData.partial_images,
          quality: tool.providerData.quality,
          size: tool.providerData.size,
        },
        include: undefined,
      };
    } else if (tool.providerData?.type === 'mcp') {
      const openaiTool: Record<string, any> = {
        type: 'mcp',
        server_label: tool.providerData.server_label,
        server_url: tool.providerData.server_url,
        connector_id: tool.providerData.connector_id,
        authorization: tool.providerData.authorization,
        allowed_tools: tool.providerData.allowed_tools,
        headers: tool.providerData.headers,
        require_approval: convertMCPRequireApproval(
          tool.providerData.require_approval,
        ),
        allowed_callers: tool.providerData.allowed_callers,
        server_description: tool.providerData.server_description,
      };
      if (tool.providerData.defer_loading === true) {
        openaiTool.defer_loading = true;
      }
      return {
        tool: openaiTool as OpenAI.Responses.Tool.Mcp,
        include: undefined,
      };
    } else if (tool.providerData) {
      return {
        tool: tool.providerData as unknown as OpenAI.Responses.Tool,
        include: undefined,
      };
    }
  }

  throw new Error(`Unsupported tool type: ${JSON.stringify(tool)}`);
}

function convertMCPRequireApproval(
  requireApproval: ProviderData.HostedMCPTool['require_approval'],
): OpenAI.Responses.Tool.Mcp.McpToolApprovalFilter | 'always' | 'never' | null {
  const normalized = normalizeHostedMcpRequireApproval(requireApproval);
  if (normalized === 'never') {
    return 'never';
  }

  if (normalized === 'always') {
    return 'always';
  }

  return {
    never: normalized.never,
    always: normalized.always,
  };
}

function getHandoffTool(handoff: SerializedHandoff): OpenAI.Responses.Tool {
  return {
    name: handoff.toolName,
    description: handoff.toolDescription,
    parameters: handoff.inputJsonSchema,
    strict: handoff.strictJsonSchema,
    type: 'function',
  };
}

export { getToolChoice, convertTool };
export { getInputItems, convertToOutputItem } from './openaiResponsesConverter';

const TERMINAL_RESPONSES_STREAM_EVENT_TYPES = new Set([
  'response.completed',
  'response.failed',
  'response.incomplete',
  'response.error',
  'error',
]);

function isTerminalResponsesStreamEventType(
  eventType: string | undefined,
): boolean {
  return (
    typeof eventType === 'string' &&
    TERMINAL_RESPONSES_STREAM_EVENT_TYPES.has(eventType)
  );
}

type UnsuccessfulResponseError = ModelBehaviorError & {
  readonly unsafeToReplay: true;
  readonly responseStarted: true;
};

function getUnsuccessfulResponseTerminalType(
  response: OpenAI.Responses.Response | undefined,
  eventType?: string,
): string | undefined {
  if (
    eventType === 'response.failed' ||
    eventType === 'response.incomplete' ||
    eventType === 'response.error' ||
    eventType === 'error' ||
    (eventType === 'response.completed' && !response)
  ) {
    return eventType;
  }

  const status = (response as { status?: unknown } | undefined)?.status;
  return status === 'failed' || status === 'incomplete'
    ? `response.${status}`
    : undefined;
}

function createUnsuccessfulResponseError(
  terminalType: string,
  request: ModelRequest,
  usage?: Usage,
): UnsuccessfulResponseError {
  const error = new ModelBehaviorError(
    terminalType === 'response.completed'
      ? 'OpenAI Responses terminal event "response.completed" is missing its required response payload.'
      : `OpenAI Responses request ended with unsuccessful terminal state "${terminalType}".`,
  ) as UnsuccessfulResponseError;
  Object.defineProperties(error, {
    unsafeToReplay: { value: true },
    responseStarted: { value: true },
  });
  if (usage) {
    reportModelFailureUsage(request, error, usage);
  }
  return error;
}

type ResponseStreamWithRequestID =
  AsyncIterable<OpenAI.Responses.ResponseStreamEvent> & {
    withResponse?: () => Promise<{
      data: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>;
      response?: Response;
      request_id: string | null;
    }>;
  };

type ResponsePromiseWithRequestMetadata<T> = Promise<T> & {
  withResponse?: () => Promise<{
    data: T;
    response?: Response;
    request_id: string | null;
  }>;
};

type ResponseEndpointMetadata = {
  requestURL?: string;
};

function getOpenAIResponseRequestId(
  response: object | undefined,
): string | undefined {
  const requestId = (response as { _request_id?: string | null } | undefined)
    ?._request_id;
  return typeof requestId === 'string' && requestId.length > 0
    ? requestId
    : undefined;
}

function attachOpenAIResponseRequestId(
  response: object,
  requestId: string | undefined,
): void {
  if (!requestId) {
    return;
  }

  const currentRequestId = getOpenAIResponseRequestId(
    response as { _request_id?: string | null },
  );
  if (currentRequestId) {
    return;
  }

  try {
    Object.defineProperty(response, '_request_id', {
      value: requestId,
      enumerable: false,
    });
  } catch {
    // Some custom clients may freeze their response objects. In that case we
    // still expose requestId on the normalized SDK response.
  }
}

async function* withAttachedResponseRequestId(
  stream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>,
  requestId: string | undefined,
): AsyncIterable<OpenAI.Responses.ResponseStreamEvent> {
  for await (const event of stream) {
    const eventType = (event as { type?: string }).type;
    if (isTerminalResponsesStreamEventType(eventType)) {
      const response = (event as { response?: object }).response;
      if (response && typeof response === 'object') {
        attachOpenAIResponseRequestId(response, requestId);
      }
    }

    yield event;
  }
}

/**
 * Model implementation that uses OpenAI's Responses API to generate responses.
 */
export class OpenAIResponsesModel implements Model {
  protected readonly _client: OpenAI;
  protected readonly _model: string;

  constructor(client: OpenAIClient, model: string) {
    this._client = client as OpenAI;
    this._model = model;
  }

  getRetryAdvice(args: ModelRetryAdviceRequest): ModelRetryAdvice | undefined {
    return getOpenAIRetryAdvice(args);
  }

  /**
   * @internal
   */
  protected _isOfficialOpenAIEndpoint(
    baseURL: string | URL | undefined,
  ): boolean {
    return isOfficialOpenAIEndpoint(baseURL, 'http');
  }

  /**
   * @internal
   */
  protected _usesOfficialOpenAIEndpoint(): boolean {
    return this._isOfficialOpenAIEndpoint(this._client.baseURL);
  }

  /**
   * @internal
   */
  protected _convertResponseOutputItems(
    items: Array<Record<string, any>>,
  ): protocol.OutputModelItem[] {
    return convertToOutputItem(items as ResponseOutputItemWithFunctionResult[]);
  }

  /**
   * @internal
   */
  protected _getResponseForSDKOutput(
    response: OpenAI.Responses.Response,
  ): OpenAI.Responses.Response {
    return response;
  }

  /**
   * @internal
   */
  protected _getUnsuccessfulResponseTerminalType(
    response: OpenAI.Responses.Response | undefined,
    eventType?: string,
  ): string | undefined {
    return getUnsuccessfulResponseTerminalType(response, eventType);
  }

  /**
   * @internal
   */
  protected _shouldEmitOutputTextDelta(
    _event: Record<string, any>,
    _outputItem: Record<string, any> | undefined,
  ): boolean {
    return true;
  }

  /**
   * @internal
   */
  protected _shouldEmitRawModelEvent(_event: Record<string, any>): boolean {
    return true;
  }

  /**
   * @internal
   */
  protected _getResponsesCreateRequestOverrides(
    _request: ModelRequest,
    _requestData: Record<string, any>,
  ): Record<string, any> {
    return {};
  }

  /**
   * @internal
   */
  protected _getResponseUsage(response: OpenAI.Responses.Response): Usage {
    return new Usage({
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
      inputTokensDetails: { ...response.usage?.input_tokens_details },
      outputTokensDetails: { ...response.usage?.output_tokens_details },
      requestUsageEntries: [
        toRequestUsageEntry(response.usage, 'responses.create'),
      ],
    });
  }

  /**
   * @internal
   */
  protected _getStreamedResponseUsage(
    response: OpenAI.Responses.Response,
  ): protocol.UsageData {
    return {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
      inputTokensDetails: { ...response.usage?.input_tokens_details },
      outputTokensDetails: { ...response.usage?.output_tokens_details },
      requestUsageEntries: [
        toRequestUsageEntry(response.usage, 'responses.create'),
      ],
    };
  }

  /**
   * @internal
   */
  protected async _fetchResponse(
    request: ModelRequest,
    stream: true,
    endpointMetadata?: ResponseEndpointMetadata,
  ): Promise<AsyncIterable<OpenAI.Responses.ResponseStreamEvent>>;
  protected async _fetchResponse(
    request: ModelRequest,
    stream: false,
    endpointMetadata?: ResponseEndpointMetadata,
  ): Promise<OpenAI.Responses.Response>;
  protected async _fetchResponse(
    request: ModelRequest,
    stream: boolean,
    endpointMetadata?: ResponseEndpointMetadata,
  ): Promise<
    | AsyncIterable<OpenAI.Responses.ResponseStreamEvent>
    | OpenAI.Responses.Response
  > {
    const builtRequest = this._buildResponsesCreateRequest(request, stream);
    const requestOptions: {
      headers: any;
      signal: AbortSignal | undefined;
      maxRetries?: number;
      query?: Record<string, unknown>;
    } = {
      headers: builtRequest.sdkRequestHeaders as any,
      signal: builtRequest.signal,
      ...(builtRequest.transportExtraQuery
        ? { query: builtRequest.transportExtraQuery }
        : {}),
    };
    if (
      (
        request as ModelRequest & {
          _internal?: { runnerManagedRetry?: boolean };
        }
      )._internal?.runnerManagedRetry === true
    ) {
      requestOptions.maxRetries = 0;
    }
    const responsePromise = this._client.responses.create(
      builtRequest.requestData,
      requestOptions,
    ) as ResponseStreamWithRequestID | Promise<OpenAI.Responses.Response>;

    let response:
      | AsyncIterable<OpenAI.Responses.ResponseStreamEvent>
      | OpenAI.Responses.Response;
    if (stream) {
      const withResponse = (responsePromise as ResponseStreamWithRequestID)
        .withResponse;
      if (typeof withResponse === 'function') {
        const streamedResponse = await withResponse.call(responsePromise);
        if (endpointMetadata) {
          endpointMetadata.requestURL = streamedResponse.response?.url;
        }
        response = withAttachedResponseRequestId(
          streamedResponse.data,
          streamedResponse.request_id ?? undefined,
        );
      } else {
        response =
          (await responsePromise) as AsyncIterable<OpenAI.Responses.ResponseStreamEvent>;
      }
    } else {
      const responseWithMetadata =
        responsePromise as ResponsePromiseWithRequestMetadata<OpenAI.Responses.Response>;
      const withResponse = responseWithMetadata.withResponse;
      if (endpointMetadata && typeof withResponse === 'function') {
        const receivedResponse = await withResponse.call(responsePromise);
        endpointMetadata.requestURL = receivedResponse.response?.url;
        response = receivedResponse.data;
      } else {
        response = (await responsePromise) as OpenAI.Responses.Response;
      }
    }

    if (logger.dontLogModelData) {
      logger.debug('Response received');
    } else {
      logger.debug(`Response received: ${JSON.stringify(response, null, 2)}`);
    }

    return response;
  }

  protected _buildResponsesCreateRequest(
    request: ModelRequest,
    stream: boolean,
  ): BuiltResponsesCreateRequest {
    const input = getInputItems(request.input);
    const prompt = getPrompt(request.prompt);
    // When a prompt template already declares a model, skip sending the agent's default model.
    // If the caller explicitly requests an override, include the resolved model name in the request.
    const shouldSendModel =
      !request.prompt || request.overridePromptModel === true;
    const effectiveRequestModel = shouldSendModel ? this._model : undefined;
    const {
      providerData: providerDataWithoutTransport,
      overrides: transportOverrides,
    } = splitResponsesTransportOverrides(request.modelSettings.providerData);
    const { tools, include } = getTools(request.tools, request.handoffs, {
      model: effectiveRequestModel,
      toolChoice: request.modelSettings.toolChoice,
    });
    const toolChoiceValidationTools = [
      ...tools,
      ...getExtraBodyToolsForToolChoiceValidation(transportOverrides.extraBody),
    ];
    const allowPromptSuppliedTools =
      Boolean(request.prompt) &&
      !(request.toolsExplicitlyProvided === true && tools.length === 0);
    const toolChoice = getToolChoice(request.modelSettings.toolChoice, {
      tools: toolChoiceValidationTools,
      model: effectiveRequestModel,
      allowPromptSuppliedComputerTool: allowPromptSuppliedTools,
    });
    assertSupportedToolChoice(toolChoice, toolChoiceValidationTools, {
      allowPromptSuppliedTools,
    });
    assertValidProgrammaticToolCallingConfiguration(
      toolChoice,
      toolChoiceValidationTools,
      { allowPromptSuppliedTools },
    );
    const { text, ...restOfProviderData } = providerDataWithoutTransport;

    if (request.modelSettings.reasoning) {
      // Merge top-level reasoning settings with provider data.
      restOfProviderData.reasoning = {
        ...request.modelSettings.reasoning,
        ...restOfProviderData.reasoning,
      };
    }

    let mergedText = text;
    if (request.modelSettings.text) {
      // Merge top-level text settings with provider data.
      mergedText = { ...request.modelSettings.text, ...text };
    }
    const responseFormat = getResponseFormat(request.outputType, mergedText);

    const shouldSendTools =
      tools.length > 0 ||
      request.toolsExplicitlyProvided === true ||
      !request.prompt;
    const compatibleToolChoice = getCompatibleToolChoice(
      toolChoice,
      toolChoiceValidationTools,
      {
        allowPromptSuppliedTools,
      },
    );
    const shouldOmitToolChoice = typeof compatibleToolChoice === 'undefined';

    let requestData = {
      ...(effectiveRequestModel ? { model: effectiveRequestModel } : {}),
      instructions: normalizeInstructions(request.systemInstructions),
      input,
      include,
      ...(shouldSendTools ? { tools } : {}),
      // The Responses API treats `conversation` and `previous_response_id` as mutually exclusive,
      // so we only send `previous_response_id` when no conversation is provided.
      conversation: request.conversationId,
      ...(request.conversationId
        ? {}
        : { previous_response_id: request.previousResponseId }),
      prompt,
      temperature: request.modelSettings.temperature,
      top_p: request.modelSettings.topP,
      truncation: request.modelSettings.truncation,
      max_output_tokens: request.modelSettings.maxTokens,
      ...(!shouldOmitToolChoice
        ? { tool_choice: compatibleToolChoice as ToolChoiceOptions }
        : {}),
      stream,
      text: responseFormat,
      store: request.modelSettings.store,
      prompt_cache_retention: normalizePromptCacheRetention(
        request.modelSettings.promptCacheRetention,
      ),
      prompt_cache_options: request.modelSettings.promptCacheOptions,
      context_management: getContextManagement(
        request.modelSettings.contextManagement,
      ),
      ...restOfProviderData,
    };

    if (transportOverrides.extraBody) {
      requestData = {
        ...requestData,
        ...transportOverrides.extraBody,
      };
    }

    const hasExplicitTools =
      Array.isArray(requestData.tools) && requestData.tools.length > 0;
    const promptMaySupplyTools =
      Boolean(request.prompt) &&
      requestData.tools === undefined &&
      request.toolsExplicitlyProvided !== true;
    if (
      !Object.prototype.hasOwnProperty.call(
        requestData,
        'parallel_tool_calls',
      ) &&
      typeof request.modelSettings.parallelToolCalls === 'boolean' &&
      (hasExplicitTools || promptMaySupplyTools)
    ) {
      (requestData as Record<string, unknown>).parallel_tool_calls =
        request.modelSettings.parallelToolCalls;
    }

    requestData = {
      ...requestData,
      ...this._getResponsesCreateRequestOverrides(request, requestData),
    };

    // Keep the transport mode aligned with the calling path even if extra_body includes stream.
    requestData.stream = stream;

    const requestHeaderAccumulator = createHeaderAccumulator();
    applyHeadersToAccumulator(requestHeaderAccumulator, HEADERS);
    applyHeadersToAccumulator(
      requestHeaderAccumulator,
      transportOverrides.extraHeaders,
      {
        allowBlockedOverride: true,
      },
    );
    const sdkRequestHeaders = headerAccumulatorToSDKHeaders(
      requestHeaderAccumulator,
    );

    const builtRequest: BuiltResponsesCreateRequest = {
      requestData,
      sdkRequestHeaders,
      signal: request.signal,
      transportExtraHeaders: transportOverrides.extraHeaders,
      transportExtraQuery: transportOverrides.extraQuery,
    };

    if (logger.dontLogModelData) {
      logger.debug('Calling LLM');
    } else {
      logger.debug(
        `Calling LLM. Request data: ${JSON.stringify(
          builtRequest.requestData,
          null,
          2,
        )}`,
      );
    }
    return builtRequest;
  }

  /**
   * Get a response from the OpenAI model using the Responses API.
   * @param request - The request to send to the model.
   * @returns A promise that resolves to the response from the model.
   */
  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const { response, rawUsage, preservedUsage } = await withResponseSpan(
      async (span) => {
        const redactedResponseIdEndpointWasTrusted =
          request.tracing === 'enabled_without_data' &&
          this._usesOfficialOpenAIEndpoint();
        const endpointMetadata: ResponseEndpointMetadata | undefined =
          request.tracing === 'enabled_without_data' ? {} : undefined;
        const response = await this._fetchResponse(
          request,
          false,
          endpointMetadata,
        );
        const rawUsage =
          request.modelSettings.preserveRawUsage === true
            ? snapshotRawUsage(response.usage)
            : undefined;
        const preservedUsage =
          rawUsage !== undefined ? this._getResponseUsage(response) : undefined;
        const terminalType =
          this._getUnsuccessfulResponseTerminalType(response);

        if (request.tracing) {
          if (
            request.tracing === true ||
            (redactedResponseIdEndpointWasTrusted &&
              this._isOfficialOpenAIEndpoint(endpointMetadata?.requestURL) &&
              this._usesOfficialOpenAIEndpoint())
          ) {
            span.spanData.response_id = response.id;
          }
          if (request.tracing === true || !terminalType) {
            span.spanData._input = request.input;
            span.spanData._response = response;
          }
        }

        if (terminalType) {
          throw createUnsuccessfulResponseError(
            terminalType,
            request,
            preservedUsage ?? this._getResponseUsage(response),
          );
        }

        return { response, rawUsage, preservedUsage };
      },
      undefined,
      getModelTracingParent(request),
    );

    const responseForSDKOutput = this._getResponseForSDKOutput(response);
    const output: ModelResponse = {
      usage: preservedUsage ?? this._getResponseUsage(response),
      output: this._convertResponseOutputItems(
        responseForSDKOutput.output as Array<Record<string, any>>,
      ),
      responseId: response.id,
      requestId: getOpenAIResponseRequestId(response),
      providerData: response,
      ...(rawUsage !== undefined ? { rawUsage } : {}),
    };

    return output;
  }

  /**
   * Get a streamed response from the OpenAI model using the Responses API.
   * @param request - The request to send to the model.
   * @returns An async iterable of the response from the model.
   */
  async *getStreamedResponse(
    request: ModelRequest,
  ): AsyncIterable<ResponseStreamEvent> {
    const span = request.tracing
      ? createResponseSpan(undefined, getModelTracingParent(request))
      : undefined;
    let terminalError: UnsuccessfulResponseError | undefined;
    try {
      if (span) {
        span.start();
        setCurrentSpan(span);
        if (request.tracing === true) {
          span.spanData._input = request.input;
        }
      }
      const redactedResponseIdEndpointWasTrusted =
        request.tracing === 'enabled_without_data' &&
        this._usesOfficialOpenAIEndpoint();
      const endpointMetadata: ResponseEndpointMetadata | undefined =
        request.tracing === 'enabled_without_data' ? {} : undefined;
      const response = await this._fetchResponse(
        request,
        true,
        endpointMetadata,
      );

      let finalResponse: OpenAI.Responses.Response | undefined;
      const outputItemsByIndex = new Map<number, Record<string, any>>();
      for await (const event of response) {
        const eventType = (event as { type?: string }).type;
        const shouldEmitRawModelEvent = this._shouldEmitRawModelEvent(
          event as unknown as Record<string, any>,
        );
        if (eventType === 'response.output_item.added') {
          const outputItemAdded = event as unknown as {
            output_index?: number;
            item?: Record<string, any>;
          };
          if (
            typeof outputItemAdded.output_index === 'number' &&
            outputItemAdded.item
          ) {
            outputItemsByIndex.set(
              outputItemAdded.output_index,
              outputItemAdded.item,
            );
          }
        }
        if (eventType === 'response.created') {
          yield {
            type: 'response_started',
            providerData: {
              ...event,
            },
          };
        } else if (isTerminalResponsesStreamEventType(eventType)) {
          const terminalEvent =
            event as OpenAI.Responses.ResponseStreamEvent & {
              response?: OpenAI.Responses.Response;
            };
          const terminalResponse = terminalEvent.response;
          const unsuccessfulTerminalType =
            this._getUnsuccessfulResponseTerminalType(
              terminalResponse,
              eventType,
            );
          if (
            span &&
            terminalResponse &&
            request.tracing === 'enabled_without_data' &&
            redactedResponseIdEndpointWasTrusted &&
            this._isOfficialOpenAIEndpoint(endpointMetadata?.requestURL) &&
            this._usesOfficialOpenAIEndpoint()
          ) {
            span.spanData.response_id = terminalResponse.id;
          }
          if (unsuccessfulTerminalType) {
            terminalError = createUnsuccessfulResponseError(
              unsuccessfulTerminalType,
              request,
              terminalResponse
                ? this._getResponseUsage(terminalResponse)
                : undefined,
            );
            if (terminalResponse) {
              finalResponse = terminalResponse;
            }
            if (span && terminalResponse) {
              if (request.tracing === true) {
                span.spanData.response_id = terminalResponse.id;
                span.spanData._response = terminalResponse;
              }
            }
            if (span?.error === null) {
              span.setError({
                message: terminalError.message,
              });
            }
          } else if (terminalResponse) {
            finalResponse = terminalResponse;
            if (span && request.tracing === true) {
              span.spanData.response_id = terminalResponse.id;
              span.spanData._response = terminalResponse;
            }
            const { response: _response, ...remainingEvent } = terminalEvent;
            const {
              output: _output,
              usage: _usage,
              id,
              ...remainingResponse
            } = terminalResponse;
            const responseForSDKOutput =
              this._getResponseForSDKOutput(terminalResponse);
            yield {
              type: 'response_done',
              response: {
                id: id,
                requestId: getOpenAIResponseRequestId(terminalResponse),
                output: this._convertResponseOutputItems(
                  responseForSDKOutput.output as Array<Record<string, any>>,
                ),
                usage: this._getStreamedResponseUsage(terminalResponse),
                ...(request.modelSettings.preserveRawUsage === true
                  ? { rawUsage: snapshotRawUsage(terminalResponse.usage) }
                  : {}),
                providerData: remainingResponse,
              },
              providerData: remainingEvent,
            };
          }
        } else if (eventType === 'response.output_text.delta') {
          const { delta, ...remainingEvent } = event as unknown as {
            delta: string;
            item_id?: string;
            output_index?: number;
          } & Record<string, any>;
          const itemId = remainingEvent.item_id;
          const outputItem =
            typeof remainingEvent.output_index === 'number'
              ? outputItemsByIndex.get(remainingEvent.output_index)
              : undefined;
          if (
            this._shouldEmitOutputTextDelta(
              event as unknown as Record<string, any>,
              outputItem,
            )
          ) {
            yield {
              type: 'output_text_delta',
              delta: delta,
              ...(typeof itemId === 'string' ? { itemId } : {}),
              providerData: remainingEvent,
            };
          }
        }

        if (shouldEmitRawModelEvent) {
          yield {
            type: 'model',
            event: event,
            providerData: {
              rawModelEventSource: OPENAI_RESPONSES_RAW_MODEL_EVENT_SOURCE,
            },
          };
        }
        if (terminalError) {
          throw terminalError;
        }
      }

      if (request.tracing && span && finalResponse) {
        if (request.tracing === true) {
          span.spanData.response_id = finalResponse.id;
        }
        if (request.tracing === true || !terminalError) {
          span.spanData._response = finalResponse;
        }
      }
    } catch (error) {
      const errorToThrow = terminalError ?? error;
      if (span?.error === null) {
        span.setError({
          message: 'Error streaming response',
          data: {
            error: request.tracing
              ? String(errorToThrow)
              : errorToThrow instanceof Error
                ? errorToThrow.name
                : undefined,
          },
        });
      }
      throw errorToThrow;
    } finally {
      if (span) {
        span.end();
        resetCurrentSpan();
      }
    }
  }
}

export type OpenAIResponsesWSModelOptions = {
  websocketBaseURL?: string;
  reuseConnection?: boolean;
  websocketOptions?: OpenAIResponsesWebSocketOptions;
};

export type OpenAIResponsesWebSocketOptions =
  ResponsesWebSocketKeepAliveOptions;

function cloneResponsesWebSocketOptions(
  options: OpenAIResponsesWebSocketOptions | undefined,
): OpenAIResponsesWebSocketOptions {
  return { ...(options ?? {}) };
}

/**
 * Model implementation that uses the OpenAI Responses API over a websocket transport.
 *
 * @see {@link https://developers.openai.com/api/docs/guides/websocket-mode}
 */
export class OpenAIResponsesWSModel extends OpenAIResponsesModel {
  #websocketBaseURL?: string;
  #reuseConnection: boolean;
  #websocketOptions: OpenAIResponsesWebSocketOptions;
  #wsConnection: ResponsesWebSocketConnection | undefined;
  #wsConnectionIdentity: string | undefined;
  #wsRequestLock: Promise<void> = Promise.resolve();

  constructor(
    client: OpenAIClient,
    model: string,
    options: OpenAIResponsesWSModelOptions = {},
  ) {
    super(client, model);
    this.#websocketBaseURL = options.websocketBaseURL;
    this.#reuseConnection = options.reuseConnection ?? true;
    this.#websocketOptions = cloneResponsesWebSocketOptions(
      options.websocketOptions,
    );
  }

  /**
   * @internal
   */
  protected override _isOfficialOpenAIEndpoint(
    baseURL: string | URL | undefined,
  ): boolean {
    return isOfficialOpenAIEndpoint(baseURL, 'websocket');
  }

  /**
   * @internal
   */
  protected override _usesOfficialOpenAIEndpoint(): boolean {
    return this._isOfficialOpenAIEndpoint(
      this.#websocketBaseURL ?? this._client.baseURL,
    );
  }

  override getRetryAdvice(
    args: ModelRetryAdviceRequest,
  ): ModelRetryAdvice | undefined {
    if (isNeverSentWebSocketError(args.error)) {
      return {
        suggested: true,
        replaySafety: 'safe',
        reason: args.error instanceof Error ? args.error.message : undefined,
      };
    }

    if (isReplaySafeWebSocketError(args.error)) {
      return {
        suggested: false,
        replaySafety: 'safe',
        reason: args.error instanceof Error ? args.error.message : undefined,
      };
    }

    if (isAmbiguousWebSocketReplayError(args.error)) {
      return (
        super.getRetryAdvice(args) ?? {
          suggested: false,
          replaySafety: 'unsafe',
          reason: args.error instanceof Error ? args.error.message : undefined,
        }
      );
    }

    return super.getRetryAdvice(args);
  }

  /**
   * @internal
   */
  protected async _fetchResponse(
    request: ModelRequest,
    stream: true,
    endpointMetadata?: ResponseEndpointMetadata,
  ): Promise<AsyncIterable<OpenAI.Responses.ResponseStreamEvent>>;
  protected async _fetchResponse(
    request: ModelRequest,
    stream: false,
    endpointMetadata?: ResponseEndpointMetadata,
  ): Promise<OpenAI.Responses.Response>;
  protected async _fetchResponse(
    request: ModelRequest,
    stream: boolean,
    endpointMetadata?: ResponseEndpointMetadata,
  ): Promise<
    | AsyncIterable<OpenAI.Responses.ResponseStreamEvent>
    | OpenAI.Responses.Response
  > {
    // The websocket transport always uses streamed Responses events, then callers either
    // consume the stream directly or collapse it into the final terminal response.
    const builtRequest = this._buildResponsesCreateRequest(request, true);

    if (stream) {
      return this.#iterWebSocketResponseEvents(builtRequest, endpointMetadata);
    }

    let receivedResponseEvent = false;
    try {
      let finalResponse: OpenAI.Responses.Response | undefined;
      for await (const event of this.#iterWebSocketResponseEvents(
        builtRequest,
        endpointMetadata,
      )) {
        receivedResponseEvent = true;
        const eventType = (event as { type?: string }).type;
        if (isTerminalResponsesStreamEventType(eventType)) {
          const terminalResponse = (
            event as { response?: OpenAI.Responses.Response }
          ).response;
          const unsuccessfulTerminalType =
            this._getUnsuccessfulResponseTerminalType(
              terminalResponse,
              eventType,
            );
          if (unsuccessfulTerminalType && !terminalResponse) {
            throw createUnsuccessfulResponseError(
              unsuccessfulTerminalType,
              request,
            );
          }
          finalResponse = terminalResponse;
        }
      }

      if (!finalResponse) {
        throw new Error(
          'Responses websocket stream ended without a terminal response event.',
        );
      }

      return finalResponse;
    } catch (error) {
      if (receivedResponseEvent) {
        markUnsafeWebSocketReplayError(error, true);
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.#dropWebSocketConnection();
  }

  async *#iterWebSocketResponseEvents(
    builtRequest: BuiltResponsesCreateRequest,
    endpointMetadata?: ResponseEndpointMetadata,
  ): AsyncIterable<OpenAI.Responses.ResponseStreamEvent> {
    const requestTimeoutDeadline =
      this.#createWebSocketRequestTimeoutDeadline();
    let releaseLock: (() => void) | undefined;
    let replayMayBeUnsafe = false;
    let receivedServerFrame = false;
    let sawTerminalResponseEvent = false;
    try {
      releaseLock = await this.#acquireWebSocketRequestLock(
        builtRequest.signal,
        requestTimeoutDeadline,
      );
      throwIfAborted(builtRequest.signal);
      const { frame, wsURL, headers } = await this.#prepareWebSocketRequest(
        builtRequest,
        requestTimeoutDeadline,
      );
      if (endpointMetadata) {
        endpointMetadata.requestURL = wsURL;
      }
      throwIfAborted(builtRequest.signal);
      let connection = await this.#ensureWebSocketConnection(
        wsURL,
        headers,
        builtRequest.signal,
        requestTimeoutDeadline,
      );
      let reusedConnectionForCurrentAttempt = connection.reused;
      let activeConnection = connection.connection;
      const setActiveConnection = (
        nextConnection: EnsuredResponsesWebSocketConnection,
      ): void => {
        connection = nextConnection;
        activeConnection = nextConnection.connection;
        reusedConnectionForCurrentAttempt = nextConnection.reused;
      };
      throwIfAborted(builtRequest.signal);
      const serializedFrame = JSON.stringify(frame);
      const sendSerializedFrame = async () => {
        try {
          try {
            await activeConnection.send(serializedFrame);
          } catch (error) {
            if (!isWebSocketNotOpenError(error)) {
              throw error;
            }

            setActiveConnection(
              await this.#reconnectWebSocketConnection(
                wsURL,
                headers,
                builtRequest.signal,
                requestTimeoutDeadline,
              ),
            );
            await activeConnection.send(serializedFrame);
          }
        } catch (error) {
          if (isWebSocketNotOpenError(error)) {
            markTransientNeverSentWebSocketError(error);
          }
          throw error;
        }
      };
      await sendSerializedFrame();
      // Once response.create leaves the client, a timeout or disconnect can
      // race with server acceptance even before the first response frame.
      replayMayBeUnsafe = true;

      while (true) {
        const rawFrame = await this.#nextWebSocketFrame(
          activeConnection,
          builtRequest.signal,
          requestTimeoutDeadline,
        );
        if (rawFrame === null) {
          if (!receivedServerFrame && reusedConnectionForCurrentAttempt) {
            // The request frame was already sent on a reused socket. If the
            // socket closes before the first response event arrives, the server
            // may still be processing the request, so replaying `response.create`
            // can duplicate model work and tool side effects.
            replayMayBeUnsafe = true;
            throw new Error(
              'Responses websocket connection closed after sending a request on a reused connection before any response events were received. The request may have been accepted, so the SDK will not automatically retry this websocket request.',
            );
          }
          throw new ResponsesWebSocketInternalError(
            'connection_closed_before_terminal_response_event',
          );
        }

        replayMayBeUnsafe = true;
        receivedServerFrame = true;
        const payloadText = await webSocketFrameToText(rawFrame);
        const payload = JSON.parse(payloadText);
        const eventType =
          isRecord(payload) && typeof payload.type === 'string'
            ? payload.type
            : undefined;

        const event = payload as OpenAI.Responses.ResponseStreamEvent;
        const isTerminalResponseEvent =
          isTerminalResponsesStreamEventType(eventType);
        // Successful websocket responses do not currently expose a transport
        // request ID analogous to the HTTP x-request-id header.
        if (isTerminalResponseEvent) {
          sawTerminalResponseEvent = true;
        }
        yield event;

        if (isTerminalResponseEvent) {
          return;
        }
      }
    } catch (error) {
      if (!replayMayBeUnsafe) {
        markReplaySafeWebSocketError(error);
      }
      if (replayMayBeUnsafe) {
        markUnsafeWebSocketReplayError(error, receivedServerFrame);
      }
      if (
        !replayMayBeUnsafe &&
        !(error instanceof OpenAI.APIUserAbortError) &&
        shouldWrapNoEventWebSocketError(error)
      ) {
        const wrappedError = new Error(
          'Responses websocket connection closed before any response events were received. The feature may not be enabled for this account or model yet.',
        );
        if (error instanceof Error) {
          (wrappedError as Error & { cause?: unknown }).cause = error;
        }
        markReplaySafeWebSocketError(wrappedError);
        if (isNeverSentWebSocketError(error)) {
          markTransientNeverSentWebSocketError(wrappedError);
        }
        throw wrappedError;
      }
      throw error;
    } finally {
      const shouldDropConnection =
        !sawTerminalResponseEvent || !this.#reuseConnection;
      const dropConnectionPromise =
        releaseLock && shouldDropConnection
          ? this.#dropWebSocketConnection()
          : undefined;
      releaseLock?.();
      await dropConnectionPromise;
    }
  }

  async #prepareWebSocketRequest(
    builtRequest: BuiltResponsesCreateRequest,
    requestTimeoutDeadline?: WebSocketRequestTimeoutDeadline,
  ): Promise<{
    frame: Record<string, any>;
    wsURL: string;
    headers: Record<string, string>;
  }> {
    const wsURL = this.#prepareWebSocketURL(builtRequest.transportExtraQuery);
    const headers = await this.#mergeWebSocketHeaders(
      wsURL,
      builtRequest.transportExtraHeaders,
      builtRequest.signal,
      requestTimeoutDeadline,
    );
    const frame = {
      ...builtRequest.requestData,
      type: 'response.create',
      stream: true,
    };

    return { frame, wsURL, headers };
  }

  async #mergeWebSocketHeaders(
    wsURL: string,
    extraHeaders: Record<string, unknown> | undefined,
    signal: AbortSignal | undefined,
    requestTimeoutDeadline?: WebSocketRequestTimeoutDeadline,
  ): Promise<Record<string, string>> {
    await this.#awaitWebSocketRequestTimedOperation(
      this.#refreshClientApiKey(),
      signal,
      requestTimeoutDeadline,
      (configuredTimeoutMs) =>
        `Responses websocket auth header preparation timed out after ${configuredTimeoutMs}ms.`,
    );

    const headerAccumulator = createHeaderAccumulator();
    const clientWithInternals = this._client as OpenAI & {
      _options?: { defaultHeaders?: unknown };
      authHeaders?: (opts: unknown) => Promise<unknown>;
    };
    const handshakeURL = new URL(wsURL);
    const handshakeQuery = searchParamsToAuthHeaderQuery(
      handshakeURL.searchParams,
    );

    const authHeaders =
      typeof clientWithInternals.authHeaders === 'function'
        ? await this.#awaitWebSocketRequestTimedOperation(
            clientWithInternals.authHeaders({
              method: 'get',
              path: handshakeURL.pathname,
              ...(handshakeQuery ? { query: handshakeQuery } : {}),
            }),
            signal,
            requestTimeoutDeadline,
            (configuredTimeoutMs) =>
              `Responses websocket auth header preparation timed out after ${configuredTimeoutMs}ms.`,
          )
        : undefined;
    applyHeadersToAccumulator(headerAccumulator, authHeaders);
    if (
      typeof clientWithInternals.authHeaders !== 'function' &&
      typeof this._client.apiKey === 'string' &&
      this._client.apiKey.length > 0 &&
      this._client.apiKey !== 'Missing Key'
    ) {
      applyHeadersToAccumulator(headerAccumulator, {
        Authorization: `Bearer ${this._client.apiKey}`,
      });
    }
    if (this._client.organization) {
      applyHeadersToAccumulator(headerAccumulator, {
        'OpenAI-Organization': this._client.organization,
      });
    }
    if (this._client.project) {
      applyHeadersToAccumulator(headerAccumulator, {
        'OpenAI-Project': this._client.project,
      });
    }

    applyHeadersToAccumulator(
      headerAccumulator,
      clientWithInternals._options?.defaultHeaders,
    );
    applyHeadersToAccumulator(headerAccumulator, HEADERS);
    applyHeadersToAccumulator(headerAccumulator, extraHeaders, {
      allowBlockedOverride: true,
    });
    return headerAccumulatorToRecord(headerAccumulator);
  }

  #prepareWebSocketURL(
    extraQuery: Record<string, unknown> | undefined,
  ): string {
    const baseURL = new URL(this.#websocketBaseURL ?? this._client.baseURL);
    const explicitBaseQuery =
      typeof this.#websocketBaseURL === 'string'
        ? new URLSearchParams(baseURL.search)
        : undefined;
    const clientWithInternals = this._client as OpenAI & {
      _options?: { defaultQuery?: unknown };
    };

    if (baseURL.protocol === 'https:') {
      baseURL.protocol = 'wss:';
    } else if (baseURL.protocol === 'http:') {
      baseURL.protocol = 'ws:';
    } else if (baseURL.protocol !== 'ws:' && baseURL.protocol !== 'wss:') {
      throw new UserError(
        `Unsupported websocket base URL protocol: ${baseURL.protocol}`,
      );
    }

    baseURL.pathname = ensureResponsesWebSocketPath(baseURL.pathname);
    mergeQueryParamsIntoURL(
      baseURL,
      clientWithInternals._options?.defaultQuery as
        Record<string, unknown> | undefined,
    );
    if (explicitBaseQuery && Array.from(explicitBaseQuery.keys()).length > 0) {
      const explicitTopLevelKeys = new Set<string>();
      for (const key of explicitBaseQuery.keys()) {
        const bracketIndex = key.indexOf('[');
        explicitTopLevelKeys.add(
          bracketIndex >= 0 ? key.slice(0, bracketIndex) : key,
        );
      }
      for (const topLevelKey of explicitTopLevelKeys) {
        for (const existingKey of Array.from(baseURL.searchParams.keys())) {
          if (
            existingKey === topLevelKey ||
            existingKey.startsWith(`${topLevelKey}[`)
          ) {
            baseURL.searchParams.delete(existingKey);
          }
        }
      }
      for (const [key, value] of explicitBaseQuery.entries()) {
        baseURL.searchParams.append(key, value);
      }
    }
    mergeQueryParamsIntoURL(baseURL, extraQuery);

    return baseURL.toString();
  }

  async #ensureWebSocketConnection(
    wsURL: string,
    headers: Record<string, string>,
    signal: AbortSignal | undefined,
    requestTimeoutDeadline?: WebSocketRequestTimeoutDeadline,
  ): Promise<EnsuredResponsesWebSocketConnection> {
    const identity = this.#getConnectionIdentity(wsURL, headers);

    if (
      this.#wsConnection &&
      this.#wsConnectionIdentity &&
      this.#wsConnectionIdentity === identity &&
      this.#wsConnection.isReusable()
    ) {
      return { connection: this.#wsConnection, reused: true };
    }

    await this.#dropWebSocketConnection();
    const connectTimeout = this.#resolveWebSocketRequestTimeout(
      requestTimeoutDeadline,
      (configuredTimeoutMs) =>
        `Responses websocket connection timed out before opening after ${configuredTimeoutMs}ms.`,
    );
    try {
      this.#wsConnection = await ResponsesWebSocketConnection.connect(
        wsURL,
        headers,
        signal,
        connectTimeout.timeoutMs,
        connectTimeout.errorMessage,
        this.#websocketOptions,
      );
    } catch (error) {
      if (isTransientConnectionSetupError(error)) {
        markTransientNeverSentWebSocketError(error);
      }
      throw error;
    }
    this.#wsConnectionIdentity = identity;
    return { connection: this.#wsConnection, reused: false };
  }

  async #reconnectWebSocketConnection(
    wsURL: string,
    headers: Record<string, string>,
    signal: AbortSignal | undefined,
    requestTimeoutDeadline?: WebSocketRequestTimeoutDeadline,
  ): Promise<EnsuredResponsesWebSocketConnection> {
    await this.#dropWebSocketConnection();
    throwIfAborted(signal);
    const connection = await this.#ensureWebSocketConnection(
      wsURL,
      headers,
      signal,
      requestTimeoutDeadline,
    );
    throwIfAborted(signal);
    return connection;
  }

  #getConnectionIdentity(
    wsURL: string,
    headers: Record<string, string>,
  ): string {
    const normalizedHeaders = Object.entries(headers)
      .map(([key, value]) => [key.toLowerCase(), value] as const)
      .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
        `${leftKey}:${leftValue}`.localeCompare(`${rightKey}:${rightValue}`),
      );

    return JSON.stringify([wsURL, normalizedHeaders]);
  }

  async #dropWebSocketConnection(): Promise<void> {
    const connectionToClose = this.#wsConnection;
    if (!connectionToClose) {
      this.#wsConnectionIdentity = undefined;
      return;
    }

    // Detach cached state before awaiting close so queued requests can proceed
    // without racing against this teardown path.
    this.#wsConnection = undefined;
    this.#wsConnectionIdentity = undefined;

    try {
      await connectionToClose.close();
    } catch {
      // Ignore close errors and reset the cached connection.
    }
  }

  async #acquireWebSocketRequestLock(
    signal: AbortSignal | undefined,
    requestTimeoutDeadline?: WebSocketRequestTimeoutDeadline,
  ): Promise<() => void> {
    throwIfAborted(signal);
    const queueWaitTimeout = this.#resolveWebSocketRequestTimeout(
      requestTimeoutDeadline,
      (configuredTimeoutMs) =>
        `Responses websocket request queue wait timed out after ${configuredTimeoutMs}ms.`,
    );

    const previousLock = this.#wsRequestLock;
    let released = false;
    let resolveOwnLock!: () => void;

    const ownLock = new Promise<void>((resolve) => {
      resolveOwnLock = resolve;
    });
    const releaseLock = () => {
      if (released) {
        return;
      }
      released = true;
      resolveOwnLock();
    };

    this.#wsRequestLock = previousLock.then(() => ownLock);

    try {
      await withAbortSignal(
        withTimeout(
          previousLock,
          queueWaitTimeout.timeoutMs,
          queueWaitTimeout.errorMessage,
        ),
        signal,
      );
      throwIfAborted(signal);
      return releaseLock;
    } catch (error) {
      releaseLock();
      if (!(error instanceof OpenAI.APIUserAbortError)) {
        markTransientNeverSentWebSocketError(error);
      }
      throw error;
    }
  }

  async #refreshClientApiKey(): Promise<void> {
    const clientWithInternals = this._client as OpenAI & {
      _callApiKey?: () => Promise<boolean>;
    };

    if (typeof clientWithInternals._callApiKey === 'function') {
      await clientWithInternals._callApiKey();
    }
  }

  #getWebSocketFrameReadTimeoutMs(): number | undefined {
    const clientWithTimeout = this._client as OpenAI & {
      timeout?: unknown;
      _options?: { timeout?: unknown };
    };
    const timeoutCandidate =
      typeof clientWithTimeout.timeout === 'number'
        ? clientWithTimeout.timeout
        : clientWithTimeout._options?.timeout;

    if (typeof timeoutCandidate === 'number') {
      return timeoutCandidate;
    }

    return OpenAI.DEFAULT_TIMEOUT;
  }

  #createWebSocketRequestTimeoutDeadline():
    WebSocketRequestTimeoutDeadline | undefined {
    const timeoutMs = this.#getWebSocketFrameReadTimeoutMs();
    if (
      typeof timeoutMs !== 'number' ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0
    ) {
      return undefined;
    }

    return {
      configuredTimeoutMs: timeoutMs,
      deadlineAtMs: Date.now() + timeoutMs,
    };
  }

  #resolveWebSocketRequestTimeout(
    requestTimeoutDeadline: WebSocketRequestTimeoutDeadline | undefined,
    errorMessageForConfiguredTimeout: (configuredTimeoutMs: number) => string,
  ): { timeoutMs: number | undefined; errorMessage: string } {
    const configuredTimeoutMs =
      requestTimeoutDeadline?.configuredTimeoutMs ??
      this.#getWebSocketFrameReadTimeoutMs();
    const safeConfiguredTimeoutMs =
      typeof configuredTimeoutMs === 'number'
        ? configuredTimeoutMs
        : OpenAI.DEFAULT_TIMEOUT;
    const errorMessage = errorMessageForConfiguredTimeout(
      safeConfiguredTimeoutMs,
    );
    if (!requestTimeoutDeadline) {
      return { timeoutMs: configuredTimeoutMs, errorMessage };
    }

    const remainingTimeoutMs = Math.ceil(
      requestTimeoutDeadline.deadlineAtMs - Date.now(),
    );
    if (remainingTimeoutMs <= 0) {
      throw new Error(errorMessage);
    }

    return { timeoutMs: remainingTimeoutMs, errorMessage };
  }

  async #awaitWebSocketRequestTimedOperation<T>(
    promise: Promise<T>,
    signal: AbortSignal | undefined,
    requestTimeoutDeadline: WebSocketRequestTimeoutDeadline | undefined,
    errorMessageForConfiguredTimeout: (configuredTimeoutMs: number) => string,
  ): Promise<T> {
    const timeout = this.#resolveWebSocketRequestTimeout(
      requestTimeoutDeadline,
      errorMessageForConfiguredTimeout,
    );
    return await withAbortSignal(
      withTimeout(promise, timeout.timeoutMs, timeout.errorMessage),
      signal,
    );
  }

  async #nextWebSocketFrame(
    connection: ResponsesWebSocketConnection,
    signal: AbortSignal | undefined,
    requestTimeoutDeadline?: WebSocketRequestTimeoutDeadline,
  ): Promise<WebSocketMessageValue | null> {
    const frameReadTimeout = this.#resolveWebSocketRequestTimeout(
      requestTimeoutDeadline,
      (configuredTimeoutMs) =>
        `Responses websocket frame read timed out after ${configuredTimeoutMs}ms.`,
    );
    return await withTimeout(
      connection.nextFrame(signal),
      frameReadTimeout.timeoutMs,
      frameReadTimeout.errorMessage,
    );
  }
}
