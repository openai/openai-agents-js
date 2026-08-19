import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  boxMount,
  dockerVolumeMountStrategy,
  Environment,
  file,
  gcsMount,
  inContainerMountStrategy,
  Manifest,
  ProcessEnvValue,
  s3Mount,
  s3FilesMount,
  type MountStrategy,
} from '../src/sandbox';
import {
  assertExistingMountTopologyPreserved,
  bindProcessEnvironmentAccess,
  captureLiveMountCredentialAuthorityIfAbsent,
  deserializeManifest,
  deserializeMountCredentialRedactionMetadata,
  liveMountCredentialAuthorityMatches,
  liveMountEnvironmentAuthorityMatches,
  manifestHasNonResumableMountAuthority,
  mountCredentialFileReferences,
  NON_RESUMABLE_MOUNT_AUTHORITY_KEY,
  recordLiveMountCredentialAuthority,
  rebindPersistedMountCredentials,
  resolveAndValidateMountEnvironment,
  sanitizeMountCredentialEnvironmentForPersistence,
  serializeManifestRecord,
  serializeMountCredentialRedactionMetadata,
  validateMountCredentialBoundaries,
  validateMountEnvironmentCredentialBoundaries,
} from '../src/sandbox/internal';
import {
  assertMountCredentialsRebound,
  redactMountCredentialsForPersistence,
} from '../src/sandbox/mountSecurity';
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
  it('preserves protected process environment references while validating mount credentials', async () => {
    process.env.AGENTS_TEST_MOUNT_PROCESS_SOURCE = 'process-secret';
    const manifest = bindProcessEnvironmentAccess(
      new Manifest({
        environment: {
          AWS_ACCESS_KEY_ID: new Environment({ value: 'access-key' }),
          AWS_SECRET_ACCESS_KEY: new Environment({ value: 'secret-key' }),
          SANDBOX_TOKEN: new ProcessEnvValue({
            name: 'AGENTS_TEST_MOUNT_PROCESS_SOURCE',
          }),
        },
        entries: {
          remote: s3Mount({
            bucket: 'example',
            mountStrategy: inContainerMountStrategy(),
          }),
        },
      }).withInContainerMountBroadCredentialExposureAcknowledged('remote'),
      {
        processEnvironmentBindings: {
          SANDBOX_TOKEN: 'AGENTS_TEST_MOUNT_PROCESS_SOURCE',
        },
      },
    );

    const resolved = await resolveAndValidateMountEnvironment(manifest);

    expect(resolved.environment.AWS_ACCESS_KEY_ID).toBeInstanceOf(Environment);
    expect(resolved.environment.SANDBOX_TOKEN).toBe(
      manifest.environment.SANDBOX_TOKEN,
    );
    expect(resolved.environment.SANDBOX_TOKEN).toBeInstanceOf(ProcessEnvValue);
    await expect(resolved.resolveEnvironment()).resolves.toMatchObject({
      SANDBOX_TOKEN: 'process-secret',
    });
    expect(JSON.stringify(resolved)).not.toContain('process-secret');
  });

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

  it('requires broad acknowledgement for an Azure managed identity selector', () => {
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
        manifest.withInContainerMountCredentialExposureAcknowledged('remote'),
      ),
    ).toThrow(/broad credential authority/iu);
    expect(() =>
      validateMountCredentialBoundaries(
        manifest.withInContainerMountBroadCredentialExposureAcknowledged(
          'remote',
        ),
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
    }).withInContainerMountCredentialExposureAcknowledged('remote');

    expect(() => validateMountCredentialBoundaries(manifest)).toThrow(
      /complete|both/u,
    );
  });

  it.each<{
    label: string;
    environment: Record<string, string>;
  }>([
    {
      label: 'partial ambient AWS pair',
      environment: { AWS_ACCESS_KEY_ID: 'access-key' },
    },
    {
      label: 'ambient AWS session token without a key pair',
      environment: { AWS_SESSION_TOKEN: 'session-token' },
    },
    {
      label: 'partial rclone remote pair',
      environment: {
        RCLONE_CONFIG_PRIVATE_ACCESS_KEY_ID: 'access-key',
      },
    },
  ])('rejects $label before provider effects', ({ environment }) => {
    const manifest = new Manifest({
      entries: {
        remote: s3Mount({
          bucket: 'private',
          mountStrategy: inContainerMountStrategy(),
        }),
      },
    }).withInContainerMountBroadCredentialExposureAcknowledged('remote');

    expect(() =>
      validateMountEnvironmentCredentialBoundaries(manifest, environment),
    ).toThrow(/complete|both/u);
  });

  it('requires separate broad acknowledgement for ambient AWS profiles', () => {
    const manifest = new Manifest({
      entries: {
        remote: s3Mount({
          bucket: 'private',
          mountStrategy: inContainerMountStrategy(),
        }),
      },
    });

    expect(() =>
      validateMountEnvironmentCredentialBoundaries(manifest, {
        AWS_PROFILE: 'trusted-profile',
      }),
    ).toThrow(/broad credential authority/iu);
    expect(() =>
      validateMountEnvironmentCredentialBoundaries(
        manifest.withInContainerMountCredentialExposureAcknowledged('remote'),
        { AWS_PROFILE: 'trusted-profile' },
      ),
    ).toThrow(/broad credential authority/iu);
    expect(() =>
      validateMountEnvironmentCredentialBoundaries(
        manifest.withInContainerMountBroadCredentialExposureAcknowledged(
          'remote',
        ),
        { AWS_PROFILE: 'trusted-profile' },
      ),
    ).not.toThrow();
  });

  it('requires separate broad acknowledgement for ambient AWS credentials shadowed by inline credentials', () => {
    const manifest = new Manifest({
      entries: {
        remote: s3Mount({
          bucket: 'private',
          accessKeyId: 'inline-access-key',
          secretAccessKey: 'inline-secret-key',
          mountStrategy: {
            type: 'e2b_cloud_bucket',
          } as MountStrategy,
        }),
      },
    }).withInContainerMountCredentialExposureAcknowledged('remote');
    const environment = {
      AWS_ACCESS_KEY_ID: 'ambient-access-key',
      AWS_SECRET_ACCESS_KEY: 'ambient-secret-key',
      AWS_SESSION_TOKEN: 'ambient-session-token',
    };

    expect(() =>
      validateMountEnvironmentCredentialBoundaries(manifest, environment),
    ).toThrow(/broad credential authority/iu);
    expect(() =>
      validateMountEnvironmentCredentialBoundaries(
        manifest.withInContainerMountBroadCredentialExposureAcknowledged(
          'remote',
        ),
        environment,
      ),
    ).not.toThrow();
  });

  it.each([
    {
      label: 'an HMAC key pair',
      credentials: {
        accessId: 'inline-access-id',
        secretAccessKey: 'inline-secret-key',
      },
    },
    {
      label: 'service account credentials',
      credentials: {
        serviceAccountCredentials: 'inline-service-account-credentials',
      },
    },
    {
      label: 'an access token',
      credentials: { accessToken: 'inline-access-token' },
    },
  ])(
    'requires separate broad acknowledgement for ambient GCS credentials shadowed by $label',
    ({ credentials }) => {
      const manifest = new Manifest({
        entries: {
          remote: gcsMount({
            bucket: 'private',
            ...credentials,
            mountStrategy: {
              type: 'e2b_cloud_bucket',
            } as MountStrategy,
          }),
        },
      }).withInContainerMountCredentialExposureAcknowledged('remote');
      const environment = {
        GOOGLE_APPLICATION_CREDENTIALS: '/run/secrets/gcp.json',
      };

      expect(() =>
        validateMountEnvironmentCredentialBoundaries(manifest, environment),
      ).toThrow(/broad credential authority/iu);
      expect(() =>
        validateMountEnvironmentCredentialBoundaries(
          manifest.withInContainerMountBroadCredentialExposureAcknowledged(
            'remote',
          ),
          environment,
        ),
      ).not.toThrow();
    },
  );

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
          manifest.withInContainerMountCredentialExposureAcknowledged('remote'),
        ),
      ).toThrow(/broad credential|does not support mount-scoped/u);
      expect(() =>
        validateMountCredentialBoundaries(
          manifest.withInContainerMountBroadCredentialExposureAcknowledged(
            'remote',
          ),
        ),
      ).not.toThrow();
    }
  });

  it('requires a trusted exact effective mount path acknowledgement', () => {
    const manifest = credentialedS3Manifest(inContainerMountStrategy(), {
      mountPath: '/workspace/data',
    });
    const trusted =
      manifest.withInContainerMountCredentialExposureAcknowledged('data');

    validateMountCredentialBoundaries(trusted);
    expect(() =>
      manifest.withInContainerMountCredentialExposureAcknowledged('other'),
    ).not.toThrow();
    expect(() =>
      validateMountCredentialBoundaries(
        manifest.withInContainerMountCredentialExposureAcknowledged('other'),
      ),
    ).toThrow(/exact path/u);
    expect(JSON.stringify(trusted)).not.toContain('CredentialExposure');
  });

  it('rejects empty and workspace-root exposure paths', () => {
    const manifest = credentialedS3Manifest(inContainerMountStrategy());

    for (const path of ['', ' ', '.', '/', '/workspace']) {
      expect(() =>
        manifest.withInContainerMountCredentialExposureAcknowledged(path),
      ).toThrow(/non-root path/u);
      expect(() =>
        manifest.withInContainerMountBroadCredentialExposureAcknowledged(path),
      ).toThrow(/non-root path/u);
    }
  });

  it('supports trusted exact absolute mount paths outside the workspace root', () => {
    const trusted = credentialedS3Manifest(inContainerMountStrategy(), {
      mountPath: '/mnt/private',
    }).withInContainerMountCredentialExposureAcknowledged('/mnt/private');

    expect(() => validateMountCredentialBoundaries(trusted)).not.toThrow();
  });

  it.each([
    'inContainerMountCredentialExposureAllowedPaths',
    'inContainerMountCredentialExposureAcknowledgedPaths',
    'inContainerMountBroadCredentialExposureAcknowledgedPaths',
  ])(
    'does not accept %s from manifest init objects or persisted records',
    (key) => {
      expect(() => new Manifest({ [key]: ['remote'] } as never)).toThrow(
        /credential exposure/u,
      );
      expect(() =>
        deserializeManifest({
          ...serializeManifestRecord(new Manifest()),
          [key]: ['remote'],
        }),
      ).toThrow(/credential exposure policy/u);
    },
  );

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
    }).withInContainerMountCredentialExposureAcknowledged('remote');

    expect(() => validateMountCredentialBoundaries(manifest)).toThrow(
      /serialized manifest entry/u,
    );
  });

  it('requires broad acknowledgement for a trusted external rclone config', () => {
    const manifest = new Manifest({
      extraPathGrants: [
        {
          path: '/run/openai-agents/rclone.conf',
          hostPath: '/tmp/rclone.conf',
          readOnly: true,
        },
      ],
      entries: {
        remote: s3Mount({
          bucket: 'example',
          mountStrategy: inContainerMountStrategy({
            pattern: {
              type: 'rclone',
              configFilePath: '/run/openai-agents/rclone.conf',
            },
          }),
        }),
      },
    });

    expect(() => validateMountCredentialBoundaries(manifest)).toThrow(
      /model-controlled sandbox/u,
    );
    expect(() =>
      validateMountCredentialBoundaries(
        manifest.withInContainerMountCredentialExposureAcknowledged('remote'),
      ),
    ).toThrow(/broad credential authority/iu);
    expect(() =>
      validateMountCredentialBoundaries(
        manifest.withInContainerMountBroadCredentialExposureAcknowledged(
          'remote',
        ),
      ),
    ).not.toThrow();
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
    }).withInContainerMountBroadCredentialExposureAcknowledged('remote');
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
    }).withInContainerMountBroadCredentialExposureAcknowledged('remote');
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
    }).withInContainerMountCredentialExposureAcknowledged('remote');
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
    }).withInContainerMountCredentialExposureAcknowledged('remote');
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
    }).withInContainerMountBroadCredentialExposureAcknowledged('remote');
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

  it('redacts shadowed credential environment beside inline credentials', () => {
    const manifest = new Manifest({
      entries: {
        remote: s3Mount({
          bucket: 'private',
          accessKeyId: 'INLINE_ACCESS_SENTINEL',
          secretAccessKey: 'INLINE_SECRET_SENTINEL',
          mountStrategy: inContainerMountStrategy(),
        }),
      },
    }).withInContainerMountCredentialExposureAcknowledged('remote');
    const environment = {
      AWS_ACCESS_KEY_ID: 'SHADOWED_ACCESS_SENTINEL',
      AWS_SECRET_ACCESS_KEY: 'SHADOWED_SECRET_SENTINEL',
      AWS_SESSION_TOKEN: 'SHADOWED_SESSION_SENTINEL',
      SAFE: 'visible',
    };

    const sanitized = sanitizeMountCredentialEnvironmentForPersistence({
      manifest,
      environment,
    });

    expect(JSON.stringify(sanitized)).not.toContain('SHADOWED_ACCESS_SENTINEL');
    expect(JSON.stringify(sanitized)).not.toContain('SHADOWED_SECRET_SENTINEL');
    expect(JSON.stringify(sanitized)).not.toContain(
      'SHADOWED_SESSION_SENTINEL',
    );
    expect(sanitized.environment).toEqual({ SAFE: 'visible' });
    expect(environment).toMatchObject({
      AWS_ACCESS_KEY_ID: 'SHADOWED_ACCESS_SENTINEL',
      AWS_SECRET_ACCESS_KEY: 'SHADOWED_SECRET_SENTINEL',
      AWS_SESSION_TOKEN: 'SHADOWED_SESSION_SENTINEL',
    });
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
    }).withInContainerMountBroadCredentialExposureAcknowledged('remote');

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

  it('redacts manifest credentials hidden by an undefined runtime override', () => {
    const manifest = new Manifest({
      environment: {
        AWS_ACCESS_KEY_ID: 'MANIFEST_ACCESS_SENTINEL',
        AWS_SECRET_ACCESS_KEY: 'MANIFEST_SECRET_SENTINEL',
      },
      entries: {
        remote: s3Mount({
          bucket: 'private',
          accessKeyId: 'INLINE_ACCESS_SENTINEL',
          secretAccessKey: 'INLINE_SECRET_SENTINEL',
          mountStrategy: inContainerMountStrategy(),
        }),
      },
    })
      .withInContainerMountCredentialExposureAcknowledged('remote')
      .withInContainerMountBroadCredentialExposureAcknowledged('remote');
    const environment = {
      AWS_ACCESS_KEY_ID: undefined,
    } as unknown as Record<string, string>;

    const sanitized = sanitizeMountCredentialEnvironmentForPersistence({
      manifest,
      environment,
    });
    const envelope = toSessionStateEnvelope(
      'probe',
      { manifest, environment },
      {},
    );

    expect(JSON.stringify(sanitized)).not.toContain('MANIFEST_ACCESS_SENTINEL');
    expect(JSON.stringify(sanitized)).not.toContain('MANIFEST_SECRET_SENTINEL');
    expect(JSON.stringify(envelope)).not.toContain('MANIFEST_ACCESS_SENTINEL');
    expect(JSON.stringify(envelope)).not.toContain('MANIFEST_SECRET_SENTINEL');
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
    }).withInContainerMountCredentialExposureAcknowledged('remote');

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
    ).withInContainerMountCredentialExposureAcknowledged('remote');
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
    ).withInContainerMountCredentialExposureAcknowledged('remote');
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
    }).withInContainerMountCredentialExposureAcknowledged('remote');
    expect(() =>
      rebindPersistedMountCredentials(persistedState, credentialless),
    ).toThrow(/no longer provides credential authority/u);
  });

  it('rejects opaque generic in-container mount sources despite acknowledgement', () => {
    const source = [
      'https://mount-user',
      'fixture-value@example.test/private',
    ].join(':');
    const manifest = new Manifest({
      entries: {
        remote: {
          type: 'mount',
          source,
          mountStrategy: inContainerMountStrategy(),
        },
      },
    });
    for (const trusted of [
      manifest.withInContainerMountCredentialExposureAcknowledged('remote'),
      manifest.withInContainerMountBroadCredentialExposureAcknowledged(
        'remote',
      ),
    ]) {
      expect(() => validateMountCredentialBoundaries(trusted)).toThrow(
        /SDK-supported strategy, provider, mount type, and pattern/u,
      );
      expect(() => serializeManifestRecord(trusted)).toThrow(
        /SDK-supported strategy, provider, mount type, and pattern/u,
      );
    }
  });

  it('supports mount-scoped Box credentials only for a closed capability', () => {
    const manifest = new Manifest({
      entries: {
        remote: boxMount({
          accessToken: 'BOX_TOKEN_SENTINEL',
          mountStrategy: inContainerMountStrategy(),
        }),
      },
    });
    expect(() => validateMountCredentialBoundaries(manifest)).toThrow(
      /mount-scoped credentials/iu,
    );
    expect(() =>
      validateMountCredentialBoundaries(
        manifest.withInContainerMountCredentialExposureAcknowledged('remote'),
      ),
    ).not.toThrow();

    const custom = new Manifest({
      entries: {
        remote: boxMount({
          accessToken: 'BOX_TOKEN_SENTINEL',
          mountStrategy: { type: 'custom' },
        }),
      },
    }).withInContainerMountCredentialExposureAcknowledged('remote');
    expect(() => validateMountCredentialBoundaries(custom)).toThrow(
      /SDK-supported strategy, provider, mount type, and pattern/u,
    );
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
      }).withInContainerMountCredentialExposureAcknowledged('remote');
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
    }).withInContainerMountCredentialExposureAcknowledged('remote');
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
    ).withInContainerMountCredentialExposureAcknowledged('remote');
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
    ).withInContainerMountCredentialExposureAcknowledged('remote');
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
        rotated.withInContainerMountCredentialExposureAcknowledged('remote'),
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
    ).withInContainerMountCredentialExposureAcknowledged('remote');
    const sameTopologyWithRotatedCredentials = credentialedS3Manifest(
      inContainerMountStrategy(),
    ).withInContainerMountCredentialExposureAcknowledged('remote');
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
    ).withInContainerMountCredentialExposureAcknowledged('remote');
    const sanitized = deserializeManifest(serializeManifestRecord(trusted));
    recordLiveMountCredentialAuthority(sanitized, trusted);

    captureLiveMountCredentialAuthorityIfAbsent(sanitized);

    expect(liveMountCredentialAuthorityMatches(sanitized, trusted)).toBe(true);
  });

  it('does not retain stale exposure trust during credential rebind', () => {
    const stale = credentialedS3Manifest(
      inContainerMountStrategy(),
    ).withInContainerMountCredentialExposureAcknowledged('remote');
    const currentWithoutTrust = credentialedS3Manifest(
      inContainerMountStrategy(),
    );

    expect(() =>
      rebindPersistedMountCredentials({ manifest: stale }, currentWithoutTrust),
    ).toThrow(/exact path/u);
  });

  it('rejects opaque rclone args even with exact-path trust', () => {
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
      /Unsupported rclone mount args/u,
    );
    const trusted =
      untrusted.withInContainerMountCredentialExposureAcknowledged('rclone');
    expect(() => validateMountCredentialBoundaries(trusted)).toThrow(
      /Unsupported rclone mount args/u,
    );
  });

  it('rejects opaque rclone config selectors but preserves safe extra args', () => {
    for (const pattern of [
      { type: 'rclone' as const, args: ['--config', '/run/rclone.conf'] },
      {
        type: 'rclone' as const,
        extraArgs: ['--config=/run/rclone.conf'],
      },
      {
        type: 'rclone' as const,
        extraArgs: ['--auth', 'opaque-authority'],
      },
    ]) {
      const manifest = new Manifest({
        entries: {
          remote: s3Mount({
            bucket: 'private',
            mountStrategy: inContainerMountStrategy({ pattern }),
          }),
        },
      }).withInContainerMountCredentialExposureAcknowledged('remote');

      expect(() => validateMountCredentialBoundaries(manifest)).toThrow(
        /configFilePath/u,
      );
    }

    const safe = new Manifest({
      entries: {
        remote: s3Mount({
          bucket: 'private',
          mountStrategy: inContainerMountStrategy({
            pattern: {
              type: 'rclone',
              extraArgs: ['--vfs-cache-mode', 'writes'],
            },
          }),
        }),
      },
    });
    expect(() => validateMountCredentialBoundaries(safe)).not.toThrow();
  });

  it('classifies alternate rclone config environment selectors as files', () => {
    const manifest = new Manifest({
      entries: {
        remote: s3Mount({
          bucket: 'private',
          mountStrategy: inContainerMountStrategy({
            pattern: { type: 'rclone' },
          }),
        }),
      },
    });
    const entry = manifest.entries.remote!;

    expect(
      mountCredentialFileReferences(manifest, entry, {
        RCLONE_CONFIG: '/run/rclone.conf',
        RCLONE_CONFIG_REMOTE_SERVICE_ACCOUNT_FILE: '/run/service.json',
      }),
    ).toEqual(
      expect.arrayContaining([
        {
          field: 'environment.RCLONE_CONFIG',
          path: '/run/rclone.conf',
        },
        {
          field: 'environment.RCLONE_CONFIG_REMOTE_SERVICE_ACCOUNT_FILE',
          path: '/run/service.json',
        },
      ]),
    );
  });

  it('rejects raw persisted alternate rclone config files from manifest entries', () => {
    for (const name of [
      'RCLONE_CONFIG',
      'RCLONE_CONFIG_REMOTE_SERVICE_ACCOUNT_FILE',
    ]) {
      const raw = serializeManifestRecord(
        new Manifest({
          entries: {
            credential: file({ content: 'secret' }),
            remote: s3Mount({
              bucket: 'private',
              mountStrategy: inContainerMountStrategy({
                pattern: { type: 'rclone' },
              }),
            }),
          },
        }),
      );
      raw.environment = { [name]: '/workspace/credential' };

      expect(() => deserializeManifest(raw)).toThrow(
        /serialized manifest entry/u,
      );
    }
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
      /SDK-supported strategy, provider, mount type, and pattern/u,
    );
    expect(() => validateMountCredentialBoundaries(s3Files)).toThrow(
      /broad credential authority/iu,
    );

    expect(() =>
      validateMountCredentialBoundaries(
        generic.withInContainerMountCredentialExposureAcknowledged('remote'),
      ),
    ).toThrow(/SDK-supported strategy, provider, mount type, and pattern/u);

    const trusted =
      s3Files.withInContainerMountBroadCredentialExposureAcknowledged('remote');
    const serializedManifest = serializeManifestRecord(trusted);
    const serialized = JSON.stringify(serializedManifest);
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
        remote: s3FilesMount({
          fileSystemId: 'fs-123',
          extraOptions: { password: 'ROTATED_S3_FILES_OPTION' },
          mountStrategy: inContainerMountStrategy(),
        }),
      },
    }).withInContainerMountBroadCredentialExposureAcknowledged('remote');
    expect(liveMountCredentialAuthorityMatches(liveManifest, rotated)).toBe(
      false,
    );
  });

  it('rejects residual config on typed mounts despite acknowledgement', () => {
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
      /does not support exposing these credential fields/u,
    );

    const trusted =
      manifest.withInContainerMountCredentialExposureAcknowledged('remote');
    expect(() => validateMountCredentialBoundaries(trusted)).toThrow(
      /does not support exposing these credential fields/u,
    );
    expect(() => serializeManifestRecord(trusted)).toThrow(
      /does not support exposing these credential fields/u,
    );
  });

  it('rejects and defensively redacts cross-provider credential fields', () => {
    const entry = {
      ...s3Mount({
        bucket: 'example',
        mountStrategy: inContainerMountStrategy(),
      }),
      serviceAccountCredentials: 'CROSS_PROVIDER_SECRET_SENTINEL',
    };
    const trusted = new Manifest({
      entries: { remote: entry },
    }).withInContainerMountCredentialExposureAcknowledged('remote');

    expect(() => validateMountCredentialBoundaries(trusted)).toThrow(
      /does not support exposing these credential fields/u,
    );
    expect(() => serializeManifestRecord(trusted)).toThrow(
      /does not support exposing these credential fields/u,
    );
    expect(
      JSON.stringify(redactMountCredentialsForPersistence(entry)),
    ).not.toContain('CROSS_PROVIDER_SECRET_SENTINEL');
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
    ).withInContainerMountCredentialExposureAcknowledged('remote');
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
    ).withInContainerMountCredentialExposureAcknowledged('remote');
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
      ).withInContainerMountCredentialExposureAcknowledged('remote'),
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
