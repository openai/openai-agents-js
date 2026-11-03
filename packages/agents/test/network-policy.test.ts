import { describe, expect, it } from 'vitest';
import { Environment, environmentConfig } from '../src/runtime/environment';
import {
  captureNetworkPolicy,
  networkPolicyDigest,
} from '../src/runtime/network-policy';
import {
  CODEX_REVISION,
  assertCheckpointNetworkPolicy,
  fromNativeCheckpoint,
  isManualSessionState,
  nativeCheckpoint,
  parseNativeCheckpoint,
  parseSessionState,
  readCheckpointSelections,
} from '../src/runtime/state';
import { prepareOutput } from '../src/runtime/output';

const executor = {
  url: 'wss://executor.invalid',
  cwd: '/job',
  tools: ['exec_command'] as const,
};

describe('managed executor network declaration', () => {
  it('distinguishes the default from an explicit empty managed policy', () => {
    const omitted = new Environment(executor);
    const empty = new Environment({ ...executor, network: {} });
    expect(environmentConfig(omitted)).not.toHaveProperty('network');
    expect(environmentConfig(empty).network).toEqual({
      allowed_domains: [],
      denied_domains: [],
      allow_all_unix_sockets: false,
      allow_local_binding: false,
    });
    expect(networkPolicyDigest(omitted.network)).toBeUndefined();
    expect(networkPolicyDigest(empty.network)).toMatch(
      /^sha256:v1:[a-f0-9]{64}$/,
    );
  });

  it('requires command admission without granting additional tools', () => {
    expect(
      () => new Environment({ ...executor, tools: [], network: {} }),
    ).toThrow('requires exec_command');
    expect(new Environment({ ...executor, network: {} }).tools).toEqual([
      'exec_command',
    ]);
  });

  it('captures immutable rules and gives canonical equivalents one identity', () => {
    const allowed = [
      'B.example.invalid.',
      'A.example.invalid',
      'blocked.invalid',
    ];
    const denied = ['blocked.invalid', '::ffff:192.0.2.1'];
    const selected = new Environment({
      ...executor,
      network: {
        allowedDomains: allowed,
        deniedDomains: denied,
        allowAllUnixSockets: true,
      },
    });
    allowed.push('late.invalid');
    denied.length = 0;
    const equivalent = new Environment({
      ...executor,
      network: {
        allowedDomains: [
          'a.example.invalid',
          'b.example.invalid',
          'a.example.invalid',
        ],
        deniedDomains: ['::FFFF:c000:0201', 'blocked.invalid'],
        allowAllUnixSockets: true,
      },
    });
    expect(selected.network).toEqual(equivalent.network);
    expect(selected.network?.allowedDomains).toEqual([
      'a.example.invalid',
      'b.example.invalid',
    ]);
    expect(selected.network?.deniedDomains).toEqual([
      '::ffff:192.0.2.1',
      'blocked.invalid',
    ]);
    expect(networkPolicyDigest(selected.network)).toBe(
      networkPolicyDigest(equivalent.network),
    );
    expect(Object.isFrozen(selected.network)).toBe(true);
    expect(Object.isFrozen(selected.network?.allowedDomains)).toBe(true);
    expect(Object.isFrozen(selected.network?.deniedDomains)).toBe(true);
  });

  it('includes every effective flag in saved policy identity', () => {
    const base = captureNetworkPolicy({});
    for (const policy of [
      { allowedDomains: ['example.invalid'] },
      { deniedDomains: ['example.invalid'] },
      { allowAllUnixSockets: true },
      { allowLocalBinding: true },
    ])
      expect(networkPolicyDigest(captureNetworkPolicy(policy))).not.toBe(
        networkPolicyDigest(base),
      );
  });

  it.each([
    '',
    '.',
    '*.',
    '**.',
    'example.invalid:443',
    'https://example.invalid',
    'user@host',
    'a/b',
    'a\\b',
    'a#b',
    'a b',
    'é.invalid',
    '[::1]:80',
    'fe80::1%eth0',
  ])('refuses an ambiguous or unsupported rule %j at declaration', (rule) => {
    expect(
      () =>
        new Environment({ ...executor, network: { allowedDomains: [rule] } }),
    ).toThrow();
  });

  it.each([
    null,
    { allowedDomains: 'host' },
    { deniedDomains: [1] },
    { allowAllUnixSockets: 1 },
    { allowLocalBinding: 'false' },
    { unknown: true },
  ])('refuses malformed policy structure %j', (policy) => {
    // @ts-expect-error Exercise caller input that does not satisfy the public type.
    expect(() => new Environment({ ...executor, network: policy })).toThrow();
  });
});

describe('checkpoint network authority', () => {
  const digest = networkPolicyDigest(captureNetworkPolicy({}))!;
  const identity = prepareOutput(undefined).identity;
  const native = (format_version: 2 | 4) =>
    parseNativeCheckpoint({
      format_version,
      codex_revision: CODEX_REVISION,
      source_session_id: 'saved-session',
      history: [],
      root_metadata: {},
    });
  const manual = {
    manual_continuation: {
      turn_id: 'saved-turn',
      reply_order: ['pending'],
      accepted_replies: {},
      pending_manual: [{ call_id: 'pending', name: 'lookup', arguments: '{}' }],
    },
    manual_context: { instructions: null, result_schemas: [], usage: null },
  };

  it.each([2, 4] as const)(
    'preserves native codec %i and manual frame identity',
    (codec) => {
      for (const pending of [undefined, manual]) {
        const state = fromNativeCheckpoint(
          native(codec),
          identity,
          undefined,
          undefined,
          pending,
          {},
          digest,
        );
        expect(state.format_version).toBe(
          (codec === 4 ? 14 : 12) + (pending ? 1 : 0),
        );
        expect(isManualSessionState(state)).toBe(!!pending);
        expect(nativeCheckpoint(state)).toEqual(native(codec));
        expect(parseSessionState(JSON.stringify(state))).toEqual(state);
        if (pending)
          expect(state.manual_continuation).toEqual(
            pending.manual_continuation,
          );
        expect(() =>
          assertCheckpointNetworkPolicy(state, digest),
        ).not.toThrow();
        expect(() => assertCheckpointNetworkPolicy(state, undefined)).toThrow(
          'must agree',
        );
      }
    },
  );

  it('retains static selection metadata without requiring it for network-only checkpoints', () => {
    const selection = { default_tools: [] };
    const state = fromNativeCheckpoint(
      native(2),
      identity,
      undefined,
      undefined,
      undefined,
      selection,
      digest,
    );
    expect(readCheckpointSelections(state)).toEqual(selection);
    const withoutSelection = fromNativeCheckpoint(
      native(2),
      identity,
      undefined,
      undefined,
      undefined,
      {},
      digest,
    );
    expect(readCheckpointSelections(withoutSelection)).toEqual({});
  });

  it('keeps legacy/default state separate from explicit empty policy', () => {
    const state = fromNativeCheckpoint(native(2), identity);
    expect(state.format_version).toBe(4);
    expect(state).not.toHaveProperty('network_policy_digest');
    expect(() => assertCheckpointNetworkPolicy(state, undefined)).not.toThrow();
    expect(() => assertCheckpointNetworkPolicy(state, digest)).toThrow(
      'must agree',
    );
  });

  it('requires the new envelope and its digest rather than accepting unknown legacy metadata', () => {
    const state = fromNativeCheckpoint(
      native(2),
      identity,
      undefined,
      undefined,
      undefined,
      {},
      digest,
    );
    const { network_policy_digest: _digest, ...missing } = state;
    expect(() => parseSessionState(JSON.stringify(missing))).toThrow();
    expect(() =>
      parseSessionState(JSON.stringify({ ...state, format_version: 4 })),
    ).toThrow('Network policy identity');
    expect(() => parseNativeCheckpoint(state)).toThrow();
    expect(() =>
      parseNativeCheckpoint({ ...native(2), network_policy_digest: digest }),
    ).toThrow('SDK envelope');
  });
});
