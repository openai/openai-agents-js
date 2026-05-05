import { Usage } from './usage';
import { StreamEvent } from './types/protocol';
import {
  HostedTool,
  ComputerTool,
  FunctionTool,
  ShellTool,
  ApplyPatchTool,
} from './tool';
import { Computer } from './computer';
import { Handoff } from './handoff';
import {
  AgentInputItem,
  AgentOutputItem,
  JsonSchemaDefinition,
  TextOutput,
  InputText,
  InputImage,
  InputFile,
} from './types';

export type ModelSettingsToolChoice =
  | 'auto'
  | 'required'
  | 'none'
  | (string & {});

/**
 * Constrains effort on reasoning for [reasoning models](https://platform.openai.com/docs/guides/reasoning).
 * Currently supported values are `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`.
 * Reducing reasoning effort can result in faster responses and fewer tokens used on reasoning in a response.
 */
export type ModelSettingsReasoningEffort =
  | 'none' // for gpt-5.1 and newer
  | 'minimal' // for gpt-5
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | null;

/**
 * Configuration options for [reasoning models](https://platform.openai.com/docs/guides/reasoning).
 */
export type ModelSettingsReasoning = {
  /**
   * Constrains effort on reasoning for [reasoning models](https://platform.openai.com/docs/guides/reasoning).
   * Currently supported values are `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`.
   * Reducing reasoning effort can result in faster responses and fewer tokens used on reasoning in a response.
   */
  effort?: ModelSettingsReasoningEffort | null;

  /**
   * A summary of the reasoning performed by the model.
   * This can be useful for debugging and understanding the model's reasoning process.
   * One of `auto`, `concise`, or `detailed`.
   */
  summary?: 'auto' | 'concise' | 'detailed' | null;
};

export interface ModelSettingsText {
  /**
   * Constrains the verbosity of the model's response.
   * Lower values will result in more concise responses, while higher values will result in more verbose responses.
   * Currently supported values are `low`, `medium`, and `high`.
   */
  verbosity?: 'low' | 'medium' | 'high' | null;
}

export type ModelSettingsContextManagement = Array<{
  /**
   * The context-management strategy to apply.
   */
  type: 'compaction' | (string & {});

  /**
   * Rendered-token threshold that triggers server-side compaction.
   */
  compactThreshold?: number;

  /**
   * Rendered-token threshold that triggers server-side compaction.
   */
  compact_threshold?: number;

  [key: string]: unknown;
}>;

export type RetryDecision =
  | boolean
  | {
      /**
       * Whether the failed request should be retried.
       */
      retry: boolean;

      /**
       * Optional delay override in milliseconds before the next retry attempt.
       */
      delayMs?: number;

      /**
       * Optional explanation for logging or debugging.
       */
      reason?: string;
    };

export type ModelRetryNormalizedError = {
  /**
   * HTTP status code when the provider exposes one.
   */
  statusCode?: number;

  /**
   * Suggested delay in milliseconds derived from retry-after style headers.
   */
  retryAfterMs?: number;

  /**
   * Provider or transport-specific error code when exposed.
   */
  errorCode?: string;

  /**
   * Whether the error appears to come from a transient transport or connectivity problem.
   */
  isNetworkError: boolean;

  /**
   * Whether the error was caused by an abort signal or abort exception.
   */
  isAbort: boolean;
};

export type ModelRetryAdvice = {
  /**
   * Optional provider recommendation for whether this error is retryable.
   * The runner still applies safety vetoes first and user policy remains the final authority.
   */
  suggested?: boolean;

  /**
   * Optional delay hint in milliseconds from the provider or transport layer.
   */
  retryAfterMs?: number;

  /**
   * Optional explanation for why the provider suggested or vetoed a retry.
   */
  reason?: string;

  /**
   * Provider confidence about whether replaying the request is safe.
   * Omit this field when replay safety is unknown.
   */
  replaySafety?: 'unsafe' | 'safe';

  /**
   * Provider-supplied normalized facts that should override generic extraction when present.
   */
  normalized?: Partial<ModelRetryNormalizedError>;
};

export type RetryPolicyContext = {
  /**
   * The error thrown by the failed model attempt.
   */
  error: unknown;

  /**
   * The 1-based number of the failed attempt.
   */
  attempt: number;

  /**
   * The configured number of retries allowed after the initial attempt.
   */
  maxRetries: number;

  /**
   * Whether the failed request was streaming.
   */
  stream: boolean;

  /**
   * Optional provider guidance for the failure.
   */
  providerAdvice?: ModelRetryAdvice;

  /**
   * Generic normalized facts extracted from the error and provider advice.
   */
  normalized: ModelRetryNormalizedError;
};

export type RetryPolicy = (
  context: RetryPolicyContext,
) => RetryDecision | Promise<RetryDecision>;

export type ModelRetryBackoffSettings = {
  /**
   * Delay for the first retry in milliseconds.
   */
  initialDelayMs?: number;

  /**
   * Maximum delay between retries in milliseconds.
   */
  maxDelayMs?: number;

  /**
   * Multiplier applied after each retry attempt.
   */
  multiplier?: number;

  /**
   * Whether to apply jitter to the computed backoff delay.
   */
  jitter?: boolean;
};

export type ModelRetrySettings = {
  /**
   * Number of retries allowed after the initial model request.
   * Retries remain opt-in; no retries occur unless `policy` returns `true`.
   */
  maxRetries?: number;

  /**
   * Backoff configuration used when the retry policy requests a retry without returning an explicit delay.
   */
  backoff?: ModelRetryBackoffSettings;

  /**
   * Runtime-only retry policy. This callback is not serialized into persisted run state.
   */
  policy?: RetryPolicy;
};

/**
 * Settings to use when calling an LLM.
 *
 * This class holds optional model configuration parameters (e.g. temperature,
 * topP, penalties, truncation, etc.).
 *
 * Not all models/providers support all of these parameters, so please check the API documentation
 * for the specific model and provider you are using.
 */
export type ModelSettings = {
  /**
   * The temperature to use when calling the model.
   */
  temperature?: number;

  /**
   * The topP to use when calling the model.
   */
  topP?: number;

  /**
   * The frequency penalty to use when calling the model.
   */
  frequencyPenalty?: number;

  /**
   * The presence penalty to use when calling the model.
   */
  presencePenalty?: number;

  /**
   * The tool choice to use when calling the model.
   */
  toolChoice?: ModelSettingsToolChoice;

  /**
   * Whether to use parallel tool calls when calling the model.
   * Defaults to false if not provided.
   */
  parallelToolCalls?: boolean;

  /**
   * The truncation strategy to use when calling the model.
   */
  truncation?: 'auto' | 'disabled';

  /**
   * The maximum number of output tokens to generate.
   */
  maxTokens?: number;

  /**
   * Whether to store the generated model response for later retrieval.
   * Defaults to true if not provided.
   */
  store?: boolean;

  /**
   * Enables prompt caching and controls how long cached content should be retained by the model provider.
   * See https://platform.openai.com/docs/guides/prompt-caching#prompt-cache-retention for the available options.
   */
  promptCacheRetention?: 'in-memory' | '24h' | null;

  /**
   * Context-management strategies to apply when calling the model.
   * This setting is available on OpenAI Responses requests, including server-side compaction.
   * See https://developers.openai.com/api/docs/guides/compaction.
   */
  contextManagement?: ModelSettingsContextManagement;

  /**
   * The reasoning settings to use when calling the model.
   */
  reasoning?: ModelSettingsReasoning;

  /**
   * The text settings to use when calling the model.
   */
  text?: ModelSettingsText;

  /**
   * Additional provider specific settings to be passed directly to the model
   * request.
   */
  providerData?: Record<string, any>;

  /**
   * Runtime-only retry configuration for the model request.
   */
  retry?: ModelRetrySettings;
};

export type ModelTracing = boolean | 'enabled_without_data';

export type SerializedFunctionTool = {
  /**
   * The type of the tool.
   */
  type: FunctionTool['type'];

  /**
   * The name of the tool.
   */
  name: FunctionTool['name'];

  /**
   * The description of the tool that helps the model to understand when to use the tool
   */
  description: FunctionTool['description'];

  /**
   * A JSON schema describing the parameters of the tool.
   */
  parameters: FunctionTool['parameters'];

  /**
   * Whether the tool is strict. If true, the model must try to strictly follow the schema
   * (might result in slower response times).
   */
  strict: FunctionTool['strict'];

  /**
   * Responses API only. Whether a top-level function tool stays hidden until tool search loads it.
   */
  deferLoading?: FunctionTool['deferLoading'];

  /**
   * Responses API only. Explicit namespace used to group related function tools.
   */
  namespace?: string;

  /**
   * Responses API only. Description shared by all tools in the namespace. Required when namespace is set.
   */
  namespaceDescription?: string;
};

export type SerializedComputerTool = {
  type: ComputerTool['type'];
  name: ComputerTool['name'];
  environment?: Computer['environment'];
  dimensions?: Computer['dimensions'];
};

export type SerializedShellTool = {
  type: ShellTool['type'];
  name: ShellTool['name'];
  environment?: ShellTool['environment'];
};

export type SerializedApplyPatchTool = {
  type: ApplyPatchTool['type'];
  name: ApplyPatchTool['name'];
};

export type SerializedHostedTool = {
  type: HostedTool['type'];
  name: HostedTool['name'];
  providerData?: HostedTool['providerData'];
};

export type SerializedTool =
  | SerializedFunctionTool
  | SerializedComputerTool
  | SerializedShellTool
  | SerializedApplyPatchTool
  | SerializedHostedTool;

export type SerializedHandoff = {
  /**
   * The name of the tool that represents the handoff.
   */
  toolName: Handoff['toolName'];

  /**
   * The tool description for the handoff
   */
  toolDescription: Handoff['toolDescription'];

  /**
   * The JSON schema for the handoff input. Can be empty if the handoff does not take an input
   */
  inputJsonSchema: Handoff['inputJsonSchema'];

  /**
   * Whether the input JSON schema is in strict mode. We strongly recommend setting this to true,
   * as it increases the likelihood of correct JSON input.
   */
  strictJsonSchema: Handoff['strictJsonSchema'];
};

/**
 * The output type passed to the model. Has any Zod types serialized to JSON Schema
 */
export type SerializedOutputType = JsonSchemaDefinition | TextOutput;

/**
 * A request to a large language model.
 */
export type ModelRequest = {
  /**
   * The system instructions to use for the model.
   */
  systemInstructions?: string;

  /**
   * The input to the model.
   */
  input: string | AgentInputItem[];

  /**
   * The ID of the previous response to use for the model.
   */
  previousResponseId?: string;

  /**
   * The ID of stored conversation to use for the model.
   *
   * see https://platform.openai.com/docs/guides/conversation-state?api-mode=responses#openai-apis-for-conversation-state
   * see https://platform.openai.com/docs/api-reference/conversations/create
   */
  conversationId?: string;

  /**
   * The model settings to use for the model.
   */
  modelSettings: ModelSettings;

  /**
   * The tools to use for the model.
   */
  tools: SerializedTool[];

  /**
   * When true, the caller explicitly configured the tools list (even if empty).
   * Providers can use this to avoid overwriting prompt-defined tools when an agent
   * does not specify its own tools.
   */
  toolsExplicitlyProvided?: boolean;

  /**
   * The type of the output to use for the model.
   */
  outputType: SerializedOutputType;

  /**
   * The handoffs to use for the model.
   */
  handoffs: SerializedHandoff[];

  /**
   * Whether to enable tracing for the model.
   */
  tracing: ModelTracing;

  /**
   * An optional signal to abort the model request.
   */
  signal?: AbortSignal;

  /**
   * The prompt template to use for the model, if any.
   */
  prompt?: Prompt;

  /**
   * When true, the resolved model should override the model configured in the prompt template.
   * Providers that support prompt templates should include the explicit model name in the request
   * even when a prompt is supplied.
   */
  overridePromptModel?: boolean;

  /**
   * @internal
   */
  _internal?: {
    runnerManagedRetry?: boolean;
  };
};

export type ModelRetryAdviceRequest = {
  /**
   * The failed request that is being evaluated for replay.
   */
  request: ModelRequest;

  /**
   * The error thrown by the failed attempt.
   */
  error: unknown;

  /**
   * Whether the failed request used streaming.
   */
  stream: boolean;

  /**
   * The 1-based number of the failed attempt.
   */
  attempt: number;
};

export type ModelResponse = {
  /**
   * The usage information for response.
   */
  usage: Usage;

  /**
   * A list of outputs (messages, tool calls, etc.) generated by the model.
   */
  output: AgentOutputItem[];

  /**
   * An ID for the response which can be used to refer to the response in subsequent calls to the
   * model. Not supported by all model providers.
   */
  responseId?: string;

  /**
   * The transport request ID for this model call, if provided by the model SDK or transport.
   */
  requestId?: string;

  /**
   * Raw response data from the underlying model provider.
   */
  providerData?: Record<string, any>;
};

/**
 * The base interface for calling an LLM.
 */
export interface Model {
  /**
   * Get a response from the model.
   *
   * @param request - The request to get a response for.
   */
  getResponse(request: ModelRequest): Promise<ModelResponse>;

  /**
   * Get a streamed response from the model.
   *
   */
  getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent>;

  /**
   * Provide optional retry advice for a failed request.
   */
  getRetryAdvice?(
    args: ModelRetryAdviceRequest,
  ): Promise<ModelRetryAdvice | undefined> | ModelRetryAdvice | undefined;
}

/**
 * The base interface for a model provider.
 *
 * The model provider is responsible for looking up `Model` instances by name.
 */
export interface ModelProvider {
  /**
   * Get a model by name
   *
   * @param modelName - The name of the model to get.
   */
  getModel(modelName?: string): Promise<Model> | Model;
}

/**
 * Reference to a prompt template and its variables.
 */
export type Prompt = {
  /**
   * The unique identifier of the prompt template to use.
   */
  promptId: string;
  /**
   * Optional version of the prompt template.
   */
  version?: string;
  /**
   * Optional variables to substitute into the prompt template.
   * Can be a string, or an object with string keys and values that are string,
   * InputText, InputImage, or InputFile.
   */
  variables?: {
    [key: string]: string | InputText | InputImage | InputFile;
  };
};
