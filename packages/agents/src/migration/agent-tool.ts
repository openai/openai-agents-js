import {
  RunContext,
  type Agent,
  type AgentToolInvocation,
  type FunctionTool,
  type RunConfig,
} from '@openai/agents-core';
import type { AgentInputItem } from '@openai/agents-core/types';
import type { MigrationRunOptions } from './index';
import { validateSettings } from './model';

type ToolCall = NonNullable<
  NonNullable<Parameters<FunctionTool['invoke']>[2]>['toolCall']
>;

export interface AgentToolExecution<Context> {
  readonly runContext: RunContext<Context>;
  readonly agentToolInvocation: AgentToolInvocation;
}

export interface PreparedAgentToolRun<Context> {
  readonly agent: Agent<Context, 'text'>;
  readonly input: string | readonly AgentInputItem[];
  readonly options: MigrationRunOptions<Context>;
  readonly execution: AgentToolExecution<Context>;
}

function reject(message: string): never {
  throw new TypeError(`Migration agent tool ${message}`);
}

/** Map the public callable's resolved inputs; capture still owns native admission. */
export function prepareAgentToolRun<Context>(
  source: Agent<Context, 'text'>,
  toolCall: ToolCall,
  config: Partial<RunConfig>,
  actualAgent: unknown,
  input: unknown,
  options: unknown,
): PreparedAgentToolRun<Context> {
  if (actualAgent !== source) reject('requires its registered source Agent');
  if (typeof input !== 'string' && !Array.isArray(input))
    reject('requires fresh text or SDK user input');
  if (!options || typeof options !== 'object' || Array.isArray(options))
    reject('requires resolved run options');
  for (const key of Object.keys(options)) {
    if (!['context', 'signal', 'stream'].includes(key))
      reject(`does not support run option ${key}`);
  }
  if (!('context' in options) || !(options.context instanceof RunContext))
    reject('requires a resolved RunContext');
  const signal = 'signal' in options ? options.signal : undefined;
  if (signal !== undefined && !(signal instanceof AbortSignal))
    reject('requires an AbortSignal');
  if (
    'stream' in options &&
    options.stream !== undefined &&
    options.stream !== false
  )
    reject('does not support live streaming');
  if (!config || typeof config !== 'object' || Array.isArray(config))
    reject('requires nested run configuration');
  for (const key of Object.keys(config)) {
    if (
      ![
        'model',
        'modelProvider',
        'modelSettings',
        'inputGuardrails',
        'outputGuardrails',
      ].includes(key)
    )
      reject(`does not support run configuration ${key}`);
  }
  if (config.modelSettings !== undefined) {
    if (
      !config.modelSettings ||
      typeof config.modelSettings !== 'object' ||
      Array.isArray(config.modelSettings)
    )
      reject('requires model settings');
    validateSettings(config.modelSettings);
  }
  const runContext: RunContext<Context> = options.context;
  return {
    agent: source,
    // capture validates and snapshots the supported fresh-user-message shape.
    input,
    options: {
      context: runContext.context,
      ...(signal !== undefined ? { signal } : {}),
      ...(config.model !== undefined ? { model: config.model } : {}),
      ...(config.modelProvider !== undefined
        ? { modelProvider: config.modelProvider }
        : {}),
      ...(config.modelSettings !== undefined
        ? {
            // validateSettings admitted the migration settings subset above.
            modelSettings:
              config.modelSettings as MigrationRunOptions<Context>['modelSettings'],
          }
        : {}),
      ...(config.inputGuardrails !== undefined
        ? { inputGuardrails: config.inputGuardrails }
        : {}),
      ...(config.outputGuardrails !== undefined
        ? {
            // capture checks these against the actual text source Agent.
            outputGuardrails:
              config.outputGuardrails as MigrationRunOptions<Context>['outputGuardrails'],
          }
        : {}),
    },
    execution: {
      runContext,
      agentToolInvocation: Object.freeze({
        toolName: toolCall.name,
        toolCallId: toolCall.callId,
        toolArguments: toolCall.arguments,
      }),
    },
  };
}
