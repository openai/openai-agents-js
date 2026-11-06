/** Private POSIX storage for the Node.js 24 external-thumbnail example. */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const privateState = () =>
  new Error(
    'Use application-owned private state outside every model-visible mount.',
  );

export class Busy extends Error {
  constructor() {
    super('Another host owns this order.');
    this.name = 'Busy';
  }
}

/**
 * The host selects an absolute directory with an existing trusted parent. Keep
 * its database, lock databases and sidecars outside all model-visible mounts.
 * The parent and processes with the same effective UID are trusted. This is a
 * local POSIX example, not a Windows or distributed-filesystem lock protocol.
 * All coordinators for this directory must use this protocol, not Python flock.
 */
export class ThumbnailStore {
  readonly directory: string;
  readonly tenant: string;

  constructor(directory: string, tenant: string) {
    if (!isAbsolute(directory) || !process.geteuid || !tenant)
      throw privateState();
    this.directory = directory;
    this.tenant = tenant;
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw privateState();
    }
    this.transaction((db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS thumbnails (
          tenant TEXT, order_id TEXT, color TEXT NOT NULL,
          receipt TEXT NOT NULL UNIQUE, image BLOB,
          PRIMARY KEY (tenant, order_id));
        CREATE TABLE IF NOT EXISTS orders (
          tenant TEXT, order_id TEXT, allowed INTEGER NOT NULL DEFAULT 1,
          generation INTEGER NOT NULL DEFAULT 0
            CHECK (typeof(generation) = 'integer' AND generation >= 0),
          binding TEXT, checkpoint TEXT, phase TEXT NOT NULL DEFAULT 'new',
          receipt_update TEXT, result TEXT, finished TEXT,
          PRIMARY KEY (tenant, order_id));
        CREATE TABLE IF NOT EXISTS mutations (
          tenant TEXT, order_id TEXT, operation TEXT, mutation_id TEXT NOT NULL,
          receipt TEXT NOT NULL, generation TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('reserved', 'spent')),
          PRIMARY KEY (tenant, order_id, operation));
      `);
    });
  }

  private checkDirectory(): void {
    try {
      const info = lstatSync(this.directory);
      if (
        !info.isDirectory() ||
        info.uid !== process.geteuid!() ||
        (info.mode & 0o077) !== 0
      )
        throw privateState();
    } catch {
      throw privateState();
    }
  }

  private checkFile(path: string): void {
    try {
      const info = lstatSync(path);
      if (
        !info.isFile() ||
        info.uid !== process.geteuid!() ||
        (info.mode & 0o077) !== 0 ||
        info.nlink !== 1
      )
        throw privateState();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw privateState();
    }
  }

  private checkFiles(path: string): void {
    this.checkDirectory();
    for (const suffix of ['', '-journal', '-wal', '-shm'])
      this.checkFile(path + suffix);
  }

  private openDatabase(name: string, timeout: number): DatabaseSync {
    this.checkDirectory();
    const path = join(this.directory, name);
    this.checkFiles(path);
    // Precreate the main file privately, independent of the process umask.
    let fd: number | undefined;
    try {
      fd = openSync(
        path,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_RDWR |
          constants.O_NOFOLLOW,
        0o600,
      );
      const info = fstatSync(fd);
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.uid !== process.geteuid!() ||
        (info.mode & 0o077) !== 0
      )
        throw privateState();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw privateState();
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    this.checkFiles(path);
    try {
      const db = new DatabaseSync(path, { timeout });
      try {
        db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
        this.checkFiles(path);
        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    } catch {
      throw privateState();
    }
  }

  /** Only synchronous, short application operations belong in a transaction. */
  transaction<T>(operation: (db: DatabaseSync) => T): T {
    const db = this.openDatabase('orders.sqlite3', 3000);
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = operation(db);
        if (result && typeof (result as { then?: unknown }).then === 'function')
          throw new TypeError(
            'A database transaction must not await host work.',
          );
        this.checkFiles(join(this.directory, 'orders.sqlite3'));
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      db.close();
    }
  }

  /** Hold a separate SQLite writer lock across host awaits; death releases it. */
  async owner<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw privateState();
    const name = `${key}.lock.sqlite3`;
    const db = this.openDatabase(name, 0);
    try {
      try {
        db.exec('BEGIN IMMEDIATE');
      } catch {
        throw new Busy();
      }
      try {
        return await operation();
      } finally {
        db.exec('ROLLBACK');
        this.checkFiles(join(this.directory, name));
      }
    } finally {
      db.close();
    }
  }

  /** The worker needs the authorized business order, not a model connection. */
  work(order: string): boolean {
    return this.transaction((db) => {
      const row = db
        .prepare(
          `SELECT color FROM thumbnails JOIN orders USING (tenant, order_id)
        WHERE tenant=? AND order_id=? AND allowed=1 AND image IS NULL`,
        )
        .get(this.tenant, order);
      if (!row) return false;
      if (row.color !== 'blue' && row.color !== 'red')
        throw new Error('This order has no supported thumbnail color.');
      const pixel = row.color === 'blue' ? [0, 0, 255] : [255, 0, 0];
      const pixels = Buffer.alloc(32 * 32 * 3);
      for (let offset = 0; offset < pixels.length; offset += 3)
        pixels.set(pixel, offset);
      const image = Buffer.concat([Buffer.from('P6\n32 32\n255\n'), pixels]);
      db.prepare(
        'UPDATE thumbnails SET image=? WHERE tenant=? AND order_id=?',
      ).run(image, this.tenant, order);
      return true;
    });
  }
}
