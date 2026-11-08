import { createHash } from 'node:crypto';
import type { Agent } from './public-agent';

/** An immutable snapshot of one native response's output. */
export interface NativeRealtimeGuardrailInput {
  readonly text: string;
  readonly responseId: string;
  readonly itemId: string;
  readonly contentIndex?: number;
  readonly outputIndex?: number;
  readonly outputKind: 'text' | 'audio_transcript';
  readonly agent: Agent<any, any>;
  readonly context: unknown;
  readonly final: boolean;
  /** Aborted when this response or the voice owner is retired. */
  readonly signal: AbortSignal;
}

export interface NativeRealtimeGuardrailResult {
  readonly tripwireTriggered: boolean;
  /** Application-local diagnostics; never sent to the speech provider. */
  readonly outputInfo?: unknown;
}

export interface NativeRealtimeOutputGuardrail {
  readonly name: string;
  readonly callback: (
    input: NativeRealtimeGuardrailInput,
  ) => NativeRealtimeGuardrailResult | Promise<NativeRealtimeGuardrailResult>;
  /** Explicit developer-authored feedback; diagnostics stay local. */
  readonly feedback?: string;
}

export interface NativeRealtimeGuardrailEvent {
  readonly type: 'guardrail';
  readonly name: string;
  readonly input: NativeRealtimeGuardrailInput;
  readonly result?: NativeRealtimeGuardrailResult;
  readonly error?: unknown;
}

/** An exact snapshot of retained work, used to avoid joining newer responses. */
export interface NativeRealtimeGuardrailWork {
  readonly completion: Promise<void>;
}

interface Worker extends NativeRealtimeGuardrailWork {
  retired: boolean;
}

interface Item {
  input: NativeRealtimeGuardrailInput;
  thresholdCount: number;
  pending?: NativeRealtimeGuardrailInput;
  worker?: Worker;
  readonly controller: AbortController;
}

interface Options {
  readonly guardrails: readonly NativeRealtimeOutputGuardrail[];
  readonly threshold?: number | null;
  readonly source: (receipt: unknown) => {
    agent: Agent<any, any>;
    context: unknown;
  };
  readonly invoke: (
    callback: () =>
      NativeRealtimeGuardrailResult | Promise<NativeRealtimeGuardrailResult>,
  ) => Promise<NativeRealtimeGuardrailResult>;
  readonly trip: (
    input: NativeRealtimeGuardrailInput,
    feedback: string | undefined,
    excludeWorker: NativeRealtimeGuardrailWork,
  ) => Promise<void>;
  readonly emit: (event: NativeRealtimeGuardrailEvent) => void;
  readonly fail: (error: unknown) => void;
}

const MAX_ITEMS = 1024;
const MAX_WORKERS = 16;
const MAX_TEXT = 1_048_576;
const MAX_IDENTITY_BYTES = 8 * 1024 * 1024;

function fingerprint(value: string): string {
  // Preserve exact JavaScript string units, including isolated surrogates.
  return createHash('sha256').update(value, 'utf16le').digest('hex');
}

/** One worker per output item, with only its latest pending snapshot retained. */
export class NativeRealtimeGuardrails {
  private readonly items = new Map<string, Item>();
  private readonly retiredResponses = new Set<string>();
  private readonly completed = new Map<string, string | null>();
  private readonly guardrails: readonly NativeRealtimeOutputGuardrail[];
  private readonly threshold: number | null;
  private activeWorkers = 0;
  private identityBytes = 0;
  private textSize = 0;
  private stopped = false;

  constructor(private readonly options: Options) {
    this.threshold = options.threshold === undefined ? 100 : options.threshold;
    if (
      this.threshold !== null &&
      (!Number.isSafeInteger(this.threshold) || this.threshold <= 0)
    ) {
      throw new TypeError(
        'guardrailTextThreshold must be a positive integer or null',
      );
    }
    this.guardrails = Object.freeze(
      options.guardrails.map((guardrail) => {
        if (
          !guardrail ||
          typeof guardrail.name !== 'string' ||
          !guardrail.name.trim() ||
          typeof guardrail.callback !== 'function' ||
          (guardrail.feedback !== undefined &&
            (typeof guardrail.feedback !== 'string' ||
              !guardrail.feedback.trim()))
        ) {
          throw new TypeError(
            'A Realtime guardrail requires a name, callback and optional nonempty feedback',
          );
        }
        return Object.freeze({ ...guardrail });
      }),
    );
  }

  private reserveIdentity(...values: string[]): void {
    const size = values.reduce((sum, value) => sum + value.length * 2, 0);
    if (this.identityBytes + size > MAX_IDENTITY_BYTES)
      throw new Error('Realtime guardrail identity capacity exceeded');
    this.identityBytes += size;
  }

  observe(value: Readonly<Record<string, unknown>>, final: boolean): void {
    if (this.stopped || this.guardrails.length === 0) return;
    const responseId = value.response_id;
    const itemId = value.item_id;
    const outputKind = value.output_kind;
    if (
      typeof responseId !== 'string' ||
      !responseId ||
      typeof itemId !== 'string' ||
      !itemId ||
      (outputKind !== 'text' && outputKind !== 'audio_transcript')
    )
      throw new Error(
        'Realtime guardrail output has no authoritative source identity',
      );
    if (this.retiredResponses.has(responseId)) return;
    for (const key of ['content_index', 'output_index']) {
      if (
        value[key] != null &&
        (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0)
      )
        throw new Error(
          'Realtime guardrail output has an invalid content index',
        );
    }
    const key = JSON.stringify([
      responseId,
      itemId,
      value.content_index ?? null,
      outputKind,
    ]);
    const completed = this.completed.get(fingerprint(key));
    if (completed === null) return;
    if (completed !== undefined) {
      if (
        final &&
        typeof value.text === 'string' &&
        fingerprint(value.text) === completed
      )
        return;
      throw new Error('Realtime output changed after its final transcript');
    }
    let item = this.items.get(key);
    if (item?.controller.signal.aborted) return;
    if (!item) {
      if (this.items.size >= MAX_ITEMS)
        throw new Error('Realtime guardrail item capacity exceeded');
      this.reserveIdentity(key, responseId, itemId);
      const controller = new AbortController();
      item = {
        thresholdCount: 0,
        controller,
        input: Object.freeze({
          text: '',
          responseId,
          itemId,
          contentIndex:
            value.content_index == null
              ? undefined
              : (value.content_index as number),
          outputIndex:
            value.output_index == null
              ? undefined
              : (value.output_index as number),
          outputKind,
          ...this.options.source(value.profile_receipt),
          final: false,
          signal: controller.signal,
        }),
      };
      this.items.set(key, item);
    }
    const fragment = final ? value.text : value.delta;
    if (typeof fragment !== 'string')
      throw new Error('Realtime guardrail output text is invalid');
    const text = final ? fragment : item.input.text + fragment;
    if (item.input.final) {
      if (final && item.input.text === text) return;
      throw new Error('Realtime output changed after its final transcript');
    }
    const textSize = this.textSize + text.length - item.input.text.length;
    if (textSize > MAX_TEXT)
      throw new Error('Realtime guardrail text capacity exceeded');
    this.textSize = textSize;
    item.input = Object.freeze({ ...item.input, text, final });
    const crossed =
      this.threshold === null ? 0 : Math.floor(text.length / this.threshold);
    if (!final && crossed <= item.thresholdCount) return;
    item.thresholdCount = crossed;
    item.pending = item.input;
    if (!item.worker) {
      if (this.activeWorkers >= MAX_WORKERS)
        throw new Error('Realtime guardrail callback capacity exceeded');
      this.activeWorkers++;
      const captured = item;
      const worker: Worker = {
        retired: false,
        completion: Promise.resolve().then(() =>
          this.run(key, captured, worker),
        ),
      };
      item.worker = worker;
      // Retain rejection for join without an unhandled-rejection side channel.
      worker.completion.catch((error) => this.options.fail(error));
    }
  }

  private async run(key: string, item: Item, worker: Worker): Promise<void> {
    try {
      while (!this.stopped && !worker.retired && item.pending) {
        const input = item.pending;
        item.pending = undefined;
        for (const guardrail of this.guardrails) {
          if (
            this.stopped ||
            worker.retired ||
            this.retiredResponses.has(input.responseId)
          )
            return;
          let result: NativeRealtimeGuardrailResult;
          try {
            result = await this.options.invoke(() => guardrail.callback(input));
            if (!result || typeof result.tripwireTriggered !== 'boolean')
              throw new TypeError(
                'Realtime guardrails must return a boolean tripwireTriggered',
              );
          } catch (error) {
            if (!this.stopped && !worker.retired)
              this.options.emit({
                type: 'guardrail',
                name: guardrail.name,
                input,
                error,
              });
            continue;
          }
          if (
            this.stopped ||
            worker.retired ||
            this.retiredResponses.has(input.responseId)
          )
            return;
          this.options.emit({
            type: 'guardrail',
            name: guardrail.name,
            input,
            result,
          });
          if (result.tripwireTriggered) {
            this.retire(new Set([input.responseId]));
            try {
              await this.options.trip(input, guardrail.feedback, worker);
            } catch (error) {
              if (!this.stopped)
                this.options.emit({
                  type: 'guardrail',
                  name: guardrail.name,
                  input,
                  error,
                });
            }
            return;
          }
        }
      }
    } finally {
      item.worker = undefined;
      this.activeWorkers--;
      if (!item.pending && (item.input.final || item.controller.signal.aborted))
        this.releaseItem(key, item);
    }
  }

  private releaseItem(key: string, item: Item): void {
    if (this.items.get(key) !== item) return;
    this.items.delete(key);
    this.textSize -= item.input.text.length;
    this.identityBytes -=
      (key.length + item.input.responseId.length + item.input.itemId.length) *
      2;
    if (this.completed.size >= MAX_ITEMS)
      this.completed.delete(this.completed.keys().next().value!);
    this.completed.set(
      fingerprint(key),
      item.controller.signal.aborted ? null : fingerprint(item.input.text),
    );
  }

  /** Snapshot and retire current matching work synchronously; never future work. */
  retire(
    responseIds?: ReadonlySet<string>,
  ): readonly NativeRealtimeGuardrailWork[] {
    const ids =
      responseIds ??
      new Set([...this.items.values()].map((item) => item.input.responseId));
    for (const id of ids) {
      if (!this.stopped && !this.retiredResponses.has(id)) {
        while (
          this.retiredResponses.size >= MAX_ITEMS ||
          this.identityBytes + id.length * 2 > MAX_IDENTITY_BYTES
        ) {
          const oldest = this.retiredResponses.values().next().value;
          if (oldest === undefined) break;
          this.retiredResponses.delete(oldest);
          this.identityBytes -= oldest.length * 2;
        }
        this.reserveIdentity(id);
        this.retiredResponses.add(id);
      }
    }
    const workers: Worker[] = [];
    for (const [key, item] of this.items) {
      if (!ids.has(item.input.responseId)) continue;
      item.pending = undefined;
      item.controller.abort();
      if (item.worker) {
        item.worker.retired = true;
        workers.push(item.worker);
      } else this.releaseItem(key, item);
    }
    return workers;
  }

  stop(): readonly NativeRealtimeGuardrailWork[] {
    this.stopped = true;
    return this.retire();
  }

  async join(
    workers: readonly NativeRealtimeGuardrailWork[],
    excludeWorker?: NativeRealtimeGuardrailWork,
  ): Promise<void> {
    const outcomes = await Promise.allSettled(
      workers
        .filter((worker) => worker !== excludeWorker)
        .map((worker) => worker.completion),
    );
    const failures = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === 'rejected',
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        'Realtime guardrail cleanup failed',
      );
  }
}
