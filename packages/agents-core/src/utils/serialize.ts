import { JsonObjectSchema } from '../types';
import { Handoff } from '../handoff';
import { Tool } from '../tool';
import { AgentOutputType } from '../agent';
import { SerializedHandoff, SerializedTool } from '../model';

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
    return {
      type: 'computer',
      name: tool.name,
      environment: tool.computer.environment,
      dimensions: tool.computer.dimensions,
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
