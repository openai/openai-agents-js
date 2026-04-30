import { randomUUID } from '@openai/agents-core/_shims';

export interface Snapshot {
  id: string;
  type: string;
  [key: string]: unknown;
}

export interface SnapshotSpec {
  type: string;
  [key: string]: unknown;
}

export type RemoteSnapshotSaveArgs = {
  id?: string;
  data: Uint8Array;
  metadata?: Record<string, unknown>;
};

export type RemoteSnapshotLoadArgs = {
  id: string;
};

export type RemoteSnapshotDeleteArgs = {
  id: string;
};

export interface RemoteSnapshotStore {
  save(args: RemoteSnapshotSaveArgs): Promise<{
    id: string;
    metadata?: Record<string, unknown>;
  }>;
  load(args: RemoteSnapshotLoadArgs): Promise<{
    data: Uint8Array;
    metadata?: Record<string, unknown>;
  }>;
  delete?(args: RemoteSnapshotDeleteArgs): Promise<void>;
  exists?(args: RemoteSnapshotLoadArgs): Promise<boolean>;
}

export interface RemoteSnapshot extends Snapshot {
  type: 'remote';
  metadata?: Record<string, unknown>;
}

export interface RemoteSnapshotSpec extends SnapshotSpec {
  type: 'remote';
  id?: string;
  store: RemoteSnapshotStore;
  metadata?: Record<string, unknown>;
}

export class NoopSnapshotSpec implements SnapshotSpec {
  readonly type = 'noop';
  readonly [key: string]: unknown;
}

export function isNoopSnapshotSpec(
  spec: SnapshotSpec | null | undefined,
): spec is NoopSnapshotSpec {
  return spec?.type === 'noop';
}

export class InMemoryRemoteSnapshotStore implements RemoteSnapshotStore {
  private readonly snapshots = new Map<
    string,
    { data: Uint8Array; metadata?: Record<string, unknown> }
  >();

  async save(args: RemoteSnapshotSaveArgs): Promise<{
    id: string;
    metadata?: Record<string, unknown>;
  }> {
    const id = args.id ?? randomUUID();
    const metadata = args.metadata ? { ...args.metadata } : undefined;
    this.snapshots.set(id, {
      data: new Uint8Array(args.data),
      ...(metadata ? { metadata } : {}),
    });
    return {
      id,
      ...(metadata ? { metadata } : {}),
    };
  }

  async load(args: RemoteSnapshotLoadArgs): Promise<{
    data: Uint8Array;
    metadata?: Record<string, unknown>;
  }> {
    const snapshot = this.snapshots.get(args.id);
    if (!snapshot) {
      throw new Error(`Remote snapshot not found: ${args.id}`);
    }
    return {
      data: new Uint8Array(snapshot.data),
      ...(snapshot.metadata ? { metadata: { ...snapshot.metadata } } : {}),
    };
  }

  async delete(args: RemoteSnapshotDeleteArgs): Promise<void> {
    this.snapshots.delete(args.id);
  }

  async exists(args: RemoteSnapshotLoadArgs): Promise<boolean> {
    return this.snapshots.has(args.id);
  }
}
