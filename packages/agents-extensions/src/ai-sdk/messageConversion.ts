import type {
  LanguageModelV2FilePart,
  LanguageModelV2Message,
  LanguageModelV2ReasoningPart,
  LanguageModelV2TextPart,
  LanguageModelV2ToolCallPart,
  LanguageModelV2ToolResultPart,
} from '@ai-sdk/provider';
import { UserError, type ModelSettings, type protocol } from '@openai/agents';
import {
  getToolSearchProviderCallId,
  resolveToolSearchCallId,
  shouldQueuePendingToolSearchCall,
  takePendingToolSearchCallId,
  toolQualifiedName,
} from '@openai/agents-core/utils';
import {
  formatInlineData,
  getInlineMediaType,
} from '@openai/agents-core/utils/internal';
import type {
  LanguageModelCompatible,
  AiSdkSpecificationVersion,
} from './modelTypes';

export function getSpecVersion(
  model: LanguageModelCompatible,
): AiSdkSpecificationVersion {
  const spec = (model as any)?.specificationVersion;
  if (!spec) {
    // Default to v2 for backward compatibility with older AI SDK model wrappers.
    return 'v2';
  }
  if (spec === 'v2') {
    return 'v2';
  }
  if (typeof spec === 'string' && spec.toLowerCase().startsWith('v3')) {
    return 'v3';
  }
  if (typeof spec === 'string' && spec.toLowerCase().startsWith('v4')) {
    return 'v4';
  }
  return 'unknown';
}

function toAiSdkFileData(
  model: LanguageModelCompatible,
  data: string | URL,
): any {
  if (getSpecVersion(model) !== 'v4') {
    return data;
  }

  return typeof data === 'string'
    ? { type: 'data', data }
    : { type: 'url', url: data };
}

function getProviderReferenceKey(model: LanguageModelCompatible): string {
  return model.provider.split('.')[0] || model.provider;
}

type ParsedInlineImageData = {
  data: string;
  mediaType: string;
};

const AI_SDK_FILE_INPUT_ERROR =
  'AI SDK file inputs require a base64 data URL, valid non-empty raw base64 data with a PDF filename or providerData.mediaType, or a public HTTP(S) URL with a PDF filename or providerData.mediaType.';

const AI_SDK_FILE_ID_ERROR =
  'OpenAI file IDs are not supported by the AI SDK adapter. Use an OpenAI Responses model directly, or pass file data or a public HTTP(S) URL.';

function parseBase64ImageDataUrl(
  imageSource: string,
): ParsedInlineImageData | undefined {
  if (!imageSource.startsWith('data:')) {
    return undefined;
  }

  const commaIndex = imageSource.indexOf(',');
  if (commaIndex === -1) {
    return undefined;
  }

  const metadata = imageSource.slice('data:'.length, commaIndex);
  if (!metadata.includes('base64')) {
    return undefined;
  }

  const [maybeMediaType] = metadata.split(';');
  const mediaType = maybeMediaType?.trim();
  if (!mediaType) {
    return undefined;
  }

  return {
    data: imageSource.slice(commaIndex + 1),
    mediaType,
  };
}

function parseBase64FileDataUrl(
  fileSource: string,
): ParsedInlineImageData | undefined {
  if (!/^data:/i.test(fileSource)) {
    return undefined;
  }

  const commaIndex = fileSource.indexOf(',');
  if (commaIndex === -1) {
    return undefined;
  }

  const metadata = fileSource.slice('data:'.length, commaIndex);
  const [maybeMediaType, ...parameters] = metadata.split(';');
  const mediaType = maybeMediaType?.trim();
  const isBase64 = parameters.some(
    (parameter) => parameter.trim().toLowerCase() === 'base64',
  );
  if (!mediaType || !isBase64) {
    return undefined;
  }

  return {
    data: fileSource.slice(commaIndex + 1),
    mediaType,
  };
}

function isValidBase64Data(value: string): boolean {
  const normalized = value.replace(/[\t\n\f\r ]/g, '');
  if (
    normalized.length === 0 ||
    normalized.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  ) {
    return false;
  }

  const paddingLength = normalized.endsWith('==')
    ? 2
    : normalized.endsWith('=')
      ? 1
      : 0;
  if (paddingLength === 0) {
    return true;
  }

  const dataLength = normalized.length - paddingLength;
  return (
    normalized.length % 4 === 0 &&
    ((paddingLength === 1 && dataLength % 4 === 3) ||
      (paddingLength === 2 && dataLength % 4 === 2))
  );
}

function getProviderDataString(
  providerData: Record<string, any> | undefined,
  key: string,
): string | undefined {
  const value = providerData?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parsePublicFileUrl(source: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UserError(AI_SDK_FILE_INPUT_ERROR);
  }
  return url;
}

function getFileMediaType(
  providerData: Record<string, any> | undefined,
  filename: string | undefined,
  url?: URL,
): string {
  const explicitMediaType = getProviderDataString(providerData, 'mediaType');
  if (explicitMediaType) {
    return explicitMediaType;
  }

  if (
    [filename, url?.pathname].some((name) =>
      name?.toLowerCase().endsWith('.pdf'),
    )
  ) {
    return 'application/pdf';
  }

  throw new UserError(AI_SDK_FILE_INPUT_ERROR);
}

function toAiSdkFilePart(
  model: LanguageModelCompatible,
  input: protocol.InputFile,
): LanguageModelV2FilePart {
  const { file, filename, providerData } = input;
  const providerOptions = toProviderOptions(providerData, model);

  if (typeof file === 'string') {
    const inlineFile = parseBase64FileDataUrl(file);
    if (inlineFile) {
      if (!isValidBase64Data(inlineFile.data)) {
        throw new UserError(AI_SDK_FILE_INPUT_ERROR);
      }
      return {
        type: 'file',
        data: toAiSdkFileData(model, inlineFile.data),
        mediaType: inlineFile.mediaType,
        ...(filename ? { filename } : {}),
        providerOptions,
      };
    }

    if (file.startsWith('data:')) {
      throw new UserError(AI_SDK_FILE_INPUT_ERROR);
    }

    const url = parsePublicFileUrl(file);
    if (!url && !isValidBase64Data(file)) {
      throw new UserError(AI_SDK_FILE_INPUT_ERROR);
    }
    const mediaType = getFileMediaType(providerOptions, filename, url);
    return {
      type: 'file',
      data: toAiSdkFileData(model, url ?? file),
      mediaType,
      ...(filename ? { filename } : {}),
      providerOptions,
    };
  }

  if (isRecord(file)) {
    const fileRecord: Record<string, unknown> = file;
    if (typeof fileRecord.id === 'string') {
      throw new UserError(AI_SDK_FILE_ID_ERROR);
    }
    if (typeof fileRecord.url === 'string') {
      const url = parsePublicFileUrl(fileRecord.url);
      if (!url) {
        throw new UserError(AI_SDK_FILE_INPUT_ERROR);
      }
      return {
        type: 'file',
        data: toAiSdkFileData(model, url),
        mediaType: getFileMediaType(providerOptions, filename, url),
        ...(filename ? { filename } : {}),
        providerOptions,
      };
    }
  }

  throw new UserError(AI_SDK_FILE_INPUT_ERROR);
}

/**
 * @internal
 * Converts a list of model items to a list of language model V2 messages.
 *
 * @param model - The model to use.
 * @param items - The items to convert.
 * @returns The list of language model V2 messages.
 */
export function itemsToLanguageV2Messages(
  model: LanguageModelCompatible,
  items: protocol.ModelItem[],
  modelSettings?: ModelSettings,
): LanguageModelV2Message[] {
  const messages: LanguageModelV2Message[] = [];
  const toolCallNamesById = new Map<string, string>();
  const pendingToolSearchCallIds: string[] = [];
  const pendingServerToolSearchCallIds: string[] = [];
  const serverToolSearchCallIds = new Set<string>();
  let generatedToolSearchCallId = 0;
  let currentAssistantMessage: LanguageModelV2Message | undefined;
  let pendingReasonerReasoning:
    { text: string; providerOptions: Record<string, any> } | undefined;
  const collapsedItems = collapseReplacedToolSearchOutputs(items);
  const consumePendingReasonerReasoning = () => {
    if (!(
      shouldIncludeReasoningContent(model, modelSettings) &&
      pendingReasonerReasoning
    )) {
      return undefined;
    }

    const pending = pendingReasonerReasoning;
    pendingReasonerReasoning = undefined;
    return pending;
  };
  const flushPendingReasonerReasoningToMessages = () => {
    const pendingReasoning = consumePendingReasonerReasoning();
    if (!pendingReasoning) {
      return;
    }

    const reasoningPart: LanguageModelV2ReasoningPart = {
      type: 'reasoning',
      text: pendingReasoning.text,
      providerOptions: pendingReasoning.providerOptions,
    };

    if (
      currentAssistantMessage &&
      Array.isArray(currentAssistantMessage.content) &&
      currentAssistantMessage.role === 'assistant'
    ) {
      currentAssistantMessage.content.unshift(reasoningPart);
      currentAssistantMessage.providerOptions = {
        ...pendingReasoning.providerOptions,
        ...currentAssistantMessage.providerOptions,
      };
    } else {
      messages.push({
        role: 'assistant',
        content: [reasoningPart],
        providerOptions: pendingReasoning.providerOptions,
      });
    }
  };
  const appendPendingReasonerReasoningToCurrentAssistant = () => {
    if (
      !currentAssistantMessage ||
      !Array.isArray(currentAssistantMessage.content) ||
      currentAssistantMessage.role !== 'assistant'
    ) {
      return;
    }

    const pendingReasoning = consumePendingReasonerReasoning();
    if (!pendingReasoning) {
      return;
    }

    // Signed reasoning blocks must be attached once before parallel tool calls.
    currentAssistantMessage.content.push({
      type: 'reasoning',
      text: pendingReasoning.text,
      providerOptions: pendingReasoning.providerOptions,
    });
    currentAssistantMessage.providerOptions = {
      ...pendingReasoning.providerOptions,
      ...currentAssistantMessage.providerOptions,
    };
  };
  const flushCurrentAssistantMessage = () => {
    if (currentAssistantMessage) {
      messages.push(currentAssistantMessage);
      currentAssistantMessage = undefined;
    }
  };

  for (const item of collapsedItems) {
    if ('caller' in item && item.caller?.type === 'program') {
      throw new UserError(
        'The AI SDK adapter does not support Programmatic Tool Calling history. Use a Responses API model directly.',
      );
    }

    if (item.type === 'message' || typeof item.type === 'undefined') {
      const { role, content, providerData } = item;
      if (role === 'system') {
        flushPendingReasonerReasoningToMessages();
        flushCurrentAssistantMessage();
        messages.push({
          role: 'system',
          content: content,
          providerOptions: toProviderOptions(providerData, model),
        });
        continue;
      }

      if (role === 'user') {
        flushPendingReasonerReasoningToMessages();
        flushCurrentAssistantMessage();
        messages.push({
          role,
          content:
            typeof content === 'string'
              ? [{ type: 'text', text: content }]
              : content.map((c) => {
                  const { providerData: contentProviderData } = c;
                  if (c.type === 'input_text') {
                    return {
                      type: 'text',
                      text: c.text,
                      providerOptions: toProviderOptions(
                        contentProviderData,
                        model,
                      ),
                    };
                  }
                  if (c.type === 'input_image') {
                    const imageSource =
                      typeof c.image === 'string'
                        ? c.image
                        : typeof (c as any).imageUrl === 'string'
                          ? (c as any).imageUrl
                          : undefined;

                    if (!imageSource) {
                      throw new UserError(
                        'Only image URLs are supported for user inputs.',
                      );
                    }

                    const inlineImage = parseBase64ImageDataUrl(imageSource);
                    if (inlineImage) {
                      return {
                        type: 'file',
                        data: toAiSdkFileData(model, inlineImage.data),
                        mediaType: inlineImage.mediaType,
                        providerOptions: toProviderOptions(
                          contentProviderData,
                          model,
                        ),
                      };
                    }

                    const url = new URL(imageSource);
                    return {
                      type: 'file',
                      data: toAiSdkFileData(model, url),
                      mediaType: 'image/*',
                      providerOptions: toProviderOptions(
                        contentProviderData,
                        model,
                      ),
                    };
                  }
                  if (c.type === 'input_file') {
                    return toAiSdkFilePart(model, c);
                  }
                  throw new UserError(`Unknown content type: ${c.type}`);
                }),
          providerOptions: toProviderOptions(providerData, model),
        });
        continue;
      }

      if (role === 'assistant') {
        flushCurrentAssistantMessage();

        const assistantProviderOptions = toProviderOptions(providerData, model);
        const assistantContent: Array<
          LanguageModelV2ReasoningPart | LanguageModelV2TextPart
        > = content.flatMap<LanguageModelV2TextPart>((c) => {
          if (c.type !== 'output_text' && c.type !== 'refusal') {
            return [];
          }

          const { providerData: contentProviderData } = c;
          return {
            type: 'text',
            text: c.type === 'output_text' ? c.text : c.refusal,
            providerOptions: toProviderOptions(contentProviderData, model),
          };
        });

        if (
          shouldIncludeReasoningContent(model, modelSettings) &&
          pendingReasonerReasoning
        ) {
          assistantContent.unshift({
            type: 'reasoning',
            text: pendingReasonerReasoning.text,
            providerOptions: pendingReasonerReasoning.providerOptions,
          });
          messages.push({
            role,
            content: assistantContent,
            providerOptions: {
              ...pendingReasonerReasoning.providerOptions,
              ...assistantProviderOptions,
            },
          });
          pendingReasonerReasoning = undefined;
          continue;
        }

        messages.push({
          role,
          content: assistantContent,
          providerOptions: assistantProviderOptions,
        });
        continue;
      }

      const exhaustiveMessageTypeCheck = item satisfies never;
      throw new Error(`Unknown message type: ${exhaustiveMessageTypeCheck}`);
    } else if (item.type === 'function_call') {
      if (!currentAssistantMessage) {
        currentAssistantMessage = {
          role: 'assistant',
          content: [],
          providerOptions: toProviderOptions(item.providerData, model),
        };
      }

      if (
        Array.isArray(currentAssistantMessage.content) &&
        currentAssistantMessage.role === 'assistant'
      ) {
        // Reasoner models (e.g., DeepSeek Reasoner) require reasoning_content on tool-call messages.
        appendPendingReasonerReasoningToCurrentAssistant();
        const toolName = getAiSdkToolName(item);
        toolCallNamesById.set(item.callId, toolName);
        const content: LanguageModelV2ToolCallPart = {
          type: 'tool-call',
          toolCallId: item.callId,
          toolName,
          input: parseArguments(item.arguments),
          providerOptions: toProviderOptions(item.providerData, model),
        };
        currentAssistantMessage.content.push(content);
      }
      continue;
    } else if (item.type === 'function_call_result') {
      flushPendingReasonerReasoningToMessages();
      flushCurrentAssistantMessage();
      const toolName =
        toolCallNamesById.get(item.callId) ?? getAiSdkToolName(item);
      const toolResult: LanguageModelV2ToolResultPart = {
        type: 'tool-result',
        toolCallId: item.callId,
        toolName,
        output: convertToAiSdkOutput(item.output, model),
        providerOptions: toProviderOptions(item.providerData, model),
      };
      messages.push({
        role: 'tool',
        content: [toolResult],
        providerOptions: toProviderOptions(item.providerData, model),
      });
      continue;
    } else if (item.type === 'tool_search_call') {
      if (!currentAssistantMessage) {
        currentAssistantMessage = {
          role: 'assistant',
          content: [],
          providerOptions: toProviderOptions(item.providerData, model),
        };
      }

      if (
        Array.isArray(currentAssistantMessage.content) &&
        currentAssistantMessage.role === 'assistant'
      ) {
        appendPendingReasonerReasoningToCurrentAssistant();
        const toolCallId = resolveToolSearchCallId(item, () => {
          generatedToolSearchCallId += 1;
          return `tool_search_${generatedToolSearchCallId}`;
        });
        if (shouldQueuePendingToolSearchCall(item)) {
          pendingToolSearchCallIds.push(toolCallId);
        } else {
          pendingServerToolSearchCallIds.push(toolCallId);
          serverToolSearchCallIds.add(toolCallId);
        }
        toolCallNamesById.set(toolCallId, 'tool_search');
        const content: LanguageModelV2ToolCallPart = {
          type: 'tool-call',
          toolCallId,
          toolName: 'tool_search',
          input: item.arguments,
          ...(getToolSearchExecution(item) === 'server'
            ? { providerExecuted: true }
            : {}),
          providerOptions: toProviderOptions(item.providerData, model),
        };
        currentAssistantMessage.content.push(content);
      }
      continue;
    } else if (item.type === 'tool_search_output') {
      const toolSearchExecution = getToolSearchExecution(item);
      const toolCallId =
        toolSearchExecution === 'server'
          ? takeQueuedToolSearchResultCallId(
              item,
              pendingServerToolSearchCallIds,
              () => {
                generatedToolSearchCallId += 1;
                return `tool_search_${generatedToolSearchCallId}`;
              },
            )
          : takePendingToolSearchCallId(item, pendingToolSearchCallIds, () => {
              generatedToolSearchCallId += 1;
              return `tool_search_${generatedToolSearchCallId}`;
            });
      const toolName = toolCallNamesById.get(toolCallId) ?? 'tool_search';
      const isMatchedServerToolSearchResult =
        toolSearchExecution === 'server' &&
        serverToolSearchCallIds.has(toolCallId);
      const providerOptions = toProviderOptions(item.providerData, model);
      const isError = item.status === 'failed';
      const toolResult: LanguageModelV2ToolResultPart = {
        type: 'tool-result',
        toolCallId,
        toolName,
        output: {
          type: isError ? 'error-json' : 'json',
          value: isMatchedServerToolSearchResult
            ? isError && item.tools.length === 1
              ? item.tools[0]
              : item.tools
            : {
                ...(typeof item.status === 'string'
                  ? { status: item.status }
                  : {}),
                tools: item.tools,
              },
        },
        providerOptions,
      };

      if (isMatchedServerToolSearchResult) {
        if (!currentAssistantMessage) {
          currentAssistantMessage = {
            role: 'assistant',
            content: [],
            providerOptions,
          };
        }
        if (
          Array.isArray(currentAssistantMessage.content) &&
          currentAssistantMessage.role === 'assistant'
        ) {
          appendPendingReasonerReasoningToCurrentAssistant();
          const serverToolCallIndex = currentAssistantMessage.content.findIndex(
            (part) =>
              part.type === 'tool-call' && part.toolCallId === toolCallId,
          );
          const firstPendingClientToolCallIndex =
            currentAssistantMessage.content.findIndex(
              (part) => part.type === 'tool-call' && !part.providerExecuted,
            );

          if (
            serverToolCallIndex >= 0 &&
            firstPendingClientToolCallIndex >= 0 &&
            firstPendingClientToolCallIndex < serverToolCallIndex
          ) {
            const [serverToolCall] = currentAssistantMessage.content.splice(
              serverToolCallIndex,
              1,
            );
            currentAssistantMessage.content.splice(
              firstPendingClientToolCallIndex,
              0,
              serverToolCall,
              toolResult,
            );
          } else if (serverToolCallIndex >= 0) {
            currentAssistantMessage.content.splice(
              serverToolCallIndex + 1,
              0,
              toolResult,
            );
          } else {
            currentAssistantMessage.content.push(toolResult);
          }
          currentAssistantMessage.providerOptions = {
            ...currentAssistantMessage.providerOptions,
            ...providerOptions,
          };
        }
        continue;
      }

      flushPendingReasonerReasoningToMessages();
      flushCurrentAssistantMessage();
      messages.push({
        role: 'tool',
        content: [toolResult],
        providerOptions,
      });
      continue;
    }

    if (item.type === 'hosted_tool_call') {
      throw new UserError('Hosted tool calls are not supported');
    }

    if (item.type === 'computer_call') {
      throw new UserError('Computer calls are not supported');
    }

    if (item.type === 'computer_call_result') {
      throw new UserError('Computer call results are not supported');
    }

    if (item.type === 'shell_call') {
      throw new UserError('Shell calls are not supported');
    }

    if (item.type === 'shell_call_output') {
      throw new UserError('Shell call results are not supported');
    }

    if (item.type === 'apply_patch_call') {
      throw new UserError('Apply patch calls are not supported');
    }

    if (item.type === 'apply_patch_call_output') {
      throw new UserError('Apply patch call results are not supported');
    }

    if (
      item.type === 'reasoning' &&
      item.content.length > 0 &&
      typeof item.content[0].text === 'string'
    ) {
      // Only forward provider data when it targets this model so signatures stay scoped correctly.
      if (shouldIncludeReasoningContent(model, modelSettings)) {
        pendingReasonerReasoning = {
          text: item.content[0].text,
          providerOptions: toProviderOptions(item.providerData, model),
        };
        continue;
      }
      flushCurrentAssistantMessage();
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: item.content[0].text,
            providerOptions: toProviderOptions(item.providerData, model),
          },
        ],
        providerOptions: toProviderOptions(item.providerData, model),
      });
      continue;
    }

    if (item.type === 'unknown') {
      flushPendingReasonerReasoningToMessages();
      messages.push({ ...(item.providerData ?? {}) } as LanguageModelV2Message);
      continue;
    }

    if (item) {
      throw new UserError(`Unknown item type: ${item.type}`);
    }

    const itemType = item satisfies never;
    throw new UserError(`Unknown item type: ${itemType}`);
  }

  flushPendingReasonerReasoningToMessages();
  if (currentAssistantMessage) {
    messages.push(currentAssistantMessage);
  }

  return messages;
}

function convertToAiSdkOutput(
  output: protocol.FunctionCallResultItem['output'],
  model: LanguageModelCompatible,
): LanguageModelV2ToolResultPart['output'] {
  if (typeof output === 'string') {
    return { type: 'text', value: output };
  }
  if (Array.isArray(output)) {
    return convertStructuredOutputsToAiSdkOutput(output, model);
  }
  if (isRecord(output) && typeof output.type === 'string') {
    if (output.type === 'text' && typeof output.text === 'string') {
      return { type: 'text', value: output.text };
    }
    if (output.type === 'image' || output.type === 'file') {
      const structuredOutputs = convertLegacyToolOutputContent(
        output as protocol.ToolCallOutputContent,
      );
      return convertStructuredOutputsToAiSdkOutput(structuredOutputs, model);
    }
  }
  return { type: 'text', value: String(output) };
}

/**
 * Normalises legacy ToolOutput* objects into the protocol `input_*` shapes so that the AI SDK
 * bridge can treat all tool results uniformly.
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
    const structured: protocol.InputImage = { type: 'input_image' };

    if (output.detail) {
      structured.detail = output.detail;
    }

    if (typeof output.image === 'string' && output.image.length > 0) {
      structured.image = output.image;
    } else if (isRecord(output.image)) {
      const imageObj = output.image as Record<string, any>;
      const inlineMediaType = getInlineMediaType(imageObj);
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
    }
    if (output.providerData) {
      structured.providerData = output.providerData;
    }
    return [structured];
  }

  if (output.type === 'file') {
    return [];
  }
  throw new UserError(
    `Unsupported tool output type: ${JSON.stringify(output)}`,
  );
}

export function getToolSearchExecution(value: {
  execution?: unknown;
  providerData?: unknown;
}): 'client' | 'server' | undefined {
  const providerExecution = isRecord(value.providerData)
    ? value.providerData.execution
    : undefined;
  const execution = value.execution ?? providerExecution;
  return execution === 'client' || execution === 'server'
    ? execution
    : undefined;
}

function takeQueuedToolSearchResultCallId(
  value: {
    providerData?: unknown;
    call_id?: unknown;
    callId?: unknown;
    id?: unknown;
  },
  pendingCallIds: string[],
  generateFallbackId?: () => string,
): string {
  const explicitCallId = getToolSearchProviderCallId(value);
  if (explicitCallId) {
    const pendingIndex = pendingCallIds.indexOf(explicitCallId);
    if (pendingIndex >= 0) {
      pendingCallIds.splice(pendingIndex, 1);
    }
    return explicitCallId;
  }

  return (
    pendingCallIds.shift() ?? resolveToolSearchCallId(value, generateFallbackId)
  );
}

function getToolSearchOutputReplacementKey(
  item: protocol.ToolSearchOutputItem,
): string | undefined {
  const providerCallId = getToolSearchProviderCallId(item);
  if (providerCallId) {
    return `call:${providerCallId}`;
  }

  if (typeof item.id === 'string' && item.id.length > 0) {
    return `item:${item.id}`;
  }

  return undefined;
}

function collapseReplacedToolSearchOutputs(
  items: protocol.ModelItem[],
): protocol.ModelItem[] {
  const latestIndexByReplacementKey = new Map<string, number>();

  items.forEach((item, index) => {
    if (item.type !== 'tool_search_output') {
      return;
    }

    const replacementKey = getToolSearchOutputReplacementKey(item);
    if (replacementKey) {
      latestIndexByReplacementKey.set(replacementKey, index);
    }
  });

  return items.filter((item, index) => {
    if (item.type !== 'tool_search_output') {
      return true;
    }

    const replacementKey = getToolSearchOutputReplacementKey(item);
    if (!replacementKey) {
      return true;
    }

    return latestIndexByReplacementKey.get(replacementKey) === index;
  });
}

/**
 * Maps protocol-level structured outputs into the content-part format for the
 * target AI SDK specification version.
 */
function convertStructuredOutputsToAiSdkOutput(
  outputs: protocol.ToolCallStructuredOutput[],
  model: LanguageModelCompatible,
): LanguageModelV2ToolResultPart['output'] {
  type ImagePart =
    | { type: 'media'; data: string; mediaType: string }
    | { type: 'image-data'; data: string; mediaType: string }
    | { type: 'image-url'; url: string }
    | { type: 'image-file-id'; fileId: string }
    | {
        type: 'file';
        data:
          | { type: 'data'; data: string }
          | { type: 'url'; url: URL }
          | { type: 'reference'; reference: Record<string, string> };
        mediaType: string;
      };

  const specVersion = getSpecVersion(model);
  const isV3 = specVersion === 'v3';
  const isV4 = specVersion === 'v4';
  const textParts: string[] = [];
  const imageParts: ImagePart[] = [];

  for (const item of outputs) {
    if (item.type === 'input_text') {
      textParts.push(item.text);
      continue;
    }
    if (item.type === 'input_image') {
      const imageObjectFileId =
        isRecord(item.image) && typeof item.image.id === 'string'
          ? item.image.id
          : undefined;
      const legacyFileId =
        typeof (item as any).fileId === 'string'
          ? (item as any).fileId
          : undefined;
      const imageFileId = imageObjectFileId ?? legacyFileId;

      if ((isV3 || isV4) && imageFileId) {
        imageParts.push(
          isV4
            ? {
                type: 'file',
                data: {
                  type: 'reference',
                  reference: {
                    [getProviderReferenceKey(model)]: imageFileId,
                  },
                },
                mediaType: 'image',
              }
            : { type: 'image-file-id', fileId: imageFileId },
        );
        continue;
      }

      const imageValue =
        typeof item.image === 'string'
          ? item.image
          : imageObjectFileId
            ? `openai-file:${imageObjectFileId}`
            : typeof (item as any).imageUrl === 'string'
              ? (item as any).imageUrl
              : undefined;

      if (!imageValue && legacyFileId) {
        textParts.push(`[image file_id=${legacyFileId}]`);
        continue;
      }
      if (!imageValue) {
        textParts.push('[image]');
        continue;
      }
      const inlineImage = parseBase64ImageDataUrl(imageValue);
      if (inlineImage) {
        imageParts.push(
          isV4
            ? {
                type: 'file',
                data: { type: 'data', data: inlineImage.data },
                mediaType: inlineImage.mediaType,
              }
            : isV3
              ? {
                  type: 'image-data',
                  data: inlineImage.data,
                  mediaType: inlineImage.mediaType,
                }
              : {
                  type: 'media',
                  data: inlineImage.data,
                  mediaType: inlineImage.mediaType,
                },
        );
        continue;
      }
      try {
        const url = new URL(imageValue);
        imageParts.push(
          isV4
            ? {
                type: 'file',
                data: { type: 'url', url },
                mediaType: 'image',
              }
            : isV3
              ? { type: 'image-url', url: url.toString() }
              : {
                  type: 'media',
                  data: url.toString(),
                  mediaType: 'image/*',
                },
        );
      } catch {
        textParts.push(imageValue);
      }
      continue;
    }

    if (item.type === 'input_file') {
      textParts.push('[file output skipped]');
      continue;
    }
  }

  if (imageParts.length === 0) {
    return { type: 'text', value: textParts.join('') };
  }

  const value: Array<{ type: 'text'; text: string } | ImagePart> = [];

  if (textParts.length > 0) {
    value.push({ type: 'text', text: textParts.join('') });
  }
  value.push(...imageParts);
  return {
    type: 'content',
    value,
  } as LanguageModelV2ToolResultPart['output'];
}

export function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}

export function getAiSdkToolName(tool: {
  name: string;
  namespace?: string;
}): string {
  return toolQualifiedName(tool.name, tool.namespace) ?? tool.name;
}

export function getModelIdentifier(model: LanguageModelCompatible): string {
  return `${model.provider}:${model.modelId}`;
}

function isProviderDataForModel(
  providerData: Record<string, any>,
  model: LanguageModelCompatible,
): boolean {
  const providerDataModel = providerData.model;
  if (typeof providerDataModel !== 'string') {
    return true;
  }

  const target = getModelIdentifier(model).toLowerCase();
  const pdLower = providerDataModel.toLowerCase();
  return (
    pdLower === target ||
    pdLower === model.modelId.toLowerCase() ||
    pdLower === model.provider.toLowerCase()
  );
}

function isGeminiModel(model: LanguageModelCompatible): boolean {
  const target = getModelIdentifier(model).toLowerCase();
  return (
    target.includes('gemini') || model.modelId.toLowerCase().includes('gemini')
  );
}

function isDeepSeekModel(model: LanguageModelCompatible): boolean {
  const target = getModelIdentifier(model).toLowerCase();
  return (
    target.includes('deepseek') ||
    model.modelId.toLowerCase().includes('deepseek') ||
    model.provider.toLowerCase().includes('deepseek')
  );
}

function shouldIncludeReasoningContent(
  model: LanguageModelCompatible,
  modelSettings?: ModelSettings,
): boolean {
  const target = getModelIdentifier(model).toLowerCase();
  const modelIdLower = model.modelId.toLowerCase();

  // DeepSeek models require reasoning_content to be sent alongside tool calls when
  // either the dedicated reasoner model is used or thinking mode is explicitly enabled.
  const isDeepSeekReasoner =
    target.includes('deepseek-reasoner') ||
    modelIdLower.includes('deepseek-reasoner');

  if (isDeepSeekReasoner) {
    return true;
  }

  if (!isDeepSeekModel(model)) {
    return false;
  }

  return hasEnabledDeepSeekThinking(modelSettings?.providerData);
}

function hasEnabledDeepSeekThinking(
  providerData: Record<string, any> | undefined,
): boolean {
  if (!isRecord(providerData)) {
    return false;
  }

  const thinkingOption = [
    providerData.thinking,
    providerData.deepseek?.thinking,
    providerData.providerOptions?.thinking,
    providerData.providerOptions?.deepseek?.thinking,
  ].find((value) => value !== undefined);

  return isThinkingEnabled(thinkingOption);
}

function isThinkingEnabled(option: unknown): boolean {
  if (option === undefined || option === null) {
    return false;
  }

  if (option === true) {
    return true;
  }

  if (typeof option === 'string') {
    return option.toLowerCase() === 'enabled';
  }

  if (isRecord(option)) {
    const type = option.type ?? option.mode ?? option.status;
    if (typeof type === 'string') {
      return type.toLowerCase() === 'enabled';
    }
  }

  return false;
}

export function toProviderOptions(
  providerData: Record<string, any> | undefined,
  model: LanguageModelCompatible,
): Record<string, any> {
  if (!isRecord(providerData)) {
    return {};
  }

  if (!isProviderDataForModel(providerData, model)) {
    return {};
  }

  const options: Record<string, any> = { ...providerData };
  delete options.model;
  delete options.responseId;
  delete options.response_id;

  if (isGeminiModel(model)) {
    const googleFields = isRecord(options.google) ? { ...options.google } : {};
    const thoughtSignature =
      googleFields.thoughtSignature ??
      googleFields.thought_signature ??
      options.thoughtSignature ??
      options.thought_signature;

    if (thoughtSignature) {
      googleFields.thoughtSignature = thoughtSignature;
    }

    if (Object.keys(googleFields).length > 0) {
      options.google = googleFields;
    }

    delete options.thoughtSignature;
    delete options.thought_signature;
  }

  return options;
}

export function parseArguments(args: string | undefined | null): any {
  if (!args) {
    return {};
  }

  try {
    return JSON.parse(args);
  } catch (_) {
    return {};
  }
}
