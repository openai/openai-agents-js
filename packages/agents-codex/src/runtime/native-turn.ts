import type { JsonObject, JsonValue } from './binding';
import type { NativeEvent } from './events';
import type { GuardrailRecord } from './guardrails';
import type { UserInput } from './input';
import {
  addModelReportedUsage,
  attachModelUsageSource,
  type ModelAttemptState,
} from './model-attempts';
import type { NativeError } from './native-error';
import type { RequestAttempts } from './request-attempts';
import type { TokenCount, TokenUsage } from './run-events';
import type { AcceptedSubmission, OperationSelection } from './session';
import type { TraceContext } from './trace-context';
import type { TraceCapture } from './tracing-context';

export interface NativeRunResult {
  finalOutput: string;
  turnId: string;
  usage: JsonValue | null;
}

/** @internal */
export class NativeTurn {
  captureRequestAttempts = false;
  requestAttemptsStarted = false;
  borrowedRequestAttempts = false;
  requestAttempts?: RequestAttempts;
  submissionRequestAttempts?: RequestAttempts;
  requestAttemptParent?: NativeTurn;
  clientSearchCatalogKeys?: Set<string>;
  readonly guardrailResults: GuardrailRecord[] = [];
  guardrailInput?: UserInput;
  stagedCheckpoint?: import('./state').ManualSessionState;
  inputGuardrailsStarted = false;
  inputGuardrailsPassed?: boolean;
  inputGuardrailsTask?: Promise<void>;
  parentTrace?: TraceContext;
  readonly accepted = Promise.withResolvers<AcceptedSubmission>();
  readonly completion = Promise.withResolvers<NativeRunResult>();
  readonly controller = new AbortController();
  mcpPublication?: Promise<void>;
  readonly pending: NativeEvent[] = [];
  readonly manualReplies = new Set<Promise<void>>();
  readonly callbacks = new Set<Promise<void>>();
  readonly toolInvocations = new Set<Promise<void>>();
  readonly toolCallIds = new Set<string>();
  readonly toolCleanupErrors: unknown[] = [];
  readonly executing = new Set<string>();
  tracing?: TraceCapture;
  // Keep workflow ownership when a retained successor takes completion tracing.
  issuedTracing?: TraceCapture;
  selection?: OperationSelection;
  writableRoots?: readonly string[];
  preparation?: AbortController;
  id: string | null = null;
  usage: JsonValue | null = null;
  modelAttempts?: ModelAttemptState;
  tokenUsage: TokenUsage | null = null;
  requests: TokenCount = 0;
  missingUsageRequests: TokenCount = 0;
  addUsage(
    raw: JsonObject,
    requests: TokenCount = 1,
    missing: TokenCount = 0,
  ): void {
    addModelReportedUsage(this, raw, requests, missing);
  }
  failure: unknown;
  nativeFailure?: NativeError;
  constructor(
    private readonly beforeWait: () => void,
    private readonly observeCompletion: (
      completion: Promise<NativeRunResult>,
    ) => Promise<NativeRunResult>,
    usageParent?: NativeTurn,
  ) {
    if (usageParent) attachModelUsageSource(usageParent, this);
    this.requestAttemptParent = usageParent;
    this.accepted.promise.catch(() => {});
    this.completion.promise.catch(() => {});
  }
  wait(): Promise<NativeRunResult> {
    this.beforeWait();
    return this.observeCompletion(this.completion.promise);
  }
}
