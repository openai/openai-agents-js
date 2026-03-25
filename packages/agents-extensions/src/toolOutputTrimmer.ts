import {
  getLogger,
  type CallModelInputFilterArgs,
  type ModelInputData,
  type AgentInputItem,
} from '@openai/agents-core';

const logger = getLogger('openai-agents:extensions:tool-output-trimmer');

function getItemName(item: AnyItem): string | undefined {
  const name = item.name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

function getItemNamespace(item: AnyItem): string | undefined {
  const ns = item.namespace;
  return typeof ns === 'string' && ns.length > 0 ? ns : undefined;
}

function getItemQualifiedName(item: AnyItem): string | undefined {
  const name = getItemName(item);
  const namespace = getItemNamespace(item);
  if (!name) return undefined;
  return namespace ? `${namespace}.${name}` : name;
}

/**
 * Configuration options for {@link ToolOutputTrimmer}.
 */
export interface ToolOutputTrimmerOptions {
  /**
   * Number of recent user messages whose surrounding items are never trimmed.
   * Must be >= 1. Defaults to 2.
   */
  recentTurns?: number;

  /**
   * Tool outputs above this character count are candidates for trimming.
   * Must be >= 1. Defaults to 500.
   */
  maxOutputChars?: number;

  /**
   * How many characters of the original output to preserve as a preview
   * when trimming. Must be >= 0. Defaults to 200.
   */
  previewChars?: number;

  /**
   * Optional set of tool names whose outputs can be trimmed. For namespaced
   * tools, both bare names and qualified `namespace.name` entries are
   * supported. If `null` or omitted, all tool outputs are eligible.
   */
  trimmableTools?: ReadonlySet<string> | readonly string[] | null;
}

type AnyItem = Record<string, unknown>;

/**
 * Built-in {@link CallModelInputFilter} that trims large tool outputs from
 * older conversation turns.
 *
 * Agentic applications often accumulate large tool outputs (search results,
 * code execution output, error analyses) that consume significant tokens but
 * lose relevance as the conversation progresses. This filter surgically
 * replaces bulky tool outputs from older turns with a compact preview,
 * reducing token usage while preserving context about what happened.
 *
 * @example
 * ```ts
 * import { ToolOutputTrimmer } from '@openai/agents-extensions';
 *
 * const trimmer = new ToolOutputTrimmer({
 *   recentTurns: 2,
 *   maxOutputChars: 500,
 *   previewChars: 200,
 *   trimmableTools: new Set(['search', 'execute_code']),
 * });
 *
 * const result = await run(agent, input, {
 *   callModelInputFilter: trimmer.filter,
 * });
 * ```
 */
export class ToolOutputTrimmer {
  readonly recentTurns: number;
  readonly maxOutputChars: number;
  readonly previewChars: number;
  readonly trimmableTools: ReadonlySet<string> | null;

  constructor(options?: ToolOutputTrimmerOptions) {
    this.recentTurns = options?.recentTurns ?? 2;
    this.maxOutputChars = options?.maxOutputChars ?? 500;
    this.previewChars = options?.previewChars ?? 200;

    if (this.recentTurns < 1) {
      throw new Error(`recentTurns must be >= 1, got ${this.recentTurns}`);
    }
    if (this.maxOutputChars < 1) {
      throw new Error(
        `maxOutputChars must be >= 1, got ${this.maxOutputChars}`,
      );
    }
    if (this.previewChars < 0) {
      throw new Error(`previewChars must be >= 0, got ${this.previewChars}`);
    }

    const tools = options?.trimmableTools;
    if (tools == null) {
      this.trimmableTools = null;
    } else if (tools instanceof Set) {
      this.trimmableTools = tools;
    } else {
      this.trimmableTools = new Set(tools);
    }

    // Bind the filter method so it can be passed directly as a callback.
    this.filter = this.filter.bind(this);
  }

  /**
   * Filter callback invoked before each model call. Finds the boundary
   * between old and recent items, then trims large tool outputs from
   * old turns. Does NOT mutate the original items.
   */
  filter(args: CallModelInputFilterArgs): ModelInputData {
    const { modelData } = args;
    const items = modelData.input;

    if (!items || items.length === 0) {
      return modelData;
    }

    const boundary = this.#findRecentBoundary(items);
    if (boundary === 0) {
      return modelData;
    }

    const callIdToNames = this.#buildCallIdToNames(items);
    let trimmedCount = 0;
    let charsSaved = 0;
    const newItems: AgentInputItem[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (i < boundary && item && typeof item === 'object') {
        const itemObj = item as AnyItem;
        const itemType = itemObj.type as string | undefined;
        // Resolve call ID from top-level fields or providerData (client
        // tool_search_output items store call_id in providerData).
        const providerData =
          typeof itemObj.providerData === 'object' && itemObj.providerData
            ? (itemObj.providerData as AnyItem)
            : undefined;
        const callId = String(
          itemObj.callId ??
            itemObj.call_id ??
            itemObj.id ??
            providerData?.call_id ??
            '',
        );
        const toolNames = callIdToNames.get(callId) ?? [];

        if (
          this.trimmableTools !== null &&
          !toolNames.some((name) => this.trimmableTools!.has(name))
        ) {
          newItems.push(item);
          continue;
        }

        let trimResult: TrimResult | null = null;
        if (itemType === 'function_call_result') {
          trimResult = this.#trimFunctionCallResult(itemObj, toolNames);
        } else if (itemType === 'tool_search_output') {
          trimResult = this.#trimToolSearchOutput(itemObj);
        }

        if (trimResult) {
          newItems.push(trimResult.item as AgentInputItem);
          trimmedCount++;
          charsSaved += trimResult.saved;
          continue;
        }
      }
      newItems.push(item);
    }

    if (trimmedCount > 0) {
      logger.debug(
        `ToolOutputTrimmer: trimmed ${trimmedCount} tool output(s), saved ~${charsSaved} chars`,
      );
    }

    return { input: newItems, instructions: modelData.instructions };
  }

  /**
   * Walk backward through items counting user messages. Returns the index of
   * the Nth user message from the end, where N = recentTurns. Items at or
   * after this index are considered recent and will not be trimmed.
   */
  #findRecentBoundary(items: AgentInputItem[]): number {
    let userMsgCount = 0;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (
        item &&
        typeof item === 'object' &&
        (item as AnyItem).role === 'user'
      ) {
        userMsgCount++;
        if (userMsgCount >= this.recentTurns) {
          return i;
        }
      }
    }
    return 0;
  }

  /**
   * Build a mapping from function_call callId to candidate tool names.
   */
  #buildCallIdToNames(items: AgentInputItem[]): Map<string, string[]> {
    const mapping = new Map<string, string[]>();
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const itemObj = item as AnyItem;

      if (itemObj.type === 'function_call') {
        const callId = itemObj.callId as string | undefined;
        if (!callId) continue;

        const names: string[] = [];
        const qualifiedName = getItemQualifiedName(itemObj);
        const bareName = getItemName(itemObj);
        if (qualifiedName) names.push(qualifiedName);
        if (bareName && bareName !== qualifiedName) names.push(bareName);
        if (names.length > 0) {
          mapping.set(callId, names);
        }
      } else if (itemObj.type === 'tool_search_call') {
        const pd =
          typeof itemObj.providerData === 'object' && itemObj.providerData
            ? (itemObj.providerData as AnyItem)
            : undefined;
        const callId = String(
          itemObj.callId ?? itemObj.call_id ?? itemObj.id ?? pd?.call_id ?? '',
        );
        if (callId) {
          mapping.set(callId, ['tool_search']);
        }
      }
    }
    return mapping;
  }

  #trimFunctionCallResult(
    item: AnyItem,
    toolNames: string[],
  ): TrimResult | null {
    const output = item.output;
    // output can be a string, a structured content object, or an array of
    // structured items. Serialize non-strings via JSON so we measure the
    // real payload size instead of getting "[object Object]".
    const outputStr =
      typeof output === 'string' ? output : serializeJsonLike(output ?? '');
    const outputLen = outputStr.length;
    if (outputLen <= this.maxOutputChars) {
      return null;
    }

    const displayName = toolNames[0] ?? 'unknown_tool';
    const preview = outputStr.slice(0, this.previewChars);
    const summary = `[Trimmed: ${displayName} output \u2014 ${outputLen} chars \u2192 ${this.previewChars} char preview]\n${preview}...`;

    if (summary.length >= outputLen) {
      return null;
    }

    return {
      item: { ...item, output: summary },
      saved: outputLen - summary.length,
    };
  }

  #trimToolSearchOutput(item: AnyItem): TrimResult | null {
    const tools = item.tools;
    if (!Array.isArray(tools)) {
      return null;
    }

    const original = serializeJsonLike(tools);
    if (original.length <= this.maxOutputChars) {
      return null;
    }

    const trimmedTools = tools.map((tool) => this.#trimToolSearchTool(tool));
    const trimmed = serializeJsonLike(trimmedTools);
    if (trimmed.length >= original.length) {
      return null;
    }

    return {
      item: { ...item, tools: trimmedTools },
      saved: original.length - trimmed.length,
    };
  }

  #trimToolSearchTool(tool: unknown): unknown {
    if (!tool || typeof tool !== 'object') {
      return tool;
    }

    const toolObj = tool as AnyItem;
    const trimmed: AnyItem = { ...toolObj };

    if (typeof trimmed.description === 'string') {
      const desc = trimmed.description as string;
      if (desc.length > this.previewChars) {
        trimmed.description = desc.slice(0, this.previewChars) + '...';
      }
    }

    const toolType = trimmed.type as string | undefined;
    if (
      toolType === 'function' &&
      trimmed.parameters &&
      typeof trimmed.parameters === 'object'
    ) {
      trimmed.parameters = trimJsonSchema(trimmed.parameters as AnyItem);
    } else if (toolType === 'namespace' && Array.isArray(trimmed.tools)) {
      trimmed.tools = (trimmed.tools as unknown[]).map((nested) =>
        this.#trimToolSearchTool(nested),
      );
    }

    return trimmed;
  }
}

type TrimResult = {
  item: AnyItem;
  saved: number;
};

function trimJsonSchema(schema: AnyItem): AnyItem {
  const result: AnyItem = {};
  for (const [key, value] of Object.entries(schema)) {
    if (['description', 'title', '$comment', 'examples'].includes(key)) {
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = trimJsonSchema(value as AnyItem);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? trimJsonSchema(item as AnyItem)
          : item,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

function serializeJsonLike(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
