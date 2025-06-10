import { HostedTool } from '@openai/agents-core';
import type OpenAI from 'openai';
import { z } from '@openai/zod/v3';

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
 */
export type WebSearchTool = {
  type: 'web_search';
  name?: 'web_search_preview' | string;
  /**
   * Optional location for the search. Lets you customize results to be relevant to a location.
   */
  userLocation?: OpenAI.Responses.WebSearchTool.UserLocation;
  /**
   * The amount of context to use for the search.
   */
  searchContextSize: 'low' | 'medium' | 'high';
};

/**
 * Adds web search abilities to your agent
 * @param options Additional configuration for the web search like specifying the location of your agent
 * @returns a web search tool definition
 */
export function webSearchTool(
  options: Partial<Omit<WebSearchTool, 'type'>> = {},
): HostedTool {
  return {
    type: 'hosted_tool',
    name: options.name ?? 'web_search_preview',
    providerData: {
      type: 'web_search',
      name: options.name ?? 'web_search_preview',
      userLocation: options.userLocation,
      searchContextSize: options.searchContextSize ?? 'medium',
    },
  };
}

/**
 * The built-in File search (backed by vector stores) tool
 */
export type FileSearchTool = {
  type: 'file_search';
  name?: 'file_search' | string;
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
  return {
    type: 'hosted_tool',
    name: options.name ?? 'file_search',
    providerData: {
      type: 'file_search',
      name: options.name ?? 'file_search',
      vectorStoreId: vectorIds,
      maxNumResults: options.maxNumResults,
      includeSearchResults: options.includeSearchResults,
      rankingOptions: options.rankingOptions,
      filters: options.filters,
    },
  };
}

export type CodeInterpreterTool = {
  type: 'code_interpreter';
  name?: 'code_interpreter' | string;
  container?:
    | string
    | OpenAI.Responses.Tool.CodeInterpreter.CodeInterpreterToolAuto;
};

/**
 * Adds code interpreter abilities to your agent
 * @param options Additional configuration for the code interpreter
 * @returns a code interpreter tool definition
 */
export function codeInterpreterTool(
  options: Partial<Omit<CodeInterpreterTool, 'type'>> = {},
): HostedTool {
  return {
    type: 'hosted_tool',
    name: options.name ?? 'code_interpreter',
    providerData: {
      type: 'code_interpreter',
      name: options.name ?? 'code_interpreter',
      container: options.container,
    },
  };
}

/**
 * The built-in Image generation tool
 */
export type ImageGenerationTool = {
  type: 'image_generation';
  name?: 'image_generation' | string;
  background?: 'transparent' | 'opaque' | 'auto' | string;
  inputImageMask?: OpenAI.Responses.Tool.ImageGeneration.InputImageMask;
  model?: 'gpt-image-1' | string;
  moderation?: 'auto' | 'low' | string;
  outputCompression?: number;
  outputFormat?: 'png' | 'webp' | 'jpeg' | string;
  partialImages?: number;
  quality?: 'low' | 'medium' | 'high' | 'auto' | string;
  size?: '1024x1024' | '1024x1536' | '1536x1024' | 'auto' | string;
};

/**
 * Adds image generation abilities to your agent
 * @param options Additional configuration for the image generation
 * @returns an image generation tool definition
 */
export function imageGenerationTool(
  options: Partial<Omit<ImageGenerationTool, 'type'>> = {},
): HostedTool {
  return {
    type: 'hosted_tool',
    name: options.name ?? 'image_generation',
    providerData: {
      type: 'image_generation',
      name: options.name ?? 'image_generation',
      background: options.background,
      inputImageMask: options.inputImageMask,
      model: options.model,
      moderation: options.moderation,
      outputCompression: options.outputCompression,
      outputFormat: options.outputFormat,
      partialImages: options.partialImages,
      quality: options.quality,
      size: options.size,
    },
  };
}

// HostedMCPTool exists in agents-core package
