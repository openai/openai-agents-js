import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  dockerVolumeMountStrategy,
  file,
  gcsMount,
  inContainerMountStrategy,
  Manifest,
  s3Mount,
  s3FilesMount,
  type MountStrategy,
} from '../src/sandbox';
import {
  assertExistingMountTopologyPreserved,
  captureLiveMountCredentialAuthorityIfAbsent,
  deserializeManifest,
  deserializeMountCredentialRedactionMetadata,
  liveMountCredentialAuthorityMatches,
  liveMountEnvironmentAuthorityMatches,
  manifestHasNonResumableMountAuthority,
  NON_RESUMABLE_MOUNT_AUTHORITY_KEY,
  recordLiveMountCredentialAuthority,
  rebindPersistedMountCredentials,
  sanitizeMountCredentialEnvironmentForPersistence,
  serializeManifestRecord,
  serializeMountCredentialRedactionMetadata,
  validateMountCredentialBoundaries,
  validateMountEnvironmentCredentialBoundaries,
} from '../src/sandbox/internal';
import { assertMountCredentialsRebound } from '../src/sandbox/mountSecurity';
import {
  sanitizeSerializedSandboxState,
  toSessionStateEnvelope,
} from '../src/sandbox/runtime/sessionState';
import { rebindPersistedPathGrants } from '../src/sandbox/sandboxes/shared/manifestPersistence';
import { materializeLocalWorkspaceManifest } from '../src/sandbox/sandboxes/shared/localWorkspace';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function credentialedS3Manifest(
  strategy: MountStrategy,
  options: { mountPath?: string } = {},
): Manifest {
  return new Manifest({
    entries: {
      remote: s3Mount({
        bucket: 'example',
        accessKeyId: 'ACCESS_KEY_SENTINEL',
        secretAccessKey: 'SECRET_KEY_SENTINEL',
        mountStrategy: strategy,
        ...options,
      }),
    },
  });
}

describe('sandbox mount credential boundaries', () => {
  it('rejects credential-bearing in-container mounts without exposing values', () => {
    const manifest = credentialedS3Manifest(inContainerMountStrategy());

    let error: unknown;
    try {
      validateMountCredentialBoundaries(manifest);
    } catch (cause) {
      error = cause;
    }

    expect(error).toMatchObject({
      code: 'mount_config_invalid',
      details: {
        mountPath: '/workspace/remote',
        mountType: 's3_mount',
        mountStrategy: 'in_container',
        credentialFields: ['accessKeyId', 'secretAccessKey'],
      },
    });
    expect(JSON.stringify(error)).not.toContain('ACCESS_KEY_SENTINEL');
    expect(JSON.stringify(error)).not.toContain('SECRET_KEY_SENTINEL');
  });

  it('preserves credentialless and external/provider-native mount alternatives', () => {
    validateMountCredentialBoundaries(
      new Manifest({
        entries: {
          public: s3Mount({
            bucket: 'public',
            mountStrategy: inContainerMountStrategy(),
          }),
        },
      }),
    );
    validateMountCredentialBoundaries(
      credentialedS3Manifest(dockerVolumeMountStrategy({ driver: 'rclone' })),
    );
    validateMountCredentialBoundaries(
      credentialedS3Manifest({ type: 'modal_cloud_bucket' }),
    );
  });

  it('treats an Azure managed identity selector as explicit mount authority', () => {
    const manifest = new Manifest({
      entries: {
        remote: {
          type: 'azure_blob_mount',
          accountName: 'account',
          container: 'private',
          identityClientId: 'MANAGED_IDENTITY_SELECTOR',
          mountStrategy: inContainerMountStrategy(),
        },
      },
    });

    expect(() => validateMountCredentialBoundaries(manifest)).toThrow(
      /model-controlled sandbox/u,
    );
    expect(() =>
      validateMountCredentialBoundaries(
        manifest.withInContainerMountCredentialExposureAllowed('remote'),
      ),
    ).not.toThrow();
  });

  it.each([
    {
      label: 'partial S3 pair',
      entry: {
        type: 's3_mount' as const,
        bucket: 'private',
        accessKeyId: 'access-key',
        mountStrategy: inContainerMountStrategy(),
      },
    },
    {
      label: 'S3 session token without a key pair',
      entry: {
        type: 's3_mount' as const,
        bucket: 'private',
        sessionToken: 'session-token',
        mountStrategy: inContainerMountStrategy(),
      },
    },
    {
      label: 'partial GCS HMAC pair',
      entry: {
        type: 'gcs_mount' as const,
        bucket: 'private',
        accessId: 'access-id',
        mountStrategy: inContainerMountStrategy(),
      },
    },
  ])('rejects $label before mount path resolution', ({ entry }) => {
    const manifest = new Manifest({
      entries: { remote: entry },
    }).withInContainerMountCredentialExposureAllowed('remote');

    expect(() => validateMountCredentialBoundaries(manifest)).toThrow(
      /complete|both/u,
    );
  });

  it('requires exact opt-in for implicit workload identity mount patterns', () => {
    const manifests = [
      new Manifest({
        entries: {
          remote: s3FilesMount({
            fileSystemId: 'fs-123',
            mountStrategy: inContainerMountStrategy({
              pattern: { type: 's3files' },
            }),
          }),
        },
      }),
      new Manifest({
        entries: {
          remote: {
            type: 'azure_blob_mount',
            accountName: 'account',
            container: 'private',
            mountStrategy: inContainerMountStrategy({
              pattern: { type: 'fuse' },
            }),
          },
        },
      }),
    ];

    for (const manifest of manifests) {
      expect(() => validateMountCredentialBoundaries(manifest)).toThrow(
        /model-controlled sandbox/u,
      );
      expect(() =>
        validateMountCredentialBoundaries(
          manifest.withInContainerMountCredentialExposureAllowed('remote'),
        ),
      ).not.toThrow();
    }
  });

  it('requires a trusted exact effective mount path opt-in', () => {
    const manifest = credentialedS3Manifest(inContainerMountStrategy(), {
      mountPath: '/workspace/data',
    });
    const trusted =
      manifest.withInContainerMountCredentialExposureAllowed('data');

    validateMountCredentialBoundaries(trusted);
    expect(() =>
      manifest.withInContainerMountCredentialExposureAllowed('other'),
    ).not.toThrow();
    expect(() =>
      validateMountCredentialBoundaries(
        manifest.withInContainerMountCredentialExposureAllowed('other'),
      ),
    ).toThrow(/exact path/u);
    expect(JSON.stringify(trusted)).not.toContain(
      'inContainerMountCredentialExposureAllowedPaths',
    );
  });

  it('rejects empty and workspace-root exposure paths', () => {
    const manifest = credentialedS3Manifest(inContainerMountStrategy());

    for (const path of ['', ' ', '.', '/', '/workspace']) {
      expect(() =>
        manifest.withInContainerMountCredentialExposureAllowed(path),
      ).toThrow(/non-root path/u);
    }
  });

  it('supports trusted exact absolute mount paths outside the workspace root', () => {
    const trusted = credentialedS3Manifest(inContainerMountStrategy(), {
      mountPath: '/mnt/private',
    }).withInContainerMountCredentialExposureAllowed('/mnt/private');

    expect(() => validateMountCredentialBoundaries(trusted)).not.toThrow();
  });

  it('does not accept exposure policy from manifest init objects', () => {
    expect(
      () =>
        new Manifest({
          inContainerMountCredentialExposureAllowedPaths: ['remote'],
        } as never),
    ).toThrow(/credential exposure/u);
  });

  it('rejects rclone credential config stored in a serialized entry', () => {
    const manifest = new Manifest({
      entries: {
        'rclone.conf': file({
          content: '[remote]\nsecret = RCLONE_SECRET_SENTINEL\n',
        }),
        remote: s3Mount({
          bucket: 'example',
          mountStrategy: inContainerMountStrategy({
            pattern: { type: 'rclone', configFilePath: 'rclone.conf' },
          }),
        }),
      },
    }).withInContainerMountCredentialExposureAllowed('remote');

    expect(() => validateMountCredentialBoundaries(manifest)).toThrow(
      /serialized manifest entry/u,
    );
  });

  it('rejects explicit and environment credential files in manifest entries', () => {
    const explicit = new Manifest({
      entries: {
        'gcp.json': file({ content: 'GCP_FILE_SECRET_SENTINEL' }),
        remote: {
          type: 'gcs_mount',
          bucket: 'private',
          serviceAccountFile: '/workspace/gcp.json',
          mountStrategy: inContainerMountStrategy(),
        },
      },
    }).withInContainerMountCredentialExposureAllowed('remote');
    expect(() => validateMountCredentialBoundaries(explicit)).toThrow(
      /credential files cannot come from a serialized manifest entry/u,
    );
    expect(() => serializeManifestRecord(explicit)).toThrow(
      /credential files cannot come from a serialized manifest entry/u,
    );

    const ambient = new Manifest({
      entries: {
        'gcp.json': file({ content: 'GCP_ENV_FILE_SECRET_SENTINEL' }),
        remote: {
          type: 'gcs_mount',
          bucket: 'private',
          mountStrategy: inContainerMountStrategy(),
        },
      },
      environment: {
        GOOGLE_APPLICATION_CREDENTIALS: '/workspace/gcp.json',
      },
    }).withInContainerMountCredentialExposureAllowed('remote');
    expect(() =>
      validateMountEnvironmentCredentialBoundaries(ambient, {
        GOOGLE_APPLICATION_CREDENTIALS: '/workspace/gcp.json',
      }),
    ).toThrow(/credential files cannot come from a serialized manifest entry/u);

    const recursiveExplicit = new Manifest({
      entries: {
        secrets: { type: 'local_dir', src: '/trusted/secrets' },
        remote: {
          type: 'gcs_mount',
          bucket: 'private',
          serviceAccountFile: '/workspace/secrets/gcp.json',
          mountStrategy: inContainerMountStrategy(),
        },
      },
    }).withInContainerMountCredentialExposureAllowed('remote');
    expect(() => validateMountCredentialBoundaries(recursiveExplicit)).toThrow(
      /credential files cannot come from a serialized manifest entry/u,
    );

    const recursiveAmbient = new Manifest({
      entries: {
        repository: {
          type: 'git_repo',
          repo: 'openai/example',
        },
        remote: {
          type: 'gcs_mount',
          bucket: 'private',
          mountStrategy: inContainerMountStrategy(),
        },
      },
    }).withInContainerMountCredentialExposureAllowed('remote');
    expect(() =>
      validateMountEnvironmentCredentialBoundaries(recursiveAmbient, {
        GOOGLE_APPLICATION_CREDENTIALS:
          '/workspace/repository/secrets/gcp.json',
      }),
    ).toThrow(/credential files cannot come from a serialized manifest entry/u);
  });

  it('rejects credential files injected into raw persisted manifests', () => {
    const raw = serializeManifestRecord(
      new Manifest({
        entries: {
          secrets: { type: 'local_dir', src: '/trusted/secrets' },
          remote: {
            type: 'gcs_mount',
            bucket: 'private',
            mountStrategy: inContainerMountStrategy(),
          },
        },
      }),
    );
    const entries = raw.entries as Record<string, Record<string, unknown>>;
    entries.remote!.serviceAccountFile = '/workspace/secrets/gcp.json';

    expect(() => deserializeManifest(raw)).toThrow(
      /credential files cannot come from a serialized manifest entry/u,
    );

    const rawAmbient = serializeManifestRecord(
      new Manifest({
        entries: {
          repository: { type: 'git_repo', repo: 'openai/example' },
          remote: {
            type: 'gcs_mount',
            bucket: 'private',
            mountStrategy: inContainerMountStrategy(),
          },
        },
      }),
    );
    rawAmbient.environment = {
      GOOGLE_APPLICATION_CREDENTIALS: {
        value: '/workspace/repository/secrets/gcp.json',
      },
    };
    expect(() => deserializeManifest(rawAmbient)).toThrow(
      /credential files cannot come from a serialized manifest entry/u,
    );
  });

  it('redacts ambient in-container mount credentials and tracks live authority', () => {
    const manifest = new Manifest({
      entries: {
        remote: s3Mount({
          bucket: 'private',
          mountStrategy: inContainerMountStrategy(),
        }),
      },
      environment: {
        AWS_ACCESS_KEY_ID: 'AMBIENT_ACCESS_SENTINEL',
        AWS_SECRET_ACCESS_KEY: 'AMBIENT_SECRET_SENTINEL',
        SAFE: 'visible',
      },
    }).withInContainerMountCredentialExposureAllowed('remote');
    const environment = {
      AWS_ACCESS_KEY_ID: 'AMBIENT_ACCESS_SENTINEL',
      AWS_SECRET_ACCESS_KEY: 'AMBIENT_SECRET_SENTINEL',
      SAFE: 'visible',
    };

    validateMountEnvironmentCredentialBoundaries(manifest, environment);
    const sanitized = sanitizeMountCredentialEnvironmentForPersistence({
      manifest,
      environment,
    });
    expect(JSON.stringify(sanitized)).not.toContain('AMBIENT_ACCESS_SENTINEL');
    expect(JSON.stringify(sanitized)).not.toContain('AMBIENT_SECRET_SENTINEL');
    expect(sanitized.environment).toEqual({ SAFE: 'visible' });

    captureLiveMountCredentialAuthorityIfAbsent(manifest, environment);
    expect(
      liveMountEnvironmentAuthorityMatches(manifest, manifest, environment),
    ).toBe(true);
    expect(
      liveMountEnvironmentAuthorityMatches(manifest, manifest, {
        ...environment,
        AWS_ACCESS_KEY_ID: 'ROTATED_ACCESS',
      }),
    ).toBe(false);
  });

  it('redacts manifest-sourced mount credentials from RunState envelopes', () => {
    const manifest = new Manifest({
      environment: {
        AWS_ACCESS_KEY_ID: 'ENVELOPE_ACCESS_SENTINEL',
        AWS_SECRET_ACCESS_KEY: 'ENVELOPE_SECRET_SENTINEL',
      },
      entries: {
        remote: s3Mount({
          bucket: 'private',
          mountStrategy: inContainerMountStrategy(),
        }),
      },
    }).withInContainerMountCredentialExposureAllowed('remote');

    const envelope = toSessionStateEnvelope(
      'probe',
      {
        manifest,
        environment: {
          AWS_ACCESS_KEY_ID: 'ENVELOPE_ACCESS_SENTINEL',
          AWS_SECRET_ACCESS_KEY: 'ENVELOPE_SECRET_SENTINEL',
        },
      },
      {},
    );
    const serialized = JSON.stringify(envelope);

    expect(serialized).not.toContain('ENVELOPE_ACCESS_SENTINEL');
    expect(serialized).not.toContain('ENVELOPE_SECRET_SENTINEL');
  });

  it('rejects resolved credential files before RunState envelope persistence', () => {
    const manifest = new Manifest({
      environment: {
        GOOGLE_APPLICATION_CREDENTIALS: async () => '/workspace/gcp.json',
      },
      entries: {
        'gcp.json': file({ content: 'GCP_FILE_SECRET_SENTINEL' }),
        remote: gcsMount({
          bucket: 'private',
          mountStrategy: inContainerMountStrategy(),
        }),
      },
    }).withInContainerMountCredentialExposureAllowed('remote');

    expect(() =>
      toSessionStateEnvelope(
        'probe',
        {
          manifest,
          environment: {
            GOOGLE_APPLICATION_CREDENTIALS: '/workspace/gcp.json',
          },
        },
        {},
      ),
    ).toThrow(/serialized manifest entry/u);
  });

  it('strips persisted credentials and rebinds only matching trusted topology', () => {
    const trusted = credentialedS3Manifest(
      inContainerMountStrategy(),
    ).withInContainerMountCredentialExposureAllowed('remote');
    const serializedManifest = serializeManifestRecord(trusted);
    const metadata = serializeMountCredentialRedactionMetadata({
      manifest: trusted,
    });
    const serialized = JSON.stringify({ serializedManifest, metadata });

    expect(serialized).not.toContain('ACCESS_KEY_SENTINEL');
    expect(serialized).not.toContain('SECRET_KEY_SENTINEL');

    const persistedState = {
      manifest: deserializeManifest(serializedManifest),
      ...deserializeMountCredentialRedactionMetadata(metadata),
    };
    expect(() =>
      rebindPersistedMountCredentials(persistedState, undefined),
    ).toThrow(/current trusted manifest/u);

    const rebound = rebindPersistedMountCredentials(persistedState, trusted);
    expect(rebound.manifest.entries.remote).toMatchObject({
      accessKeyId: 'ACCESS_KEY_SENTINEL',
      secretAccessKey: 'SECRET_KEY_SENTINEL',
    });
    validateMountCredentialBoundaries(rebound.manifest);

    const mismatched = credentialedS3Manifest(
      inContainerMountStrategy(),
    ).withInContainerMountCredentialExposureAllowed('remote');
    (mismatched.entries.remote as { bucket: string }).bucket = 'different';
    expect(() =>
      rebindPersistedMountCredentials(persistedState, mismatched),
    ).toThrow(/configuration does not match/u);

    const credentialless = new Manifest({
      entries: {
        remote: s3Mount({
          bucket: 'example',
          mountStrategy: inContainerMountStrategy(),
        }),
      },
    }).withInContainerMountCredentialExposureAllowed('remote');
    expect(() =>
      rebindPersistedMountCredentials(persistedState, credentialless),
    ).toThrow(/no longer provides credential authority/u);
  });

  it('strips and rebinds opaque generic in-container mount sources', () => {
    const source =
      'https://mount-user:SOURCE_SECRET_SENTINEL@example.test/private';
    const trusted = new Manifest({
      entries: {
        remote: {
          type: 'mount',
          source,
          mountStrategy: inContainerMountStrategy(),
        },
      },
    }).withInContainerMountCredentialExposureAllowed('remote');
    const serializedManifest = serializeManifestRecord(trusted);
    const metadata = serializeMountCredentialRedactionMetadata({
      manifest: trusted,
    });

    expect(JSON.stringify({ serializedManifest, metadata })).not.toContain(
      'SOURCE_SECRET_SENTINEL',
    );
    expect(
      (serializedManifest.entries as Record<string, unknown>).remote,
    ).not.toHaveProperty('source');

    const rebound = rebindPersistedMountCredentials(
      {
        manifest: deserializeManifest(serializedManifest),
        ...deserializeMountCredentialRedactionMetadata(metadata),
      },
      trusted,
    );
    expect(rebound.manifest.entries.remote).toMatchObject({ source });
    validateMountCredentialBoundaries(rebound.manifest);
  });

  it('treats arbitrary command and external config mount authority as non-resumable', () => {
    for (const pattern of [
      { type: 'fuse' as const, command: 'custom-mount' },
      { type: 'rclone' as const, configFilePath: '/run/secrets/rclone.conf' },
    ]) {
      const manifest = new Manifest({
        entries: {
          remote: s3Mount({
            bucket: 'private',
            mountStrategy: inContainerMountStrategy({ pattern }),
          }),
        },
      }).withInContainerMountCredentialExposureAllowed('remote');
      expect(manifestHasNonResumableMountAuthority(manifest)).toBe(true);
    }
  });

  it('derives non-resumable authority while sanitizing legacy envelopes', () => {
    const manifest = new Manifest({
      entries: {
        remote: {
          type: 'mount',
          source: 'memory://fixture',
          mountStrategy: inContainerMountStrategy({
            pattern: { type: 'fuse', command: 'custom-mount' },
          }),
        },
      },
    }).withInContainerMountCredentialExposureAllowed('remote');
    const sessionState = {
      version: 2 as const,
      backendId: 'fake',
      workspaceReady: true,
      manifest: {
        ...serializeManifestRecord(new Manifest()),
        entries: structuredClone(manifest.entries),
      },
      providerState: {},
    };

    const sanitized = sanitizeSerializedSandboxState({
      backendId: 'fake',
      currentAgentKey: 'agent',
      currentAgentName: 'Agent',
      sessionState,
      sessionsByAgent: {},
    });

    expect(
      sanitized.sessionState.providerState[NON_RESUMABLE_MOUNT_AUTHORITY_KEY],
    ).toBe(true);
  });

  it('rejects credential rebind when the persisted manifest root changed', () => {
    const trusted = credentialedS3Manifest(
      inContainerMountStrategy(),
    ).withInContainerMountCredentialExposureAllowed('remote');
    const serializedManifest = serializeManifestRecord(trusted);
    serializedManifest.root = '/attacker/workspace';
    const persistedState = {
      manifest: deserializeManifest(serializedManifest),
      ...deserializeMountCredentialRedactionMetadata(
        serializeMountCredentialRedactionMetadata({ manifest: trusted }),
      ),
    };

    expect(() =>
      rebindPersistedMountCredentials(persistedState, trusted),
    ).toThrow(/mount root does not match/u);
  });

  it('detects live mount credential, policy, and topology changes', () => {
    const original = credentialedS3Manifest(
      inContainerMountStrategy(),
    ).withInContainerMountCredentialExposureAllowed('remote');
    const liveManifest = deserializeManifest(serializeManifestRecord(original));
    recordLiveMountCredentialAuthority(liveManifest, original);

    expect(liveMountCredentialAuthorityMatches(liveManifest, original)).toBe(
      true,
    );

    const rotated = credentialedS3Manifest(inContainerMountStrategy());
    (rotated.entries.remote as { accessKeyId: string }).accessKeyId =
      'ROTATED_ACCESS_KEY';
    expect(
      liveMountCredentialAuthorityMatches(
        liveManifest,
        rotated.withInContainerMountCredentialExposureAllowed('remote'),
      ),
    ).toBe(false);

    const credentialless = new Manifest({
      entries: {
        remote: s3Mount({
          bucket: 'example',
          mountStrategy: inContainerMountStrategy(),
        }),
      },
    });
    expect(
      liveMountCredentialAuthorityMatches(liveManifest, credentialless),
    ).toBe(false);
    expect(
      liveMountCredentialAuthorityMatches(
        liveManifest,
        credentialedS3Manifest(inContainerMountStrategy()),
      ),
    ).toBe(false);
    expect(
      liveMountCredentialAuthorityMatches(liveManifest, new Manifest()),
    ).toBe(false);
  });

  it('rejects removing or replacing active mount topology', () => {
    const current = credentialedS3Manifest(
      inContainerMountStrategy(),
    ).withInContainerMountCredentialExposureAllowed('remote');
    const sameTopologyWithRotatedCredentials = credentialedS3Manifest(
      inContainerMountStrategy(),
    ).withInContainerMountCredentialExposureAllowed('remote');
    (
      sameTopologyWithRotatedCredentials.entries.remote as {
        accessKeyId: string;
      }
    ).accessKeyId = 'ROTATED_ACCESS_KEY';

    expect(() =>
      assertExistingMountTopologyPreserved(
        current,
        sameTopologyWithRotatedCredentials,
      ),
    ).not.toThrow();
    expect(() =>
      assertExistingMountTopologyPreserved(
        current,
        new Manifest({ entries: { remote: { type: 'dir' } } }),
      ),
    ).toThrow(/cannot be removed or replaced.*remote/u);
    expect(() =>
      assertExistingMountTopologyPreserved(current, new Manifest()),
    ).toThrow(/cannot be removed or replaced.*remote/u);
  });

  it('preserves provider-recorded authority during manager registration', () => {
    const trusted = credentialedS3Manifest(
      inContainerMountStrategy(),
    ).withInContainerMountCredentialExposureAllowed('remote');
    const sanitized = deserializeManifest(serializeManifestRecord(trusted));
    recordLiveMountCredentialAuthority(sanitized, trusted);

    captureLiveMountCredentialAuthorityIfAbsent(sanitized);

    expect(liveMountCredentialAuthorityMatches(sanitized, trusted)).toBe(true);
  });

  it('does not retain stale exposure trust during credential rebind', () => {
    const stale = credentialedS3Manifest(
      inContainerMountStrategy(),
    ).withInContainerMountCredentialExposureAllowed('remote');
    const currentWithoutTrust = credentialedS3Manifest(
      inContainerMountStrategy(),
    );

    expect(() =>
      rebindPersistedMountCredentials({ manifest: stale }, currentWithoutTrust),
    ).toThrow(/exact path/u);
  });

  it('redacts opaque in-container strategy credentials as non-resumable', () => {
    const untrusted = new Manifest({
      entries: {
        rclone: s3Mount({
          bucket: 'private',
          mountStrategy: inContainerMountStrategy({
            pattern: {
              type: 'rclone',
              extraArgs: ['--auth', 'RCLONE_OPAQUE_SENTINEL'],
            },
          }),
        }),
      },
    });
    expect(() => validateMountCredentialBoundaries(untrusted)).toThrow(
      /model-controlled sandbox/u,
    );
    const trusted =
      untrusted.withInContainerMountCredentialExposureAllowed('rclone');
    const serializedManifest = serializeManifestRecord(trusted);
    const serialized = JSON.stringify(serializedManifest);

    expect(serialized).not.toContain('RCLONE_OPAQUE_SENTINEL');
    const metadata = serializeMountCredentialRedactionMetadata({
      manifest: trusted,
    });
    expect(metadata[NON_RESUMABLE_MOUNT_AUTHORITY_KEY]).toBe(true);
    expect(() =>
      rebindPersistedMountCredentials(
        {
          manifest: deserializeManifest(serializedManifest),
          ...deserializeMountCredentialRedactionMetadata(metadata),
        },
        trusted,
      ),
    ).toThrow(/opaque mount authority/u);
  });

  it('marks opaque Docker driver topology as non-resumable', () => {
    const persistedTrusted = new Manifest({
      entries: {
        volume: s3Mount({
          bucket: 'private',
          mountStrategy: dockerVolumeMountStrategy({
            driver: 'rclone',
            driverOptions: {
              bucket: 'bucket-a',
              token: 'DRIVER_OPAQUE_SENTINEL',
            },
          }),
        }),
      },
    });
    const currentTrusted = new Manifest({
      entries: {
        volume: s3Mount({
          bucket: 'private',
          mountStrategy: dockerVolumeMountStrategy({
            driver: 'rclone',
            driverOptions: {
              bucket: 'bucket-b',
              token: 'CURRENT_DRIVER_SENTINEL',
            },
          }),
        }),
      },
    });
    const serializedManifest = serializeManifestRecord(persistedTrusted);
    const metadata = serializeMountCredentialRedactionMetadata({
      manifest: persistedTrusted,
    });

    expect(JSON.stringify(serializedManifest)).not.toContain(
      'DRIVER_OPAQUE_SENTINEL',
    );
    expect(metadata[NON_RESUMABLE_MOUNT_AUTHORITY_KEY]).toBe(true);
    expect(() =>
      rebindPersistedMountCredentials(
        {
          manifest: deserializeManifest(serializedManifest),
          ...deserializeMountCredentialRedactionMetadata(metadata),
        },
        currentTrusted,
      ),
    ).toThrow(/opaque mount authority/u);
  });

  it('default-denies opaque mount config channels as non-resumable', () => {
    const generic = new Manifest({
      entries: {
        remote: {
          type: 'mount',
          provider: 'custom',
          config: { token: 'GENERIC_CONFIG_SENTINEL' },
          mountStrategy: inContainerMountStrategy(),
        },
      },
    });
    const s3Files = new Manifest({
      entries: {
        remote: s3FilesMount({
          fileSystemId: 'fs-123',
          extraOptions: { password: 'S3_FILES_OPTION_SENTINEL' },
          mountStrategy: inContainerMountStrategy(),
        }),
      },
    });

    expect(() => validateMountCredentialBoundaries(generic)).toThrow(
      /model-controlled sandbox/u,
    );
    expect(() => validateMountCredentialBoundaries(s3Files)).toThrow(
      /model-controlled sandbox/u,
    );

    const trusted = new Manifest({
      entries: {
        generic: generic.entries.remote!,
        s3Files: s3Files.entries.remote!,
      },
    })
      .withInContainerMountCredentialExposureAllowed('generic')
      .withInContainerMountCredentialExposureAllowed('s3Files');
    const serializedManifest = serializeManifestRecord(trusted);
    const serialized = JSON.stringify(serializedManifest);
    expect(serialized).not.toContain('GENERIC_CONFIG_SENTINEL');
    expect(serialized).not.toContain('S3_FILES_OPTION_SENTINEL');

    const metadata = serializeMountCredentialRedactionMetadata({
      manifest: trusted,
    });
    expect(metadata[NON_RESUMABLE_MOUNT_AUTHORITY_KEY]).toBe(true);
    expect(() =>
      rebindPersistedMountCredentials(
        {
          manifest: deserializeManifest(serializedManifest),
          ...deserializeMountCredentialRedactionMetadata(metadata),
        },
        trusted,
      ),
    ).toThrow(/opaque mount authority/u);

    const liveManifest = deserializeManifest(serializedManifest);
    recordLiveMountCredentialAuthority(liveManifest, trusted);
    expect(liveMountCredentialAuthorityMatches(liveManifest, trusted)).toBe(
      true,
    );
    const rotated = new Manifest({
      entries: {
        generic: {
          ...(trusted.entries.generic as Record<string, unknown>),
          config: { token: 'ROTATED_GENERIC_CONFIG' },
        } as never,
        s3Files: trusted.entries.s3Files!,
      },
    })
      .withInContainerMountCredentialExposureAllowed('generic')
      .withInContainerMountCredentialExposureAllowed('s3Files');
    expect(liveMountCredentialAuthorityMatches(liveManifest, rotated)).toBe(
      false,
    );
  });

  it('default-denies residual config on typed mounts as non-resumable', () => {
    const manifest = new Manifest({
      entries: {
        remote: {
          type: 's3_mount',
          bucket: 'example',
          config: { token: 'TYPED_CONFIG_SENTINEL' },
          mountStrategy: inContainerMountStrategy(),
        },
      },
    });

    expect(() => validateMountCredentialBoundaries(manifest)).toThrow(
      /model-controlled sandbox/u,
    );

    const trusted =
      manifest.withInContainerMountCredentialExposureAllowed('remote');
    const serializedManifest = serializeManifestRecord(trusted);
    expect(JSON.stringify(serializedManifest)).not.toContain(
      'TYPED_CONFIG_SENTINEL',
    );

    const metadata = serializeMountCredentialRedactionMetadata({
      manifest: trusted,
    });
    expect(metadata[NON_RESUMABLE_MOUNT_AUTHORITY_KEY]).toBe(true);
    expect(() =>
      rebindPersistedMountCredentials(
        {
          manifest: deserializeManifest(serializedManifest),
          ...deserializeMountCredentialRedactionMetadata(metadata),
        },
        trusted,
      ),
    ).toThrow(/opaque mount authority/u);
  });

  it('requires trusted rebind provenance for credential-bearing resume state', () => {
    const trustedExternal = credentialedS3Manifest({
      type: 'modal_cloud_bucket',
    });

    expect(() =>
      assertMountCredentialsRebound({ manifest: trustedExternal }),
    ).toThrow(/rebound from a current trusted manifest/u);

    const rebound = rebindPersistedMountCredentials(
      {
        manifest: deserializeManifest(serializeManifestRecord(trustedExternal)),
      },
      trustedExternal,
    );
    expect(() => assertMountCredentialsRebound(rebound)).not.toThrow();

    expect(() =>
      rebindPersistedMountCredentials(
        {
          manifest: deserializeManifest(
            serializeManifestRecord(trustedExternal),
          ),
        },
        undefined,
      ),
    ).toThrow(/current trusted manifest/u);

    const trustedInside = credentialedS3Manifest(
      inContainerMountStrategy(),
    ).withInContainerMountCredentialExposureAllowed('remote');
    const reboundInside = rebindPersistedMountCredentials(
      { manifest: deserializeManifest(serializeManifestRecord(trustedInside)) },
      trustedInside,
    );
    expect(() => assertMountCredentialsRebound(reboundInside)).toThrow(
      /fresh sandbox/u,
    );
  });

  it('preserves exact-path trust across host path grant rebinding', () => {
    const trusted = credentialedS3Manifest(
      inContainerMountStrategy(),
    ).withInContainerMountCredentialExposureAllowed('remote');
    const persistedState = {
      manifest: deserializeManifest(serializeManifestRecord(trusted)),
      ...deserializeMountCredentialRedactionMetadata(
        serializeMountCredentialRedactionMetadata({ manifest: trusted }),
      ),
    };

    const credentialRebound = rebindPersistedMountCredentials(
      persistedState,
      trusted,
    );
    const fullyRebound = rebindPersistedPathGrants(credentialRebound, trusted);

    expect(() =>
      validateMountCredentialBoundaries(fullyRebound.manifest),
    ).not.toThrow();
  });

  it('sanitizes credentials injected into raw persisted manifests', () => {
    const raw = serializeManifestRecord(
      credentialedS3Manifest(
        inContainerMountStrategy(),
      ).withInContainerMountCredentialExposureAllowed('remote'),
    );
    const rawEntry = (raw.entries as Record<string, Record<string, unknown>>)
      .remote;
    rawEntry.accessKeyId = 'RAW_ACCESS_SENTINEL';
    rawEntry.secretAccessKey = 'RAW_SECRET_SENTINEL';

    const manifest = deserializeManifest(raw);
    expect(JSON.stringify(manifest)).not.toContain('RAW_ACCESS_SENTINEL');
    expect(JSON.stringify(manifest)).not.toContain('RAW_SECRET_SENTINEL');
    expect(() =>
      rebindPersistedMountCredentials({ manifest }, undefined),
    ).toThrow(/current trusted manifest/u);
  });

  it('rejects before local filesystem side effects', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'mount-security-'));
    tempDirs.push(parent);
    const workspace = join(parent, 'workspace');

    await expect(
      materializeLocalWorkspaceManifest(
        credentialedS3Manifest(inContainerMountStrategy()),
        workspace,
      ),
    ).rejects.toThrow(/model-controlled sandbox/u);
    await expect(access(workspace)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
