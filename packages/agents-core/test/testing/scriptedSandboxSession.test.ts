import { describe, expect, expectTypeOf, it } from 'vitest';
import { run } from '../../src';
import type { SandboxSession } from '../../src/sandbox';
import { Manifest, SandboxAgent, shell } from '../../src/sandbox';
import { manifestAcknowledgesInContainerMountCredentialExposure } from '../../src/sandbox/manifest';
import { registerSandboxPreStopHook } from '../../src/sandbox/runtime/sessionLifecycle';
import {
  InvalidScriptedSandboxStepError,
  SandboxCallMatcherError,
  ScriptedModel,
  UnexpectedSandboxCallError,
  UnconsumedSandboxStepsError,
  assistantMessage,
  functionCall,
  scriptedSandboxSession,
  type ScriptedSandboxCallFor,
} from '../../src/testing';

describe('scriptedSandboxSession', () => {
  it('returns a session with only configured optional methods', async () => {
    const session = scriptedSandboxSession([
      {
        method: 'execCommand',
        match: ({ cmd }) => cmd === 'pwd',
        result: '/workspace\n',
      },
    ]);

    expectTypeOf(session).toMatchTypeOf<SandboxSession>();
    expectTypeOf(session.execCommand).toEqualTypeOf<
      NonNullable<SandboxSession['execCommand']>
    >();
    expect('execCommand' in session).toBe(true);
    expect('writeStdin' in session).toBe(false);

    await expect(session.execCommand({ cmd: 'pwd' })).resolves.toBe(
      '/workspace\n',
    );
    expect(session.calls).toEqual([
      {
        index: 0,
        method: 'execCommand',
        args: [{ cmd: 'pwd' }],
      },
    ]);
    expect(session.remainingSteps).toBe(0);
    expect(() => session.assertComplete()).not.toThrow();
  });

  it('drives a SandboxAgent shell workflow with ScriptedModel', async () => {
    const session = scriptedSandboxSession([
      {
        method: 'execCommand',
        match: ({ cmd }) => cmd === 'pwd',
        result: '/workspace\n',
      },
    ]);
    const model = new ScriptedModel([
      [functionCall('exec_command', { cmd: 'pwd' }, { callId: 'call_1' })],
      [assistantMessage('The workspace is /workspace.')],
    ]);
    const agent = new SandboxAgent({
      name: 'Test agent',
      model,
      capabilities: [shell()],
    });

    const result = await run(agent, 'Where am I?', {
      sandbox: { session },
    });

    expect(result.finalOutput).toBe('The workspace is /workspace.');
    expect(session.calls).toHaveLength(1);
    expect(model.calls).toHaveLength(2);
    session.assertComplete();
    model.assertComplete();
  });

  it('supports typed responders and synchronous session methods', async () => {
    const session = scriptedSandboxSession([
      {
        method: 'execCommand',
        respond: (call) => `call ${call.index}: ${call.args[0].cmd as string}`,
      },
      {
        method: 'supportsPty',
        result: true,
      },
    ]);

    await expect(session.execCommand({ cmd: 'echo hello' })).resolves.toBe(
      'call 0: echo hello',
    );
    expect(session.supportsPty()).toBe(true);
    expect(session.calls.map((call) => call.method)).toEqual([
      'execCommand',
      'supportsPty',
    ]);
  });

  it('allows SDK-managed lifecycle hooks to wrap scripted methods', async () => {
    const calls: string[] = [];
    const session = scriptedSandboxSession([
      {
        method: 'stop',
        respond: () => {
          calls.push('stop');
        },
      },
    ]);

    registerSandboxPreStopHook(session, () => {
      calls.push('hook');
    });
    await session.stop();

    expect(calls).toEqual(['hook', 'stop']);
    session.assertComplete();
  });

  it('records detached invocation-time argument snapshots', async () => {
    const session = scriptedSandboxSession([
      {
        method: 'hydrateWorkspace',
        result: undefined,
      },
    ]);
    const archive = new Uint8Array([1, 2, 3]);

    const hydration = session.hydrateWorkspace(archive);
    archive[0] = 9;
    await hydration;

    const firstSnapshot = session.calls[0].args[0] as Uint8Array;
    expect([...firstSnapshot]).toEqual([1, 2, 3]);
    firstSnapshot[0] = 8;
    expect([...(session.calls[0].args[0] as Uint8Array)]).toEqual([1, 2, 3]);
  });

  it('isolates applyManifest matcher snapshots from the caller and call history', async () => {
    const manifest = createMutableManifest();
    const session = scriptedSandboxSession([
      {
        method: 'applyManifest',
        match: (snapshot) => {
          expectManifestValues(snapshot, 'initial');
          mutateManifest(snapshot, 'matcher');
          return true;
        },
        result: undefined,
      },
    ]);

    await session.applyManifest(manifest);

    expectManifestValues(manifest, 'initial');
    expectManifestValues(session.calls[0].args[0] as Manifest, 'initial');
  });

  it('isolates applyManifest responder snapshots from call history', async () => {
    const manifest = createMutableManifest();
    const session = scriptedSandboxSession([
      {
        method: 'applyManifest',
        respond: (call) => {
          const snapshot = call.args[0];
          expectManifestValues(snapshot, 'initial');
          mutateManifest(snapshot, 'responder');
        },
      },
    ]);

    await session.applyManifest(manifest);

    expectManifestValues(manifest, 'initial');
    expectManifestValues(session.calls[0].args[0] as Manifest, 'initial');
  });

  it('keeps applyManifest call snapshots stable after later mutations', async () => {
    const manifest = createMutableManifest();
    const session = scriptedSandboxSession([
      {
        method: 'applyManifest',
        result: undefined,
      },
    ]);

    await session.applyManifest(manifest);
    mutateManifest(manifest, 'caller');

    const firstRead = session.calls[0].args[0] as Manifest;
    expectManifestValues(firstRead, 'initial');
    mutateManifest(firstRead, 'observer');
    expectManifestValues(session.calls[0].args[0] as Manifest, 'initial');
  });

  it('snapshots mutable static results when they are queued', async () => {
    const archive = new Uint8Array([1, 2, 3]);
    const session = scriptedSandboxSession([
      {
        method: 'persistWorkspace',
        result: archive,
      },
    ]);

    archive[0] = 9;

    await expect(session.persistWorkspace()).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it('preserves runtime identities in call snapshots', () => {
    const hook = () => {};
    const session = scriptedSandboxSession([
      {
        method: 'registerPreStopHook',
        result: undefined,
      },
    ]);

    session.registerPreStopHook(hook);

    expect(session.calls[0].args[0]).toBe(hook);
  });

  it('reports mismatched, rejected, and extra calls without payloads', async () => {
    const mismatch = scriptedSandboxSession([
      { method: 'execCommand', result: 'ok' },
      { method: 'readFile', result: 'contents' },
    ]);

    const mismatchError = await mismatch
      .readFile({ path: '/secret/payload.txt' })
      .catch((error: unknown) => error);
    expect(mismatchError).toBeInstanceOf(UnexpectedSandboxCallError);
    expect(mismatchError).toMatchObject({
      callIndex: 0,
      actualMethod: 'readFile',
      expectedMethod: 'execCommand',
      remainingSteps: 1,
    });
    expect(String(mismatchError)).not.toContain('/secret/payload.txt');

    const rejected = scriptedSandboxSession([
      {
        method: 'execCommand',
        match: () => false,
        result: 'unused',
      },
    ]);
    await expect(
      rejected.execCommand({ cmd: 'secret command' }),
    ).rejects.toBeInstanceOf(SandboxCallMatcherError);

    const extra = scriptedSandboxSession([
      { method: 'execCommand', result: 'first' },
    ]);
    await extra.execCommand({ cmd: 'first' });
    await expect(extra.execCommand({ cmd: 'second' })).rejects.toMatchObject({
      callIndex: 1,
      actualMethod: 'execCommand',
      expectedMethod: undefined,
      remainingSteps: 0,
    });
  });

  it('preserves matcher and injected errors', async () => {
    const matcherError = new Error('matcher failed');
    const matcherSession = scriptedSandboxSession([
      {
        method: 'execCommand',
        match: () => {
          throw matcherError;
        },
        result: 'unused',
      },
    ]);
    await expect(matcherSession.execCommand({ cmd: 'pwd' })).rejects.toBe(
      matcherError,
    );

    const injectedError = new Error('sandbox unavailable');
    const errorSession = scriptedSandboxSession([
      { method: 'execCommand', error: injectedError },
    ]);
    await expect(errorSession.execCommand({ cmd: 'pwd' })).rejects.toBe(
      injectedError,
    );
  });

  it('reports unconsumed steps with their method order', () => {
    const session = scriptedSandboxSession([
      { method: 'execCommand', result: 'first' },
      { method: 'readFile', result: 'second' },
    ]);

    expect(() => session.assertComplete()).toThrowError(
      UnconsumedSandboxStepsError,
    );
    try {
      session.assertComplete();
    } catch (error) {
      expect(error).toMatchObject({
        remainingSteps: 2,
        pendingMethods: ['execCommand', 'readFile'],
      });
    }
  });

  it('validates scripted step envelopes before session use', () => {
    expect(() =>
      scriptedSandboxSession([{ method: 'unknown', result: 'nope' }] as any),
    ).toThrowError(
      expect.objectContaining({
        name: 'InvalidScriptedSandboxStepError',
        reason: 'unknown_method',
        inputIndex: 0,
        method: 'unknown',
      }),
    );
    expect(() =>
      scriptedSandboxSession([{ method: 'execCommand' }] as any),
    ).toThrowError(
      expect.objectContaining({
        name: 'InvalidScriptedSandboxStepError',
        reason: 'invalid_outcome',
        inputIndex: 0,
        method: 'execCommand',
      }),
    );
    expect(() =>
      scriptedSandboxSession([
        { method: 'execCommand', result: 'ok', respond: 'not a function' },
      ] as any),
    ).toThrowError(InvalidScriptedSandboxStepError);
  });

  it('exposes method-specific call types', () => {
    type ExecCall = ScriptedSandboxCallFor<'execCommand'>;
    expectTypeOf<ExecCall['args'][0]>().toEqualTypeOf<
      Parameters<NonNullable<SandboxSession['execCommand']>>[0]
    >();
  });
});

function createMutableManifest(): Manifest {
  return new Manifest({
    root: '/workspace',
    entries: {
      'config.json': {
        type: 'file',
        content: 'initial',
      },
    },
    environment: {
      TEST_VALUE: 'initial',
    },
    users: ['initial'],
    groups: [{ name: 'initial', users: ['initial'] }],
    extraPathGrants: [
      {
        path: '/initial',
        hostPath: '/host/initial',
        description: 'initial',
      },
    ],
    remoteMountCommandAllowlist: ['initial'],
  }).withInContainerMountCredentialExposureAcknowledged('/workspace/mount');
}

function expectManifestValues(manifest: Manifest, value: string): void {
  expect(manifest.root).toBe(value === 'initial' ? '/workspace' : `/${value}`);
  expect(manifest.entries['config.json']).toMatchObject({ content: value });
  expect(manifest.environment.TEST_VALUE.value).toBe(value);
  expect(manifest.users[0]?.name).toBe(value);
  expect(manifest.groups[0]).toMatchObject({
    name: value,
    users: [{ name: value }],
  });
  expect(manifest.extraPathGrants[0]).toMatchObject({
    path: `/${value}`,
    hostPath: `/host/${value}`,
    description: value,
  });
  expect(manifest.remoteMountCommandAllowlist).toEqual([value]);
  if (value === 'initial') {
    expect(
      manifestAcknowledgesInContainerMountCredentialExposure(
        manifest,
        '/workspace/mount',
        'mount_scoped',
      ),
    ).toBe(true);
  }
}

function mutateManifest(manifest: Manifest, value: string): void {
  (manifest as { root: string }).root = `/${value}`;
  (manifest.entries['config.json'] as { content: string }).content = value;
  (manifest.environment.TEST_VALUE as { value: string }).value = value;
  manifest.users[0]!.name = value;
  manifest.groups[0]!.name = value;
  manifest.groups[0]!.users![0]!.name = value;
  manifest.extraPathGrants[0]!.path = `/${value}`;
  manifest.extraPathGrants[0]!.hostPath = `/host/${value}`;
  manifest.extraPathGrants[0]!.description = value;
  manifest.remoteMountCommandAllowlist[0] = value;
}
