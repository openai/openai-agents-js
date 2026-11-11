import { Agent } from '../src';
import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  Manifest,
  type SandboxClient,
  type SandboxSessionLike,
} from '@openai/agents-core/sandbox';
import { cleanupSandboxSession } from '@openai/agents-core/sandbox/internal';
import { Environment } from '../src/runtime/environment';
import { acquireEnvironment } from '../src/runtime/environment-source';
import { sandboxEnvironment } from '../src/runtime/sandbox-environment';
import { CODEX_REVISION, parseSessionState } from '../src/runtime/state';
import {
  ManagedWorkspaceCheckpoint,
  capturedWorkspaceJson,
  validateManagedWorkspaceOpening,
  bindManagedWorkspaceSource,
  captureRetiredWorkspace,
} from '../src/runtime/managed-workspace';

const state = () =>
  parseSessionState(
    JSON.stringify({
      format_version: 2,
      codex_revision: CODEX_REVISION,
      source_session_id: 'saved',
      history: [],
      root_metadata: {},
    }),
  );

it('captures detached pairs and rejects mixed/corrupted receipts', () => {
  const pair = ManagedWorkspaceCheckpoint._capture(
    state(),
    capturedWorkspaceJson({ backendId: 'fixture', providerState: { id: 'A' } }),
  );
  expect(
    ManagedWorkspaceCheckpoint.fromJSON(JSON.stringify(pair)).toJSON(),
  ).toEqual(pair.toJSON());
  pair.workspace.providerState.id = 'changed';
  expect(pair.workspace.providerState.id).toBe('A');
  expect(() =>
    ManagedWorkspaceCheckpoint.fromJSON({
      ...pair.toJSON(),
      workspace: pair.workspaceJson.replace('A', 'B'),
    }),
  ).toThrow(/association/);
});

it('rejects a recomputed pair with only workspace authorization before acquisition', () => {
  const workspace = capturedWorkspaceJson({
    backendId: 'fixture',
    providerState: { id: 'B' },
  });
  const original = ManagedWorkspaceCheckpoint._capture(state(), workspace);
  const conversation = JSON.stringify({
    ...original.conversation,
    source_session_id: 'other-conversation',
  });
  const forged = ManagedWorkspaceCheckpoint.fromJSON({
    ...original.toJSON(),
    conversation,
    association: createHash('sha256')
      .update(conversation)
      .update('\0')
      .update(workspace)
      .digest('hex'),
  });
  const acquire = vi.fn(async () => {
    throw new Error('must not acquire');
  });
  const source = bindManagedWorkspaceSource(acquire, {
    authorizedReceipt: workspace,
  });
  expect(() => validateManagedWorkspaceOpening(forged, source)).toThrow(
    /trusted.*checkpoint/,
  );
  expect(acquire).not.toHaveBeenCalled();
});

it('rejects raw surrogate collisions while retaining valid and escaped Unicode wire text', () => {
  const workspace = capturedWorkspaceJson({
    backendId: 'fixture',
    providerState: { id: 'B' },
  });
  const trustedText = JSON.stringify({
    ...state(),
    source_session_id: 'saved' + String.fromCharCode(0xfffd),
  });
  const digest = (text: string) =>
    createHash('sha256')
      .update(text)
      .update('\0')
      .update(workspace)
      .digest('hex');
  const trusted = new ManagedWorkspaceCheckpoint(
    trustedText,
    workspace,
    digest(trustedText),
  );
  const source = bindManagedWorkspaceSource(
    async () => {
      throw new Error('unused');
    },
    {
      authorizedReceipt: workspace,
      authorizedAssociation: trusted.association,
    },
  );
  expect(validateManagedWorkspaceOpening(trusted, source).state).toEqual(
    trusted.conversation,
  );
  for (const code of [0xd800, 0xdc00]) {
    const malformed = trustedText.replace(
      String.fromCharCode(0xfffd),
      String.fromCharCode(code),
    );
    expect(malformed).not.toBe(trustedText);
    expect(digest(malformed)).toBe(trusted.association);
    expect(
      () =>
        new ManagedWorkspaceCheckpoint(
          malformed,
          workspace,
          trusted.association,
        ),
    ).toThrow(/well-formed Unicode/);
  }
  const escaped = JSON.stringify({
    ...state(),
    source_session_id: 'saved' + String.fromCharCode(0xd800),
  });
  expect(escaped.isWellFormed()).toBe(true);
  expect(
    () => new ManagedWorkspaceCheckpoint(escaped, workspace, digest(escaped)),
  ).not.toThrow();
  const paired = JSON.stringify({
    ...state(),
    source_session_id: 'saved' + String.fromCodePoint(0x1f989),
  });
  expect(
    () => new ManagedWorkspaceCheckpoint(paired, workspace, digest(paired)),
  ).not.toThrow();
});

it('distinguishes retiring capture provenance from ordinary data and trusted full-pair grants', () => {
  const workspace = capturedWorkspaceJson({
    backendId: 'fixture',
    providerState: { id: 'B' },
  });
  const captured = captureRetiredWorkspace(state(), workspace);
  const imported = ManagedWorkspaceCheckpoint.fromJSON(captured.toJSON());
  const acquire = vi.fn(async () => {
    throw new Error('must not acquire');
  });
  const source = bindManagedWorkspaceSource(acquire, {
    authorizedReceipt: workspace,
  });
  expect(validateManagedWorkspaceOpening(captured, source).state).toEqual(
    imported.conversation,
  );
  for (const ordinary of [
    imported,
    ManagedWorkspaceCheckpoint._capture(state(), workspace),
  ]) {
    expect(() => validateManagedWorkspaceOpening(ordinary, source)).toThrow(
      /trusted.*checkpoint/,
    );
  }
  const trusted = bindManagedWorkspaceSource(
    async () => {
      throw new Error('unused');
    },
    {
      authorizedReceipt: workspace,
      authorizedAssociation: imported.association,
    },
  );
  expect(validateManagedWorkspaceOpening(imported, trusted).state).toEqual(
    imported.conversation,
  );
  const otherConversation = parseSessionState(
    JSON.stringify({ ...state(), source_session_id: 'other' }),
  );
  expect(() =>
    validateManagedWorkspaceOpening(
      captureRetiredWorkspace(otherConversation, workspace),
      trusted,
    ),
  ).toThrow(/trusted.*checkpoint/);
  expect(() =>
    validateManagedWorkspaceOpening(
      ManagedWorkspaceCheckpoint._capture(otherConversation, workspace),
      trusted,
    ),
  ).toThrow(/trusted.*checkpoint/);
  const wrongWorkspace = bindManagedWorkspaceSource(
    async () => {
      throw new Error('unused');
    },
    {
      authorizedReceipt: capturedWorkspaceJson({
        backendId: 'fixture',
        providerState: { id: 'other' },
      }),
      authorizedAssociation: imported.association,
    },
  );
  expect(() =>
    validateManagedWorkspaceOpening(captured, wrongWorkspace),
  ).toThrow(/current authorized/);
  expect(Object.keys(captured.toJSON()).sort()).toEqual([
    'association',
    'conversation',
    'format',
    'workspace',
  ]);
  expect(JSON.stringify(captured)).not.toContain('captureProvenance');
  expect(acquire).not.toHaveBeenCalled();
});

it('denies an untrusted matching-workspace pair through public opening before provider effects', async () => {
  const deserialize = vi.fn();
  const resume = vi.fn();
  const connect = vi.fn();
  const source = sandboxEnvironment({
    client: {
      backendId: 'fixture',
      deserializeSessionState: deserialize,
      resume,
      serializeSessionState: vi.fn(),
    },
    manifest: new Manifest(),
    managedWorkspace: true,
    authorizedResumeState: {
      backendId: 'fixture',
      serializedState: { id: 'B' },
    },
    connect,
  });
  const pair = ManagedWorkspaceCheckpoint.fromJSON(
    ManagedWorkspaceCheckpoint._capture(
      state(),
      capturedWorkspaceJson({
        backendId: 'fixture',
        providerState: { id: 'B' },
      }),
    ).toJSON(),
  );
  await expect(
    new Agent({ instructions: '' }).session({
      state: pair,
      environment: source,
    }),
  ).rejects.toThrow(/trusted.*checkpoint/);
  expect(deserialize).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
});

it.each([undefined, null, false, 0, ''])(
  'retains a falsy stop failure (%s), skips capture and runs later cleanup',
  async (value) => {
    const events: string[] = [];
    const finalize = vi.fn(async () => {
      events.push('capture');
    });
    const session: SandboxSessionLike = {
      state: { manifest: new Manifest() },
      stop: async () => {
        events.push('stop');
        throw value;
      },
      shutdown: async () => {
        events.push('shutdown');
      },
      delete: async () => {
        events.push('delete');
      },
    };
    await expect(
      cleanupSandboxSession(session, undefined, finalize),
    ).rejects.toBe(value);
    expect(finalize).not.toHaveBeenCalled();
    expect(events).toEqual(['stop', 'shutdown', 'delete']);
  },
);

it('runs capture after stop and preserves cleanup after a falsy capture failure', async () => {
  const events: string[] = [];
  const session: SandboxSessionLike = {
    state: { manifest: new Manifest() },
    stop: async () => {
      events.push('stop');
    },
    shutdown: async () => {
      events.push('shutdown');
    },
  };
  await expect(
    cleanupSandboxSession(session, undefined, async () => {
      events.push('capture');
      throw false;
    }),
  ).rejects.toBe(false);
  expect(events).toEqual(['stop', 'capture', 'shutdown']);
});

it('captures explicit serialized authorization before deserialization and never serializes for comparison', async () => {
  const events: string[] = [];
  const payload = { id: 'A' };
  const resource: SandboxSessionLike = {
    state: {
      manifest: new Manifest(),
      snapshot: { type: 'local', id: 'A', path: '/synthetic/A' },
    },
    stop: async () => {
      events.push('stop');
    },
    shutdown: async () => {
      events.push('shutdown');
    },
  };
  const serialize = vi.fn(async () => {
    events.push('serialize');
    return { id: 'B' };
  });
  const client: SandboxClient = {
    backendId: 'fixture',
    serializeSessionState: serialize,
    deserializeSessionState: async (data) => {
      events.push('deserialize');
      expect(data.id).toBe('A');
      return resource.state;
    },
    resume: async () => {
      events.push('resume');
      return resource;
    },
    delete: async () => {
      events.push('delete');
    },
  };
  const pair = ManagedWorkspaceCheckpoint._capture(
    state(),
    capturedWorkspaceJson({ backendId: 'fixture', providerState: { id: 'A' } }),
  );
  const source = sandboxEnvironment({
    client,
    manifest: new Manifest(),
    managedWorkspace: true,
    authorizedResumeState: { backendId: 'fixture', serializedState: payload },
    authorizedResumeCheckpoint: pair,
    connect: async () =>
      Environment.lease(
        new Environment({ url: 'wss://fixture.invalid', cwd: '/workspace' }),
        async () => {
          events.push('gateway');
        },
      ),
  });
  payload.id = 'mutated';
  validateManagedWorkspaceOpening(pair, source);
  expect(events).toEqual([]);
  expect(() =>
    validateManagedWorkspaceOpening(
      ManagedWorkspaceCheckpoint._capture(
        state(),
        capturedWorkspaceJson({
          backendId: 'fixture',
          providerState: { id: 'wrong' },
        }),
      ),
      source,
    ),
  ).toThrow(/current authorized/);
  expect(events).toEqual([]);
  const owner = await acquireEnvironment(source);
  expect(serialize).not.toHaveBeenCalled();
  owner.managedWorkspace!.captureRequested = true;
  await owner.dispose();
  expect(events).toEqual([
    'deserialize',
    'resume',
    'gateway',
    'stop',
    'serialize',
    'shutdown',
    'delete',
  ]);
  expect(JSON.parse(owner.managedWorkspace!.receipt!).providerState.id).toBe(
    'B',
  );
});

it('rejects mismatched paired state through the public opening before any source effect', async () => {
  const deserialize = vi.fn();
  const source = sandboxEnvironment({
    client: {
      backendId: 'fixture',
      deserializeSessionState: deserialize,
      resume: vi.fn(),
      serializeSessionState: vi.fn(),
    },
    manifest: new Manifest(),
    managedWorkspace: true,
    authorizedResumeState: {
      backendId: 'fixture',
      serializedState: { id: 'authorized' },
    },
    connect: vi.fn(),
  });
  const wrong = ManagedWorkspaceCheckpoint._capture(
    state(),
    capturedWorkspaceJson({
      backendId: 'fixture',
      providerState: { id: 'other' },
    }),
  );
  await expect(
    new Agent({ instructions: 'Keep authority.' }).session({
      state: wrong,
      environment: source,
    }),
  ).rejects.toThrow(/current authorized/);
  expect(deserialize).not.toHaveBeenCalled();
});

it('normalizes provider JSON omission and rejects nonfinite values', () => {
  expect(capturedWorkspaceJson({ id: 'A', optional: undefined })).toBe(
    '{"id":"A"}',
  );
  expect(() => capturedWorkspaceJson({ id: NaN })).toThrow(/finite/);
});

it('isolates capture owners and receipts for two acquisitions of one fresh source', async () => {
  let next = 0;
  const stopped: number[] = [];
  const client: SandboxClient = {
    backendId: 'fixture',
    create: async () => {
      const id = ++next;
      return {
        state: {
          manifest: new Manifest(),
          snapshot: { type: 'local', id: String(id), path: '/synthetic/' + id },
        },
        stop: async () => {
          stopped.push(id);
        },
        shutdown: async () => {},
      };
    },
    serializeSessionState: async (state) => ({ id: state.snapshot!.id }),
    delete: async () => {},
  };
  const source = sandboxEnvironment({
    client,
    manifest: new Manifest(),
    managedWorkspace: true,
    connect: async () =>
      Environment.lease(
        new Environment({ url: 'wss://fixture.invalid', cwd: '/workspace' }),
        async () => {},
      ),
  });
  const first = await acquireEnvironment(source),
    second = await acquireEnvironment(source);
  expect(first.managedWorkspace).not.toBe(second.managedWorkspace);
  first.managedWorkspace!.captureRequested = true;
  await first.dispose();
  const receipt = first.managedWorkspace!.receipt;
  expect(JSON.parse(receipt!).providerState.id).toBe('1');
  expect(second.managedWorkspace!.receipt).toBeUndefined();
  expect(second.managedWorkspace!.captureRequested).toBe(false);
  second.managedWorkspace!.captureRequested = true;
  await second.dispose();
  expect(JSON.parse(second.managedWorkspace!.receipt!).providerState.id).toBe(
    '2',
  );
  expect(first.managedWorkspace!.receipt).toBe(receipt);
  expect(stopped).toEqual([1, 2]);
});
