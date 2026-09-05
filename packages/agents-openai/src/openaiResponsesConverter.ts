import { protocol, UserError } from '@openai/agents-core';
import type { ModelRequest } from '@openai/agents-core';
import type OpenAI from 'openai';
import logger from './logger';
import {
  CodeInterpreterStatus,
  FileSearchStatus,
  ImageGenerationStatus,
  WebSearchStatus,
} from './tools';
import {
  camelOrSnakeToSnakeCase,
  getSnakeCasedProviderDataWithoutReservedKeys,
} from './utils/providerData';
import type { ProviderData } from '@openai/agents-core/types';
import {
  encodeUint8ArrayToBase64,
  getToolSearchExecution,
  getToolSearchProviderCallId,
} from '@openai/agents-core/utils';
import {
  assertValidCompactionItems,
  formatInlineData,
  getInlineMediaType,
} from '@openai/agents-core/utils/internal';
import { FAKE_ID } from './openaiItemIds';

type ResponseFunctionCallOutputListItem =
  OpenAI.Responses.ResponseFunctionCallOutputItemList[number];

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
      namespace?: string;
    })
  | OpenAI.Responses.ResponseToolSearchCall
  | OpenAI.Responses.ResponseToolSearchOutputItem;

type OpenAIToolSearchOutputToolPayload = Record<string, any>;

/**
 * Tool search outputs are replayed through agents-core protocol items, which use camelCase
 * field names, while the Responses API wire shape uses snake_case. Keep this codec even with
 * first-class upstream types because the local protocol still normalizes these payloads.
 */
function toOpenAIToolSearchOutputToolPayload(
  tool: OpenAIToolSearchOutputToolPayload,
  _withinNamespace = false,
): Record<string, any> {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
    return tool as Record<string, any>;
  }

  if (tool.type === 'tool_reference' && typeof tool.functionName === 'string') {
    return {
      type: 'tool_reference',
      function_name: tool.functionName,
      ...(typeof tool.namespace === 'string'
        ? { namespace: tool.namespace }
        : {}),
    };
  }

  if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
    return {
      ...tool,
      tools: tool.tools.map((entry: OpenAIToolSearchOutputToolPayload) =>
        toOpenAIToolSearchOutputToolPayload(entry, true),
      ),
    };
  }

  if (tool.type === 'function') {
    const { deferLoading, allowedCallers, outputSchema, ...rest } =
      tool as Record<string, any>;
    return {
      ...rest,
      ...(typeof deferLoading === 'boolean'
        ? { defer_loading: deferLoading }
        : {}),
      ...(Array.isArray(allowedCallers)
        ? { allowed_callers: allowedCallers }
        : {}),
      ...(outputSchema && typeof outputSchema === 'object'
        ? { output_schema: outputSchema }
        : {}),
    };
  }

  return tool as Record<string, any>;
}

function fromOpenAIToolSearchOutputToolPayload(
  tool: Record<string, any>,
  _withinNamespace = false,
): OpenAIToolSearchOutputToolPayload {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
    return tool as OpenAIToolSearchOutputToolPayload;
  }

  if (
    tool.type === 'tool_reference' &&
    typeof tool.function_name === 'string'
  ) {
    return {
      type: 'tool_reference',
      functionName: tool.function_name,
      ...(typeof tool.namespace === 'string'
        ? { namespace: tool.namespace }
        : {}),
    };
  }

  if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
    return {
      ...tool,
      tools: tool.tools.map((entry: Record<string, any>) =>
        fromOpenAIToolSearchOutputToolPayload(entry, true),
      ),
    };
  }

  if (tool.type === 'function') {
    const { defer_loading, allowed_callers, output_schema, ...rest } = tool;
    return {
      ...rest,
      ...(typeof defer_loading === 'boolean'
        ? { deferLoading: defer_loading }
        : {}),
      ...(Array.isArray(allowed_callers)
        ? { allowedCallers: allowed_callers }
        : {}),
      ...(output_schema && typeof output_schema === 'object'
        ? { outputSchema: output_schema }
        : {}),
    };
  }

  return tool as OpenAIToolSearchOutputToolPayload;
}

type ResponseFunctionToolCallWithNamespace =
  OpenAI.Responses.ResponseFunctionToolCall & {
    namespace?: string;
  };

type ResponseShellCallOutput =
  OpenAI.Responses.ResponseInputItem.ShellCallOutput;

type ResponseShellCallOutputContent =
  OpenAI.Responses.ResponseFunctionShellCallOutputContent;

type ResponseApplyPatchCallOutput =
  OpenAI.Responses.ResponseInputItem.ApplyPatchCallOutput;

type OpenAIToolSearchStatus = 'in_progress' | 'completed' | 'incomplete';

function normalizeToolSearchStatus(
  status?: string,
): OpenAIToolSearchStatus | null {
  return status === 'in_progress' ||
    status === 'completed' ||
    status === 'incomplete'
    ? status
    : null;
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
    const topLevelInlineMediaType = getInlineMediaType(
      output as Record<string, any>,
    );

    if (typeof output.image === 'string' && output.image.length > 0) {
      structured.image = output.image;
    } else if (isRecord(output.image)) {
      const imageObj = output.image as Record<string, any>;
      const inlineMediaType =
        getInlineMediaType(imageObj) ?? topLevelInlineMediaType;
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
        structured.image = formatInlineData(
          base64Data,
          topLevelInlineMediaType,
        );
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

function getInputMessageContent(
  entry: protocol.UserContent,
): OpenAI.Responses.ResponseInputContent {
  if (entry.type === 'input_text') {
    return {
      type: 'input_text',
      text: entry.text,
      ...(entry.promptCacheBreakpoint
        ? { prompt_cache_breakpoint: entry.promptCacheBreakpoint }
        : {}),
      ...getSnakeCasedProviderDataWithoutReservedKeys(entry.providerData, [
        'type',
        'text',
      ]),
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
      ...(entry.promptCacheBreakpoint
        ? { prompt_cache_breakpoint: entry.promptCacheBreakpoint }
        : {}),
      ...getSnakeCasedProviderDataWithoutReservedKeys(entry.providerData, [
        'type',
        'detail',
        'image_url',
        'file_id',
      ]),
    };
  } else if (entry.type === 'input_file') {
    const fileEntry: OpenAI.Responses.ResponseInputFile = {
      type: 'input_file',
    };
    if (typeof entry.file === 'string') {
      const value = entry.file.trim();
      if (value.startsWith('data:')) {
        fileEntry.file_data = value;
      } else if (value.startsWith('https://')) {
        fileEntry.file_url = value;
      } else if (/^[A-Za-z0-9+/=]+$/.test(value)) {
        fileEntry.file_data = value;
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
      ...(entry.promptCacheBreakpoint
        ? { prompt_cache_breakpoint: entry.promptCacheBreakpoint }
        : {}),
      ...getSnakeCasedProviderDataWithoutReservedKeys(entry.providerData, [
        'type',
        'file_data',
        'file_url',
        'file_id',
        'filename',
      ]),
    };
  }

  throw new UserError(
    `Unsupported input content type: ${JSON.stringify(entry)}`,
  );
}

function getProviderDataField<T>(
  providerData: unknown,
  keys: readonly string[],
): T | undefined {
  if (
    !providerData ||
    typeof providerData !== 'object' ||
    Array.isArray(providerData)
  ) {
    return undefined;
  }

  const record = providerData as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] !== 'undefined') {
      return record[key] as T;
    }
  }

  return undefined;
}

function getOutputMessageContent(
  entry: protocol.AssistantContent,
): OpenAI.Responses.ResponseOutputMessage['content'][number] {
  if (entry.type === 'output_text') {
    const annotations = getProviderDataField<
      OpenAI.Responses.ResponseOutputText['annotations']
    >(entry.providerData, ['annotations']);
    const normalizedAnnotations: OpenAI.Responses.ResponseOutputText['annotations'] =
      Array.isArray(annotations) ? annotations : [];
    return {
      type: 'output_text',
      text: entry.text,
      annotations: normalizedAnnotations,
      ...getSnakeCasedProviderDataWithoutReservedKeys(entry.providerData, [
        'type',
        'text',
        'annotations',
      ]),
    };
  }

  if (entry.type === 'refusal') {
    return {
      type: 'refusal',
      refusal: entry.refusal,
      ...getSnakeCasedProviderDataWithoutReservedKeys(entry.providerData, [
        'type',
        'refusal',
      ]),
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
      ...getSnakeCasedProviderDataWithoutReservedKeys(item.providerData, [
        'id',
        'role',
        'content',
        'phase',
      ]),
    };
  }

  if (item.role === 'user') {
    if (typeof item.content === 'string') {
      return {
        id: item.id,
        role: 'user',
        content: item.content,
        ...getSnakeCasedProviderDataWithoutReservedKeys(item.providerData, [
          'id',
          'role',
          'content',
          'phase',
        ]),
      };
    }

    return {
      id: item.id,
      role: 'user',
      content: item.content.map(getInputMessageContent),
      ...getSnakeCasedProviderDataWithoutReservedKeys(item.providerData, [
        'id',
        'role',
        'content',
        'phase',
      ]),
    };
  }

  if (item.role === 'assistant') {
    const phase =
      item.phase ?? getProviderDataField<unknown>(item.providerData, ['phase']);
    if (
      typeof phase !== 'undefined' &&
      phase !== 'commentary' &&
      phase !== 'final_answer'
    ) {
      throw new UserError(
        `Invalid assistant message phase: ${JSON.stringify(phase)}. Expected "commentary" or "final_answer".`,
      );
    }
    const assistantMessage: OpenAI.Responses.ResponseOutputMessage = {
      type: 'message',
      id: item.id!,
      role: 'assistant',
      content: item.content.map(getOutputMessageContent),
      status: item.status,
      ...(typeof phase === 'undefined' ? {} : { phase }),
      ...getSnakeCasedProviderDataWithoutReservedKeys(item.providerData, [
        'type',
        'id',
        'role',
        'content',
        'status',
        'phase',
      ]),
    };
    return stripSdkGeneratedPlaceholderItemId(assistantMessage);
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

type OpenAIToolCaller =
  { type: 'direct' } | { type: 'program'; caller_id: string };

function toOpenAIToolCaller(
  caller: protocol.ToolCaller | undefined,
): OpenAIToolCaller | undefined {
  if (!caller) {
    return undefined;
  }
  if (caller.type === 'direct') {
    return { type: 'direct' };
  }
  return { type: 'program', caller_id: caller.callerId };
}

function fromOpenAIToolCaller(
  caller: unknown,
): protocol.ToolCaller | undefined {
  if (!isRecord(caller)) {
    return undefined;
  }
  if (caller.type === 'direct') {
    return { type: 'direct' };
  }
  if (caller.type === 'program' && typeof caller.caller_id === 'string') {
    return { type: 'program', callerId: caller.caller_id };
  }
  return undefined;
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

function stripSdkGeneratedPlaceholderItemId<
  T extends OpenAI.Responses.ResponseInputItem,
>(item: T): T {
  const itemWithOptionalId = item as OpenAI.Responses.ResponseInputItem & {
    id?: unknown;
  };
  if (itemWithOptionalId.id !== FAKE_ID) {
    return item;
  }

  const { id: _id, ...itemWithoutId } = itemWithOptionalId;
  return itemWithoutId as T;
}

function stripOutputOnlyCreatedBy<T extends OpenAI.Responses.ResponseInputItem>(
  item: T,
): T {
  if (!Object.prototype.hasOwnProperty.call(item, 'created_by')) {
    return item;
  }

  const { created_by: _createdBy, ...withoutCreatedBy } = item as T & {
    created_by?: string;
  };
  return withoutCreatedBy as T;
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

  const inputItems = input.map((item): OpenAI.Responses.ResponseInputItem => {
    if (isMessageItem(item)) {
      return getMessageItem(item);
    }

    if (item.type === 'tool_search_call') {
      const status = normalizeToolSearchStatus(item.status);
      const callId = getToolSearchProviderCallId(item);
      const execution = getToolSearchExecution(item);
      const toolSearchCall: OpenAI.Responses.ResponseInputItem.ToolSearchCall =
        {
          type: 'tool_search_call',
          id: item.id,
          ...(status !== null ? { status } : {}),
          arguments: item.arguments,
          ...(callId ? { call_id: callId } : {}),
          ...(execution ? { execution } : {}),
          ...getSnakeCasedProviderDataWithoutReservedKeys(item.providerData, [
            'type',
            'id',
            'status',
            'arguments',
            'call_id',
            'callId',
            'execution',
          ]),
        };
      return toolSearchCall;
    }

    if (item.type === 'tool_search_output') {
      const status = normalizeToolSearchStatus(item.status);
      const callId = getToolSearchProviderCallId(item);
      const execution = getToolSearchExecution(item);
      const toolSearchOutput: OpenAI.Responses.ResponseToolSearchOutputItemParam =
        {
          type: 'tool_search_output',
          id: item.id,
          ...(status !== null ? { status } : {}),
          tools: item.tools.map(
            (tool) =>
              toOpenAIToolSearchOutputToolPayload(
                tool,
              ) as OpenAI.Responses.Tool,
          ),
          ...(callId ? { call_id: callId } : {}),
          ...(execution ? { execution } : {}),
          ...getSnakeCasedProviderDataWithoutReservedKeys(item.providerData, [
            'type',
            'id',
            'status',
            'tools',
            'call_id',
            'callId',
            'execution',
          ]),
        };
      return toolSearchOutput;
    }

    if (item.type === 'program') {
      return {
        type: 'program',
        id: item.id!,
        call_id: item.callId,
        code: item.code,
        fingerprint: item.fingerprint,
        ...getSnakeCasedProviderDataWithoutReservedKeys(item.providerData, [
          'type',
          'id',
          'call_id',
          'callId',
          'code',
          'fingerprint',
        ]),
      } satisfies OpenAI.Responses.ResponseInputItem.Program;
    }

    if (item.type === 'program_output') {
      return {
        type: 'program_output',
        id: item.id!,
        call_id: item.callId,
        result: item.output,
        status: item.status,
        ...getSnakeCasedProviderDataWithoutReservedKeys(item.providerData, [
          'type',
          'id',
          'call_id',
          'callId',
          'output',
          'result',
          'status',
        ]),
      } satisfies OpenAI.Responses.ResponseInputItem.ProgramOutput;
    }

    if (item.type === 'function_call') {
      const entry: ResponseFunctionToolCallWithNamespace = {
        id: item.id,
        type: 'function_call',
        name: item.name,
        call_id: item.callId,
        arguments: item.arguments,
        status: item.status,
        ...(item.caller ? { caller: toOpenAIToolCaller(item.caller) } : {}),
        ...(typeof item.namespace === 'string'
          ? { namespace: item.namespace }
          : {}),
        ...getSnakeCasedProviderDataWithoutReservedKeys(item.providerData, [
          'id',
          'type',
          'name',
          'call_id',
          'arguments',
          'status',
          'namespace',
          'caller',
        ]),
      };

      return stripSdkGeneratedPlaceholderItemId(entry);
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
        ...(item.caller ? { caller: toOpenAIToolCaller(item.caller) } : {}),
        ...getSnakeCasedProviderDataWithoutReservedKeys(item.providerData, [
          'type',
          'id',
          'call_id',
          'output',
          'status',
          'namespace',
          'caller',
        ]),
      };
      return entry as unknown as OpenAI.Responses.ResponseInputItem.FunctionCallOutput;
    }

    if (item.type === 'reasoning') {
      const encryptedContent = getProviderDataField<string>(item.providerData, [
        'encryptedContent',
        'encrypted_content',
      ]);
      const entry: OpenAI.Responses.ResponseReasoningItem = {
        id: item.id!,
        type: 'reasoning',
        summary: item.content.map((content) => ({
          type: 'summary_text',
          text: content.text,
          ...getSnakeCasedProviderDataWithoutReservedKeys(
            content.providerData,
            ['type', 'text'],
          ),
        })),
        ...(typeof encryptedContent === 'string'
          ? { encrypted_content: encryptedContent }
          : {}),
        ...getSnakeCasedProviderDataWithoutReservedKeys(item.providerData, [
          'id',
          'type',
          'summary',
          'encrypted_content',
        ]),
      };
      return entry;
    }

    if (item.type === 'computer_call') {
      const pendingSafetyChecks = getProviderDataField<
        OpenAI.Responses.ResponseComputerToolCall['pending_safety_checks']
      >(item.providerData, ['pendingSafetyChecks', 'pending_safety_checks']);
      const batchedActions = Array.isArray(
        (item as { actions?: unknown }).actions,
      )
        ? ((item as { actions?: OpenAI.Responses.ComputerActionList })
            .actions ?? [])
        : [];
      const actionPayload =
        batchedActions.length > 0
          ? {
              action: item.action ?? batchedActions[0],
              actions: batchedActions,
            }
          : item.action
            ? { action: item.action }
            : {};
      // The live API rejects empty pending_safety_checks on replayed computer calls.
      const entry = {
        type: 'computer_call',
        call_id: item.callId,
        id: item.id!,
        status: item.status,
        ...(Array.isArray(pendingSafetyChecks) && pendingSafetyChecks.length > 0
          ? { pending_safety_checks: pendingSafetyChecks }
          : {}),
        ...actionPayload,
        ...getSnakeCasedProviderDataWithoutReservedKeys(item.providerData, [
          'type',
          'call_id',
          'id',
          'action',
          'actions',
          'status',
          'pending_safety_checks',
        ]),
      };

      return entry as unknown as OpenAI.Responses.ResponseComputerToolCall;
    }

    if (item.type === 'computer_call_result') {
      const acknowledgedSafetyChecks = getProviderDataField<
        OpenAI.Responses.ResponseInputItem.ComputerCallOutput['acknowledged_safety_checks']
      >(item.providerData, [
        'acknowledgedSafetyChecks',
        'acknowledged_safety_checks',
      ]);
      const entry: OpenAI.Responses.ResponseInputItem.ComputerCallOutput = {
        type: 'computer_call_output',
        id: item.id,
        call_id: item.callId,
        output: buildResponseOutput(item),
        status: item.providerData?.status,
        ...(Array.isArray(acknowledgedSafetyChecks) &&
        acknowledgedSafetyChecks.length > 0
          ? { acknowledged_safety_checks: acknowledgedSafetyChecks }
          : {}),
        ...getSnakeCasedProviderDataWithoutReservedKeys(item.providerData, [
          'type',
          'id',
          'call_id',
          'output',
          'status',
          'acknowledged_safety_checks',
        ]),
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

      const entry: OpenAI.Responses.ResponseInputItem.ShellCall & {
        caller?: ReturnType<typeof toOpenAIToolCaller>;
      } = {
        type: 'shell_call',
        id: item.id,
        call_id: item.callId,
        status: item.status ?? 'in_progress',
        action,
        ...(item.caller ? { caller: toOpenAIToolCaller(item.caller) } : {}),
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
        caller?: ReturnType<typeof toOpenAIToolCaller>;
      } = {
        type: 'shell_call_output',
        call_id: item.callId,
        output: sanitizedOutputs,
        id: item.id ?? undefined,
        status: item.status ?? undefined,
        ...(item.caller ? { caller: toOpenAIToolCaller(item.caller) } : {}),
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
      const entry: OpenAI.Responses.ResponseInputItem.ApplyPatchCall & {
        caller?: ReturnType<typeof toOpenAIToolCaller>;
      } = {
        type: 'apply_patch_call',
        id: item.id ?? undefined,
        call_id: item.callId,
        status: item.status ?? 'in_progress',
        operation: serializeApplyPatchOperationForResponses(item.operation),
        ...(item.caller ? { caller: toOpenAIToolCaller(item.caller) } : {}),
      };

      return entry;
    }

    if (item.type === 'apply_patch_call_output') {
      const entry: OpenAI.Responses.ResponseInputItem.ApplyPatchCallOutput & {
        caller?: ReturnType<typeof toOpenAIToolCaller>;
      } = {
        type: 'apply_patch_call_output',
        id: item.id ?? undefined,
        call_id: item.callId,
        status: item.status ?? 'completed',
        output: item.output ?? undefined,
        ...(item.caller ? { caller: toOpenAIToolCaller(item.caller) } : {}),
      };

      return entry;
    }

    if (item.type === 'hosted_tool_call') {
      const hostedCaller = (
        item as protocol.HostedToolCallItem & {
          caller?: protocol.ToolCaller;
        }
      ).caller;
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
        const entry: OpenAI.Responses.ResponseCodeInterpreterToolCall & {
          caller?: OpenAIToolCaller;
        } = {
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
          ...(hostedCaller ? { caller: toOpenAIToolCaller(hostedCaller) } : {}),
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
        const entry: OpenAI.Responses.ResponseInputItem.McpListTools & {
          caller?: OpenAIToolCaller;
        } = {
          ...camelOrSnakeToSnakeCase(item.providerData),
          type: 'mcp_list_tools',
          id: item.id!,
          tools: camelOrSnakeToSnakeCase(providerData.tools) as any,
          server_label: providerData.server_label,
          error: providerData.error,
          ...(hostedCaller ? { caller: toOpenAIToolCaller(hostedCaller) } : {}),
        };
        return entry;
      } else if (
        item.providerData?.type === 'mcp_approval_request' ||
        item.name === 'mcp_approval_request'
      ) {
        const providerData =
          item.providerData as ProviderData.HostedMCPApprovalRequest;
        const entry: OpenAI.Responses.ResponseInputItem.McpApprovalRequest & {
          caller?: OpenAIToolCaller;
        } = {
          ...camelOrSnakeToSnakeCase(item.providerData), // place here to prioritize the below fields
          type: 'mcp_approval_request',
          id: providerData.id ?? item.id!,
          name: providerData.name,
          arguments: providerData.arguments,
          server_label: providerData.server_label,
          ...(hostedCaller ? { caller: toOpenAIToolCaller(hostedCaller) } : {}),
        };
        return entry;
      } else if (
        item.providerData?.type === 'mcp_approval_response' ||
        item.name === 'mcp_approval_response'
      ) {
        const providerData =
          item.providerData as ProviderData.HostedMCPApprovalResponse;
        const entry: OpenAI.Responses.ResponseInputItem.McpApprovalResponse & {
          caller?: OpenAIToolCaller;
        } = {
          ...camelOrSnakeToSnakeCase(providerData),
          type: 'mcp_approval_response',
          id: providerData.id,
          approve: providerData.approve,
          approval_request_id: providerData.approval_request_id,
          reason: providerData.reason,
          ...(hostedCaller ? { caller: toOpenAIToolCaller(hostedCaller) } : {}),
        };
        return entry;
      } else if (
        item.providerData?.type === 'mcp_call' ||
        item.name === 'mcp_call'
      ) {
        const providerData = item.providerData as ProviderData.HostedMCPCall;
        const entry: OpenAI.Responses.ResponseInputItem.McpCall & {
          caller?: OpenAIToolCaller;
        } = {
          // output, which can be a large text string, is optional here, so we don't include it
          // output: item.output,
          ...camelOrSnakeToSnakeCase(providerData), // place here to prioritize the below fields
          type: 'mcp_call',
          id: providerData.id ?? item.id!,
          name: providerData.name,
          arguments: providerData.arguments,
          server_label: providerData.server_label,
          error: providerData.error,
          ...(hostedCaller ? { caller: toOpenAIToolCaller(hostedCaller) } : {}),
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
      const compactionItem = {
        type: 'compaction',
        id: item.id ?? undefined,
        encrypted_content: encryptedContent,
      } as protocol.CompactionItem;
      assertValidCompactionItems([compactionItem]);
      return compactionItem as OpenAI.Responses.ResponseInputItem;
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
  return inputItems.map(stripOutputOnlyCreatedBy);
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
      const { id, type, role, content, status, phase, ...providerData } = item;
      return {
        id,
        type,
        role,
        content: content.map(convertToMessageContentItem),
        status,
        ...(phase === 'commentary' || phase === 'final_answer'
          ? { phase }
          : {}),
        providerData: {
          ...providerData,
          ...(phase === 'commentary' || phase === 'final_answer'
            ? { phase }
            : {}),
        },
      };
    } else if (item.type === 'tool_search_call') {
      const {
        id,
        type: _type,
        status,
        arguments: args,
        ...providerData
      } = item as OpenAI.Responses.ResponseToolSearchCall & Record<string, any>;
      const output: protocol.ToolSearchCallItem = {
        type: 'tool_search_call',
        id,
        status,
        arguments: args,
        providerData,
      };
      return output;
    } else if (item.type === 'tool_search_output') {
      const {
        id,
        type: _type,
        status,
        tools,
        ...providerData
      } = item as OpenAI.Responses.ResponseToolSearchOutputItem &
        Record<string, any>;
      const output: protocol.ToolSearchOutputItem = {
        type: 'tool_search_output',
        id,
        status,
        tools: Array.isArray(tools)
          ? (tools.map((tool) =>
              fromOpenAIToolSearchOutputToolPayload(tool),
            ) as any)
          : [],
        providerData,
      };
      return output;
    } else if (item.type === 'program') {
      const {
        id,
        call_id,
        code,
        fingerprint,
        type: _type,
        ...providerData
      } = item as OpenAI.Responses.ResponseOutputItem.Program &
        Record<string, unknown>;
      const output: protocol.ProgramCallItem = {
        type: 'program',
        id,
        callId: call_id,
        code,
        fingerprint,
        providerData,
      };
      return output;
    } else if (item.type === 'program_output') {
      const {
        id,
        call_id,
        result,
        status,
        type: _type,
        ...providerData
      } = item as OpenAI.Responses.ResponseOutputItem.ProgramOutput &
        Record<string, unknown>;
      const output: protocol.ProgramCallResultItem = {
        type: 'program_output',
        id,
        callId: call_id,
        output: result,
        status,
        providerData,
      };
      return output;
    } else if (
      item.type === 'file_search_call' ||
      item.type === 'web_search_call' ||
      item.type === 'image_generation_call' ||
      item.type === 'code_interpreter_call'
    ) {
      const { status, ...remainingItem } = item;
      const caller = fromOpenAIToolCaller(
        (remainingItem as { caller?: unknown }).caller,
      );
      if (caller) {
        delete (remainingItem as { caller?: unknown }).caller;
      }
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
        ...(caller ? { caller } : {}),
        providerData: remainingItem,
      };
      return output;
    } else if (item.type === 'function_call') {
      const functionCall = item as ResponseFunctionToolCallWithNamespace;
      const {
        call_id,
        name,
        namespace,
        caller,
        status,
        arguments: args,
        ...providerData
      } = functionCall;
      const output: protocol.FunctionCallItem = {
        type: 'function_call',
        id: functionCall.id!,
        callId: call_id,
        name,
        ...(typeof namespace === 'string' ? { namespace } : {}),
        status,
        arguments: args,
        ...(caller ? { caller: fromOpenAIToolCaller(caller) } : {}),
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
        namespace,
        caller,
        ...providerData
      } = item as OpenAI.Responses.ResponseFunctionToolCallOutputItem & {
        name?: string;
        function_name?: string;
        namespace?: string;
      };
      const output: protocol.FunctionCallResultItem = {
        type: 'function_call_result',
        id: item.id,
        callId: call_id,
        name: toolName ?? functionName ?? call_id,
        ...(typeof namespace === 'string' ? { namespace } : {}),
        status: status ?? 'completed',
        output: convertFunctionCallOutputToProtocol(rawOutput),
        ...(caller ? { caller: fromOpenAIToolCaller(caller) } : {}),
        providerData,
      };
      return output;
    } else if (item.type === 'computer_call') {
      const { call_id, status, action, actions, ...providerData } = item;
      const normalizedActions =
        Array.isArray(actions) && actions.length > 0 ? actions : undefined;
      if (!normalizedActions && !action) {
        throw new UserError(
          `Unsupported computer call item without an action or actions: ${JSON.stringify(item)}`,
        );
      }
      const output: protocol.ComputerUseCallItem = {
        type: 'computer_call',
        id: item.id!,
        callId: call_id,
        status,
        action: action ?? normalizedActions?.[0],
        ...(normalizedActions ? { actions: normalizedActions } : {}),
        providerData,
      };
      return output;
    } else if (item.type === 'shell_call') {
      const { call_id, status, action, caller, ...providerData } = item;
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
        ...(caller ? { caller: fromOpenAIToolCaller(caller) } : {}),
        providerData,
      };
      return output;
    } else if (item.type === 'shell_call_output') {
      const {
        call_id,
        output: responseOutput,
        max_output_length,
        status,
        caller,
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
        ...(status ? { status } : {}),
        ...(caller ? { caller: fromOpenAIToolCaller(caller) } : {}),
        providerData,
      };
      if (typeof max_output_length === 'number') {
        output.maxOutputLength = max_output_length;
      }
      return output;
    } else if (item.type === 'apply_patch_call') {
      const { call_id, status, operation, caller, ...providerData } = item;
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
        case 'update_file': {
          const moveTo = getApplyPatchMoveDestination(operation);
          normalizedOperation = {
            type: 'update_file',
            path: operation.path,
            diff: operation.diff,
            ...(moveTo !== undefined ? { moveTo } : {}),
          };
          break;
        }
        default:
          throw new UserError('Unknown apply_patch operation type');
      }

      const output: protocol.ApplyPatchCallItem = {
        type: 'apply_patch_call',
        id: item.id ?? undefined,
        callId: call_id,
        status: status ?? 'in_progress',
        operation: normalizedOperation,
        ...(caller ? { caller: fromOpenAIToolCaller(caller) } : {}),
        providerData,
      };
      return output;
    } else if (item.type === 'apply_patch_call_output') {
      const {
        call_id,
        status,
        output: responseOutput,
        caller,
        ...providerData
      } = item as unknown as ResponseApplyPatchCallOutput;
      const output: protocol.ApplyPatchCallResultItem = {
        type: 'apply_patch_call_output',
        id: item.id ?? undefined,
        callId: call_id,
        status,
        output: typeof responseOutput === 'string' ? responseOutput : undefined,
        ...(caller ? { caller: fromOpenAIToolCaller(caller) } : {}),
        providerData,
      };
      return output;
    } else if (item.type === 'mcp_list_tools') {
      const { ...providerData } = item;
      const caller = fromOpenAIToolCaller(
        (providerData as Record<string, unknown>).caller,
      );
      if (caller) {
        delete (providerData as Record<string, unknown>).caller;
      }
      const output: protocol.HostedToolCallItem = {
        type: 'hosted_tool_call',
        id: item.id!,
        name: item.type,
        status: 'completed',
        output: undefined,
        ...(caller ? { caller } : {}),
        providerData,
      };
      return output;
    } else if (item.type === 'mcp_approval_request') {
      const { ...providerData } = item;
      const caller = fromOpenAIToolCaller(
        (providerData as Record<string, unknown>).caller,
      );
      if (caller) {
        delete (providerData as Record<string, unknown>).caller;
      }
      const output: protocol.HostedToolCallItem = {
        type: 'hosted_tool_call',
        id: item.id!,
        name: 'mcp_approval_request',
        status: 'completed',
        output: undefined,
        ...(caller ? { caller } : {}),
        providerData,
      };
      return output;
    } else if (item.type === 'mcp_call') {
      // Avoiding to duplicate potentially large output data
      const { output: outputData, ...providerData } = item;
      const caller = fromOpenAIToolCaller(
        (providerData as Record<string, unknown>).caller,
      );
      if (caller) {
        delete (providerData as Record<string, unknown>).caller;
      }
      const output: protocol.HostedToolCallItem = {
        type: 'hosted_tool_call',
        id: item.id!,
        name: item.type,
        status: 'completed',
        output: outputData ?? undefined,
        ...(caller ? { caller } : {}),
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
      const output = {
        type: 'compaction',
        id: item.id ?? undefined,
        encrypted_content,
        created_by,
        providerData,
      } as unknown as protocol.CompactionItem;
      assertValidCompactionItems([output]);
      return output;
    }

    return {
      type: 'unknown',
      id: item.id,
      providerData: item,
    };
  });
}

function getApplyPatchMoveDestination(operation: unknown): string | undefined {
  const moveTo = (operation as { move_to?: unknown }).move_to;
  if (moveTo === undefined || moveTo === null) {
    return undefined;
  }
  if (typeof moveTo !== 'string' || moveTo.length === 0) {
    throw new UserError(
      'apply_patch_call update_file move_to must be a non-empty string',
    );
  }
  return moveTo;
}

function serializeApplyPatchOperationForResponses(
  operation: protocol.ApplyPatchOperation,
): OpenAI.Responses.ResponseInputItem.ApplyPatchCall['operation'] {
  if (operation.type !== 'update_file' || operation.moveTo === undefined) {
    return operation;
  }

  const { moveTo, ...rest } = operation;
  return {
    ...rest,
    move_to: moveTo,
  } as OpenAI.Responses.ResponseInputItem.ApplyPatchCall['operation'];
}

export { getInputItems, convertToOutputItem, getPrompt, isRecord };
export type { ResponseOutputItemWithFunctionResult };
