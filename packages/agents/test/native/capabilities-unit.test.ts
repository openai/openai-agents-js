import { describe, expect, it, vi } from 'vitest';
import { CapabilityError, NativeError, NativeProvider } from '../../src';
import {
  checkpointStatus,
  createCapabilities,
  featureSupport,
  type CapabilityFacts,
  type FeatureName,
  type FeatureSupport,
} from '../../src/runtime/capabilities';
import { Session, type SessionOptions } from '../../src/runtime/session';
import { captureTools } from '../../src/runtime/tools';
import type { Engine, NativeThread } from '../../src/runtime/binding';
import { CODEX_REVISION } from '../../src/runtime/state';

// These pure cases test reports and the SDK boundary, without native admission.
const empty: CapabilityFacts = {
  manual: false,
  manualRestore: false,
  functionCallback: false,
  mcp: false,
  executor: false,
  codeMode: false,
  nativeAgents: false,
  local: false,
  remoteSkills: false,
  checklist: false,
};
const baseline: Record<FeatureName, FeatureSupport['status']> = {
  nativeOutput: 'supported',
  promptedOutput: 'limited',
  manualSuspend: 'unsupported',
  nativeOutputManualRestore: 'unsupported',
  toolSelection: 'limited',
  functionPolicy: 'unsupported',
  mcpBeforePolicy: 'unsupported',
  mcpResultPolicy: 'unsupported',
  environmentBeforePolicy: 'unsupported',
  environmentCodeResultPolicy: 'unsupported',
  nativeAgents: 'unsupported',
  remoteSkills: 'unsupported',
  checklist: 'unsupported',
};

describe('configuration reports', () => {
  it.each(
    Object.entries(baseline) as [FeatureName, FeatureSupport['status']][],
  )('reports the public baseline for %s', (feature, status) => {
    const report = featureSupport(feature, empty);
    expect(report.status).toBe(status);
    expect(report.reason.length).toBeGreaterThan(0);
    expect(report.scope.length).toBeGreaterThan(0);
    expect(Object.isFrozen(report)).toBe(true);
  });
  it('reports the admitted manual and callback configuration', () => {
    const facts = {
      ...empty,
      manual: true,
      manualRestore: true,
      functionCallback: true,
    };
    expect(featureSupport('manualSuspend', facts).status).toBe('limited');
    expect(featureSupport('functionPolicy', facts).status).toBe('supported');
    expect(featureSupport('nativeOutputManualRestore', facts).status).toBe(
      'limited',
    );
    expect(
      featureSupport('manualSuspend', { ...facts, local: true }).status,
    ).toBe('unsupported');
    expect(
      featureSupport('nativeOutputManualRestore', { ...facts, local: true })
        .status,
    ).toBe('unsupported');
    expect(
      featureSupport('nativeOutputManualRestore', {
        ...empty,
        manualRestore: true,
        executor: true,
        codeMode: true,
      }).status,
    ).toBe('limited');
  });
  it('distinguishes executor, Code Mode, remote roots and native grants', () => {
    const facts = {
      ...empty,
      executor: true,
      codeMode: true,
      nativeAgents: true,
      remoteSkills: true,
      checklist: true,
      mcp: true,
    };
    for (const feature of [
      'environmentBeforePolicy',
      'nativeAgents',
      'remoteSkills',
      'checklist',
      'mcpBeforePolicy',
      'mcpResultPolicy',
    ] as const)
      expect(featureSupport(feature, facts).status).toBe('supported');
    expect(featureSupport('environmentCodeResultPolicy', facts).status).toBe(
      'limited',
    );
    expect(
      featureSupport('environmentCodeResultPolicy', {
        ...facts,
        codeMode: false,
      }).status,
    ).toBe('limited');
    expect(
      featureSupport('remoteSkills', { ...empty, remoteSkills: true }).status,
    ).toBe('supported');
    expect(
      featureSupport('remoteSkills', { ...empty, executor: true }).status,
    ).toBe('unsupported');
  });
  it('keeps retained reports detached while the view reads current facts', () => {
    let facts = empty;
    const view = createCapabilities(
      () => {},
      (feature) => featureSupport(feature, facts),
      false,
    );
    const before = view.get('functionPolicy');
    facts = { ...empty, functionCallback: true };
    expect(view.get('functionPolicy').status).toBe('supported');
    facts = empty;
    expect(view.get('functionPolicy').status).toBe('unsupported');
    expect(before.status).toBe('unsupported');
    expect(Object.isFrozen(view)).toBe(true);
  });
  it('requires MCP before policies only while MCP tools are acknowledged', () => {
    let facts = empty;
    const view = createCapabilities(
      () => {},
      (feature) => featureSupport(feature, facts),
      false,
    );
    expect(() => view.require('mcpBeforePolicy')).toThrow(CapabilityError);
    facts = { ...empty, mcp: true, nativeAgents: true };
    const admitted = view.get('mcpBeforePolicy');
    expect(admitted.status).toBe('supported');
    expect(admitted.scope).toContain('root and admitted native children');
    expect(admitted.scope).toContain(
      'closed native children and released callbacks',
    );
    expect(() => view.require('mcpBeforePolicy')).not.toThrow();
    facts = empty;
    expect(() => view.require('mcpBeforePolicy')).toThrow(CapabilityError);
    expect(admitted.status).toBe('supported');
  });
  it('requires explicit acceptance of limited support and rejects unsupported', () => {
    const view = createCapabilities(
      () => {},
      (feature) => featureSupport(feature, empty),
      false,
    );
    expect(() => view.require('nativeOutput')).not.toThrow();
    expect(() => view.require('toolSelection')).toThrow(CapabilityError);
    expect(() =>
      view.require('toolSelection', { allowLimited: true }),
    ).not.toThrow();
    expect(() => view.require('checklist', { allowLimited: true })).toThrow(
      CapabilityError,
    );
    const support = featureSupport('checklist', empty);
    const error = new CapabilityError('checklist', support);
    expect(error).toBeInstanceOf(NativeError);
    expect(error.name).toBe('CapabilityError');
    expect(error.support).toEqual(support);
    expect(error.support).not.toBe(support);
    expect(Object.isFrozen(error.support)).toBe(true);
    expect([
      error.statusCode,
      error.code,
      error.requestId,
      error.category,
    ]).toEqual([null, null, null, null]);
    expect(error.cause).toBeUndefined();
  });
  it('validates unknown features before checking retained-view health', () => {
    const healthy = vi.fn(() => {
      throw new NativeError('closed');
    });
    const read = vi.fn((feature: FeatureName) =>
      featureSupport(feature, empty),
    );
    const view = createCapabilities(healthy, read, true);
    // @ts-expect-error Runtime callers can supply unknown names.
    expect(() => view.get('missing')).toThrow(TypeError);
    expect(healthy).not.toHaveBeenCalled();
    expect(() => view.get('nativeOutput')).toThrow(NativeError);
    expect(() => view.websocketsAllowed).toThrow(NativeError);
    expect(read).not.toHaveBeenCalled();
  });
  it.each([
    [{}, true],
    [{ baseUrl: 'https://example.invalid/v1' }, false],
    [{ baseUrl: 'https://example.invalid/v1', supportsWebsockets: true }, true],
    [{ supportsWebsockets: false }, false],
  ] as const)(
    'captures the same WebSocket policy used by the provider %j',
    async (options, expected) => {
      const provider = new NativeProvider({ ...options, apiKey: 'test' });
      const lease = provider._acquire();
      try {
        expect(lease.websocketsAllowed).toBe(expected);
        expect(lease.config['model_providers.native_agent']).toMatchObject({
          supports_websockets: expected,
        });
      } finally {
        await lease.release();
        await provider.close();
      }
    },
  );
});

const checkpoint = JSON.stringify({
  format_version: 2,
  codex_revision: CODEX_REVISION,
  source_session_id: 'session',
  history: [],
  root_metadata: {},
});
function fixture(
  options: SessionOptions = {},
  response?: () => Promise<string>,
) {
  const native = {
    id: 'session',
    _export_checkpoint: vi.fn(
      response ??
        (async () =>
          JSON.stringify({
            kind: 'snapshot',
            snapshot: checkpoint,
          })),
    ),
    _close_report: vi.fn(async () => null),
  } as unknown as NativeThread;
  const engine = {
    _close_report: vi.fn(async () => null),
  } as unknown as Engine;
  return {
    native,
    session: new Session(engine, native, captureTools([]), options, {}),
  };
}

describe('checkpoint advice SDK boundary', () => {
  it('rechecks close after a held probe and refuses concurrent inspection', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { native, session } = fixture({}, async () => {
      entered.resolve();
      await release.promise;
      return JSON.stringify({ kind: 'snapshot', snapshot: checkpoint });
    });
    const pending = session.checkpointStatus({ kind: 'idle' });
    try {
      await entered.promise;
      expect(session.capabilities.get('nativeOutput').status).toBe('supported');
      expect(await session.checkpointStatus({ kind: 'idle' })).toMatchObject({
        status: 'notReady',
      });
      expect(native._export_checkpoint).toHaveBeenCalledTimes(1);
      const closing = session.close();
      release.resolve();
      expect(await pending).toMatchObject({ status: 'notReady' });
      await closing;
    } finally {
      release.resolve();
      await pending;
      await session.close();
    }
  });
  it('uses the explicit probe and returns immutable advice without exposing a snapshot', async () => {
    const { native, session } = fixture();
    expect(await session.checkpointStatus({ kind: 'idle' })).toEqual({
      status: 'ready',
      reasons: [],
    });
    expect(native._export_checkpoint).toHaveBeenCalledTimes(1);
    expect(native._export_checkpoint).toHaveBeenCalledWith(null, false, true);
    expect(Object.isFrozen(checkpointStatus('ready').reasons)).toBe(true);
    expect(Object.isFrozen(checkpointStatus('notReady', 'fixed'))).toBe(true);
    await session.close();
    expect(await session.checkpointStatus({ kind: 'idle' })).toMatchObject({
      status: 'notReady',
    });
  });
  it.each(['nativeBusy', 'nativeChanged'] as const)(
    'preserves definite native refusal %s',
    async (reason) => {
      const { session } = fixture({}, async () =>
        JSON.stringify({ kind: 'notReady', reason }),
      );
      expect(await session.checkpointStatus({ kind: 'idle' })).toMatchObject({
        status: 'notReady',
      });
      await session.close();
    },
  );
  it.each([
    async () => {
      throw new Error('private native detail');
    },
    async () => '{',
    async () => JSON.stringify({ kind: 'snapshot', snapshot: '{}' }),
    async () =>
      JSON.stringify({ kind: 'notReady', reason: 'private native detail' }),
  ])(
    'returns fixed unknown advice for unverifiable responses',
    async (response) => {
      const { session } = fixture({}, response);
      expect(await session.checkpointStatus({ kind: 'idle' })).toEqual({
        status: 'unknown',
        reasons: ['Native checkpoint readiness could not be verified'],
      });
      await session.close();
    },
  );
  it('refuses portable advice for local storage without calling native export', async () => {
    const { native, session } = fixture({ localStorage: true });
    for (const kind of ['idle', 'manualWait'] as const)
      expect(await session.checkpointStatus({ kind })).toMatchObject({
        status: 'notReady',
      });
    expect(native._export_checkpoint).not.toHaveBeenCalled();
    await session.close();
  });
});
