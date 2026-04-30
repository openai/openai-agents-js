import type {
  NoopSnapshotSpec,
  RemoteSnapshot,
  RemoteSnapshotSpec,
  Snapshot,
  SnapshotSpec,
} from '../snapshot';

export interface LocalSnapshot extends Snapshot {
  type: 'local';
  path: string;
}

export interface LocalSnapshotSpec extends SnapshotSpec {
  type: 'local';
  baseDir?: string;
}

export type LocalSandboxSnapshotSpec =
  | LocalSnapshotSpec
  | RemoteSnapshotSpec
  | NoopSnapshotSpec;
export type LocalSandboxSnapshot = LocalSnapshot | RemoteSnapshot;
