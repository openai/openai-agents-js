/** Application journal for one thumbnail and one mutation of each kind per order. */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  DeferredAuthorizationError,
  type JobAction,
  type JobBinding,
  type JobClaim,
  type JobContext,
  type JobJournal,
  type JobOperation,
  type JobUpdate,
} from '@openai/agents/experimental/deferred';
import { Busy, ThumbnailStore } from './external-job-store';

interface OrderRow {
  fence: string;
  binding: string | null;
  checkpoint: string | null;
  phase: string;
  receipt_update: string | null;
  result: string | null;
  finished: string | null;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const denied = () => new DeferredAuthorizationError();
function bindingJson(binding: JobBinding): string {
  const value = {
    tenant: binding.tenant,
    runId: binding.runId,
    providerId: binding.providerId,
    sessionId: binding.sessionId,
    turnId: binding.turnId,
    callId: binding.callId,
    toolName: binding.toolName,
    requestDigest: binding.requestDigest,
    checkpointDigest: binding.checkpointDigest,
  };
  if (
    Object.values(value).some((v) => typeof v !== 'string' || !v) ||
    !/^[a-f0-9]{64}$/.test(value.requestDigest) ||
    !/^[a-f0-9]{64}$/.test(value.checkpointDigest)
  )
    throw denied();
  return JSON.stringify(value);
}

export class Journal implements JobJournal {
  readonly store: ThumbnailStore;
  readonly order: string;
  readonly scope: readonly [string, string];
  readonly key: string;
  private generation?: string;

  constructor(store: ThumbnailStore, order: string) {
    if (!order) throw new TypeError('Supply a stable application order ID.');
    this.store = store;
    this.order = order;
    this.scope = Object.freeze([store.tenant, order]);
    this.key = hash(JSON.stringify(this.scope));
  }

  async owner<T>(operation: () => Promise<T>): Promise<T> {
    if (this.generation !== undefined) throw new Busy();
    return this.store.owner(this.key, async () => {
      this.generation = this.store.transaction((db) => {
        db.prepare(
          'INSERT OR IGNORE INTO orders (tenant,order_id) VALUES (?,?)',
        ).run(...this.scope);
        const changed = db
          .prepare(
            `UPDATE orders SET generation=generation+1
          WHERE tenant=? AND order_id=? AND allowed=1 AND generation<9223372036854775807`,
          )
          .run(...this.scope);
        if (changed.changes !== 1) throw denied();
        return db
          .prepare(
            'SELECT CAST(generation AS TEXT) AS fence FROM orders WHERE tenant=? AND order_id=?',
          )
          .get(...this.scope)!.fence as string;
      });
      try {
        return await operation();
      } finally {
        this.generation = undefined;
      }
    });
  }

  private row(db: DatabaseSync, claim?: JobClaim): OrderRow {
    if (this.generation === undefined) throw denied();
    const row = db
      .prepare(
        `SELECT CAST(generation AS TEXT) AS fence,
      binding,checkpoint,phase,receipt_update,result,finished FROM orders
      WHERE tenant=? AND order_id=? AND allowed=1 AND CAST(generation AS TEXT)=?`,
      )
      .get(...this.scope, this.generation) as unknown as OrderRow | undefined;
    if (
      !row ||
      (claim &&
        (claim.key !== this.key ||
          claim.generation !== this.generation ||
          row.binding !== bindingJson(claim.binding)))
    )
      throw denied();
    return row;
  }

  load(): { checkpoint: string | null; finished: boolean } {
    return this.store.transaction((db) => {
      const row = this.row(db);
      return { checkpoint: row.checkpoint, finished: row.finished !== null };
    });
  }

  async prepare(
    stateJson: string,
    bindings: readonly JobBinding[],
    context: JobContext,
  ): Promise<void> {
    context.signal.throwIfAborted();
    if (
      bindings.length !== 1 ||
      bindings[0].tenant !== this.store.tenant ||
      bindings[0].runId !== this.order ||
      bindings[0].checkpointDigest !== hash(stateJson)
    )
      throw denied();
    const binding = bindingJson(bindings[0]);
    this.store.transaction((db) => {
      const row = this.row(db);
      if (row.phase !== 'new') {
        if (row.binding !== binding || row.checkpoint !== stateJson)
          throw denied();
        return;
      }
      db.prepare(
        "UPDATE orders SET phase='prepared',binding=?,checkpoint=? WHERE tenant=? AND order_id=?",
      ).run(binding, stateJson, ...this.scope);
    });
  }

  async claim(
    binding: JobBinding,
    operation: JobOperation,
    context: JobContext,
  ): Promise<JobClaim> {
    context.signal.throwIfAborted();
    return this.store.transaction((db) => {
      const row = this.row(db);
      if (row.binding !== bindingJson(binding)) throw denied();
      const update = row.receipt_update
        ? (JSON.parse(row.receipt_update) as JobUpdate)
        : undefined;
      let action: JobAction = 'unknown';
      if (operation !== 'advance') {
        const spent = db
          .prepare(
            "SELECT 1 FROM mutations WHERE tenant=? AND order_id=? AND operation=? AND state='spent'",
          )
          .get(...this.scope, operation);
        if (
          !spent &&
          update?.receipt &&
          (update.status === 'inputRequired' ||
            (operation === 'cancel' && update.status === 'pending'))
        )
          action = operation;
      } else if (row.phase === 'prepared') {
        db.prepare(
          "UPDATE orders SET phase='creating' WHERE tenant=? AND order_id=?",
        ).run(...this.scope);
        action = 'start';
      } else if (row.phase === 'creating') action = 'reconcileCreation';
      else if (row.result !== null) action = 'deliver';
      else if (update?.status === 'completed') action = 'project';
      else if (
        update?.receipt &&
        ['pending', 'inputRequired', 'unknown'].includes(update.status)
      )
        action = 'observe';
      return Object.freeze({
        binding: Object.freeze({ ...binding }),
        key: this.key,
        generation: row.fence,
        action,
        update,
        ...(row.result === null ? {} : { resultJson: row.result }),
      });
    });
  }

  async authorize(
    claim: JobClaim,
    action: JobAction,
    context: JobContext,
  ): Promise<void> {
    context.signal.throwIfAborted();
    this.store.transaction((db) => {
      const row = this.row(db, claim);
      const update = row.receipt_update
        ? (JSON.parse(row.receipt_update) as JobUpdate)
        : undefined;
      const allowed =
        (['start', 'reconcileCreation'].includes(action) &&
          row.phase === 'creating') ||
        (action === 'observe' &&
          !!update?.receipt &&
          ['pending', 'inputRequired', 'unknown'].includes(update.status)) ||
        (action === 'respond' && update?.status === 'inputRequired') ||
        (action === 'cancel' &&
          !!update?.receipt &&
          ['pending', 'inputRequired'].includes(update.status)) ||
        (action === 'project' && update?.status === 'completed') ||
        (action === 'deliver' && row.result !== null);
      if (!allowed) throw denied();
    });
  }

  /** Providers keep target-side checks and writes inside this short transaction. */
  authorized<T>(
    claim: JobClaim,
    operation: (db: DatabaseSync) => T,
    context: JobContext,
  ): T {
    context.signal.throwIfAborted();
    return this.store.transaction((db) => {
      this.row(db, claim);
      return operation(db);
    });
  }

  async record(
    claim: JobClaim,
    update: JobUpdate,
    context: JobContext,
  ): Promise<void> {
    context.signal.throwIfAborted();
    this.store.transaction((db) => {
      const row = this.row(db, claim);
      const previous = row.receipt_update
        ? (JSON.parse(row.receipt_update) as JobUpdate)
        : undefined;
      if (
        row.result !== null ||
        (previous?.receipt && previous.receipt !== update.receipt)
      )
        throw denied();
      if (
        previous &&
        !['pending', 'inputRequired'].includes(previous.status) &&
        !(previous.status === 'unknown' && previous.receipt) &&
        JSON.stringify(previous) !== JSON.stringify(update)
      )
        throw denied();
      db.prepare(
        "UPDATE orders SET phase='recorded',receipt_update=? WHERE tenant=? AND order_id=?",
      ).run(JSON.stringify(update), ...this.scope);
    });
  }

  async saveResult(
    claim: JobClaim,
    resultJson: string,
    context: JobContext,
  ): Promise<void> {
    context.signal.throwIfAborted();
    if (JSON.stringify(JSON.parse(resultJson)) !== resultJson)
      throw new TypeError('Save exact public JSON bytes.');
    this.store.transaction((db) => {
      const row = this.row(db, claim);
      const update = row.receipt_update
        ? (JSON.parse(row.receipt_update) as JobUpdate)
        : undefined;
      if (
        update?.status !== 'completed' ||
        (row.result !== null && row.result !== resultJson)
      )
        throw denied();
      db.prepare(
        'UPDATE orders SET result=? WHERE tenant=? AND order_id=?',
      ).run(resultJson, ...this.scope);
    });
  }

  /** One approved mutation per operation; reserve does not spend it at claim time. */
  reserveMutation(
    claim: JobClaim,
    operation: 'respond' | 'cancel',
    mutationId: string,
    context: JobContext,
  ): void {
    const receipt = claim.update?.receipt;
    if (!mutationId || !receipt) throw denied();
    this.authorized(
      claim,
      (db) => {
        this.checkMutation(db, claim, operation);
        const existing = db
          .prepare(
            'SELECT mutation_id,receipt,state FROM mutations WHERE tenant=? AND order_id=? AND operation=?',
          )
          .get(...this.scope, operation);
        if (
          existing &&
          (existing.mutation_id !== mutationId ||
            existing.receipt !== receipt ||
            existing.state === 'spent')
        )
          throw denied();
        db.prepare(
          `INSERT INTO mutations VALUES (?,?,?,?,?,?,'reserved')
        ON CONFLICT (tenant,order_id,operation) DO UPDATE SET generation=excluded.generation`,
        ).run(...this.scope, operation, mutationId, receipt, claim.generation);
      },
      context,
    );
  }

  /** Call only after validating the target/challenge, immediately before sending. */
  spendMutation(
    claim: JobClaim,
    operation: 'respond' | 'cancel',
    mutationId: string,
    context: JobContext,
  ): void {
    this.authorized(
      claim,
      (db) => {
        this.checkMutation(db, claim, operation);
        const changed = db
          .prepare(
            `UPDATE mutations SET state='spent' WHERE tenant=? AND order_id=?
        AND operation=? AND mutation_id=? AND receipt=? AND generation=? AND state='reserved'`,
          )
          .run(
            ...this.scope,
            operation,
            mutationId,
            claim.update?.receipt ?? '',
            claim.generation,
          );
        if (changed.changes !== 1) throw denied();
      },
      context,
    );
  }

  private checkMutation(
    db: DatabaseSync,
    claim: JobClaim,
    operation: 'respond' | 'cancel',
  ): void {
    const row = this.row(db, claim);
    const update = row.receipt_update
      ? (JSON.parse(row.receipt_update) as JobUpdate)
      : undefined;
    if (
      row.result !== null ||
      !update?.receipt ||
      update.receipt !== claim.update?.receipt ||
      (update.status !== 'inputRequired' &&
        !(operation === 'cancel' && update.status === 'pending'))
    )
      throw denied();
  }

  /** The host publishes only after delivery/settlement and a saved public result. */
  finish(stateJson: string): void {
    this.store.transaction((db) => {
      const row = this.row(db);
      if (
        row.result === null ||
        (row.finished !== null && row.finished !== stateJson)
      )
        throw denied();
      db.prepare(
        'UPDATE orders SET finished=? WHERE tenant=? AND order_id=?',
      ).run(stateJson, ...this.scope);
    });
  }
}
