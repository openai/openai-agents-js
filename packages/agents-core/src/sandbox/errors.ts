import { UserError } from '../errors';

export type SandboxErrorCode =
  | 'configuration_error'
  | 'runtime_error'
  | 'artifact_error'
  | 'snapshot_error'
  | 'archive_error'
  | 'mount_error'
  | 'lifecycle_error'
  | 'pty_error'
  | 'unsupported_feature'
  | 'path_resolution_error'
  | 'provider_error'
  | 'invalid_manifest_path'
  | 'invalid_compression_scheme'
  | 'exposed_port_unavailable'
  | 'exec_nonzero'
  | 'exec_timeout'
  | 'exec_transport_error'
  | 'pty_session_not_found'
  | 'apply_patch_invalid_path'
  | 'apply_patch_invalid_diff'
  | 'apply_patch_file_not_found'
  | 'apply_patch_decode_error'
  | 'workspace_read_not_found'
  | 'workspace_archive_read_error'
  | 'workspace_archive_write_error'
  | 'workspace_write_type_error'
  | 'workspace_stop_error'
  | 'workspace_start_error'
  | 'workspace_root_not_found'
  | 'local_file_read_error'
  | 'local_dir_read_error'
  | 'local_checksum_error'
  | 'git_missing_in_image'
  | 'git_clone_error'
  | 'git_subpath_error'
  | 'git_copy_error'
  | 'mount_missing_tool'
  | 'mount_failed'
  | 'mount_config_invalid'
  | 'skills_config_invalid'
  | 'sandbox_config_invalid'
  | 'snapshot_persist_error'
  | 'snapshot_restore_error'
  | 'snapshot_not_restorable';

export class SandboxError extends UserError {
  readonly code: SandboxErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: SandboxErrorCode = 'runtime_error',
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export class SandboxConfigurationError extends SandboxError {
  constructor(
    message: string,
    details?: Record<string, unknown>,
    code: SandboxErrorCode = 'configuration_error',
  ) {
    super(message, code, details);
  }
}

export class SandboxRuntimeError extends SandboxError {
  constructor(
    message: string,
    details?: Record<string, unknown>,
    code: SandboxErrorCode = 'runtime_error',
  ) {
    super(message, code, details);
  }
}

export class SandboxArtifactError extends SandboxError {
  constructor(
    message: string,
    details?: Record<string, unknown>,
    code: SandboxErrorCode = 'artifact_error',
  ) {
    super(message, code, details);
  }
}

export class SandboxSnapshotError extends SandboxError {
  constructor(
    message: string,
    details?: Record<string, unknown>,
    code: SandboxErrorCode = 'snapshot_error',
  ) {
    super(message, code, details);
  }
}

export class SandboxArchiveError extends SandboxError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'archive_error', details);
  }
}

export class SandboxMountError extends SandboxError {
  constructor(
    message: string,
    details?: Record<string, unknown>,
    code: SandboxErrorCode = 'mount_error',
  ) {
    super(message, code, details);
  }
}

export class SandboxLifecycleError extends SandboxError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'lifecycle_error', details);
  }
}

export class SandboxPtyError extends SandboxError {
  constructor(
    message: string,
    details?: Record<string, unknown>,
    code: SandboxErrorCode = 'pty_error',
  ) {
    super(message, code, details);
  }
}

export class SandboxUnsupportedFeatureError extends SandboxError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'unsupported_feature', details);
  }
}

export class SandboxPathResolutionError extends SandboxError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'path_resolution_error', details);
  }
}

export class SandboxProviderError extends SandboxError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'provider_error', details);
  }
}

export class SandboxInvalidManifestPathError extends SandboxError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'invalid_manifest_path', details);
  }
}

export class SandboxInvalidCompressionSchemeError extends SandboxError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'invalid_compression_scheme', details);
  }
}

export class SandboxExposedPortUnavailableError extends SandboxRuntimeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details, 'exposed_port_unavailable');
  }
}

export class SandboxExecError extends SandboxRuntimeError {
  constructor(
    message: string,
    code: Extract<
      SandboxErrorCode,
      'exec_nonzero' | 'exec_timeout' | 'exec_transport_error'
    >,
    details?: Record<string, unknown>,
  ) {
    super(message, details, code);
  }
}

export class SandboxExecNonZeroError extends SandboxExecError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'exec_nonzero', details);
  }
}

export class SandboxExecTimeoutError extends SandboxExecError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'exec_timeout', details);
  }
}

export class SandboxExecTransportError extends SandboxExecError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'exec_transport_error', details);
  }
}

export class SandboxPtySessionNotFoundError extends SandboxPtyError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details, 'pty_session_not_found');
  }
}

export class SandboxApplyPatchError extends SandboxError {
  constructor(
    message: string,
    code: Extract<
      SandboxErrorCode,
      | 'apply_patch_invalid_path'
      | 'apply_patch_invalid_diff'
      | 'apply_patch_file_not_found'
      | 'apply_patch_decode_error'
    >,
    details?: Record<string, unknown>,
  ) {
    super(message, code, details);
  }
}

export class SandboxApplyPatchPathError extends SandboxApplyPatchError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'apply_patch_invalid_path', details);
  }
}

export class SandboxApplyPatchDiffError extends SandboxApplyPatchError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'apply_patch_invalid_diff', details);
  }
}

export class SandboxApplyPatchFileNotFoundError extends SandboxApplyPatchError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'apply_patch_file_not_found', details);
  }
}

export class SandboxApplyPatchDecodeError extends SandboxApplyPatchError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'apply_patch_decode_error', details);
  }
}

export class SandboxWorkspaceError extends SandboxRuntimeError {
  constructor(
    message: string,
    code: Extract<
      SandboxErrorCode,
      | 'workspace_read_not_found'
      | 'workspace_archive_read_error'
      | 'workspace_archive_write_error'
      | 'workspace_write_type_error'
      | 'workspace_stop_error'
      | 'workspace_start_error'
      | 'workspace_root_not_found'
    >,
    details?: Record<string, unknown>,
  ) {
    super(message, details, code);
  }
}

export class SandboxWorkspaceReadNotFoundError extends SandboxWorkspaceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'workspace_read_not_found', details);
  }
}

export class SandboxWorkspaceArchiveReadError extends SandboxWorkspaceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'workspace_archive_read_error', details);
  }
}

export class SandboxWorkspaceArchiveWriteError extends SandboxWorkspaceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'workspace_archive_write_error', details);
  }
}

export class SandboxWorkspaceWriteTypeError extends SandboxWorkspaceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'workspace_write_type_error', details);
  }
}

export class SandboxWorkspaceStopError extends SandboxWorkspaceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'workspace_stop_error', details);
  }
}

export class SandboxWorkspaceStartError extends SandboxWorkspaceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'workspace_start_error', details);
  }
}

export class SandboxWorkspaceRootNotFoundError extends SandboxWorkspaceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'workspace_root_not_found', details);
  }
}

export class SandboxLocalArtifactError extends SandboxArtifactError {
  constructor(
    message: string,
    code: Extract<
      SandboxErrorCode,
      'local_file_read_error' | 'local_dir_read_error' | 'local_checksum_error'
    >,
    details?: Record<string, unknown>,
  ) {
    super(message, details, code);
  }
}

export class SandboxLocalFileReadError extends SandboxLocalArtifactError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'local_file_read_error', details);
  }
}

export class SandboxLocalDirReadError extends SandboxLocalArtifactError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'local_dir_read_error', details);
  }
}

export class SandboxLocalChecksumError extends SandboxLocalArtifactError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'local_checksum_error', details);
  }
}

export class SandboxGitArtifactError extends SandboxArtifactError {
  constructor(
    message: string,
    code: Extract<
      SandboxErrorCode,
      | 'git_missing_in_image'
      | 'git_clone_error'
      | 'git_subpath_error'
      | 'git_copy_error'
    >,
    details?: Record<string, unknown>,
  ) {
    super(message, details, code);
  }
}

export class SandboxGitMissingInImageError extends SandboxGitArtifactError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'git_missing_in_image', details);
  }
}

export class SandboxGitCloneError extends SandboxGitArtifactError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'git_clone_error', details);
  }
}

export class SandboxGitSubpathError extends SandboxGitArtifactError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'git_subpath_error', details);
  }
}

export class SandboxGitCopyError extends SandboxGitArtifactError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'git_copy_error', details);
  }
}

export class SandboxMountToolMissingError extends SandboxMountError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details, 'mount_missing_tool');
  }
}

export class SandboxMountCommandError extends SandboxMountError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details, 'mount_failed');
  }
}

export class SandboxMountConfigError extends SandboxMountError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details, 'mount_config_invalid');
  }
}

export class SandboxSkillsConfigError extends SandboxError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'skills_config_invalid', details);
  }
}

export class SandboxConfigError extends SandboxConfigurationError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details, 'sandbox_config_invalid');
  }
}

export class SandboxSnapshotPersistError extends SandboxSnapshotError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details, 'snapshot_persist_error');
  }
}

export class SandboxSnapshotRestoreError extends SandboxSnapshotError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details, 'snapshot_restore_error');
  }
}

export class SandboxSnapshotNotRestorableError extends SandboxSnapshotError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details, 'snapshot_not_restorable');
  }
}
