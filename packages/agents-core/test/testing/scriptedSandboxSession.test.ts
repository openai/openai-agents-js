import { describe, expect, expectTypeOf, it } from 'vitest';
import { run } from '../../src';
import type { SandboxSession } from '../../src/sandbox';
import { SandboxAgent, shell } from '../../src/sandbox';
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
