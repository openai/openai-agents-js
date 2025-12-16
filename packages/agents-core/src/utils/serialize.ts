import { JsonObjectSchema } from '../types';
import { Handoff } from '../handoff';
import { Tool } from '../tool';
import { AgentOutputType } from '../agent';
import { SerializedHandoff, SerializedTool } from '../model';
import { UserError } from '../errors';
import type { Computer } from '../computer';

function isComputerInstance(value: unknown): value is Computer {
  return (
    !!value &&
    typeof value === 'object' &&
    'environment' in (value as Record<string, unknown>) &&
    'dimensions' in (value as Record<string, unknown>)
  );
}

export function serializeTool(tool: Tool<any>): SerializedTool {
  if (tool.type === 'function') {
    return {
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as JsonObjectSchema<any>,
      strict: tool.strict,
    };
  }
  if (tool.type === 'computer') {
    // When a computer is created lazily via an initializer, serializeTool can be called before initialization (e.g., manual serialize without running the agent).
    if (!isComputerInstance(tool.computer)) {
      throw new UserError(
        'Computer tool is not initialized for serialization. Call resolveComputer({ tool, runContext }) first (for example, when building a model payload outside Runner.run).',
      );
    }
    return {
      type: 'computer',
      name: tool.name,
      environment: tool.computer.environment,
      dimensions: tool.computer.dimensions,
    };
  }
  if (tool.type === 'shell') {
    return {
      type: 'shell',
      name: tool.name,
    };
  }
  if (tool.type === 'apply_patch') {
    return {
      type: 'apply_patch',
      name: tool.name,
    };
  }
  return {
    type: 'hosted_tool',
    name: tool.name,
    providerData: tool.providerData,
  };
}

export function serializeHandoff<TContext, TOutput extends AgentOutputType>(
  h: Handoff<TContext, TOutput>,
): SerializedHandoff {
  return {
    toolName: h.toolName,
    toolDescription: h.toolDescription,
    inputJsonSchema: h.inputJsonSchema as JsonObjectSchema<any>,
    strictJsonSchema: h.strictJsonSchema,
  };
}
