import {
  attachClientToolSearchExecutor,
  HostedTool,
  type ClientToolSearchExecutor,
  UserError,
} from '@openai/agents-core';
import type OpenAI from 'openai';
import { z } from 'zod';
import * as ProviderData from './types/providerData';

// -----------------------------------------------------
// Status enums
// -----------------------------------------------------

export const WebSearchStatus = z
  .enum(['in_progress', 'completed', 'searching', 'failed'])
  .default('failed');

export const FileSearchStatus = z
  .enum(['in_progress', 'completed', 'searching', 'failed', 'incomplete'])
  .default('failed');

export const CodeInterpreterStatus = z
  .enum(['in_progress', 'completed', 'interpreting'])
  .default('in_progress');

export const ImageGenerationStatus = z
  .enum(['in_progress', 'completed', 'generating', 'failed'])
  .default('failed');

// -----------------------------------------------------
// The tools below are OpenAI specific tools
// -----------------------------------------------------

/**
 * The built-in Web search tool
 *
 * see https://platform.openai.com/docs/guides/tools-web-search?api-mode=responses
 */
export type WebSearchTool = {
  type: 'web_search';
  name?: 'web_search' | 'web_search_preview' | (string & {});
  /**
   * Optional location for the search. Lets you customize results to be relevant to a location.
   */
  userLocation?: OpenAI.Responses.WebSearchTool.UserLocation;

  /**
   * Optional filters for the search.
   */
  filters?: { allowedDomains?: Array<string> | null };

  /**
   * High level guidance for the amount of context window space to use for the
   * search. One of `low`, `medium`, or `high`. `medium` is the default.
   */
  searchContextSize: 'low' | 'medium' | 'high';

  /**
   * Whether the tool may fetch live internet content. When omitted, the API
   * default is used.
   */
  externalWebAccess?: boolean;
};

/**
 * Adds web search abilities to your agent
 * @param options Additional configuration for the web search like specifying the location of your agent
 * @returns a web search tool definition
 */
export function webSearchTool(
  options: Partial<Omit<WebSearchTool, 'type'>> = {},
): HostedTool {
  const providerData: ProviderData.WebSearchTool = {
    type: 'web_search',
    name: options.name ?? 'web_search',
    user_location: options.userLocation,
    filters: options.filters?.allowedDomains
      ? { allowed_domains: options.filters.allowedDomains }
      : undefined,
    search_context_size: options.searchContextSize ?? 'medium',
  };
  if (options.externalWebAccess !== undefined) {
    providerData.external_web_access = options.externalWebAccess;
  }
  return {
    type: 'hosted_tool',
    name: options.name ?? 'web_search',
    providerData,
  };
}

/**
 * The built-in File search (backed by vector stores) tool
 */
export type FileSearchTool = {
  type: 'file_search';
  name?: 'file_search' | (string & {});
  /**
   * The IDs of the vector stores to search.
   */
  vectorStoreId: string[];
  /**
   * The maximum number of results to return.
   */
  maxNumResults?: number;
  /**
   * Whether to include the search results in the output produced by the LLM.
   */
  includeSearchResults?: boolean;
  /**
   * Ranking options for search.
   */
  rankingOptions?: OpenAI.Responses.FileSearchTool.RankingOptions;
  /**
   * A filter to apply based on file attributes.
   */
  filters?: OpenAI.ComparisonFilter | OpenAI.CompoundFilter;
};

/**
 * Adds file search abilities to your agent
 * @param vectorStoreIds The IDs of the vector stores to search.
 * @param options Additional configuration for the file search like specifying the maximum number of results to return.
 * @returns a file search tool definition
 */
export function fileSearchTool(
  vectorStoreIds: string | string[],
  options: Partial<Omit<FileSearchTool, 'type' | 'vectorStoreId'>> = {},
): HostedTool {
  const vectorIds = Array.isArray(vectorStoreIds)
    ? vectorStoreIds
    : [vectorStoreIds];
  const providerData: ProviderData.FileSearchTool = {
    type: 'file_search',
    name: options.name ?? 'file_search',
    vector_store_ids: vectorIds,
    max_num_results: options.maxNumResults,
    include_search_results: options.includeSearchResults,
    ranking_options: options.rankingOptions,
    filters: options.filters,
  };
  return {
    type: 'hosted_tool',
    name: options.name ?? 'file_search',
    providerData,
  };
}

export type CodeInterpreterTool = {
  type: 'code_interpreter';
  name?: 'code_interpreter' | (string & {});
  container?:
    | string
    | OpenAI.Responses.Tool.CodeInterpreter.CodeInterpreterToolAuto;
};

export type ToolSearchTool<Context = unknown> = {
  type: 'tool_search';
  name?: 'tool_search';
  execution?: OpenAI.Responses.ToolSearchTool['execution'];
  description?: string | null;
  parameters?: unknown | null;
  execute?: ClientToolSearchExecutor<Context>;
};

/**
 * Adds code interpreter abilities to your agent
 * @param options Additional configuration for the code interpreter
 * @returns a code interpreter tool definition
 */
export function codeInterpreterTool(
  options: Partial<Omit<CodeInterpreterTool, 'type'>> = {},
): HostedTool {
  const providerData: ProviderData.CodeInterpreterTool = {
    type: 'code_interpreter',
    name: options.name ?? 'code_interpreter',
    container: options.container ?? { type: 'auto' },
  };
  return {
    type: 'hosted_tool',
    name: options.name ?? 'code_interpreter',
    providerData,
  };
}

/**
 * Adds tool_search capabilities to your agent.
 *
 * This lets the model search deferred function tools and load them into context on demand.
 * By default, tool search is executed by OpenAI. Set `execution: 'client'` to
 * use a custom loop that receives `tool_search_call` / `tool_search_output`
 * items. The standard runner only supports the default built-in client schema
 * (leave `parameters` unset) and auto-executes `{ paths: string[] }` searches
 * over deferred top-level function tools and deferred namespace members.
 *
 * @returns a hosted tool_search definition.
 */
export function toolSearchTool<Context = unknown>(
  options: Partial<Omit<ToolSearchTool<Context>, 'type'>> = {},
): HostedTool {
  if (typeof options.name === 'string' && options.name !== 'tool_search') {
    throw new UserError(
      'toolSearchTool() only supports the canonical built-in name "tool_search".',
    );
  }

  if (typeof options.execute === 'function' && options.execution !== 'client') {
    throw new UserError(
      'toolSearchTool() only supports execute when execution is "client".',
    );
  }

  const providerData: ProviderData.ToolSearchTool = {
    type: 'tool_search',
    name: 'tool_search',
    execution: options.execution,
    description: options.description,
    parameters: options.parameters,
  };
  const hostedTool: HostedTool = {
    type: 'hosted_tool',
    name: 'tool_search',
    providerData,
  };

  if (typeof options.execute === 'function') {
    attachClientToolSearchExecutor(hostedTool, options.execute);
  }

  return hostedTool;
}

/**
 * The built-in Image generation tool
 */
export type ImageGenerationTool = {
  type: 'image_generation';
  name?: 'image_generation' | (string & {});
  background?: 'transparent' | 'opaque' | 'auto' | (string & {});
  inputFidelity?: 'high' | 'low' | null;
  inputImageMask?: OpenAI.Responses.Tool.ImageGeneration.InputImageMask;
  model?: 'gpt-image-1' | 'gpt-image-1-mini' | 'gpt-image-1.5' | (string & {});
  moderation?: 'auto' | 'low' | (string & {});
  outputCompression?: number;
  outputFormat?: 'png' | 'webp' | 'jpeg' | (string & {});
  partialImages?: number;
  quality?: 'low' | 'medium' | 'high' | 'auto' | (string & {});
  size?: '1024x1024' | '1024x1536' | '1536x1024' | 'auto' | (string & {});
};

/**
 * Adds image generation abilities to your agent
 * @param options Additional configuration for the image generation
 * @returns an image generation tool definition
 */
export function imageGenerationTool(
  options: Partial<Omit<ImageGenerationTool, 'type'>> = {},
): HostedTool {
  const providerData: ProviderData.ImageGenerationTool = {
    type: 'image_generation',
    name: options.name ?? 'image_generation',
    background: options.background,
    input_fidelity: options.inputFidelity,
    input_image_mask: options.inputImageMask,
    model: options.model,
    moderation: options.moderation,
    output_compression: options.outputCompression,
    output_format: options.outputFormat,
    partial_images: options.partialImages,
    quality: options.quality,
    size: options.size,
  };
  return {
    type: 'hosted_tool',
    name: options.name ?? 'image_generation',
    providerData,
  };
}

// HostedMCPTool exists in agents-core package
