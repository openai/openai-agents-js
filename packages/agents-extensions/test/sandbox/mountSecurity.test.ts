import { describe, expect, it, vi } from 'vitest';
import { Manifest, s3Mount } from '@openai/agents-core/sandbox';
import {
  captureLiveMountCredentialAuthority,
  liveMountCredentialAuthorityMatches,
} from '@openai/agents-core/sandbox/internal';
import { applyInlineManifestEntryToState } from '../../src/sandbox/shared';
import { serializeRemoteSandboxSessionState } from '../../src/sandbox/shared/sessionState';
import {
  captureRcloneMountEnvironmentAuthority,
  rcloneMountEnvironmentAuthorityMatches,
  validateRcloneMountEnvironmentCredentialExposure,
} from '../../src/sandbox/shared/inContainerMounts';

describe('remote mount credential boundaries', () => {
  it.each([
    ['AWS_ACCESS_KEY_ID', 'access-key'],
    ['GOOGLE_APPLICATION_CREDENTIALS', '/run/secrets/gcp.json'],
    ['RCLONE_CONFIG_PASS', 'obscured-password'],
  ])(
    'rejects %s mount authority without an exact trusted path opt-in',
    (name, value) => {
      const entry =
        name === 'GOOGLE_APPLICATION_CREDENTIALS'
          ? {
              type: 'gcs_mount' as const,
              bucket: 'example',
              mountStrategy: { type: 'daytona_cloud_bucket' },
            }
          : s3Mount({
              bucket: 'example',
              mountStrategy: { type: 'daytona_cloud_bucket' },
            });
      const manifest = new Manifest({ entries: { remote: entry } });

      expect(() =>
        validateRcloneMountEnvironmentCredentialExposure(manifest, {
          [name]: value,
        }),
      ).toThrow(/model-controlled sandbox/u);
      expect(() =>
        validateRcloneMountEnvironmentCredentialExposure(
          manifest.withInContainerMountCredentialExposureAllowed('remote'),
          { [name]: value },
        ),
      ).not.toThrow();
    },
  );

  it('omits rclone mount credential environment from persisted state', () => {
    const manifest = new Manifest({
      entries: {
        remote: s3Mount({
          bucket: 'example',
          mountStrategy: { type: 'e2b_cloud_bucket' },
        }),
      },
      environment: {
        AWS_ACCESS_KEY_ID: 'access-key',
        AWS_SECRET_ACCESS_KEY: 'secret-key',
        KEEP: 'safe',
      },
    }).withInContainerMountCredentialExposureAllowed('remote');

    const serialized = serializeRemoteSandboxSessionState({
      manifest,
      environment: {
        AWS_ACCESS_KEY_ID: 'access-key',
        AWS_SECRET_ACCESS_KEY: 'secret-key',
        KEEP: 'safe',
      },
    });

    expect(serialized.environment).toEqual({ KEEP: 'safe' });
    expect(
      (serialized.manifest as { environment: Record<string, unknown> })
        .environment,
    ).toEqual({ KEEP: { value: 'safe' } });
  });

  it('compares immutable per-mount rclone environment authority', () => {
    const manifest = new Manifest({
      entries: {
        first: s3Mount({
          bucket: 'first',
          mountStrategy: { type: 'runloop_cloud_bucket' },
        }),
        second: s3Mount({
          bucket: 'second',
          mountStrategy: { type: 'runloop_cloud_bucket' },
        }),
      },
    })
      .withInContainerMountCredentialExposureAllowed('first')
      .withInContainerMountCredentialExposureAllowed('second');
    const state = {
      manifest,
      environment: {
        AWS_ACCESS_KEY_ID: 'first-key',
        AWS_SECRET_ACCESS_KEY: 'first-secret',
      },
    };
    captureRcloneMountEnvironmentAuthority(
      state,
      '/workspace/first',
      manifest.entries.first!,
    );
    state.environment = {
      AWS_ACCESS_KEY_ID: 'second-key',
      AWS_SECRET_ACCESS_KEY: 'second-secret',
    };
    captureRcloneMountEnvironmentAuthority(
      state,
      '/workspace/second',
      manifest.entries.second!,
    );

    expect(
      rcloneMountEnvironmentAuthorityMatches(state, manifest, {
        AWS_ACCESS_KEY_ID: 'second-key',
        AWS_SECRET_ACCESS_KEY: 'second-secret',
      }),
    ).toBe(false);
    expect(
      rcloneMountEnvironmentAuthorityMatches(state, manifest, {
        AWS_ACCESS_KEY_ID: 'first-key',
        AWS_SECRET_ACCESS_KEY: 'first-secret',
      }),
    ).toBe(false);
  });

  it('ignores ambient AWS values for inline credentials but tracks rclone overrides', () => {
    const manifest = new Manifest({
      entries: {
        remote: s3Mount({
          bucket: 'example',
          accessKeyId: 'inline-key',
          secretAccessKey: 'inline-secret',
          mountStrategy: { type: 'e2b_cloud_bucket' },
        }),
      },
    }).withInContainerMountCredentialExposureAllowed('remote');
    const state = {
      manifest,
      environment: { AWS_ACCESS_KEY_ID: 'ambient-key' },
    };
    captureRcloneMountEnvironmentAuthority(
      state,
      '/workspace/remote',
      manifest.entries.remote!,
    );

    expect(
      rcloneMountEnvironmentAuthorityMatches(state, manifest, {
        AWS_ACCESS_KEY_ID: 'rotated-ambient-key',
      }),
    ).toBe(true);
    expect(
      rcloneMountEnvironmentAuthorityMatches(state, manifest, {
        RCLONE_CONFIG_PASS: 'new-password',
      }),
    ).toBe(false);
  });

  it('rejects dynamic credential-bearing mounts before provider side effects', async () => {
    const state = {
      manifest: new Manifest(),
      environment: {},
    };
    const mkdir = vi.fn();
    const writeFile = vi.fn();
    const writer = { mkdir, writeFile };
    const resolvePath = vi.fn(async (path: string) => `/workspace/${path}`);

    await expect(
      applyInlineManifestEntryToState(
        state,
        'remote',
        s3Mount({
          bucket: 'example',
          accessKeyId: 'ACCESS_KEY_SENTINEL',
          secretAccessKey: 'SECRET_KEY_SENTINEL',
          mountStrategy: { type: 'daytona_cloud_bucket' },
        }),
        'TestProvider',
        writer,
        resolvePath,
      ),
    ).rejects.toThrow(/model-controlled sandbox/u);
    expect(resolvePath).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('updates live authority only after successful dynamic mount mutation', async () => {
    const original = new Manifest({
      entries: {
        remote: s3Mount({
          bucket: 'example',
          accessKeyId: 'old-access-key',
          secretAccessKey: 'old-secret-key',
          mountStrategy: { type: 'modal_cloud_bucket' },
        }),
      },
    });
    const state = { manifest: original, environment: {} };
    captureLiveMountCredentialAuthority(state.manifest);
    const writer = { mkdir: vi.fn(), writeFile: vi.fn() };
    const resolvePath = vi.fn(async (path: string) => `/workspace/${path}`);
    const rotatedEntry = s3Mount({
      bucket: 'example',
      accessKeyId: 'new-access-key',
      secretAccessKey: 'new-secret-key',
      mountStrategy: { type: 'modal_cloud_bucket' },
    });

    await applyInlineManifestEntryToState(
      state,
      'remote',
      rotatedEntry,
      'TestProvider',
      writer,
      resolvePath,
      { materializeMount: vi.fn(async () => {}) },
    );
    const rotated = new Manifest({ entries: { remote: rotatedEntry } });
    expect(liveMountCredentialAuthorityMatches(state.manifest, rotated)).toBe(
      true,
    );
    expect(liveMountCredentialAuthorityMatches(state.manifest, original)).toBe(
      false,
    );

    const committedManifest = state.manifest;
    const failedRotation = new Manifest({
      entries: {
        remote: s3Mount({
          bucket: 'example',
          accessKeyId: 'failed-access-key',
          secretAccessKey: 'failed-secret-key',
          mountStrategy: { type: 'modal_cloud_bucket' },
        }),
      },
    });
    await expect(
      applyInlineManifestEntryToState(
        state,
        'remote',
        failedRotation.entries.remote!,
        'TestProvider',
        writer,
        resolvePath,
        {
          materializeMount: vi.fn(async () => {
            throw new Error('mount failed');
          }),
        },
      ),
    ).rejects.toThrow('mount failed');
    expect(state.manifest).toBe(committedManifest);
    expect(liveMountCredentialAuthorityMatches(state.manifest, rotated)).toBe(
      true,
    );
  });
});
