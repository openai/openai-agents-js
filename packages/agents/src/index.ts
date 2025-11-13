import { setDefaultModelProvider } from '@openai/agents-core';
import { OpenAIProvider } from '@openai/agents-openai';
import { setDefaultOpenAITracingExporter } from '@openai/agents-openai';

setDefaultModelProvider(new OpenAIProvider());
setDefaultOpenAITracingExporter();

export * from '@openai/agents-core';
export * from '@openai/agents-openai';
export { applyPatchTool, shellTool } from '@openai/agents-core';
export type {
  Shell,
  ShellAction,
  ShellResult,
  ShellOutputResult,
  ApplyPatchOperation,
  ApplyPatchResult,
  Editor,
  ShellTool,
  ApplyPatchTool,
} from '@openai/agents-core';
export * as realtime from '@openai/agents-realtime';
