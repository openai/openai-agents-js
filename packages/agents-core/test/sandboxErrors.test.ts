import { describe, expect, it } from 'vitest';
import { UserError } from '../src';
import {
  SandboxApplyPatchDecodeError,
  SandboxApplyPatchDiffError,
  SandboxApplyPatchFileNotFoundError,
  SandboxApplyPatchPathError,
  SandboxConfigError,
  SandboxError,
  SandboxExecNonZeroError,
  SandboxExecTimeoutError,
  SandboxExecTransportError,
  SandboxExposedPortUnavailableError,
  SandboxGitCloneError,
  SandboxGitCopyError,
  SandboxGitMissingInImageError,
  SandboxInvalidCompressionSchemeError,
  SandboxInvalidManifestPathError,
  SandboxLocalChecksumError,
  SandboxLocalDirReadError,
  SandboxLocalFileReadError,
  SandboxMountCommandError,
  SandboxMountConfigError,
  SandboxMountToolMissingError,
  SandboxPtySessionNotFoundError,
  SandboxSkillsConfigError,
  SandboxSnapshotNotRestorableError,
  SandboxSnapshotPersistError,
  SandboxSnapshotRestoreError,
  SandboxWorkspaceArchiveReadError,
  SandboxWorkspaceArchiveWriteError,
  SandboxWorkspaceReadNotFoundError,
  SandboxWorkspaceRootNotFoundError,
  SandboxWorkspaceStartError,
  SandboxWorkspaceStopError,
  SandboxWorkspaceWriteTypeError,
} from '../src/sandbox';

describe('sandbox errors', () => {
  it('defaults the base sandbox error to runtime_error', () => {
    const error = new SandboxError('failed', undefined, { provider: 'fake' });

    expect(error).toBeInstanceOf(UserError);
    expect(error.name).toBe('SandboxError');
    expect(error.code).toBe('runtime_error');
    expect(error.details).toEqual({ provider: 'fake' });
  });

  it('exposes Python-parity error codes for concrete sandbox failures', () => {
    const cases: Array<[SandboxError, string, string]> = [
      [
        new SandboxInvalidManifestPathError('bad path'),
        'invalid_manifest_path',
        'SandboxInvalidManifestPathError',
      ],
      [
        new SandboxInvalidCompressionSchemeError('bad compression'),
        'invalid_compression_scheme',
        'SandboxInvalidCompressionSchemeError',
      ],
      [
        new SandboxExposedPortUnavailableError('port unavailable'),
        'exposed_port_unavailable',
        'SandboxExposedPortUnavailableError',
      ],
      [
        new SandboxExecNonZeroError('nonzero'),
        'exec_nonzero',
        'SandboxExecNonZeroError',
      ],
      [
        new SandboxExecTimeoutError('timeout'),
        'exec_timeout',
        'SandboxExecTimeoutError',
      ],
      [
        new SandboxExecTransportError('transport'),
        'exec_transport_error',
        'SandboxExecTransportError',
      ],
      [
        new SandboxPtySessionNotFoundError('missing session'),
        'pty_session_not_found',
        'SandboxPtySessionNotFoundError',
      ],
      [
        new SandboxApplyPatchPathError('bad patch path'),
        'apply_patch_invalid_path',
        'SandboxApplyPatchPathError',
      ],
      [
        new SandboxApplyPatchDiffError('bad diff'),
        'apply_patch_invalid_diff',
        'SandboxApplyPatchDiffError',
      ],
      [
        new SandboxApplyPatchFileNotFoundError('missing file'),
        'apply_patch_file_not_found',
        'SandboxApplyPatchFileNotFoundError',
      ],
      [
        new SandboxApplyPatchDecodeError('decode failed'),
        'apply_patch_decode_error',
        'SandboxApplyPatchDecodeError',
      ],
      [
        new SandboxWorkspaceReadNotFoundError('read missing'),
        'workspace_read_not_found',
        'SandboxWorkspaceReadNotFoundError',
      ],
      [
        new SandboxWorkspaceArchiveReadError('archive read'),
        'workspace_archive_read_error',
        'SandboxWorkspaceArchiveReadError',
      ],
      [
        new SandboxWorkspaceArchiveWriteError('archive write'),
        'workspace_archive_write_error',
        'SandboxWorkspaceArchiveWriteError',
      ],
      [
        new SandboxWorkspaceWriteTypeError('write type'),
        'workspace_write_type_error',
        'SandboxWorkspaceWriteTypeError',
      ],
      [
        new SandboxWorkspaceStopError('stop failed'),
        'workspace_stop_error',
        'SandboxWorkspaceStopError',
      ],
      [
        new SandboxWorkspaceStartError('start failed'),
        'workspace_start_error',
        'SandboxWorkspaceStartError',
      ],
      [
        new SandboxWorkspaceRootNotFoundError('root missing'),
        'workspace_root_not_found',
        'SandboxWorkspaceRootNotFoundError',
      ],
      [
        new SandboxLocalFileReadError('local file'),
        'local_file_read_error',
        'SandboxLocalFileReadError',
      ],
      [
        new SandboxLocalDirReadError('local dir'),
        'local_dir_read_error',
        'SandboxLocalDirReadError',
      ],
      [
        new SandboxLocalChecksumError('checksum'),
        'local_checksum_error',
        'SandboxLocalChecksumError',
      ],
      [
        new SandboxGitMissingInImageError('git missing'),
        'git_missing_in_image',
        'SandboxGitMissingInImageError',
      ],
      [
        new SandboxGitCloneError('git clone'),
        'git_clone_error',
        'SandboxGitCloneError',
      ],
      [
        new SandboxGitCopyError('git copy'),
        'git_copy_error',
        'SandboxGitCopyError',
      ],
      [
        new SandboxMountToolMissingError('mount tool'),
        'mount_missing_tool',
        'SandboxMountToolMissingError',
      ],
      [
        new SandboxMountCommandError('mount failed'),
        'mount_failed',
        'SandboxMountCommandError',
      ],
      [
        new SandboxMountConfigError('mount config'),
        'mount_config_invalid',
        'SandboxMountConfigError',
      ],
      [
        new SandboxSkillsConfigError('skills config'),
        'skills_config_invalid',
        'SandboxSkillsConfigError',
      ],
      [
        new SandboxConfigError('sandbox config'),
        'sandbox_config_invalid',
        'SandboxConfigError',
      ],
      [
        new SandboxSnapshotPersistError('snapshot persist'),
        'snapshot_persist_error',
        'SandboxSnapshotPersistError',
      ],
      [
        new SandboxSnapshotRestoreError('snapshot restore'),
        'snapshot_restore_error',
        'SandboxSnapshotRestoreError',
      ],
      [
        new SandboxSnapshotNotRestorableError('snapshot not restorable'),
        'snapshot_not_restorable',
        'SandboxSnapshotNotRestorableError',
      ],
    ];

    for (const [error, code, name] of cases) {
      expect(error).toBeInstanceOf(SandboxError);
      expect(error).toBeInstanceOf(UserError);
      expect(error.code).toBe(code);
      expect(error.name).toBe(name);
    }
  });

  it('preserves structured details on concrete errors', () => {
    const error = new SandboxExecTimeoutError('command timed out', {
      command: ['npm', 'test'],
      timeoutMs: 1000,
    });

    expect(error.details).toEqual({
      command: ['npm', 'test'],
      timeoutMs: 1000,
    });
  });
});
