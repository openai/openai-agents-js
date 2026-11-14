export {
  assertHostPathGrantsRebound,
  deserializeMountCredentialRedactionMetadata,
  deserializeHostPathGrantRedactionMetadata,
  deserializeManifest,
  mergeManifestEntryDelta,
  mergeManifestDelta,
  rebindPersistedMountCredentials,
  rebindPersistedPathGrants,
  sanitizeEnvironmentForPersistence,
  serializeEnvironmentForPersistence,
  serializeHostPathGrantRedactionMetadata,
  serializeMountCredentialRedactionMetadata,
  serializeManifest,
  serializeManifestRecord,
} from './sandboxes/shared/manifestPersistence';
export {
  assertExistingMountTopologyPreserved,
  assertLiveMountCredentialAuthorityMatches,
  assertLiveMountEnvironmentAuthorityMatches,
  assertMountCredentialsRebound,
  assertSandboxSessionStateUsable,
  assertSandboxStateGenerationUnchanged,
  captureSandboxStateGeneration,
  captureLiveMountCredentialAuthority,
  captureLiveMountCredentialAuthorityIfAbsent,
  captureLiveMountEnvironmentAuthority,
  captureLiveMountRuntimeAuthority,
  copySandboxStateRuntimeAuthority,
  copyValidatedMountEffectivePaths,
  copyTrustedMountCredentialRebindProvenance,
  configuredMountCredentialFields,
  liveMountCredentialAuthorityMatches,
  liveMountEnvironmentAuthorityMatches,
  liveMountRuntimeAuthorityMatches,
  manifestHasNonResumableMountAuthority,
  isSandboxSessionStateUnsafe,
  isMountCredentialFileEnvironmentName,
  manifestHasInContainerMounts,
  mountCredentialEnvironmentForEntry,
  mountCredentialFileReferences,
  NON_RESUMABLE_MOUNT_AUTHORITY_KEY,
  markSandboxSessionStateUnsafe,
  recordLiveMountCredentialAuthority,
  resolveAndValidateMountEnvironment,
  sanitizeMountCredentialEnvironmentForPersistence,
  validateMountCredentialBoundariesAtEffectivePath,
  validateMountCredentialBoundaries,
  validateMountCredentialFileEffectivePaths,
  validateMountEnvironmentCredentialBoundaries,
  withExclusiveSandboxManifestMutation,
  withExclusiveSandboxStateInspection,
} from './mountSecurity';
export type {
  EffectiveManifestEntryPath,
  MountCredentialExposureDecision,
  MountCredentialFileReference,
} from './mountSecurity';
export { dispatchSandboxEvent } from './events';
export { openDockerGatewayScope } from './sandboxes/docker';
export { stableJsonStringify } from './shared/stableJson';
export {
  BOUNDED_FILE_READ_STATUS_BYTES,
  boundedFileReadCommand,
  decodeBoundedFileRead,
} from './shared/boundedFileRead';
export {
  Manifest,
  renderManifestDescription,
  cloneManifest,
  copyManifestMountCredentialExposurePolicy,
  replaceManifestMountCredentialExposurePolicy,
} from './manifest';
export {
  elapsedSeconds,
  formatExecResponse,
  truncateOutput,
} from './shared/output';
export {
  isHostPathStrictlyWithinRoot,
  isHostPathWithinRoot,
  relativeHostPathEscapesRoot,
  relativeHostPathEscapesRootOrSelf,
  sandboxPathGrantHostPath,
} from './shared/hostPath';
export {
  hasBackslashPathSeparator,
  hasEscapingParentPathSegment,
  hasParentPathSegment,
  isUnderPosixPath,
  normalizePosixPath,
  posixDirname,
  relativePosixPathWithinRoot,
} from './shared/posixPath';
export {
  assertShellEnvironmentName,
  deserializePersistedEnvironmentForRuntime,
  materializeEnvironment,
  materializeStaticEnvironment,
  mergeMaterializedEnvironment,
  mergeStaticMaterializedEnvironment,
  rehydratePersistedEnvironmentForRuntime,
  resolveEnvironmentReferences,
  serializeManifestEnvironment,
  serializeRuntimeEnvironmentForPersistence,
} from './shared/environment';
export { shellQuote } from './shared/shell';
export {
  isSandboxPathNotFoundError,
  probeSandboxDirectoryExists,
  probeSandboxPathExists,
  type SandboxPathProbeResult,
} from './shared/pathProbe';
export {
  isRecord,
  isStringRecord,
  readOptionalBoolean,
  readOptionalNumber,
  readOptionalNumberArray,
  readOptionalRecord,
  readOptionalRecordArray,
  readOptionalString,
  readOptionalStringRecord,
  readString,
  readStringArray,
} from './shared/typeGuards';
export {
  validateCredentialPair,
  type CredentialPairValidation,
} from './shared/credentials';
export {
  assertViewImageByteLength,
  imageOutputFromBytes,
  MAX_VIEW_IMAGE_BYTES,
  sniffImageMediaType,
  toUint8Array,
} from './shared/media';

export { cleanupSandboxSession } from './runtime/sessionLifecycle';

export {
  openLocalSourceDirectory,
  readLocalSourceFile,
  readLocalSourceFileAt,
  readLocalSourceEntriesAt,
  walkLocalSourceDirectoryEntries,
} from './shared/localSourceReader';

export { retainManagedWorkspaceSnapshot } from './sandboxes/shared/localSnapshots';

export { renderRemoteMountPolicyInstructions } from './runtime/prompts';

// Resource-only skill operations; no Classic capability or agent runtime.
export {
  createSkillConfiguration,
  processSkillManifest,
  resolveSkillRuntimeMetadata,
  resolveSkillsMetadata,
  renderSkillsDiscoveryInstructions,
  renderSkillsInstructions,
  resolveLazySkillEntry,
  joinRelativePaths,
} from './skillResources';
export type {
  SkillConfiguration,
  SkillsArgs,
  SkillDescriptor,
  SkillIndexEntry,
  LocalDirLazySkillSource,
} from './skillResources';

export { modelWorkspaceResourcePath } from './workspacePaths';

export { skillWorkspaceRoot } from './skillResources';

export {
  getSandboxStateIdentity,
  getLocalSandboxStateAuthority,
  isDeserializedSandboxState,
} from './internal/sessionStateTrust';

export { SandboxMemoryStorage } from './memory/storage';
export { memory } from './capabilities/memory';
export {
  RolloutExtractionArtifactsSchema,
  validateRolloutArtifacts,
  formatRawMemory,
  formatRolloutSummary,
} from './memory/artifacts';

export { beforeGitRepoCopy } from './internal/gitRepoCopy';

export {
  exceptionName as sandboxMemoryExceptionName,
  exceptionMessage as sandboxMemoryExceptionMessage,
} from './memory/rollouts';

export {
  applyManifestToProvidedSession,
  collectAdditiveManifestEntries,
} from './runtime/providedSessionManifest';
export {
  createWorkspaceFileNoFollow,
  hasExclusiveWorkspaceCreate,
  registerExclusiveWorkspaceCreate,
} from './sandboxes/shared/exclusiveWorkspaceFiles';

export { applyPatchFormat } from './internal/patchFormat';
