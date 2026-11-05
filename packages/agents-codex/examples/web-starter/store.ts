import { randomUUID } from 'node:crypto';
import { constants, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StoredReport } from './mcp-peer';
import { AppError, terminal, type Owner, type Snapshot } from './protocol';

export interface TaskRecord {
  owner: Owner;
  requestKey: string;
  task: string;
  expiresAt: number;
  snapshot: Snapshot;
  checkpoint?: string;
}

/** One trusted POSIX process owns this directory, SQLite writer lock and bytes. */
export class TaskStore {
  private readonly db: DatabaseSync;
  private readonly lock: DatabaseSync;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (
      !info.isDirectory() ||
      info.uid !== process.geteuid?.() ||
      info.mode & 0o077
    )
      throw new Error('Use a private, owned POSIX directory (0700).');
    const open = (name: string) => {
      const path = join(directory, name);
      try {
        const fd = openSync(
          path,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY |
            constants.O_NOFOLLOW,
          0o600,
        );
        closeSync(fd);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      for (const suffix of ['', '-journal', '-wal', '-shm']) {
        try {
          const file = lstatSync(path + suffix);
          if (
            !file.isFile() ||
            file.nlink !== 1 ||
            file.uid !== process.geteuid?.() ||
            file.mode & 0o077
          )
            throw new Error('State files must be private owned regular files.');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      const db = new DatabaseSync(path, { timeout: 0 });
      try {
        db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    };
    this.lock = open('owner.sqlite3');
    let opened: DatabaseSync | undefined;
    try {
      this.lock.exec('BEGIN IMMEDIATE');
      this.db = opened = open('tasks.sqlite3');
      this.db.exec(`CREATE TABLE IF NOT EXISTS tasks (
        receipt TEXT PRIMARY KEY, owner TEXT NOT NULL, request_key TEXT NOT NULL,
        task TEXT NOT NULL, expires_at INTEGER NOT NULL, snapshot TEXT NOT NULL,
        checkpoint TEXT, UNIQUE(owner, request_key));
        CREATE TABLE IF NOT EXISTS artifacts (
        handle TEXT PRIMARY KEY, receipt TEXT NOT NULL UNIQUE, bytes TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS reports (reference TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL, json TEXT NOT NULL);`);
      for (const record of this.records()) {
        if (record.expiresAt > Date.now() && !terminal(record.snapshot.phase)) {
          this.update(record.owner, record.snapshot.receipt, {
            phase: 'unknown',
            error:
              'Process restarted; prior effects are unknown. This task will not replay.',
          });
        }
      }
    } catch (error) {
      opened?.close();
      this.lock.close();
      throw error;
    }
  }
  private records(): TaskRecord[] {
    return this.db
      .prepare('SELECT * FROM tasks')
      .all()
      .map((row) => this.decode(row));
  }
  private decode(row: Record<string, unknown>): TaskRecord {
    return {
      owner: row.owner as Owner,
      requestKey: String(row.request_key),
      task: String(row.task),
      expiresAt: Number(row.expires_at),
      snapshot: JSON.parse(String(row.snapshot)) as Snapshot,
      ...(row.checkpoint ? { checkpoint: String(row.checkpoint) } : {}),
    };
  }
  get(owner: Owner, receipt: string): TaskRecord {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE receipt=? AND owner=?')
      .get(receipt, owner);
    if (!row || Number(row.expires_at) <= Date.now())
      throw new AppError(404, 'Task unavailable.');
    return this.decode(row);
  }
  recover(
    owner: Owner,
    requestKey: string,
    task: string,
  ): TaskRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE owner=? AND request_key=?')
      .get(owner, requestKey);
    if (!row) return;
    if (row.task !== task)
      throw new AppError(409, 'Request key already has a different task.');
    return this.get(owner, String(row.receipt));
  }
  admit(
    owner: Owner,
    requestKey: string,
    task: string,
    deadlineAt: number,
  ): TaskRecord {
    // Retention deletion is explicit: the sample refuses growth after 128 receipts.
    const count = this.db.prepare('SELECT count(*) AS n FROM tasks').get()!;
    if (Number(count.n) >= 128)
      throw new AppError(
        429,
        'Private store is full; stop and explicitly retire its directory.',
      );
    const snapshot: Snapshot = {
      receipt: randomUUID(),
      revision: 1,
      phase: 'queued',
      deadlineAt,
    };
    this.db
      .prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,NULL)')
      .run(
        snapshot.receipt,
        owner,
        requestKey,
        task,
        Date.now() + 3_600_000,
        JSON.stringify(snapshot),
      );
    return this.get(owner, snapshot.receipt);
  }
  update(
    owner: Owner,
    receipt: string,
    change: Partial<Snapshot>,
    checkpoint?: string,
  ): Snapshot {
    const record = this.get(owner, receipt);
    const next = {
      ...record.snapshot,
      ...change,
      revision: record.snapshot.revision + 1,
    };
    // A live authority token is never durable.
    delete next.approval;
    this.db
      .prepare(
        'UPDATE tasks SET snapshot=?, checkpoint=COALESCE(?,checkpoint) WHERE receipt=?',
      )
      .run(JSON.stringify(next), checkpoint ?? null, receipt);
    return next;
  }
  publish(owner: Owner, receipt: string, bytes: string): Snapshot {
    const record = this.get(owner, receipt);
    if (record.snapshot.artifact)
      throw new AppError(409, 'Publication already committed.');
    const handle = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('INSERT INTO artifacts VALUES(?,?,?)')
        .run(handle, receipt, bytes);
      const next = this.update(owner, receipt, {
        artifact: { handle, filename: 'presentation.json' },
      });
      this.db.exec('COMMIT');
      return next;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  artifact(owner: Owner, handle: string): string {
    const row = this.db
      .prepare(
        'SELECT artifacts.bytes, tasks.receipt FROM artifacts JOIN tasks USING(receipt) WHERE handle=? AND owner=?',
      )
      .get(handle, owner);
    if (!row) throw new AppError(404, 'Artifact unavailable.');
    this.get(owner, String(row.receipt));
    return String(row.bytes);
  }
  storeReport(report: StoredReport): undefined {
    const bytes = JSON.stringify(report);
    if (Buffer.byteLength(bytes) > 64_000 || report.expiresAt <= Date.now())
      throw new AppError(409, 'Report unavailable.');
    const count = this.db.prepare('SELECT count(*) AS n FROM reports').get()!;
    if (Number(count.n) >= 128)
      throw new AppError(429, 'Report store is full.');
    this.db
      .prepare('INSERT INTO reports VALUES(?,?,?,?)')
      .run(report.reference, report.owner, report.expiresAt, bytes);
    return undefined;
  }
  reportReferences(owner: Owner): string[] {
    return this.db
      .prepare('SELECT reference FROM reports WHERE owner=? AND expires_at>?')
      .all(owner, Date.now())
      .map((row) => String(row.reference));
  }
  report(owner: Owner, reference: string): StoredReport {
    const row = this.db
      .prepare(
        'SELECT json FROM reports WHERE reference=? AND owner=? AND expires_at>?',
      )
      .get(reference, owner, Date.now());
    if (!row) throw new AppError(404, 'Report unavailable.');
    return JSON.parse(String(row.json)) as StoredReport;
  }
  close(): void {
    try {
      this.db.close();
    } finally {
      this.lock.close();
    }
  }
}
