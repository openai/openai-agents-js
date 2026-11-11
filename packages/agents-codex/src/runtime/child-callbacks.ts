import {
  modelAttemptTerminalError,
  releaseModelAttemptPayload,
  type ModelAttemptState,
} from './model-attempts';
import type { JsonObject } from './binding';
import type { GuardrailRecord } from './guardrails';
import type { TokenUsage, TokenCount } from './run-events';
import type { ObservationPhase } from './observation';
import type { CallbackTraceStorages } from './tracing-context';

/** Shared by a native owner's readers and their observed child turns. */
export interface ChildObservationProducer {
  ended: boolean;
  /** The ordered event reader ended; auxiliary callback readers may still drain. */
  eventReaderEnded: boolean;
  readonly callbackTraceStorages: CallbackTraceStorages;
}

/** Internal callback ownership for independently running native child turns. */
export interface ChildCallbackOwner {
  clientSearchCatalogKeys?: Set<string>;
  readonly guardrailResults: GuardrailRecord[];
  guardrailInput?: readonly JsonObject[];
  inputGuardrailsStarted: boolean;
  inputGuardrailsTask?: Promise<void>;
  readonly childId: string;
  rootTurnId?: string;
  modelAttempts?: ModelAttemptState;
  tokenUsage: TokenUsage | null;
  requests: TokenCount;
  missingUsageRequests: TokenCount;
  readonly incarnation: string;
  readonly turnId: string;
  readonly controller: AbortController;
  readonly tasks: Set<Promise<void>>;
  readonly calls: Set<string>;
  readonly observationProducer: ChildObservationProducer;
  observationPhase: ObservationPhase;
  readonly observationAfter: number;
  nativeStartObserved: boolean;
  instanceId?: string;
  failure?: unknown;
  terminal: boolean;
}

export class ChildCallbacks {
  constructor(private readonly observationSequence: () => number = () => 0) {}
  private readonly owners = new Map<string, ChildCallbackOwner>();
  private key(childId: string, incarnation: string, turnId: string): string {
    return JSON.stringify([childId, incarnation, turnId]);
  }
  find(
    childId: string,
    incarnation: string,
    turnId: string,
  ): ChildCallbackOwner | undefined {
    return this.owners.get(this.key(childId, incarnation, turnId));
  }
  owner(
    childId: string,
    incarnation: string,
    turnId: string,
    producer: ChildObservationProducer,
    instanceId?: string,
  ): ChildCallbackOwner {
    const key = this.key(childId, incarnation, turnId);
    let owner = this.owners.get(key);
    if (!owner) {
      owner = {
        guardrailResults: [],
        inputGuardrailsStarted: false,
        childId,
        tokenUsage: null,
        requests: 0,
        missingUsageRequests: 0,
        incarnation,
        turnId,
        controller: new AbortController(),
        tasks: new Set(),
        calls: new Set(),
        observationProducer: producer,
        observationPhase: 'open',
        observationAfter: this.observationSequence(),
        nativeStartObserved: false,
        terminal: false,
      };
      this.owners.set(key, owner);
    }
    // An incarnation belongs to one native runtime; later lookups only fill
    // a counter missing when an auxiliary callback first created this owner.
    owner.instanceId ??= instanceId;
    return owner;
  }
  /** End observation after entered callback work, without revoking authority. */
  retireObservations(
    producer: ChildObservationProducer,
    notify: (owner: ChildCallbackOwner) => void,
    matches?: (owner: ChildCallbackOwner) => boolean,
  ): Promise<void> | undefined {
    const pending: Promise<void>[] = [];
    for (const owner of this.owners.values()) {
      if (
        owner.observationProducer !== producer ||
        owner.observationPhase !== 'open' ||
        (matches && !matches(owner))
      )
        continue;
      owner.observationPhase = 'finishing';
      pending.push(
        this.drain(owner.childId, owner.incarnation, owner.turnId)
          // The result/cleanup owner still reports this retained failure.
          .catch(() => {})
          .finally(() => {
            owner.observationPhase = 'ended';
            notify(owner);
          }),
      );
    }
    if (pending.length) return Promise.all(pending).then(() => {});
    return undefined;
  }
  active(owner: ChildCallbackOwner): boolean {
    return !owner.terminal && !owner.controller.signal.aborted;
  }
  track(
    owner: ChildCallbackOwner,
    callback: () => Promise<void>,
    failed: () => Promise<void>,
  ): void {
    const task = Promise.resolve()
      .then(callback)
      .catch(async (error) => {
        if (
          owner.controller.signal.aborted &&
          error === owner.controller.signal.reason
        )
          return;
        if (owner.failure === undefined) owner.failure = error;
        owner.controller.abort(error);
        await failed().catch(() => {});
      })
      .finally(() => owner.tasks.delete(task));
    owner.tasks.add(task);
  }
  end(childId: string, incarnation: string, turnId?: string): void {
    for (const owner of this.owners.values()) {
      if (
        owner.childId === childId &&
        owner.incarnation === incarnation &&
        (turnId === undefined || owner.turnId === turnId)
      ) {
        owner.terminal = true;
        owner.controller.abort(new Error('Native child turn ended'));
      }
    }
  }
  async drain(
    childId: string,
    incarnation: string,
    turnId: string,
  ): Promise<void> {
    const owner = this.owners.get(this.key(childId, incarnation, turnId));
    if (!owner) return;
    while (owner.tasks.size) await Promise.allSettled([...owner.tasks]);
    const terminal = modelAttemptTerminalError(owner);
    try {
      if (
        terminal &&
        (owner.failure === terminal || owner.failure === terminal.error)
      )
        throw terminal.error;
      if (owner.failure !== undefined) throw owner.failure;
    } finally {
      if (owner.terminal) releaseModelAttemptPayload(owner);
    }
  }
  forOrigins(origins: ReadonlySet<string>): readonly ChildCallbackOwner[] {
    return [...this.owners.values()].filter(
      (owner) =>
        owner.rootTurnId !== undefined && origins.has(owner.rootTurnId),
    );
  }
  /** SDK callback work already entered, or still current when a stop begins. */
  entered(): ChildCallbackOwner[] {
    return [...this.owners.values()].filter(
      (owner) => this.active(owner) || owner.tasks.size > 0,
    );
  }
  /** Join the initial work plus callbacks which reached JS during native stop.
   * This is callback ownership only; native decides thread membership.
   */
  async drainEntered(initial: readonly ChildCallbackOwner[]): Promise<void> {
    const selected = new Set([...initial, ...this.entered()]);
    const results = await Promise.allSettled(
      [...selected].map((owner) =>
        this.drain(owner.childId, owner.incarnation, owner.turnId),
      ),
    );
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length > 1)
      throw new AggregateError(failures, 'Child callback cleanup failed', {
        cause: failures[0],
      });
    if (failures.length) throw failures[0];
  }
  stop(reason: Error = new Error('Session closed')): void {
    for (const owner of this.owners.values()) {
      owner.terminal = true;
      owner.controller.abort(reason);
    }
  }
  async close(): Promise<void> {
    this.stop();
    await Promise.all(
      [...this.owners.values()].map(async (owner) => {
        while (owner.tasks.size) await Promise.allSettled([...owner.tasks]);
      }),
    );
  }
}
