import {
  Model,
  RequestUsage,
  Usage,
  withResponseSpan,
  createResponseSpan,
  setCurrentSpan,
  resetCurrentSpan,
  protocol,
  UserError,
} from '@openai/agents-core';
import type {
  SerializedHandoff,
  SerializedTool,
  ModelRequest,
  ModelResponse,
  ModelSettingsToolChoice,
  ResponseStreamEvent,
  SerializedOutputType,
} from '@openai/agents-core';
import OpenAI from 'openai';
import logger from './logger';
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
import {
  CodeInterpreterStatus,
  FileSearchStatus,
  ImageGenerationStatus,
  WebSearchStatus,
} from './tools';
import { camelOrSnakeToSnakeCase } from './utils/providerData';
import { ProviderData } from '@openai/agents-core/types';
import { encodeUint8ArrayToBase64 } from '@openai/agents-core/utils';

type ToolChoice =
  | ToolChoiceOptions
  | ToolChoiceTypes
  // TOOD: remove this once the underlying ToolChoiceTypes include this
  | { type: 'web_search' }
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

type ResponseFunctionCallOutputListItem =
  | {
      type: 'input_text';
      text: string;
    }
  | {
      type: 'input_image';
      image_url?: string | null;
      file_id?: string | null;
      detail?: 'low' | 'high' | 'auto' | null;
    }
  | {
      type: 'input_file';
      file_data?: string | null;
      file_url?: string | null;
      file_id?: string | null;
      filename?: string | null;
    };

type ExtendedFunctionCallOutput = Omit<
  OpenAI.Responses.ResponseInputItem.FunctionCallOutput,
  'output'
> & {
  output: string | ResponseFunctionCallOutputListItem[];
};

type ResponseOutputItemWithFunctionResult =
  | OpenAI.Responses.ResponseOutputItem
  | (OpenAI.Responses.ResponseFunctionToolCallOutputItem & {
      name?: string;
      function_name?: string;
    });

type ResponseShellCallOutput =
  OpenAI.Responses.ResponseInputItem.ShellCallOutput;
type ResponseShellCallOutputContent =
  OpenAI.Responses.ResponseFunctionShellCallOutputContent;
type ResponseApplyPatchCallOutput =
  OpenAI.Responses.ResponseInputItem.ApplyPatchCallOutput;
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
type SerializedShellContainerAutoEnvironment = Extract<
  SerializedShellEnvironment,
  { type: 'container_auto' }
>;
type SerializedShellContainerSkill = NonNullable<
  SerializedShellContainerAutoEnvironment['skills']
>[number];
type SerializedShellContainerNetworkPolicy =
  SerializedShellContainerAutoEnvironment['networkPolicy'];

const HostedToolChoice = z.enum([
  'file_search',
  'web_search',
  'web_search_preview',
  'code_interpreter',
  'image_generation',
  'mcp',
  // Specialized local tools
  'computer_use_preview',
  'shell',
  'apply_patch',
]);

const DefaultToolChoice = z.enum(['auto', 'required', 'none']);

function getToolChoice(
  toolChoice?: ModelSettingsToolChoice,
): ToolChoice | undefined {
  if (typeof toolChoice === 'undefined') {
    return undefined;
  }

  const resultDefaultCheck = DefaultToolChoice.safeParse(toolChoice);
  if (resultDefaultCheck.success) {
    return resultDefaultCheck.data;
  }

  const result = HostedToolChoice.safeParse(toolChoice);
  if (result.success) {
    return { type: result.data as any };
  }

  return { type: 'function', name: toolChoice };
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

function normalizeFunctionCallOutputForRequest(
  output: protocol.FunctionCallResultItem['output'],
): string | ResponseFunctionCallOutputListItem[] {
  if (typeof output === 'string') {
    return output;
  }

  if (Array.isArray(output)) {
    return output.map(convertStructuredOutputToRequestItem);
  }

  if (isRecord(output) && typeof output.type === 'string') {
    if (output.type === 'text' && typeof output.text === 'string') {
      return output.text;
    }

    if (output.type === 'image' || output.type === 'file') {
      const structuredItems = convertLegacyToolOutputContent(
        output as protocol.ToolCallOutputContent,
      );
      return structuredItems.map(convertStructuredOutputToRequestItem);
    }
  }

  return String(output);
}

/**
 * Older tool integrations (and the Python SDK) still return their own `ToolOutput*` objects.
 * Translate those into the protocol `input_*` structures so the rest of the pipeline can stay
 * agnostic about who produced the data.
 */
function convertLegacyToolOutputContent(
  output: protocol.ToolCallOutputContent,
): protocol.ToolCallStructuredOutput[] {
  if (output.type === 'text') {
    const structured: protocol.InputText = {
      type: 'input_text',
      text: output.text,
    };
    if (output.providerData) {
      structured.providerData = output.providerData;
    }
    return [structured];
  }

  if (output.type === 'image') {
    const structured: protocol.InputImage = {
      type: 'input_image',
    };

    if (output.detail) {
      structured.detail = output.detail;
    }

    const legacyImageUrl = (output as any).imageUrl;
    const legacyFileId = (output as any).fileId;
    const dataValue = (output as any).data;

    if (typeof output.image === 'string' && output.image.length > 0) {
      structured.image = output.image;
    } else if (isRecord(output.image)) {
      const imageObj = output.image as Record<string, any>;
      const inlineMediaType = getImageInlineMediaType(imageObj);
      if (typeof imageObj.url === 'string' && imageObj.url.length > 0) {
        structured.image = imageObj.url;
      } else if (
        typeof imageObj.data === 'string' &&
        imageObj.data.length > 0
      ) {
        structured.image = formatInlineData(imageObj.data, inlineMediaType);
      } else if (
        imageObj.data instanceof Uint8Array &&
        imageObj.data.length > 0
      ) {
        structured.image = formatInlineData(imageObj.data, inlineMediaType);
      } else {
        const referencedId =
          (typeof imageObj.fileId === 'string' &&
            imageObj.fileId.length > 0 &&
            imageObj.fileId) ||
          (typeof imageObj.id === 'string' && imageObj.id.length > 0
            ? imageObj.id
            : undefined);
        if (referencedId) {
          structured.image = { id: referencedId };
        }
      }
    } else if (
      typeof legacyImageUrl === 'string' &&
      legacyImageUrl.length > 0
    ) {
      structured.image = legacyImageUrl;
    } else if (typeof legacyFileId === 'string' && legacyFileId.length > 0) {
      structured.image = { id: legacyFileId };
    } else {
      let base64Data: string | undefined;
      if (typeof dataValue === 'string' && dataValue.length > 0) {
        base64Data = dataValue;
      } else if (dataValue instanceof Uint8Array && dataValue.length > 0) {
        base64Data = encodeUint8ArrayToBase64(dataValue);
      }

      if (base64Data) {
        structured.image = base64Data;
      }
    }

    if (output.providerData) {
      structured.providerData = output.providerData;
    }

    return [structured];
  }

  if (output.type === 'file') {
    const structured: protocol.InputFile = {
      type: 'input_file',
    };

    const fileValue = (output as any).file ?? output.file;
    if (typeof fileValue === 'string') {
      structured.file = fileValue;
    } else if (isRecord(fileValue)) {
      if (typeof fileValue.data === 'string' && fileValue.data.length > 0) {
        structured.file = formatInlineData(
          fileValue.data,
          fileValue.mediaType ?? 'text/plain',
        );
      } else if (
        fileValue.data instanceof Uint8Array &&
        fileValue.data.length > 0
      ) {
        structured.file = formatInlineData(
          fileValue.data,
          fileValue.mediaType ?? 'text/plain',
        );
      } else if (
        typeof fileValue.url === 'string' &&
        fileValue.url.length > 0
      ) {
        structured.file = { url: fileValue.url };
      } else {
        const referencedId =
          (typeof fileValue.id === 'string' &&
            fileValue.id.length > 0 &&
            fileValue.id) ||
          (typeof (fileValue as any).fileId === 'string' &&
          (fileValue as any).fileId.length > 0
            ? (fileValue as any).fileId
            : undefined);
        if (referencedId) {
          structured.file = { id: referencedId };
        }
      }

      if (
        typeof fileValue.filename === 'string' &&
        fileValue.filename.length > 0
      ) {
        structured.filename = fileValue.filename;
      }
    }

    if (!structured.file) {
      const legacy = normalizeLegacyFileFromOutput(output as any);
      if (legacy.file) {
        structured.file = legacy.file;
      }
      if (legacy.filename) {
        structured.filename = legacy.filename;
      }
    }
    if (output.providerData) {
      structured.providerData = output.providerData;
    }

    return [structured];
  }

  throw new UserError(
    `Unsupported tool output type: ${JSON.stringify(output)}`,
  );
}

/**
 * Converts the protocol-level structured output into the exact wire format expected by the
 * Responses API. Be careful to keep the snake_case property names the service requires here.
 */
function convertStructuredOutputToRequestItem(
  item: protocol.ToolCallStructuredOutput,
): ResponseFunctionCallOutputListItem {
  if (item.type === 'input_text') {
    return {
      type: 'input_text',
      text: item.text,
    };
  }

  if (item.type === 'input_image') {
    const result: ResponseFunctionCallOutputListItem = { type: 'input_image' };

    const imageValue = (item as any).image ?? (item as any).imageUrl;
    if (typeof imageValue === 'string') {
      result.image_url = imageValue;
    } else if (isRecord(imageValue) && typeof imageValue.id === 'string') {
      result.file_id = imageValue.id;
    }

    const legacyFileId = (item as any).fileId;
    if (typeof legacyFileId === 'string') {
      result.file_id = legacyFileId;
    }

    if (item.detail) {
      result.detail = item.detail as any;
    }

    return result;
  }

  if (item.type === 'input_file') {
    const result: ResponseFunctionCallOutputListItem = { type: 'input_file' };

    if (typeof item.file === 'string') {
      // String file values are treated as inline data or URLs; use { id: "file_..." } for OpenAI file IDs.
      const value = item.file.trim();
      if (value.startsWith('data:')) {
        result.file_data = value;
      } else if (value.startsWith('http://') || value.startsWith('https://')) {
        result.file_url = value;
      } else if (/^[A-Za-z0-9+/=]+$/.test(value)) {
        result.file_data = value;
      } else {
        result.file_url = value;
      }
    } else if (
      item.file &&
      typeof item.file === 'object' &&
      'id' in item.file &&
      typeof (item.file as { id?: unknown }).id === 'string'
    ) {
      result.file_id = (item.file as { id: string }).id;
    } else if (
      item.file &&
      typeof item.file === 'object' &&
      'url' in item.file &&
      typeof (item.file as { url?: unknown }).url === 'string'
    ) {
      result.file_url = (item.file as { url: string }).url;
    }

    const legacyFileData = (item as any).fileData;
    if (typeof legacyFileData === 'string') {
      result.file_data = legacyFileData;
    }

    const legacyFileUrl = (item as any).fileUrl;
    if (typeof legacyFileUrl === 'string') {
      result.file_url = legacyFileUrl;
    }

    const legacyFileId = (item as any).fileId;
    if (typeof legacyFileId === 'string') {
      result.file_id = legacyFileId;
    }

    if (item.filename) {
      result.filename = item.filename;
    }

    return result;
  }

  throw new UserError(
    `Unsupported structured tool output: ${JSON.stringify(item)}`,
  );
}

function convertResponseFunctionCallOutputItemToStructured(
  item: ResponseFunctionCallOutputListItem,
): protocol.ToolCallStructuredOutput | null {
  if (item.type === 'input_text') {
    return {
      type: 'input_text',
      text: item.text,
    };
  }

  if (item.type === 'input_image') {
    const structured: protocol.InputImage = { type: 'input_image' };

    if (typeof item.image_url === 'string' && item.image_url.length > 0) {
      structured.image = item.image_url;
    } else if (typeof item.file_id === 'string' && item.file_id.length > 0) {
      structured.image = { id: item.file_id };
    } else {
      // As of 2025-10-30, conversations retrieval API may not include
      // data url in image_url property; so skipping this pattern
      logger.debug(
        `Skipped the "input_image" output item from a tool call result because the OpenAI Conversations API response didn't include the required property (image_url or file_id).`,
      );
      return null;
    }

    if (item.detail) {
      structured.detail = item.detail;
    }

    return structured;
  }

  if (item.type === 'input_file') {
    const structured: protocol.InputFile = { type: 'input_file' };

    if (typeof item.file_id === 'string' && item.file_id.length > 0) {
      structured.file = { id: item.file_id };
    } else if (typeof item.file_url === 'string' && item.file_url.length > 0) {
      structured.file = { url: item.file_url };
    } else if (
      typeof item.file_data === 'string' &&
      item.file_data.length > 0
    ) {
      structured.file = item.file_data;
    }

    if (item.filename) {
      structured.filename = item.filename;
    }

    return structured;
  }

  const exhaustive: never = item;
  throw new UserError(
    `Unsupported structured tool output: ${JSON.stringify(exhaustive)}`,
  );
}

function convertFunctionCallOutputToProtocol(
  output: OpenAI.Responses.ResponseFunctionToolCallOutputItem['output'],
): protocol.FunctionCallResultItem['output'] {
  if (typeof output === 'string') {
    return output;
  }

  if (Array.isArray(output)) {
    return output
      .map(convertResponseFunctionCallOutputItemToStructured)
      .filter((s) => s !== null);
  }

  return '';
}

function normalizeLegacyFileFromOutput(value: Record<string, any>): {
  file?: protocol.InputFile['file'];
  filename?: string;
} {
  const filename =
    typeof value.filename === 'string' && value.filename.length > 0
      ? value.filename
      : undefined;

  const referencedId =
    typeof value.id === 'string' && value.id.length > 0
      ? value.id
      : typeof value.fileId === 'string' && value.fileId.length > 0
        ? value.fileId
        : undefined;
  if (referencedId) {
    return { file: { id: referencedId }, filename };
  }

  if (typeof value.fileUrl === 'string' && value.fileUrl.length > 0) {
    return { file: { url: value.fileUrl }, filename };
  }

  if (typeof value.fileData === 'string' && value.fileData.length > 0) {
    return {
      file: formatInlineData(value.fileData, value.mediaType ?? 'text/plain'),
      filename,
    };
  }

  if (value.fileData instanceof Uint8Array && value.fileData.length > 0) {
    return {
      file: formatInlineData(value.fileData, value.mediaType ?? 'text/plain'),
      filename,
    };
  }

  return {};
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}

function getShellCallProviderDataForInput(
  providerData: protocol.ShellCallItem['providerData'],
): {
  environment?: OpenAI.Responses.ResponseInputItem.ShellCall['environment'];
} {
  const normalized = camelOrSnakeToSnakeCase(providerData);
  if (!isRecord(normalized)) {
    return {};
  }
  const environment = normalized.environment;
  if (!isRecord(environment)) {
    return {};
  }
  return {
    environment:
      environment as OpenAI.Responses.ResponseInputItem.ShellCall['environment'],
  };
}

function getImageInlineMediaType(
  source: Record<string, any>,
): string | undefined {
  if (typeof source.mediaType === 'string' && source.mediaType.length > 0) {
    return source.mediaType;
  }
  return undefined;
}

function formatInlineData(
  data: string | Uint8Array,
  mediaType?: string,
): string {
  const base64 =
    typeof data === 'string' ? data : encodeUint8ArrayToBase64(data);
  return mediaType ? `data:${mediaType};base64,${base64}` : base64;
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
): {
  tools: OpenAI.Responses.Tool[];
  include: OpenAI.Responses.ResponseIncludable[];
} {
  const openaiTools: OpenAI.Responses.Tool[] = [];
  const include: OpenAI.Responses.ResponseIncludable[] = [];
  for (const tool of tools) {
    const { tool: openaiTool, include: openaiIncludes } = converTool(tool);
    openaiTools.push(openaiTool);
    if (openaiIncludes && openaiIncludes.length > 0) {
      for (const item of openaiIncludes) {
        include.push(item);
      }
    }
  }

  return {
    tools: [...openaiTools, ...handoffs.map(getHandoffTool)],
    include,
  };
}

function converTool<_TContext = unknown>(
  tool: SerializedTool,
): {
  tool: OpenAI.Responses.Tool;
  include?: OpenAI.Responses.ResponseIncludable[];
} {
  if (tool.type === 'function') {
    return {
      tool: {
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: tool.strict,
      },
      include: undefined,
    };
  } else if (tool.type === 'computer') {
    return {
      tool: {
        type: 'computer_use_preview',
        environment: tool.environment,
        display_width: tool.dimensions[0],
        display_height: tool.dimensions[1],
      },
      include: undefined,
    };
  } else if (tool.type === 'shell') {
    return {
      tool: {
        type: 'shell',
        environment: toOpenAIShellEnvironment(tool.environment),
      } as OpenAI.Responses.FunctionShellTool,
      include: undefined,
    };
  } else if (tool.type === 'apply_patch') {
    return {
      tool: {
        type: 'apply_patch',
      } as OpenAI.Responses.ApplyPatchTool,
      include: undefined,
    };
  } else if (tool.type === 'hosted_tool') {
    if (tool.providerData?.type === 'web_search') {
      return {
        tool: {
          type: 'web_search',
          user_location: tool.providerData.user_location,
          filters: tool.providerData.filters,
          search_context_size: tool.providerData.search_context_size,
        },
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
      return {
        tool: {
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
        },
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
  if (requireApproval === 'never' || requireApproval === undefined) {
    return 'never';
  }

  if (requireApproval === 'always') {
    return 'always';
  }

  return {
    never: { tool_names: requireApproval.never?.tool_names },
    always: { tool_names: requireApproval.always?.tool_names },
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

function getInputMessageContent(
  entry: protocol.UserContent,
): OpenAI.Responses.ResponseInputContent {
  if (entry.type === 'input_text') {
    return {
      type: 'input_text',
      text: entry.text,
      ...camelOrSnakeToSnakeCase(entry.providerData),
    };
  } else if (entry.type === 'input_image') {
    const imageEntry: OpenAI.Responses.ResponseInputImage = {
      type: 'input_image',
      detail: (entry.detail ?? 'auto') as any,
    };
    if (typeof entry.image === 'string') {
      imageEntry.image_url = entry.image;
    } else if (entry.image && 'id' in entry.image) {
      imageEntry.file_id = entry.image.id;
    } else if (typeof (entry as any).imageUrl === 'string') {
      imageEntry.image_url = (entry as any).imageUrl;
    } else if (typeof (entry as any).fileId === 'string') {
      imageEntry.file_id = (entry as any).fileId;
    }
    return {
      ...imageEntry,
      ...camelOrSnakeToSnakeCase(entry.providerData),
    };
  } else if (entry.type === 'input_file') {
    const fileEntry: OpenAI.Responses.ResponseInputFile = {
      type: 'input_file',
    };
    if (typeof entry.file === 'string') {
      if (entry.file.startsWith('data:')) {
        fileEntry.file_data = entry.file;
      } else if (entry.file.startsWith('https://')) {
        fileEntry.file_url = entry.file;
      } else {
        throw new UserError(
          `Unsupported string data for file input. If you're trying to pass an uploaded file's ID, use an object with the ID property instead.`,
        );
      }
    } else if (
      entry.file &&
      typeof entry.file === 'object' &&
      'id' in entry.file
    ) {
      fileEntry.file_id = entry.file.id;
    } else if (
      entry.file &&
      typeof entry.file === 'object' &&
      'url' in entry.file
    ) {
      fileEntry.file_url = entry.file.url;
    }

    const legacyFileData = (entry as any).fileData;
    if (typeof legacyFileData === 'string') {
      fileEntry.file_data = legacyFileData;
    }
    const legacyFileUrl = (entry as any).fileUrl;
    if (typeof legacyFileUrl === 'string') {
      fileEntry.file_url = legacyFileUrl;
    }
    const legacyFileId = (entry as any).fileId;
    if (typeof legacyFileId === 'string') {
      fileEntry.file_id = legacyFileId;
    }
    if (entry.filename) {
      fileEntry.filename = entry.filename;
    }
    return {
      ...fileEntry,
      ...camelOrSnakeToSnakeCase(entry.providerData),
    };
  }

  throw new UserError(
    `Unsupported input content type: ${JSON.stringify(entry)}`,
  );
}

function getOutputMessageContent(
  entry: protocol.AssistantContent,
): OpenAI.Responses.ResponseOutputMessage['content'][number] {
  if (entry.type === 'output_text') {
    return {
      type: 'output_text',
      text: entry.text,
      annotations: [],
      ...camelOrSnakeToSnakeCase(entry.providerData),
    };
  }

  if (entry.type === 'refusal') {
    return {
      type: 'refusal',
      refusal: entry.refusal,
      ...camelOrSnakeToSnakeCase(entry.providerData),
    };
  }

  throw new UserError(
    `Unsupported output content type: ${JSON.stringify(entry)}`,
  );
}

function getMessageItem(
  item: protocol.MessageItem,
):
  | OpenAI.Responses.ResponseInputMessageItem
  | OpenAI.Responses.ResponseOutputMessage
  | OpenAI.Responses.EasyInputMessage {
  if (item.role === 'system') {
    return {
      id: item.id,
      role: 'system',
      content: item.content,
      ...camelOrSnakeToSnakeCase(item.providerData),
    };
  }

  if (item.role === 'user') {
    if (typeof item.content === 'string') {
      return {
        id: item.id,
        role: 'user',
        content: item.content,
        ...camelOrSnakeToSnakeCase(item.providerData),
      };
    }

    return {
      id: item.id,
      role: 'user',
      content: item.content.map(getInputMessageContent),
      ...camelOrSnakeToSnakeCase(item.providerData),
    };
  }

  if (item.role === 'assistant') {
    const assistantMessage: OpenAI.Responses.ResponseOutputMessage = {
      type: 'message',
      id: item.id!,
      role: 'assistant',
      content: item.content.map(getOutputMessageContent),
      status: item.status,
      ...camelOrSnakeToSnakeCase(item.providerData),
    };
    return assistantMessage;
  }

  throw new UserError(`Unsupported item ${JSON.stringify(item)}`);
}

function isMessageItem(item: protocol.ModelItem): item is protocol.MessageItem {
  if (item.type === 'message') {
    return true;
  }

  if (typeof item.type === 'undefined' && typeof item.role === 'string') {
    return true;
  }

  return false;
}

function getPrompt(prompt: ModelRequest['prompt']):
  | {
      id: string;
      version?: string;
      variables?: Record<string, any>;
    }
  | undefined {
  if (!prompt) {
    return undefined;
  }

  const transformedVariables: Record<string, any> = {};

  for (const [key, value] of Object.entries(prompt.variables ?? {})) {
    if (typeof value === 'string') {
      transformedVariables[key] = value;
    } else if (typeof value === 'object') {
      transformedVariables[key] = getInputMessageContent(value);
    }
  }

  return {
    id: prompt.promptId,
    version: prompt.version,
    variables: transformedVariables,
  };
}

function getInputItems(
  input: ModelRequest['input'],
): OpenAI.Responses.ResponseInputItem[] {
  if (typeof input === 'string') {
    return [
      {
        role: 'user',
        content: input,
      },
    ];
  }

  return input.map((item): OpenAI.Responses.ResponseInputItem => {
    if (isMessageItem(item)) {
      return getMessageItem(item);
    }

    if (item.type === 'function_call') {
      const entry: OpenAI.Responses.ResponseFunctionToolCall = {
        id: item.id,
        type: 'function_call',
        name: item.name,
        call_id: item.callId,
        arguments: item.arguments,
        status: item.status,
        ...camelOrSnakeToSnakeCase(item.providerData),
      };

      return entry;
    }

    if (item.type === 'function_call_result') {
      const normalizedOutput = normalizeFunctionCallOutputForRequest(
        item.output,
      );

      const entry: ExtendedFunctionCallOutput = {
        type: 'function_call_output',
        id: item.id,
        call_id: item.callId,
        output: normalizedOutput,
        status: item.status,
        ...camelOrSnakeToSnakeCase(item.providerData),
      };
      return entry as unknown as OpenAI.Responses.ResponseInputItem.FunctionCallOutput;
    }

    if (item.type === 'reasoning') {
      const entry: OpenAI.Responses.ResponseReasoningItem = {
        id: item.id!,
        type: 'reasoning',
        summary: item.content.map((content) => ({
          type: 'summary_text',
          text: content.text,
          ...camelOrSnakeToSnakeCase(content.providerData),
        })),
        encrypted_content: item.providerData?.encryptedContent,
        ...camelOrSnakeToSnakeCase(item.providerData),
      };
      return entry;
    }

    if (item.type === 'computer_call') {
      const entry: OpenAI.Responses.ResponseComputerToolCall = {
        type: 'computer_call',
        call_id: item.callId,
        id: item.id!,
        action: item.action,
        status: item.status,
        pending_safety_checks: [],
        ...camelOrSnakeToSnakeCase(item.providerData),
      };

      return entry;
    }

    if (item.type === 'computer_call_result') {
      const entry: OpenAI.Responses.ResponseInputItem.ComputerCallOutput = {
        type: 'computer_call_output',
        id: item.id,
        call_id: item.callId,
        output: buildResponseOutput(item),
        status: item.providerData?.status,
        acknowledged_safety_checks: item.providerData?.acknowledgedSafetyChecks,
        ...camelOrSnakeToSnakeCase(item.providerData),
      };
      return entry;
    }

    if (item.type === 'shell_call') {
      const action: OpenAI.Responses.ResponseInputItem.ShellCall['action'] = {
        commands: item.action.commands,
        timeout_ms:
          typeof item.action.timeoutMs === 'number'
            ? item.action.timeoutMs
            : null,
        max_output_length:
          typeof item.action.maxOutputLength === 'number'
            ? item.action.maxOutputLength
            : null,
      };
      const shellProviderData = getShellCallProviderDataForInput(
        item.providerData,
      );

      const entry: OpenAI.Responses.ResponseInputItem.ShellCall = {
        type: 'shell_call',
        id: item.id,
        call_id: item.callId,
        status: item.status ?? 'in_progress',
        action,
        ...shellProviderData,
      };

      return entry;
    }

    if (item.type === 'shell_call_output') {
      const shellOutputs: protocol.ShellCallOutputContent[] = item.output;
      const sanitizedOutputs: ResponseShellCallOutputContent[] =
        shellOutputs.map((entry) => {
          const outcome = entry?.outcome;
          const exitCode = outcome?.type === 'exit' ? outcome.exitCode : null;
          return {
            stdout: typeof entry?.stdout === 'string' ? entry.stdout : '',
            stderr: typeof entry?.stderr === 'string' ? entry.stderr : '',
            outcome:
              outcome?.type === 'timeout'
                ? { type: 'timeout' }
                : { type: 'exit', exit_code: exitCode ?? 0 },
          } as ResponseShellCallOutputContent;
        });

      const entry: OpenAI.Responses.ResponseInputItem.ShellCallOutput & {
        max_output_length?: number;
      } = {
        type: 'shell_call_output',
        call_id: item.callId,
        output: sanitizedOutputs,
        id: item.id ?? undefined,
      };
      if (typeof item.maxOutputLength === 'number') {
        entry.max_output_length = item.maxOutputLength;
      }

      return entry;
    }

    if (item.type === 'apply_patch_call') {
      if (!item.operation) {
        throw new UserError('apply_patch_call missing operation');
      }
      const entry: OpenAI.Responses.ResponseInputItem.ApplyPatchCall = {
        type: 'apply_patch_call',
        id: item.id ?? undefined,
        call_id: item.callId,
        status: item.status ?? 'in_progress',
        operation: item.operation,
      };

      return entry;
    }

    if (item.type === 'apply_patch_call_output') {
      const entry: OpenAI.Responses.ResponseInputItem.ApplyPatchCallOutput = {
        type: 'apply_patch_call_output',
        id: item.id ?? undefined,
        call_id: item.callId,
        status: item.status ?? 'completed',
        output: item.output ?? undefined,
      };

      return entry;
    }

    if (item.type === 'hosted_tool_call') {
      if (
        item.providerData?.type === 'web_search_call' ||
        item.providerData?.type === 'web_search' // for backward compatibility
      ) {
        const providerData = camelOrSnakeToSnakeCase(item.providerData) ?? {};
        const hasAction = providerData.action !== undefined;
        const hasValidAction =
          isRecord(providerData.action) &&
          typeof providerData.action.type === 'string';
        if (hasAction && !hasValidAction) {
          throw new UserError('web_search_call invalid action');
        }
        const entry = {
          ...providerData, // place here to prioritize the below fields
          type: 'web_search_call',
          id: item.id!,
          status: WebSearchStatus.parse(item.status ?? 'failed'),
        } as OpenAI.Responses.ResponseInputItem;
        if (hasValidAction) {
          (entry as OpenAI.Responses.ResponseFunctionWebSearch).action =
            providerData.action as OpenAI.Responses.ResponseFunctionWebSearch['action'];
        }

        return entry;
      }

      if (
        item.providerData?.type === 'file_search_call' ||
        item.providerData?.type === 'file_search' // for backward compatibility
      ) {
        const entry: OpenAI.Responses.ResponseFileSearchToolCall = {
          ...camelOrSnakeToSnakeCase(item.providerData), // place here to prioritize the below fields
          type: 'file_search_call',
          id: item.id!,
          status: FileSearchStatus.parse(item.status ?? 'failed'),
          queries: item.providerData?.queries ?? [],
          results: item.providerData?.results,
        };

        return entry;
      }

      if (
        item.providerData?.type === 'code_interpreter_call' ||
        item.providerData?.type === 'code_interpreter' // for backward compatibility
      ) {
        const entry: OpenAI.Responses.ResponseCodeInterpreterToolCall = {
          ...camelOrSnakeToSnakeCase(item.providerData), // place here to prioritize the below fields
          type: 'code_interpreter_call',
          id: item.id!,
          code: item.providerData?.code ?? '',
          // This property used to be results, so keeping both for backward compatibility
          // That said, this property cannot be passed from a user, so it's just API's internal data.
          outputs:
            item.providerData?.outputs ?? item.providerData?.results ?? [],
          status: CodeInterpreterStatus.parse(item.status ?? 'failed'),
          container_id: item.providerData?.container_id,
        };

        return entry;
      }

      if (
        item.providerData?.type === 'image_generation_call' ||
        item.providerData?.type === 'image_generation' // for backward compatibility
      ) {
        const entry: OpenAI.Responses.ResponseInputItem.ImageGenerationCall = {
          ...camelOrSnakeToSnakeCase(item.providerData), // place here to prioritize the below fields
          type: 'image_generation_call',
          id: item.id!,
          result: item.providerData?.result ?? null,
          status: ImageGenerationStatus.parse(item.status ?? 'failed'),
        };

        return entry;
      }

      if (
        item.providerData?.type === 'mcp_list_tools' ||
        item.name === 'mcp_list_tools'
      ) {
        const providerData =
          item.providerData as ProviderData.HostedMCPListTools;
        const entry: OpenAI.Responses.ResponseInputItem.McpListTools = {
          ...camelOrSnakeToSnakeCase(item.providerData),
          type: 'mcp_list_tools',
          id: item.id!,
          tools: camelOrSnakeToSnakeCase(providerData.tools) as any,
          server_label: providerData.server_label,
          error: providerData.error,
        };
        return entry;
      } else if (
        item.providerData?.type === 'mcp_approval_request' ||
        item.name === 'mcp_approval_request'
      ) {
        const providerData =
          item.providerData as ProviderData.HostedMCPApprovalRequest;
        const entry: OpenAI.Responses.ResponseInputItem.McpApprovalRequest = {
          ...camelOrSnakeToSnakeCase(item.providerData), // place here to prioritize the below fields
          type: 'mcp_approval_request',
          id: providerData.id ?? item.id!,
          name: providerData.name,
          arguments: providerData.arguments,
          server_label: providerData.server_label,
        };
        return entry;
      } else if (
        item.providerData?.type === 'mcp_approval_response' ||
        item.name === 'mcp_approval_response'
      ) {
        const providerData =
          item.providerData as ProviderData.HostedMCPApprovalResponse;
        const entry: OpenAI.Responses.ResponseInputItem.McpApprovalResponse = {
          ...camelOrSnakeToSnakeCase(providerData),
          type: 'mcp_approval_response',
          id: providerData.id,
          approve: providerData.approve,
          approval_request_id: providerData.approval_request_id,
          reason: providerData.reason,
        };
        return entry;
      } else if (
        item.providerData?.type === 'mcp_call' ||
        item.name === 'mcp_call'
      ) {
        const providerData = item.providerData as ProviderData.HostedMCPCall;
        const entry: OpenAI.Responses.ResponseInputItem.McpCall = {
          // output, which can be a large text string, is optional here, so we don't include it
          // output: item.output,
          ...camelOrSnakeToSnakeCase(providerData), // place here to prioritize the below fields
          type: 'mcp_call',
          id: providerData.id ?? item.id!,
          name: providerData.name,
          arguments: providerData.arguments,
          server_label: providerData.server_label,
          error: providerData.error,
        };
        return entry;
      }

      throw new UserError(
        `Unsupported built-in tool call type: ${JSON.stringify(item)}`,
      );
    }

    if (item.type === 'compaction') {
      const encryptedContent =
        (item as any).encrypted_content ?? (item as any).encryptedContent;
      if (typeof encryptedContent !== 'string') {
        throw new UserError('Compaction item missing encrypted_content');
      }
      return {
        type: 'compaction',
        id: item.id ?? undefined,
        encrypted_content: encryptedContent,
      } as OpenAI.Responses.ResponseInputItem;
    }

    if (item.type === 'unknown') {
      return {
        ...camelOrSnakeToSnakeCase(item.providerData), // place here to prioritize the below fields
        id: item.id,
      } as OpenAI.Responses.ResponseInputItem;
    }

    const exhaustive = item satisfies never;
    throw new UserError(`Unsupported item ${JSON.stringify(exhaustive)}`);
  });
}

// As of May 29, the output is always screenshot putput
function buildResponseOutput(
  item: protocol.ComputerCallResultItem,
): OpenAI.Responses.ResponseComputerToolCallOutputScreenshot {
  return {
    type: 'computer_screenshot',
    image_url: item.output.data,
  };
}

function convertToMessageContentItem(
  item: OpenAI.Responses.ResponseOutputMessage['content'][number],
): protocol.AssistantContent {
  if (item.type === 'output_text') {
    const { type, text, ...providerData } = item;
    return {
      type,
      text,
      ...(Object.keys(providerData).length > 0 ? { providerData } : {}),
    };
  }

  if (item.type === 'refusal') {
    const { type, refusal, ...providerData } = item;
    return {
      type,
      refusal,
      ...(Object.keys(providerData).length > 0 ? { providerData } : {}),
    };
  }

  throw new Error(`Unsupported message content type: ${JSON.stringify(item)}`);
}

function convertToOutputItem(
  items: ResponseOutputItemWithFunctionResult[],
): protocol.OutputModelItem[] {
  return items.map((item) => {
    if (item.type === 'message') {
      const { id, type, role, content, status, ...providerData } = item;
      return {
        id,
        type,
        role,
        content: content.map(convertToMessageContentItem),
        status,
        providerData,
      };
    } else if (
      item.type === 'file_search_call' ||
      item.type === 'web_search_call' ||
      item.type === 'image_generation_call' ||
      item.type === 'code_interpreter_call'
    ) {
      const { status, ...remainingItem } = item;
      let outputData = undefined;
      if ('result' in remainingItem && remainingItem.result !== null) {
        // type: "image_generation_call"
        outputData = remainingItem.result;
        delete (remainingItem as any).result;
      }
      const output: protocol.HostedToolCallItem = {
        type: 'hosted_tool_call',
        id: item.id!,
        name: item.type,
        status,
        output: outputData,
        providerData: remainingItem,
      };
      return output;
    } else if (item.type === 'function_call') {
      const { call_id, name, status, arguments: args, ...providerData } = item;
      const output: protocol.FunctionCallItem = {
        type: 'function_call',
        id: item.id!,
        callId: call_id,
        name,
        status,
        arguments: args,
        providerData,
      };
      return output;
    } else if (item.type === 'function_call_output') {
      const {
        call_id,
        status,
        output: rawOutput,
        name: toolName,
        function_name: functionName,
        ...providerData
      } = item as OpenAI.Responses.ResponseFunctionToolCallOutputItem & {
        name?: string;
        function_name?: string;
      };
      const output: protocol.FunctionCallResultItem = {
        type: 'function_call_result',
        id: item.id,
        callId: call_id,
        name: toolName ?? functionName ?? call_id,
        status: status ?? 'completed',
        output: convertFunctionCallOutputToProtocol(rawOutput),
        providerData,
      };
      return output;
    } else if (item.type === 'computer_call') {
      const { call_id, status, action, ...providerData } = item;
      const output: protocol.ComputerUseCallItem = {
        type: 'computer_call',
        id: item.id!,
        callId: call_id,
        status,
        action,
        providerData,
      };
      return output;
    } else if (item.type === 'shell_call') {
      const { call_id, status, action, ...providerData } = item;
      const shellAction: protocol.ShellAction = {
        commands: Array.isArray(action?.commands) ? action.commands : [],
      };
      const timeout = action?.timeout_ms;
      if (typeof timeout === 'number') {
        shellAction.timeoutMs = timeout;
      }
      const maxOutputLength = action?.max_output_length;
      if (typeof maxOutputLength === 'number') {
        shellAction.maxOutputLength = maxOutputLength;
      }
      const output: protocol.ShellCallItem = {
        type: 'shell_call',
        id: item.id ?? undefined,
        callId: call_id,
        status: status ?? 'in_progress',
        action: shellAction,
        providerData,
      };
      return output;
    } else if (item.type === 'shell_call_output') {
      const {
        call_id,
        output: responseOutput,
        max_output_length,
        ...providerData
      } = item as ResponseShellCallOutput;
      let normalizedOutput: protocol.ShellCallOutputContent[] = [];
      if (Array.isArray(responseOutput)) {
        normalizedOutput = responseOutput.map((entry) => ({
          stdout: typeof entry?.stdout === 'string' ? entry.stdout : '',
          stderr: typeof entry?.stderr === 'string' ? entry.stderr : '',
          outcome:
            entry?.outcome?.type === 'timeout'
              ? { type: 'timeout' as const }
              : {
                  type: 'exit' as const,
                  exitCode:
                    typeof entry?.outcome?.exit_code === 'number'
                      ? entry.outcome.exit_code
                      : null,
                },
        }));
      }
      const output: protocol.ShellCallResultItem = {
        type: 'shell_call_output',
        id: item.id ?? undefined,
        callId: call_id,
        output: normalizedOutput,
        providerData,
      };
      if (typeof max_output_length === 'number') {
        output.maxOutputLength = max_output_length;
      }
      return output;
    } else if (item.type === 'apply_patch_call') {
      const { call_id, status, operation, ...providerData } = item;
      if (!operation) {
        throw new UserError('apply_patch_call missing operation');
      }

      let normalizedOperation: protocol.ApplyPatchOperation;
      switch (operation.type) {
        case 'create_file':
          normalizedOperation = {
            type: 'create_file',
            path: operation.path,
            diff: operation.diff,
          };
          break;
        case 'delete_file':
          normalizedOperation = {
            type: 'delete_file',
            path: operation.path,
          };
          break;
        case 'update_file':
          normalizedOperation = {
            type: 'update_file',
            path: operation.path,
            diff: operation.diff,
          };
          break;
        default:
          throw new UserError('Unknown apply_patch operation type');
      }

      const output: protocol.ApplyPatchCallItem = {
        type: 'apply_patch_call',
        id: item.id ?? undefined,
        callId: call_id,
        status: status ?? 'in_progress',
        operation: normalizedOperation,
        providerData,
      };
      return output;
    } else if (item.type === 'apply_patch_call_output') {
      const {
        call_id,
        status,
        output: responseOutput,
        ...providerData
      } = item as unknown as ResponseApplyPatchCallOutput;
      const output: protocol.ApplyPatchCallResultItem = {
        type: 'apply_patch_call_output',
        id: item.id ?? undefined,
        callId: call_id,
        status,
        output: typeof responseOutput === 'string' ? responseOutput : undefined,
        providerData,
      };
      return output;
    } else if (item.type === 'mcp_list_tools') {
      const { ...providerData } = item;
      const output: protocol.HostedToolCallItem = {
        type: 'hosted_tool_call',
        id: item.id!,
        name: item.type,
        status: 'completed',
        output: undefined,
        providerData,
      };
      return output;
    } else if (item.type === 'mcp_approval_request') {
      const { ...providerData } = item;
      const output: protocol.HostedToolCallItem = {
        type: 'hosted_tool_call',
        id: item.id!,
        name: 'mcp_approval_request',
        status: 'completed',
        output: undefined,
        providerData,
      };
      return output;
    } else if (item.type === 'mcp_call') {
      // Avoiding to duplicate potentially large output data
      const { output: outputData, ...providerData } = item;
      const output: protocol.HostedToolCallItem = {
        type: 'hosted_tool_call',
        id: item.id!,
        name: item.type,
        status: 'completed',
        output: outputData || undefined,
        providerData,
      };
      return output;
    } else if (item.type === 'reasoning') {
      // Avoiding to duplicate potentially large summary data
      const { summary, ...providerData } = item;
      const output: protocol.ReasoningItem = {
        type: 'reasoning',
        id: item.id!,
        content: summary.map((content) => {
          // Avoiding to duplicate potentially large text
          const { text, ...remainingContent } = content;
          return {
            type: 'input_text',
            text,
            providerData: remainingContent,
          };
        }),
        providerData,
      };
      return output;
    } else if (item.type === 'compaction') {
      const { encrypted_content, created_by, ...providerData } = item as {
        encrypted_content?: string;
        created_by?: string;
        id?: string;
      };
      if (typeof encrypted_content !== 'string') {
        throw new UserError('Compaction item missing encrypted_content');
      }
      const output: protocol.CompactionItem = {
        type: 'compaction',
        id: item.id ?? undefined,
        encrypted_content,
        created_by,
        providerData,
      };
      return output;
    }

    return {
      type: 'unknown',
      id: item.id,
      providerData: item,
    };
  });
}

export { getToolChoice, converTool, getInputItems, convertToOutputItem };

const TERMINAL_RESPONSES_STREAM_EVENT_TYPES = new Set([
  'response.completed',
  'response.failed',
  'response.incomplete',
  'response.error',
]);

function isTerminalResponsesStreamEventType(
  eventType: string | undefined,
): boolean {
  return (
    typeof eventType === 'string' &&
    TERMINAL_RESPONSES_STREAM_EVENT_TYPES.has(eventType)
  );
}

type ResponseStreamWithRequestID =
  AsyncIterable<OpenAI.Responses.ResponseStreamEvent> & {
    withResponse?: () => Promise<{
      data: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>;
      request_id: string | null;
    }>;
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

  constructor(client: OpenAI, model: string) {
    this._client = client;
    this._model = model;
  }

  /**
   * @internal
   */
  protected async _fetchResponse(
    request: ModelRequest,
    stream: true,
  ): Promise<AsyncIterable<OpenAI.Responses.ResponseStreamEvent>>;
  protected async _fetchResponse(
    request: ModelRequest,
    stream: false,
  ): Promise<OpenAI.Responses.Response>;
  protected async _fetchResponse(
    request: ModelRequest,
    stream: boolean,
  ): Promise<
    | AsyncIterable<OpenAI.Responses.ResponseStreamEvent>
    | OpenAI.Responses.Response
  > {
    const builtRequest = this._buildResponsesCreateRequest(request, stream);
    const responsePromise = this._client.responses.create(
      builtRequest.requestData,
      {
        headers: builtRequest.sdkRequestHeaders as any,
        signal: builtRequest.signal,
        ...(builtRequest.transportExtraQuery
          ? { query: builtRequest.transportExtraQuery }
          : {}),
      },
    ) as ResponseStreamWithRequestID | Promise<OpenAI.Responses.Response>;

    let response:
      | AsyncIterable<OpenAI.Responses.ResponseStreamEvent>
      | OpenAI.Responses.Response;
    if (stream) {
      const withResponse = (responsePromise as ResponseStreamWithRequestID)
        .withResponse;
      if (typeof withResponse === 'function') {
        const streamedResponse = await withResponse.call(responsePromise);
        response = withAttachedResponseRequestId(
          streamedResponse.data,
          streamedResponse.request_id ?? undefined,
        );
      } else {
        response =
          (await responsePromise) as AsyncIterable<OpenAI.Responses.ResponseStreamEvent>;
      }
    } else {
      response = (await responsePromise) as OpenAI.Responses.Response;
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
    const { tools, include } = getTools(request.tools, request.handoffs);
    const toolChoice = getToolChoice(request.modelSettings.toolChoice);
    const {
      providerData: providerDataWithoutTransport,
      overrides: transportOverrides,
    } = splitResponsesTransportOverrides(request.modelSettings.providerData);
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
    const prompt = getPrompt(request.prompt);

    let parallelToolCalls: boolean | undefined = undefined;
    if (typeof request.modelSettings.parallelToolCalls === 'boolean') {
      if (request.modelSettings.parallelToolCalls && tools.length === 0) {
        throw new Error('Parallel tool calls are not supported without tools');
      }

      parallelToolCalls = request.modelSettings.parallelToolCalls;
    }

    // When a prompt template already declares a model, skip sending the agent's default model.
    // If the caller explicitly requests an override, include the resolved model name in the request.
    const shouldSendModel =
      !request.prompt || request.overridePromptModel === true;

    const shouldSendTools =
      tools.length > 0 ||
      request.toolsExplicitlyProvided === true ||
      !request.prompt;
    const shouldOmitToolChoice =
      Boolean(request.prompt) &&
      !shouldSendTools &&
      typeof toolChoice === 'object';

    let requestData = {
      ...(shouldSendModel ? { model: this._model } : {}),
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
        ? { tool_choice: toolChoice as ToolChoiceOptions }
        : {}),
      parallel_tool_calls: parallelToolCalls,
      stream,
      text: responseFormat,
      store: request.modelSettings.store,
      prompt_cache_retention: request.modelSettings.promptCacheRetention,
      ...restOfProviderData,
    };

    if (transportOverrides.extraBody) {
      requestData = {
        ...requestData,
        ...transportOverrides.extraBody,
      };
    }

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
    const response = await withResponseSpan(async (span) => {
      const response = await this._fetchResponse(request, false);

      if (request.tracing) {
        span.spanData.response_id = response.id;
        span.spanData._input = request.input;
        span.spanData._response = response;
      }

      return response;
    });

    const output: ModelResponse = {
      usage: new Usage({
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
        inputTokensDetails: { ...response.usage?.input_tokens_details },
        outputTokensDetails: { ...response.usage?.output_tokens_details },
        requestUsageEntries: [
          toRequestUsageEntry(response.usage, 'responses.create'),
        ],
      }),
      output: convertToOutputItem(response.output),
      responseId: response.id,
      requestId: getOpenAIResponseRequestId(response),
      providerData: response,
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
    const span = request.tracing ? createResponseSpan() : undefined;
    try {
      if (span) {
        span.start();
        setCurrentSpan(span);
        if (request.tracing === true) {
          span.spanData._input = request.input;
        }
      }
      const response = await this._fetchResponse(request, true);

      let finalResponse: OpenAI.Responses.Response | undefined;
      for await (const event of response) {
        const eventType = (event as { type?: string }).type;
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
              response: OpenAI.Responses.Response;
            };
          finalResponse = terminalEvent.response;
          const { response, ...remainingEvent } = terminalEvent;
          const { output, usage, id, ...remainingResponse } = response;
          yield {
            type: 'response_done',
            response: {
              id: id,
              requestId: getOpenAIResponseRequestId(response),
              output: convertToOutputItem(output),
              usage: {
                inputTokens: usage?.input_tokens ?? 0,
                outputTokens: usage?.output_tokens ?? 0,
                totalTokens: usage?.total_tokens ?? 0,
                inputTokensDetails: {
                  ...usage?.input_tokens_details,
                },
                outputTokensDetails: {
                  ...usage?.output_tokens_details,
                },
                requestUsageEntries: [
                  toRequestUsageEntry(usage, 'responses.create'),
                ],
              },
              providerData: remainingResponse,
            },
            providerData: remainingEvent,
          };
          if (eventType === 'response.completed') {
            yield {
              type: 'model',
              event: event,
            };
          }
        } else if (eventType === 'response.output_text.delta') {
          const { delta, ...remainingEvent } = event as {
            delta: string;
          } & Record<string, any>;
          yield {
            type: 'output_text_delta',
            delta: delta,
            providerData: remainingEvent,
          };
        }

        yield {
          type: 'model',
          event: event,
        };
      }

      if (request.tracing && span && finalResponse) {
        span.spanData.response_id = finalResponse.id;
        span.spanData._response = finalResponse;
      }
    } catch (error) {
      if (span) {
        span.setError({
          message: 'Error streaming response',
          data: {
            error: request.tracing
              ? String(error)
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

export type OpenAIResponsesWSModelOptions = {
  websocketBaseURL?: string;
  reuseConnection?: boolean;
};

/**
 * Model implementation that uses the OpenAI Responses API over a websocket transport.
 *
 * @see {@link https://developers.openai.com/api/docs/guides/websocket-mode}
 */
export class OpenAIResponsesWSModel extends OpenAIResponsesModel {
  #websocketBaseURL?: string;
  #reuseConnection: boolean;
  #wsConnection: ResponsesWebSocketConnection | undefined;
  #wsConnectionIdentity: string | undefined;
  #wsRequestLock: Promise<void> = Promise.resolve();

  constructor(
    client: OpenAI,
    model: string,
    options: OpenAIResponsesWSModelOptions = {},
  ) {
    super(client, model);
    this.#websocketBaseURL = options.websocketBaseURL;
    this.#reuseConnection = options.reuseConnection ?? true;
  }

  /**
   * @internal
   */
  protected async _fetchResponse(
    request: ModelRequest,
    stream: true,
  ): Promise<AsyncIterable<OpenAI.Responses.ResponseStreamEvent>>;
  protected async _fetchResponse(
    request: ModelRequest,
    stream: false,
  ): Promise<OpenAI.Responses.Response>;
  protected async _fetchResponse(
    request: ModelRequest,
    stream: boolean,
  ): Promise<
    | AsyncIterable<OpenAI.Responses.ResponseStreamEvent>
    | OpenAI.Responses.Response
  > {
    // The websocket transport always uses streamed Responses events, then callers either
    // consume the stream directly or collapse it into the final terminal response.
    const builtRequest = this._buildResponsesCreateRequest(request, true);

    if (stream) {
      return this.#iterWebSocketResponseEvents(builtRequest);
    }

    let finalResponse: OpenAI.Responses.Response | undefined;
    for await (const event of this.#iterWebSocketResponseEvents(builtRequest)) {
      const eventType = (event as { type?: string }).type;
      if (isTerminalResponsesStreamEventType(eventType)) {
        finalResponse = (event as { response: OpenAI.Responses.Response })
          .response;
      }
    }

    if (!finalResponse) {
      throw new Error(
        'Responses websocket stream ended without a terminal response event.',
      );
    }

    return finalResponse;
  }

  async close(): Promise<void> {
    await this.#dropWebSocketConnection();
  }

  async *#iterWebSocketResponseEvents(
    builtRequest: BuiltResponsesCreateRequest,
  ): AsyncIterable<OpenAI.Responses.ResponseStreamEvent> {
    const requestTimeoutDeadline =
      this.#createWebSocketRequestTimeoutDeadline();
    const releaseLock = await this.#acquireWebSocketRequestLock(
      builtRequest.signal,
      requestTimeoutDeadline,
    );

    let receivedAnyEvent = false;
    let sawTerminalResponseEvent = false;
    try {
      throwIfAborted(builtRequest.signal);
      const { frame, wsURL, headers } = await this.#prepareWebSocketRequest(
        builtRequest,
        requestTimeoutDeadline,
      );
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
      };
      await sendSerializedFrame();

      while (true) {
        const rawFrame = await this.#nextWebSocketFrame(
          activeConnection,
          builtRequest.signal,
          requestTimeoutDeadline,
        );
        if (rawFrame === null) {
          if (!receivedAnyEvent && reusedConnectionForCurrentAttempt) {
            // The request frame was already sent on a reused socket. If the
            // socket closes before the first response event arrives, the server
            // may still be processing the request, so replaying `response.create`
            // can duplicate model work and tool side effects.
            receivedAnyEvent = true;
            throw new Error(
              'Responses websocket connection closed after sending a request on a reused connection before any response events were received. The request may have been accepted, so the SDK will not automatically retry this websocket request.',
            );
          }
          throw new ResponsesWebSocketInternalError(
            'connection_closed_before_terminal_response_event',
            'Responses websocket connection closed before a terminal response event.',
          );
        }

        const payloadText = await webSocketFrameToText(rawFrame);
        const payload = JSON.parse(payloadText);
        const eventType =
          isRecord(payload) && typeof payload.type === 'string'
            ? payload.type
            : undefined;

        if (eventType === 'error') {
          receivedAnyEvent = true;
          throw new Error(
            `Responses websocket error: ${JSON.stringify(payload)}`,
          );
        }

        const event = payload as OpenAI.Responses.ResponseStreamEvent;
        const isTerminalResponseEvent =
          isTerminalResponsesStreamEventType(eventType);
        // Successful websocket responses do not currently expose a transport
        // request ID analogous to the HTTP x-request-id header.
        receivedAnyEvent = true;
        if (isTerminalResponseEvent) {
          sawTerminalResponseEvent = true;
        }
        yield event;

        if (isTerminalResponseEvent) {
          return;
        }
      }
    } catch (error) {
      if (
        !receivedAnyEvent &&
        !(error instanceof OpenAI.APIUserAbortError) &&
        shouldWrapNoEventWebSocketError(error)
      ) {
        const wrappedError = new Error(
          'Responses websocket connection closed before any response events were received. The feature may not be enabled for this account or model yet.',
        );
        if (error instanceof Error) {
          (wrappedError as Error & { cause?: unknown }).cause = error;
        }
        throw wrappedError;
      }
      throw error;
    } finally {
      const shouldDropConnection =
        !sawTerminalResponseEvent || !this.#reuseConnection;
      const dropConnectionPromise = shouldDropConnection
        ? this.#dropWebSocketConnection()
        : undefined;
      releaseLock();
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
        | Record<string, unknown>
        | undefined,
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
    this.#wsConnection = await ResponsesWebSocketConnection.connect(
      wsURL,
      headers,
      signal,
      connectTimeout.timeoutMs,
      connectTimeout.errorMessage,
    );
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
    | WebSocketRequestTimeoutDeadline
    | undefined {
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

/**
 * Sending an empty string for instructions can override the prompt parameter.
 * Thus, this method checks if the instructions is an empty string and returns undefined if it is.
 * @param instructions - The instructions to normalize.
 * @returns The normalized instructions.
 */
function normalizeInstructions(
  instructions: string | undefined,
): string | undefined {
  if (typeof instructions === 'string') {
    if (instructions.trim() === '') {
      return undefined;
    }
    return instructions;
  }
  return undefined;
}

function searchParamsToAuthHeaderQuery(
  searchParams: URLSearchParams,
): Record<string, string | string[]> | undefined {
  const query: Record<string, string | string[]> = {};
  let hasEntries = false;

  for (const [key, value] of searchParams.entries()) {
    hasEntries = true;
    const existingValue = query[key];
    if (typeof existingValue === 'undefined') {
      query[key] = value;
      continue;
    }
    if (Array.isArray(existingValue)) {
      existingValue.push(value);
      continue;
    }
    query[key] = [existingValue, value];
  }

  return hasEntries ? query : undefined;
}

function toRequestUsageEntry(
  usage: OpenAI.Responses.ResponseUsage | undefined,
  endpoint: string,
): RequestUsage {
  return new RequestUsage({
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    totalTokens: usage?.total_tokens ?? 0,
    inputTokensDetails: { ...usage?.input_tokens_details },
    outputTokensDetails: { ...usage?.output_tokens_details },
    endpoint,
  });
}
