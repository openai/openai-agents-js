import type {
  Agent as ClassicAgent,
  AgentOutputType,
  Model,
  ModelProvider,
  ModelResponse,
  ModelSettings,
  Session,
  SessionInputCallback,
  InputGuardrail,
  InputGuardrailResult,
  OutputGuardrail,
  OutputGuardrailResult,
  OutputGuardrailMetadata,
  RunHooks,
  RunContext,
  RunToolApprovalItem,
  RunRawModelStreamEvent,
  ToolInputGuardrailResult,
  ToolOutputGuardrailResult,
} from '@openai/agents-core';
import type { TokenUsageInfo } from '../runtime/run-events';
import type { ResolvedAgentOutput } from '@openai/agents-core/types';
import type { AgentInputItem } from '@openai/agents-core/types';
import { run, stream } from './run';
import type { ReadableStream } from 'node:stream/web';
import type { MigrationItem, MigrationSemanticEvent } from './result';
import type { MigrationPausedRun } from './approvals';
export type { MigrationPausedRun } from './approvals';
export { MigrationCleanupError } from './run';

export type MigrationModelSettings = Pick<
  ModelSettings,
  | 'timeoutMs'
  | 'retry'
  | 'temperature'
  | 'topP'
  | 'frequencyPenalty'
  | 'presencePenalty'
  | 'maxTokens'
  | 'store'
  | 'toolChoice'
>;

export interface MigrationRunOptions<
  Context,
  Output extends AgentOutputType = 'text',
> {
  context: Context;
  session?: Session;
  sessionInputCallback?: SessionInputCallback;
  signal?: AbortSignal;
  model?: string | Model;
  modelProvider?: ModelProvider;
  modelSettings?: MigrationModelSettings;
  inputGuardrails?: readonly InputGuardrail[];
  outputGuardrails?: readonly OutputGuardrail<Output, Context>[];
  /** Receives synchronous lifecycle notifications; Runner configuration is not applied. */
  hooks?: RunHooks<Context, Output>;
  /** Selects the Model method; stream invocation buffers through EOF and cleanup. */
  modelInvocation?: 'response' | 'stream';
}

/** Opt in to one in-process held function; dynamic predicates remain unsupported. */
export interface MigrationApprovalOptions<
  Context,
  Output extends AgentOutputType = 'text',
> extends MigrationRunOptions<Context, Output> {
  approvals: 'manual';
}

export interface MigrationRunResult<
  Context = any,
  Output extends AgentOutputType = 'text',
> {
  readonly input: string | AgentInputItem[];
  readonly newItems: MigrationItem[];
  readonly rawResponses: ModelResponse[];
  readonly lastResponseId: string | undefined;
  readonly lastAgent: ClassicAgent<Context, Output>;
  readonly runContext: RunContext<Context>;
  /** Empty on completed results; held calls use the live MigrationPausedRun carrier. */
  readonly interruptions: RunToolApprovalItem[];
  readonly history: AgentInputItem[];
  readonly output: AgentInputItem[];
  toInputList(): AgentInputItem[];
  /** Buffered accepted semantic events, not live Model streaming. */
  toStream(): ReadableStream<MigrationSemanticEvent>;
  [Symbol.asyncIterator](): AsyncGenerator<MigrationSemanticEvent>;
  readonly completed: Promise<void>;
  toTextStream(): never;
  readonly finalOutput: ResolvedAgentOutput<Output>;
  readonly modelResponses: readonly ModelResponse[];
  readonly inputGuardrailResults: readonly InputGuardrailResult[];
  readonly outputGuardrailResults: readonly OutputGuardrailResult<
    OutputGuardrailMetadata,
    Output
  >[];
  readonly toolInputGuardrailResults: readonly ToolInputGuardrailResult[];
  readonly toolOutputGuardrailResults: readonly ToolOutputGuardrailResult[];
  readonly native: Readonly<{
    sessionId: string;
    turnId: string;
    usage: TokenUsageInfo | null;
    /** Actual native terminal facts when an explicit adapter policy finishes the result. */
    outcome?: Readonly<{
      type: 'task_complete' | 'turn_complete' | 'turn_aborted';
      reason: string | null;
    }>;
  }>;
}

/** Experimental adapter for the supported classic Agent subset. */
export const SDKRunner: {
  run<Context, Output extends AgentOutputType = 'text'>(
    agent: ClassicAgent<Context, Output>,
    input: string | readonly AgentInputItem[],
    options: MigrationApprovalOptions<Context, Output>,
  ): Promise<
    MigrationRunResult<Context, Output> | MigrationPausedRun<Context, Output>
  >;
  run<Context, Output extends AgentOutputType = 'text'>(
    agent: ClassicAgent<Context, Output>,
    /**
     * Fresh text or supported completed SDK messages and function-call/result pairs.
     * Images require inline base64 data URLs and default detail.
     */
    input: string | readonly AgentInputItem[],
    options: MigrationRunOptions<Context, Output>,
  ): Promise<MigrationRunResult<Context, Output>>;
  /**
   * Live unvalidated Model events; accepted semantics wait for guarded completion.
   * Raw delivery retains at most 4 MiB of JSON and fails rather than dropping.
   * Cancel through the caller signal or a reader; completed joins physical work.
   */
  stream<Context>(
    agent: ClassicAgent<Context, 'text'>,
    input: string | readonly AgentInputItem[],
    options: MigrationRunOptions<Context>,
  ): Promise<{
    /** Actual Model events, including tentative content before final guards. */
    readonly unvalidatedRaw: ReadableStream<RunRawModelStreamEvent>;
    /** The actual guarded native result or error, after physical callback joins. */
    readonly completed: Promise<MigrationRunResult<Context>>;
    /** Supported accepted SDK semantic events, buffered until completed. */
    toStream(): ReadableStream<MigrationSemanticEvent>;
    [Symbol.asyncIterator](): AsyncIterator<MigrationSemanticEvent>;
  }>;
} = Object.freeze({ run, stream });
