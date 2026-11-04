import { toRuntimeCheckpoint } from '../../src/runtime/state';
import { describe, expect, it } from 'vitest';
import { inspect } from 'node:util';
import {
  CODEX_REVISION,
  parseSessionState,
  fromNativeCheckpoint,
  parseNativeCheckpoint,
} from '../../src/runtime/state';
import { z } from 'zod';
import { manualTool } from '../../src/runtime/manual';
import { captureTools } from '../../src/runtime/tools';
import { prepareOutput } from '../../src/runtime/output';
import {
  assertCheckpointSelections,
  checkpointDefaultTools,
} from '../../src/runtime/selection-state';
describe('portable state authority', () => {
  it.each(['invalid-history', 'invalid-json', 'invalid-token', 'unknown-key'])(
    'does not echo saved input in %s errors',
    (kind) => {
      const secret = 'S3CRET';
      const source =
        kind === 'invalid-token'
          ? secret
          : kind === 'invalid-json'
            ? JSON.stringify({ message: secret }) + ' trailing'
            : JSON.stringify({
                kind: 'idle',
                ...(kind === 'unknown-key' ? { [secret]: true } : {}),
                output_context: prepareOutput(undefined).identity,
                network_policy_digest: null,
                format_version: 2,
                codex_revision: CODEX_REVISION,
                source_session_id: 'saved-session',
                root_metadata: {},
                history: kind === 'unknown-key' ? [] : { message: secret },
              });
      let caught: unknown;
      try {
        parseSessionState(source);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(String(caught)).not.toContain(secret);
      expect(inspect(caught)).not.toContain(secret);
    },
  );

  it('rejects Classic RunState, numbered alpha checkpoints, and incompatible native revisions', () => {
    const native = {
      format_version: 2,
      codex_revision: CODEX_REVISION,
      source_session_id: 'a',
      root_metadata: {},
      history: [],
    };
    const output_context = prepareOutput(undefined).identity;
    for (const older of [
      { currentTurn: 1, generatedItems: [] },
      { ...native, format_version: 4, output_context },
    ]) {
      expect(() => parseSessionState(JSON.stringify(older))).toThrow(
        'SDK that saved',
      );
    }
    const envelope = {
      kind: 'idle',
      ...native,
      output_context,
      network_policy_digest: null,
    };
    expect(() =>
      parseSessionState(
        JSON.stringify({
          ...envelope,
          ...native,
          codex_revision: 'other',
        }),
      ),
    ).toThrow();
    expect(() =>
      parseSessionState(
        JSON.stringify({
          ...envelope,
          ...native,
          format_version: 99,
        }),
      ),
    ).toThrow();
  });
});

describe('portable child graph', () => {
  const root = {
    format_version: 2,
    codex_revision: '7c2ce90716335c889a5076ded9a630459f9c9899',
    source_session_id: 'a',
    history: [],
    root_metadata: {},
  };
  const envelope = (native: object) => ({
    kind: 'idle',
    ...native,
    output_context: prepareOutput(undefined).identity,
    network_policy_digest: null,
  });
  it('requires a rooted unique tree and rejects expired rights as callable state', () => {
    const cyclic = {
      ...root,
      descendants: [
        {
          status: 'active',
          thread_id: 'b',
          parent_thread_id: 'c',
          metadata: {},
          history: [],
        },
        {
          status: 'active',
          thread_id: 'c',
          parent_thread_id: 'b',
          metadata: {},
          history: [],
        },
      ],
    };
    expect(() => parseSessionState(JSON.stringify(envelope(cyclic)))).toThrow(
      'rooted tree',
    );
    const valid = {
      ...root,
      descendants: [
        {
          status: 'closed',
          thread_id: 'b',
          parent_thread_id: 'a',
          closed_at: 4,
          metadata: {},
          history: [],
        },
      ],
    };
    expect(parseSessionState(JSON.stringify(envelope(valid)))).toMatchObject({
      ...valid,
    });
    expect(() =>
      parseSessionState(
        JSON.stringify(
          envelope({ ...valid, interrupted_thread_ids: ['outside'] }),
        ),
      ),
    ).toThrow('outside');
  });
});

// These are portable opening-schema checks, not evidence of fork admission.
describe('retained planning data at the portable opening parser', () => {
  const saved = {
    format_version: 2,
    codex_revision: CODEX_REVISION,
    source_session_id: 'source',
    root_metadata: {},
    history: [],
    root_goal: {
      thread_id: 'source',
      objective: 'Retained objective',
      status: 'paused',
      tokens_used: 1,
    },
  };
  const envelope = (native: object) => ({
    kind: 'idle',
    ...native,
    output_context: prepareOutput(undefined).identity,
    network_policy_digest: null,
  });
  it.each([
    { ...saved.root_goal, status: 'active' },
    { ...saved.root_goal, tokens_used: -1 },
    { ...saved.root_goal, thread_id: 'foreign' },
  ])('rejects invalid goal metadata before native restore', (root_goal) => {
    expect(() =>
      parseSessionState(JSON.stringify(envelope({ ...saved, root_goal }))),
    ).toThrow();
  });
  it('rejects a foreign checklist root at opening', () => {
    expect(() =>
      parseSessionState(
        JSON.stringify(
          envelope({
            ...saved,
            root_checklist: {
              thread_id: 'foreign',
              turn_id: 'historical',
              explanation: null,
              plan: [],
            },
          }),
        ),
      ),
    ).toThrow('checklist thread identity');
  });
});

describe('static selection checkpoint envelope', () => {
  const identity = prepareOutput(undefined).identity;
  const native = (format_version: 2 | 4) =>
    parseNativeCheckpoint({
      format_version,
      codex_revision: CODEX_REVISION,
      source_session_id: 'original-session',
      history: [],
      root_metadata: {},
    });
  const manual = {
    manual_continuation: {
      turn_id: 'original-turn',
      reply_order: ['pending'],
      accepted_replies: {},
      pending_manual: [{ call_id: 'pending', name: 'lookup', arguments: '{}' }],
    },
    manual_context: {
      instructions: null,
      result_schemas: [{ name: 'lookup', schema: { type: 'string' } }],
      usage: null,
    },
  };
  const lookup = { name: 'lookup', namespace: 'functions' };

  it.each([2, 4] as const)(
    'preserves native codec %i alongside manual selection',
    (codec) => {
      const saved = fromNativeCheckpoint(native(codec), identity, {
        manual,
        selection: {
          operation_tools: [lookup],
          default_tools: [],
        },
      });
      expect(parseSessionState(JSON.stringify(saved))).toMatchObject({
        kind: 'manual',
        operation_tools: [lookup],
        default_tools: [],
      });
      expect(saved.source_session_id).toBe('original-session');
      expect(saved.history).toEqual([]);
      expect(saved).not.toHaveProperty('native');
      const payload = toRuntimeCheckpoint(saved);
      expect(payload.format_version).toBe(codec);
      expect(payload).not.toHaveProperty('operation_tools');
      expect(payload).not.toHaveProperty('default_tools');
      expect(parseNativeCheckpoint(payload)).toMatchObject(native(codec));
      expect(() =>
        parseNativeCheckpoint({ ...payload, operation_tools: [lookup] }),
      ).toThrow();
    },
  );

  it('preserves an omitted selection separately from explicit empty managed defaults', () => {
    const unselected = fromNativeCheckpoint(native(2), identity);
    expect(unselected.kind).toBe('idle');
    expect(unselected.default_tools).toBeUndefined();
    const empty = fromNativeCheckpoint(native(2), identity, {
      selection: { default_tools: [] },
    });
    expect(empty.kind).toBe('idle');
    expect(empty.default_tools).toEqual([]);
    const vm = fromNativeCheckpoint(native(4), identity, {
      selection: { default_tools: [] },
    });
    expect(vm.kind).toBe('idle');
    expect(vm.format_version).toBe(4);
  });

  it('rejects duplicate references and operation metadata outside a manual checkpoint', () => {
    const saved = fromNativeCheckpoint(native(2), identity, {
      manual,
      selection: { operation_tools: [lookup] },
    });
    expect(() =>
      parseSessionState(
        JSON.stringify({ ...saved, operation_tools: [lookup, lookup] }),
      ),
    ).toThrow('Duplicate checkpoint tool reference');
    expect(() =>
      parseSessionState(
        JSON.stringify({
          ...fromNativeCheckpoint(native(2), identity),
          operation_tools: [],
        }),
      ),
    ).toThrow('Checkpoint contains unexpected fields');
  });

  it('resolves defaults and operation authority independently against current declarations', () => {
    const a = manualTool({
      name: 'a',
      description: '',
      parameters: z.object({}),
      result: z.string(),
    });
    const b = manualTool({
      name: 'b',
      description: '',
      parameters: z.object({}),
      result: z.string(),
    });
    const catalog = captureTools([a, b]);
    const selections = {
      default_tools: [],
      operation_tools: [{ name: 'b', namespace: 'functions' }],
    };
    expect(checkpointDefaultTools(undefined, catalog)).toBe(catalog.tools);
    expect(checkpointDefaultTools([], catalog)).toEqual([]);
    expect(() =>
      assertCheckpointSelections(
        selections,
        catalog,
        [{ name: 'b' }],
        [{ name: 'b' }],
      ),
    ).not.toThrow();
    expect(() =>
      assertCheckpointSelections(
        selections,
        catalog,
        [{ name: 'a' }],
        [{ name: 'b' }],
      ),
    ).toThrow('not admitted');
    expect(() =>
      assertCheckpointSelections(
        { operation_tools: [] },
        catalog,
        [],
        [{ name: 'b' }],
      ),
    ).toThrow('pending manual tools');
    expect(() => checkpointDefaultTools([lookup], catalog)).toThrow(
      'current declarations',
    );
  });
});
