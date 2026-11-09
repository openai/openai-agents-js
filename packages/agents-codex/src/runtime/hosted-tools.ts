import type OpenAI from 'openai';
import type { JsonObject } from './binding';

export interface HostedToolOptions {
  /** Additional provider fields; declared fields and tool identity cannot be replaced. */
  providerData?: JsonObject;
}

export interface FileSearchOptions extends HostedToolOptions {
  maxNumResults?: number;
  includeSearchResults?: boolean;
  rankingOptions?: OpenAI.Responses.FileSearchTool.RankingOptions;
  filters?: OpenAI.ComparisonFilter | OpenAI.CompoundFilter | null;
}

/** Provider-owned vector store search; no application callback runs. */
export interface FileSearch extends FileSearchOptions {
  readonly kind: 'file_search';
  readonly vectorStoreIds: readonly string[];
}

export interface CodeInterpreterOptions extends HostedToolOptions {
  /** Request raw provider outputs in accepted history. Defaults to true. */
  includeOutputs?: boolean;
  /** The provider owns container creation, reuse, expiry, and file retention. */
  container:
    string | OpenAI.Responses.Tool.CodeInterpreter.CodeInterpreterToolAuto;
  /** Provider invocation contexts; omission preserves provider defaults. */
  allowedCallers?: OpenAI.Responses.Tool.CodeInterpreter['allowed_callers'];
}

/** Provider-owned code execution, independent of the workspace executor. */
export interface CodeInterpreter extends CodeInterpreterOptions {
  readonly kind: 'code_interpreter';
}

export interface ImageGenerationOptions extends HostedToolOptions {
  action?: OpenAI.Responses.Tool.ImageGeneration['action'];
  background?: OpenAI.Responses.Tool.ImageGeneration['background'];
  inputFidelity?: 'high' | 'low' | null;
  inputImageMask?: OpenAI.Responses.Tool.ImageGeneration.InputImageMask;
  model?: OpenAI.Responses.Tool.ImageGeneration['model'];
  moderation?: OpenAI.Responses.Tool.ImageGeneration['moderation'];
  outputCompression?: number;
  outputFormat?:
    OpenAI.Responses.Tool.ImageGeneration['output_format'] | 'gif' | 'svg';
  complexity?: 'low' | 'medium' | 'high';
  frameCount?: number;
  frameDurationMs?: number;
  svg?: {
    model?: string;
    reasoning?: {
      effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    } | null;
  };
  partialImages?: number;
  quality?: OpenAI.Responses.Tool.ImageGeneration['quality'] | 'xhigh' | 'max';
  size?: OpenAI.Responses.Tool.ImageGeneration['size'];
}

/** Provider-owned image generation and editing. */
export interface ImageGeneration extends ImageGenerationOptions {
  readonly kind: 'image_generation';
}

export type HostedTool = FileSearch | CodeInterpreter | ImageGeneration;

/** Capture nested provider configuration without retaining application objects. */
function capture<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (part: unknown): void => {
    if (part === null || typeof part !== 'object') return;
    for (const child of Object.values(part)) freeze(child);
    Object.freeze(part);
  };
  freeze(copy);
  return copy;
}

export function fileSearch(
  vectorStoreIds: string | readonly string[],
  options: FileSearchOptions = {},
): FileSearch {
  return capture({
    ...options,
    kind: 'file_search' as const,
    vectorStoreIds:
      typeof vectorStoreIds === 'string'
        ? [vectorStoreIds]
        : [...vectorStoreIds],
  });
}

export function codeInterpreter(
  options: CodeInterpreterOptions,
): CodeInterpreter {
  return capture({ ...options, kind: 'code_interpreter' as const });
}

export function imageGeneration(
  options: ImageGenerationOptions = {},
): ImageGeneration {
  return capture({ ...options, kind: 'image_generation' as const });
}

/** @internal Re-capture structural declarations at the session opening boundary. */
export function captureHostedTool(tool: HostedTool): HostedTool {
  return capture(tool);
}

/** @internal The bridge removes SDK include controls before provider serialization. */
export function hostedToolSpecs(tools: readonly HostedTool[]): JsonObject[] {
  return tools.map((tool): JsonObject => {
    const providerData = tool.providerData ?? {};
    const fieldsByKind = {
      file_search: [
        'vector_store_ids',
        'max_num_results',
        'include_search_results',
        'ranking_options',
        'filters',
      ],
      code_interpreter: ['container', 'allowed_callers', 'include_outputs'],
      image_generation: [
        'action',
        'complexity',
        'frame_count',
        'frame_duration_ms',
        'svg',
        'background',
        'input_fidelity',
        'input_image_mask',
        'model',
        'moderation',
        'output_compression',
        'output_format',
        'partial_images',
        'quality',
        'size',
      ],
    };
    const reserved = new Set([
      'type',
      'kind',
      'provider_data',
      'providerData',
      ...fieldsByKind[tool.kind],
    ]);
    if (Object.keys(providerData).some((key) => reserved.has(key))) {
      throw new TypeError(
        'Hosted tool providerData cannot replace declared fields',
      );
    }
    if (tool.kind === 'file_search')
      return {
        ...providerData,
        type: tool.kind,
        vector_store_ids: [...tool.vectorStoreIds],
        ...(tool.maxNumResults === undefined
          ? {}
          : { max_num_results: tool.maxNumResults }),
        ...(tool.includeSearchResults === undefined
          ? {}
          : { include_search_results: tool.includeSearchResults }),
        ...(tool.rankingOptions === undefined
          ? {}
          : { ranking_options: tool.rankingOptions as JsonObject }),
        ...(tool.filters === undefined
          ? {}
          : { filters: tool.filters as unknown as JsonObject }),
      };
    if (tool.kind === 'code_interpreter')
      return {
        ...providerData,
        type: tool.kind,
        container: tool.container as JsonObject | string,
        ...(tool.includeOutputs === undefined
          ? {}
          : { include_outputs: tool.includeOutputs }),
        ...(tool.allowedCallers === undefined
          ? {}
          : { allowed_callers: tool.allowedCallers }),
      };
    const fields = {
      action: tool.action,
      complexity: tool.complexity,
      frame_count: tool.frameCount,
      frame_duration_ms: tool.frameDurationMs,
      svg: tool.svg,
      background: tool.background,
      input_fidelity: tool.inputFidelity,
      input_image_mask: tool.inputImageMask,
      model: tool.model,
      moderation: tool.moderation,
      output_compression: tool.outputCompression,
      output_format: tool.outputFormat,
      partial_images: tool.partialImages,
      quality: tool.quality,
      size: tool.size,
    };
    return {
      ...providerData,
      type: tool.kind,
      ...Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined),
      ),
    } as JsonObject;
  });
}

/** Provider statuses stay distinct from local execution statuses. */
export type HostedToolStatus =
  | 'in_progress'
  | 'searching'
  | 'interpreting'
  | 'generating'
  | 'completed'
  | 'incomplete'
  | 'failed';
type HostedItemIdentity = {
  id: string;
  turn_id: string;
  /** Existing JS history identity. */
  turnId: string;
  status: HostedToolStatus;
  /** Complete provider item, including fields unknown to this SDK version. */
  provider_data: JsonObject;
};
export type HostedToolItem = HostedItemIdentity &
  (
    | {
        type: 'file_search_call';
        queries: string[];
        results: import('./binding').JsonValue;
      }
    | {
        type: 'code_interpreter_call';
        container_id: string;
        code: string | null;
        outputs: import('./binding').JsonValue;
      }
    | {
        type: 'image_generation_call';
        result: string | null;
        revised_prompt: string | null;
      }
  );
