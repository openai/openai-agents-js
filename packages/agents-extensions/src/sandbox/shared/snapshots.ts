import { SandboxSnapshotError } from '@openai/agents-core/sandbox';
import { toWorkspaceArchiveBytes } from './archive';

export type NativeSnapshotProvider =
  | 'e2b'
  | 'modal_snapshot_directory'
  | 'modal_snapshot_filesystem'
  | 'runloop'
  | 'vercel';

export type NativeSnapshotRef = {
  provider: NativeSnapshotProvider;
  snapshotId: string;
  workspacePersistence?: string;
};

const NATIVE_SNAPSHOT_PREFIXES: Record<NativeSnapshotProvider, string> = {
  e2b: 'E2B_SANDBOX_SNAPSHOT_V1\n',
  modal_snapshot_directory: 'MODAL_SANDBOX_DIR_SNAPSHOT_V1\n',
  modal_snapshot_filesystem: 'MODAL_SANDBOX_FS_SNAPSHOT_V1\n',
  runloop: 'RUNLOOP_SANDBOX_SNAPSHOT_V1\n',
  vercel: 'UC_VERCEL_SNAPSHOT_V1\n',
};

export function encodeNativeSnapshotRef(ref: NativeSnapshotRef): Uint8Array {
  const prefix = NATIVE_SNAPSHOT_PREFIXES[ref.provider];
  const body = JSON.stringify(
    {
      snapshot_id: ref.snapshotId,
      ...(ref.workspacePersistence
        ? { workspace_persistence: ref.workspacePersistence }
        : {}),
    },
    Object.keys({
      snapshot_id: ref.snapshotId,
      workspace_persistence: ref.workspacePersistence,
    }).sort(),
  );
  return new TextEncoder().encode(`${prefix}${body}`);
}

export function decodeNativeSnapshotRef(
  data: string | ArrayBuffer | Uint8Array,
): NativeSnapshotRef | undefined {
  const text = new TextDecoder().decode(toWorkspaceArchiveBytes(data));

  for (const [provider, prefix] of Object.entries(NATIVE_SNAPSHOT_PREFIXES) as [
    NativeSnapshotProvider,
    string,
  ][]) {
    if (!text.startsWith(prefix)) {
      continue;
    }

    try {
      const payload = JSON.parse(text.slice(prefix.length)) as {
        snapshot_id?: unknown;
        workspace_persistence?: unknown;
      };
      if (typeof payload.snapshot_id !== 'string' || !payload.snapshot_id) {
        return undefined;
      }
      return {
        provider,
        snapshotId: payload.snapshot_id,
        workspacePersistence:
          typeof payload.workspace_persistence === 'string'
            ? payload.workspace_persistence
            : undefined,
      };
    } catch {
      return undefined;
    }
  }

  return undefined;
}

export function requireNativeSnapshotRef(
  data: string | ArrayBuffer | Uint8Array,
  provider: NativeSnapshotProvider,
): NativeSnapshotRef {
  const ref = decodeNativeSnapshotRef(data);
  if (!ref || ref.provider !== provider) {
    throw new SandboxSnapshotError(
      `Expected a ${provider} native snapshot reference.`,
      {
        provider,
      },
    );
  }
  return ref;
}
