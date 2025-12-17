import { DeepPartial } from '../types';
import {
  resetCurrentSpan,
  setCurrentSpan,
  withNewSpanContext,
} from './context';
import { CreateSpanOptions, getGlobalTraceProvider } from './provider';
import {
  Span,
  ResponseSpanData,
  SpanData,
  AgentSpanData,
  FunctionSpanData,
  HandoffSpanData,
  GenerationSpanData,
  CustomSpanData,
  GuardrailSpanData,
  TranscriptionSpanData,
  SpeechSpanData,
  SpeechGroupSpanData,
  MCPListToolsSpanData,
} from './spans';
import { Trace } from './traces';

type CreateArgs<TData extends SpanData> = DeepPartial<CreateSpanOptions<TData>>;

function _withSpanFactory<
  TData extends SpanData,
  TCreateSpanFunction extends (...args: any[]) => Span<TData>,
>(createSpan: TCreateSpanFunction) {
  return async <TOutput>(
    fn: (span: Span<TData>) => Promise<TOutput>,
    ...args: Parameters<TCreateSpanFunction>
  ) => {
    // Creating a new span context to make sure that the previous span is correctly reset
    return withNewSpanContext(async () => {
      const span = createSpan(...args);
      setCurrentSpan(span);
      try {
        span.start();
        return await fn(span);
      } catch (error: any) {
        span.setError({
          message: error.message,
          data: error.data,
        });
        throw error;
      } finally {
        span.end();
        resetCurrentSpan();
      }
    });
  };
}

/**
 * Create a new response span. The span will not be started automatically, you should either
 * use `withResponseSpan()` or call `span.start()` and `span.end()` manually.
 *
 * This span captures the details of a model response, primarily the response identifier.
 * If you need to capture detailed generation information such as input/output messages,
 * model configuration, or usage data, use `createGenerationSpan()` instead.
 *
 * @param options - Optional span creation options, including span data and identifiers.
 * @param parent - The parent span or trace. If not provided, the current trace/span will be used
 * automatically.
 *
 * @returns The newly created response span.
 */
export function createResponseSpan(
  options?: CreateArgs<ResponseSpanData>,
  parent?: Span<any> | Trace,
): Span<ResponseSpanData> {
  options = {};
  return getGlobalTraceProvider().createSpan(
    {
      ...options,
      data: {
        type: 'response',
        ...options.data,
      },
    },
    parent,
  );
}

/**
 * Create a new response span and automatically start and end it.
 *
 * This span captures the details of a model response, primarily the response identifier.
 * If you need to capture detailed generation information such as input/output messages,
 * model configuration, or usage data, use `generationSpan()` instead.
 */
export const withResponseSpan = _withSpanFactory<
  ResponseSpanData,
  typeof createResponseSpan
>(createResponseSpan);

/**
 * Create a new agent span. The span will not be started automatically, you should either
 * use `withAgentSpan()` or call `span.start()` and `span.end()` manually.
 *
 * @param options - Optional span creation options, including span data and identifiers.
 * @param parent - The parent span or trace. If not provided, the current trace/span will be used
 * automatically.
 *
 * @returns The newly created agent span.
 */
export function createAgentSpan(
  options?: CreateArgs<AgentSpanData>,
  parent?: Span<any> | Trace,
): Span<AgentSpanData> {
  return getGlobalTraceProvider().createSpan(
    {
      ...options,
      data: {
        type: 'agent',
        name: options?.data?.name ?? 'Agent',
        ...options?.data,
      },
    },
    parent,
  );
}

/**
 * Create a new agent span and automatically start and end it.
 */
export const withAgentSpan = _withSpanFactory<
  AgentSpanData,
  typeof createAgentSpan
>(createAgentSpan);

/**
 * Create a new function span. The span will not be started automatically, you should either
 * use `withFunctionSpan()` or call `span.start()` and `span.end()` manually.
 *
 * @param options - Optional span creation options, including span data and identifiers.
 * @param parent - The parent span or trace. If not provided, the current trace/span will be used
 * automatically.
 *
 * @returns The newly created function span.
 */
export function createFunctionSpan(
  options: CreateArgs<FunctionSpanData> & { data: { name: string } },
  parent?: Span<any> | Trace,
): Span<FunctionSpanData> {
  return getGlobalTraceProvider().createSpan(
    {
      ...options,
      data: {
        type: 'function',
        input: options?.data?.input ?? '',
        output: options?.data?.output ?? '',
        ...options?.data,
      },
    },
    parent,
  );
}

/**
 * Create a new function span and automatically start and end it.
 */
export const withFunctionSpan = _withSpanFactory<
  FunctionSpanData,
  typeof createFunctionSpan
>(createFunctionSpan);

/**
 * Create a new handoff span. The span will not be started automatically, you should either
 * use `withHandoffSpan()` or call `span.start()` and `span.end()` manually.
 *
 * @param options - Optional span creation options, including span data and identifiers.
 * @param parent - The parent span or trace. If not provided, the current trace/span will be used
 * automatically.
 *
 * @returns The newly created handoff span.
 */
export function createHandoffSpan(
  options?: CreateArgs<HandoffSpanData>,
  parent?: Span<any> | Trace,
): Span<HandoffSpanData> {
  return getGlobalTraceProvider().createSpan(
    {
      ...options,
      data: { type: 'handoff', ...options?.data },
    },
    parent,
  );
}

/**
 * Create a new handoff span and automatically start and end it.
 */
export const withHandoffSpan = _withSpanFactory<
  HandoffSpanData,
  typeof createHandoffSpan
>(createHandoffSpan);

/**
 * Create a new generation span. The span will not be started automatically, you should either
 * use `withGenerationSpan()` or call `span.start()` and `span.end()` manually.
 *
 * This span captures the details of a model generation, including input/output message
 * sequences, model information, and usage data. If you only need to capture a model response
 * identifier, consider using `createResponseSpan()` instead.
 */
export function createGenerationSpan(
  options?: CreateArgs<GenerationSpanData>,
  parent?: Span<any> | Trace,
): Span<GenerationSpanData> {
  return getGlobalTraceProvider().createSpan(
    {
      ...options,
      data: {
        type: 'generation',
        ...options?.data,
      },
    },
    parent,
  );
}

/** Automatically create a generation span, run fn and close the span */
export const withGenerationSpan = _withSpanFactory<
  GenerationSpanData,
  typeof createGenerationSpan
>(createGenerationSpan);

/**
 * Create a new custom span. The span will not be started automatically, you should either use
 * `withCustomSpan()` or call `span.start()` and `span.end()` manually.
 */
export function createCustomSpan(
  options: CreateArgs<CustomSpanData> & { data: { name: string } },
  parent?: Span<any> | Trace,
): Span<CustomSpanData> {
  return getGlobalTraceProvider().createSpan(
    {
      ...options,
      data: {
        type: 'custom',
        data: {},
        ...options?.data,
      },
    },
    parent,
  );
}

export const withCustomSpan = _withSpanFactory<
  CustomSpanData,
  typeof createCustomSpan
>(createCustomSpan);

/**
 * Create a new guardrail span. The span will not be started automatically, you should either use
 * `withGuardrailSpan()` or call `span.start()` and `span.end()` manually.
 */
export function createGuardrailSpan(
  options: CreateArgs<GuardrailSpanData> & { data: { name: string } },
  parent?: Span<any> | Trace,
): Span<GuardrailSpanData> {
  return getGlobalTraceProvider().createSpan(
    {
      ...options,
      data: {
        type: 'guardrail',
        triggered: false,
        ...options?.data,
      },
    },
    parent,
  );
}

export const withGuardrailSpan = _withSpanFactory<
  GuardrailSpanData,
  typeof createGuardrailSpan
>(createGuardrailSpan);

/**
 * Create a new transcription span. The span will not be started automatically.
 */
export function createTranscriptionSpan(
  options: CreateArgs<TranscriptionSpanData> & {
    data: { input: { data: string; format: 'pcm' | (string & {}) } };
  },
  parent?: Span<any> | Trace,
): Span<TranscriptionSpanData> {
  return getGlobalTraceProvider().createSpan(
    {
      ...options,
      data: {
        type: 'transcription',
        ...options.data,
      },
    },
    parent,
  );
}

export const withTranscriptionSpan = _withSpanFactory<
  TranscriptionSpanData,
  typeof createTranscriptionSpan
>(createTranscriptionSpan);

/**
 * Create a new speech span. The span will not be started automatically.
 */
export function createSpeechSpan(
  options: CreateArgs<SpeechSpanData> & {
    data: { output: { data: string; format: 'pcm' | (string & {}) } };
  },
  parent?: Span<any> | Trace,
): Span<SpeechSpanData> {
  return getGlobalTraceProvider().createSpan(
    {
      ...options,
      data: {
        type: 'speech',
        ...options.data,
      },
    },
    parent,
  );
}

export const withSpeechSpan = _withSpanFactory<
  SpeechSpanData,
  typeof createSpeechSpan
>(createSpeechSpan);

/**
 * Create a new speech group span. The span will not be started automatically.
 */
export function createSpeechGroupSpan(
  options?: CreateArgs<SpeechGroupSpanData>,
  parent?: Span<any> | Trace,
): Span<SpeechGroupSpanData> {
  return getGlobalTraceProvider().createSpan(
    {
      ...options,
      data: {
        type: 'speech_group',
        ...options?.data,
      },
    },
    parent,
  );
}

export const withSpeechGroupSpan = _withSpanFactory<
  SpeechGroupSpanData,
  typeof createSpeechGroupSpan
>(createSpeechGroupSpan);

/**
 * Create a new MCP list tools span. The span will not be started automatically.
 */
export function createMCPListToolsSpan(
  options?: CreateArgs<MCPListToolsSpanData>,
  parent?: Span<any> | Trace,
): Span<MCPListToolsSpanData> {
  return getGlobalTraceProvider().createSpan(
    {
      ...options,
      data: {
        type: 'mcp_tools',
        ...options?.data,
      },
    },
    parent,
  );
}

export const withMCPListToolsSpan = _withSpanFactory<
  MCPListToolsSpanData,
  typeof createMCPListToolsSpan
>(createMCPListToolsSpan);
