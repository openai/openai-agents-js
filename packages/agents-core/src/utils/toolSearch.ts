export {
  getToolSearchProviderCallId,
  getToolSearchMatchKey,
  getToolSearchOutputReplacementKey,
  getToolSearchExecution,
  isClientToolSearchCall,
  resolveToolSearchCallId,
  shouldQueuePendingToolSearchCall,
  takePendingToolSearchCallId,
} from '../tooling';

type OpenAIToolSearchOutputToolPayload = Record<string, any>;

/**
 * Tool search outputs are replayed through agents-core protocol items, which use camelCase
 * field names, while the Responses API wire shape uses snake_case. Keep this codec even with
 * first-class upstream types because the local protocol still normalizes these payloads.
 */
export function toOpenAIToolSearchOutputToolPayload(
  tool: OpenAIToolSearchOutputToolPayload,
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
        toOpenAIToolSearchOutputToolPayload(entry),
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

export function fromOpenAIToolSearchOutputToolPayload(
  tool: Record<string, any>,
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
        fromOpenAIToolSearchOutputToolPayload(entry),
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
