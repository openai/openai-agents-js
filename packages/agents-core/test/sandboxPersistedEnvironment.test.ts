import { expect, it, vi } from 'vitest';
import {
  cloneManifest,
  EnvValueReference,
  Manifest,
  registerEnvValueReference,
} from '../src/sandbox/manifest';
import {
  deserializeManifest,
  serializeManifestRecord,
} from '../src/sandbox/sandboxes/shared/manifestPersistence';
import { deserializeLocalSandboxSessionStateValues } from '../src/sandbox/sandboxes/shared/sessionStateValues';
import type { SandboxClient } from '../src/sandbox/client';
import {
  deserializeSandboxSessionStateEntry,
  toSessionStateEnvelope,
} from '../src/sandbox/runtime/sessionState';

it('keeps persisted reference metadata inert across manifest and local restoration', async () => {
  class SecretReference extends EnvValueReference {
    static readonly type = 'test.persisted_reference_boundary';
    constructor(readonly key: string) {
      super();
    }
    serialize(): Record<string, unknown> {
      return { key: this.key };
    }
    async resolve(): Promise<string> {
      return `synthetic-secret:${this.key}`;
    }
  }
  const parse = vi.fn(
    (payload: Record<string, unknown>) =>
      new SecretReference(String(payload.key)),
  );
  const unregister = registerEnvValueReference(SecretReference, parse);
  try {
    const reference = { type: SecretReference.type, key: 'attacker-key' };
    const state = {
      manifest: { environment: { TOKEN: reference } },
      workspaceRootPath: '/synthetic-workspace',
      environment: {},
    };
    const manifest = deserializeManifest(state.manifest);
    expect(serializeManifestRecord(cloneManifest(manifest))).toMatchObject({
      environment: { TOKEN: reference },
    });
    await expect(manifest.resolveEnvironment()).rejects.toThrow(
      /trusted manifest/,
    );
    await expect(
      deserializeLocalSandboxSessionStateValues(state, null),
    ).rejects.toThrow(/trusted manifest/);
    expect(parse).not.toHaveBeenCalled();

    const trusted = new Manifest({
      environment: { TOKEN: new SecretReference('trusted-key') },
    });
    const restored = await deserializeLocalSandboxSessionStateValues(
      {
        ...state,
        manifest: { environment: trusted.environment },
      },
      null,
    );
    expect(restored.environment.TOKEN).toBe('synthetic-secret:trusted-key');
  } finally {
    unregister();
  }
});

it('restores current environment through the real local deserializer before serialized resume', async () => {
  const resolveReference = vi.fn(async () => 'synthetic-current-reference');
  class CurrentReference extends EnvValueReference {
    static readonly type = 'test.local_serialized_current_environment';
    constructor() {
      super();
    }
    serialize(): Record<string, unknown> {
      return {};
    }
    resolve = resolveReference;
  }
  const unregister = registerEnvValueReference(
    CurrentReference,
    () => new CurrentReference(),
  );
  try {
    const deserialize = vi.fn((state: Record<string, unknown>) =>
      deserializeLocalSandboxSessionStateValues(state, null),
    );
    const client = {
      backendId: 'unix-local',
      deserializeSessionState: deserialize,
    } as SandboxClient;
    const trusted = new Manifest({
      environment: {
        TOKEN: 'current',
        EPHEMERAL: { value: 'current-ephemeral', ephemeral: true },
        DERIVED: { value: 'placeholder', resolve: () => 'current-resolved' },
        REF: new CurrentReference(),
      },
    });
    const envelope = toSessionStateEnvelope(
      client.backendId,
      { manifest: new Manifest({ environment: { TOKEN: 'old' } }) },
      {
        workspaceRootPath: '/synthetic-workspace',
        environment: {
          TOKEN: 'attacker',
          EXTRA: 'injected',
          REF: 'attacker-reference',
        },
      },
    );
    const restored = await deserializeSandboxSessionStateEntry(
      client,
      {
        backendId: client.backendId,
        currentAgentKey: 'worker',
        currentAgentName: 'worker',
        sessionState: envelope,
      },
      trusted,
    );
    expect(deserialize.mock.calls[0]![0]).not.toHaveProperty('environment');
    expect(restored?.environment).toEqual({
      TOKEN: 'current',
      EPHEMERAL: 'current-ephemeral',
      DERIVED: 'current-resolved',
      REF: 'synthetic-current-reference',
    });
    expect(resolveReference).toHaveBeenCalledOnce();
  } finally {
    unregister();
  }
});
