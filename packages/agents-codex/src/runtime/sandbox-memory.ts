import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { Agent, type AgentOutput } from './public-agent';
import { NativeError } from './native-error';
import type { CanonicalHistorySnapshot } from './history';
import type {
  MemoryLayoutConfig,
  MemoryStore,
  SandboxSessionLike,
} from '@openai/agents-core/sandbox';
import type * as SandboxRuntime from '@openai/agents-core/sandbox/internal';

type Runtime = typeof SandboxRuntime;
type PhaseAgent = Pick<Agent<undefined, unknown>, 'withOutputType'>;

/** Explicit native generation configuration; phase Agents retain their own authority. */
export interface SandboxMemoryOptions {
  /** Native extraction Agent; the SDK supplies the structured artifact schema. */
  phaseOne: PhaseAgent;
  /** Native consolidation Agent; the SDK supplies summary and memory output fields. */
  phaseTwo: PhaseAgent;
  layout?: MemoryLayoutConfig;
  store?: MemoryStore;
  /** Bounded recent selection for consolidation; default 16, maximum 256. */
  maxRawMemories?: number;
}

const text = z.string().max(65_536);
const consolidatedMemory = z.object({
  summary: text.min(1),
  memory: text.min(1),
});
const MAX_INPUT_BYTES = 1_000_000;

/** @internal Terminal data from the current Session's settled source turn. */
export interface SandboxMemoryTerminal {
  terminal_state:
    | 'completed'
    | 'cancelled'
    | 'failed'
    | 'guardrail_tripped'
    | 'max_turns_exceeded';
  exception_type: string | null;
  exception_message: string | null;
  has_final_output: boolean;
}

interface MemoryInvocation {
  resource?: SandboxSessionLike;
  active: boolean;
}
const memoryInvocation = new AsyncLocalStorage<MemoryInvocation>();
const memoryTails = new WeakMap<SandboxSessionLike, Promise<void>>();

async function withMemoryResource<T>(
  resource: SandboxSessionLike,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = memoryTails.get(resource) ?? Promise.resolve();
  const release = Promise.withResolvers<void>();
  const tail = previous.catch(() => {}).then(() => release.promise);
  memoryTails.set(resource, tail);
  void tail.then(() => {
    if (memoryTails.get(resource) === tail) memoryTails.delete(resource);
  });
  const cancelled = Promise.withResolvers<void>();
  const abort = () =>
    cancelled.reject(
      new NativeError('Sandbox memory generation was cancelled'),
    );
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    await Promise.race([previous.catch(() => {}), cancelled.promise]);
    signal.throwIfAborted();
    return await operation();
  } finally {
    signal.removeEventListener('abort', abort);
    release.resolve();
  }
}

/** @internal Validate configuration before acquiring any provider resource. */
export function captureSandboxMemory(
  options: SandboxMemoryOptions,
  runtime: Runtime,
) {
  if (
    !(options.phaseOne instanceof Agent) ||
    !(options.phaseTwo instanceof Agent)
  )
    throw new TypeError('Sandbox memory phases require native Agents');
  const maxRawMemories = options.maxRawMemories ?? 16;
  if (
    !Number.isSafeInteger(maxRawMemories) ||
    maxRawMemories < 1 ||
    maxRawMemories > 256
  )
    throw new RangeError('maxRawMemories must be between 1 and 256');
  const config = runtime.memory({
    read: false,
    generate: true,
    layout:
      options.layout === undefined
        ? undefined
        : structuredClone(options.layout),
    store: options.store,
  });
  const extracted = runtime.RolloutExtractionArtifactsSchema.extend({
    rollout_summary: text,
    rollout_slug: text,
    raw_memory: text,
  });
  const phaseOne = options.phaseOne.withOutputType(extracted);
  const phaseTwo = options.phaseTwo.withOutputType(consolidatedMemory);
  return (resource: SandboxSessionLike) =>
    new SandboxMemoryOwner(
      resource,
      runtime,
      config,
      phaseOne,
      phaseTwo,
      maxRawMemories,
    );
}

/** @internal One acquisition owns generation, cancellation and its current native source. */
export class SandboxMemoryOwner {
  private readonly controller = new AbortController();
  private readonly storage: InstanceType<Runtime['SandboxMemoryStorage']>;
  private thread?: string;
  private readonly resourceSessionId: string | undefined;
  private enqueuedRevision?: string;
  private completedRevision?: string;

  constructor(
    private readonly resource: SandboxSessionLike,
    private readonly runtime: Runtime,
    private readonly config: ReturnType<Runtime['memory']>,
    private readonly phaseOne: AgentOutput<
      undefined,
      z.infer<Runtime['RolloutExtractionArtifactsSchema']>
    >,
    private readonly phaseTwo: AgentOutput<
      undefined,
      z.infer<typeof consolidatedMemory>
    >,
    private readonly maxRawMemories: number,
  ) {
    this.resourceSessionId =
      typeof resource.state.sessionId === 'string'
        ? resource.state.sessionId
        : undefined;
    if (
      typeof resource.readFileNoFollow !== 'function' ||
      typeof resource.writeFileNoFollow !== 'function'
    )
      throw new TypeError(
        'Native sandbox memory requires no-follow file access',
      );
    this.storage = new runtime.SandboxMemoryStorage({
      session: resource,
      store: config.store,
      writeFile: resource.writeFileNoFollow.bind(resource),
      readFile: (args) =>
        resource.readFileNoFollow!({
          ...args,
          maxBytes: Math.min(args.maxBytes ?? MAX_INPUT_BYTES, MAX_INPUT_BYTES),
        }),
      runOperation: (name, run) => this.operation(name, run),
    });
  }

  cancel(): void {
    this.controller.abort();
  }

  checkOperation(operation: string): void {
    const invocation = memoryInvocation.getStore();
    if (invocation?.active && invocation.resource === this.resource)
      throw new NativeError(
        `A sandbox memory phase cannot ${operation} a Session for its own resource`,
      );
  }

  private active(): void {
    if (this.controller.signal.aborted)
      throw new NativeError('Sandbox memory generation was cancelled');
  }

  private async operation<T>(name: string, run: () => Promise<T>): Promise<T> {
    this.active();
    const started = performance.now();
    const base = {
      type: 'sandbox_operation' as const,
      name,
      data: {
        rollout_id: this.thread,
        ...(this.resourceSessionId === undefined
          ? {}
          : { sandbox_session_id: this.resourceSessionId }),
      },
    };
    this.runtime.dispatchSandboxEvent({
      ...base,
      phase: 'start',
      timestamp: new Date().toISOString(),
    });
    try {
      this.active();
      const result = await run();
      this.active();
      this.runtime.dispatchSandboxEvent({
        ...base,
        phase: 'end',
        timestamp: new Date().toISOString(),
        durationMs: performance.now() - started,
      });
      return result;
    } catch (error) {
      this.runtime.dispatchSandboxEvent({
        ...base,
        phase: 'error',
        timestamp: new Date().toISOString(),
        durationMs: performance.now() - started,
        error: {
          name: 'SandboxMemoryError',
          message: 'Native sandbox memory operation failed',
        },
      });
      throw error;
    }
  }

  private async generate<Output>(
    agent: AgentOutput<undefined, Output>,
    input: string,
    invocation: MemoryInvocation,
  ): Promise<Output> {
    this.active();
    return memoryInvocation.run(
      invocation,
      async () =>
        (await agent.run(input, { signal: this.controller.signal }))
          .finalOutput,
    );
  }

  async flush(
    thread: string,
    snapshot: CanonicalHistorySnapshot,
    terminal: SandboxMemoryTerminal,
  ): Promise<void> {
    this.checkOperation('flush');
    this.active();
    await withMemoryResource(
      this.resource,
      this.controller.signal,
      async () => {
        const invocation: MemoryInvocation = {
          resource: this.resource,
          active: true,
        };
        try {
          await this.flushCurrent(thread, snapshot, terminal, invocation);
        } finally {
          invocation.active = false;
          invocation.resource = undefined;
        }
      },
    );
  }

  private async flushCurrent(
    thread: string,
    snapshot: CanonicalHistorySnapshot,
    terminal: SandboxMemoryTerminal,
    invocation: MemoryInvocation,
  ): Promise<void> {
    this.active();
    if (this.thread !== undefined && this.thread !== thread)
      throw new NativeError('Sandbox memory belongs to another native Session');
    const transcript = memoryTranscript(
      thread,
      snapshot,
      terminal,
      this.resourceSessionId,
    );
    this.thread = thread;
    if (this.completedRevision === snapshot.revision) return;
    const { memoriesDir, sessionsDir, summaryFile } = this.config.layout;
    const rolloutPath = `${sessionsDir}/${thread}.jsonl`;
    if (this.enqueuedRevision !== snapshot.revision) {
      await this.operation('sandbox.memory.enqueue_rollout', async () => {
        await this.storage.ensureLayout(this.config);
        // Each revision is a complete snapshot; keep one bounded latest record.
        await this.storage.writeText(
          rolloutPath,
          `${boundedJson(transcript)}\n`,
        );
      });
      this.enqueuedRevision = snapshot.revision;
    }
    await this.operation('sandbox.memory.flush', async () => {
      const input = boundedJson({ transcript });
      const artifacts = this.runtime.RolloutExtractionArtifactsSchema.parse(
        await this.generate(this.phaseOne, input, invocation),
      );
      if (!this.runtime.validateRolloutArtifacts(artifacts)) return;
      const updatedAt = new Date().toISOString();
      const rolloutSummaryFile = `rollout_summaries/${thread}.md`;
      await this.storage.writeText(
        `${memoriesDir}/raw_memories/${thread}.md`,
        this.runtime.formatRawMemory({
          updatedAt,
          rolloutId: thread,
          rolloutPath,
          rolloutSummaryFile,
          terminalState: 'completed',
          rawMemory: artifacts.raw_memory,
        }),
      );
      await this.storage.writeText(
        `${memoriesDir}/${rolloutSummaryFile}`,
        this.runtime.formatRolloutSummary({
          updatedAt,
          rolloutPath,
          sessionId: this.resourceSessionId ?? '',
          terminalState: 'completed',
          rolloutSummary: artifacts.rollout_summary,
        }),
      );
      const selection = await this.storage.buildPhaseTwoInputSelection({
        memoriesDir,
        maxRawMemoriesForConsolidation: this.maxRawMemories,
      });
      const inputs: Array<{ rolloutId: string; memory: string | null }> = [];
      for (const item of selection.selected) {
        inputs.push({
          rolloutId: item.rolloutId,
          memory: await this.storage.readText(
            `${memoriesDir}/raw_memories/${item.rolloutId}.md`,
          ),
        });
        boundedJson(inputs);
      }
      const output = consolidatedMemory.parse(
        await this.generate(
          this.phaseTwo,
          boundedJson({ memories: inputs }),
          invocation,
        ),
      );
      await this.storage.writeText(`${memoriesDir}/MEMORY.md`, output.memory);
      await this.storage.writeText(
        `${memoriesDir}/${summaryFile}`,
        output.summary,
      );
      await this.storage.writePhaseTwoSelection({
        memoriesDir,
        selectedItems: selection.selected,
      });
    });
    this.completedRevision = snapshot.revision;
  }
}

function boundedJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > MAX_INPUT_BYTES)
    throw new RangeError('Native sandbox memory input exceeds 1000000 bytes');
  return encoded;
}

function memoryTranscript(
  thread: string,
  snapshot: CanonicalHistorySnapshot,
  terminal: SandboxMemoryTerminal,
  resourceSessionId?: string,
) {
  if (snapshot.total > 256)
    throw new RangeError(
      'Native sandbox memory supports at most 256 original records',
    );
  const items: Array<Record<string, unknown>> = [];
  for (const item of snapshot.items) {
    if (item.role === 'developer' || item.role === 'system') continue;
    if (item.type === 'reasoning') continue;
    if (item.type === 'function_call') {
      if (
        typeof item.name !== 'string' ||
        typeof item.call_id !== 'string' ||
        typeof item.arguments !== 'string'
      )
        throw new TypeError('Invalid native memory function call');
      items.push({
        type: item.type,
        name: item.name,
        call_id: item.call_id,
        arguments: item.arguments,
        ...(typeof item.namespace === 'string'
          ? { namespace: item.namespace }
          : {}),
      });
      continue;
    }
    if (item.type === 'function_call_output') {
      if (
        typeof item.call_id !== 'string' ||
        (typeof item.output !== 'string' && !Array.isArray(item.output))
      )
        throw new TypeError('Invalid native memory function output');
      items.push({
        type: item.type,
        call_id: item.call_id,
        output:
          typeof item.output === 'string'
            ? item.output
            : item.output.map(memoryTextPart),
      });
      continue;
    }
    if (item.type !== 'message')
      throw new TypeError(
        'Native sandbox memory requires text messages and function tool history',
      );
    if (item.role !== 'user' && item.role !== 'assistant') continue;
    if (!Array.isArray(item.content))
      throw new TypeError('Invalid native memory message content');
    const content: Array<{ type: string; text: string }> = [];
    const metadata = item.internal_chat_message_metadata_passthrough;
    const origins =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>).content_item_kinds
        : undefined;
    for (const [index, part] of item.content.entries()) {
      if (
        item.role === 'user' &&
        (!Array.isArray(origins) ||
          origins.length !== item.content.length ||
          typeof origins[index] !== 'string' ||
          !origins[index].startsWith('user.'))
      )
        continue;
      content.push(memoryTextPart(part));
    }
    if (content.length) items.push({ role: item.role, content });
  }
  const payload = {
    rollout_id: thread,
    native_thread_id: thread,
    ...(resourceSessionId === undefined
      ? {}
      : { sandbox_session_id: resourceSessionId }),
    updated_at: new Date().toISOString(),
    terminal_metadata: {
      terminal_state: terminal.terminal_state,
      exception_type: terminal.exception_type,
      exception_message: terminal.exception_message,
      has_final_output: terminal.has_final_output,
      native_history_revision: snapshot.revision,
    },
    items,
  };
  boundedJson(payload);
  return payload;
}

function memoryTextPart(part: unknown): { type: string; text: string } {
  if (
    !part ||
    typeof part !== 'object' ||
    !('type' in part) ||
    !('text' in part) ||
    (part.type !== 'input_text' && part.type !== 'output_text') ||
    typeof part.text !== 'string'
  )
    throw new TypeError('Native sandbox memory requires text content');
  return { type: part.type, text: part.text };
}
