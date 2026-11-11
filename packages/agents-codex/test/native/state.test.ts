import { describe, expect, it } from 'vitest';
import { inspect } from 'node:util';
import {
  CODEX_REVISION,
  parseSessionState,
  fromNativeCheckpoint,
  nativeCheckpoint,
  parseNativeCheckpoint,
  readCheckpointSelections,
  withOutputState,
} from '../../src/runtime/state';
import { z } from 'zod';
import { manualTool } from '../../src/runtime/manual';
import { captureTools } from '../../src/runtime/tools';
import { HttpMCP, ChatGPTAppsMCP } from '../../src';
import { prepareOutput } from '../../src/runtime/output';
import {
  assertCheckpointSelections,
  checkpointDefaultTools,
  checkpointResourceServers,
} from '../../src/runtime/selection-state';
describe('portable state authority', () => {
  it.each(['invalid-history', 'invalid-json', 'invalid-token'])(
    'does not echo saved input in %s errors',
    (kind) => {
      const secret = 'S3CRET';
      const source =
        kind === 'invalid-token'
          ? secret
          : kind === 'invalid-json'
            ? JSON.stringify({ message: secret }) + ' trailing'
            : JSON.stringify({
                format_version: 2,
                codex_revision: CODEX_REVISION,
                source_session_id: 'saved-session',
                root_metadata: {},
                history: { message: secret },
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

  it('refuses legacy SDK RunState, wrong revisions and future versions before native startup', () => {
    expect(() =>
      parseSessionState('{"currentTurn":1,"generatedItems":[]}'),
    ).toThrow();
    expect(() =>
      parseSessionState(
        '{"format_version":2,"codex_revision":"another","source_session_id":"a","history":[]}',
      ),
    ).toThrow();
    expect(() =>
      parseSessionState(
        '{"format_version":3,"codex_revision":"7c2ce90716335c889a5076ded9a630459f9c9899","source_session_id":"a","history":[]}',
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
    expect(() => parseSessionState(JSON.stringify(cyclic))).toThrow(
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
    expect(parseSessionState(JSON.stringify(valid))).toMatchObject(valid);
    expect(() =>
      parseSessionState(
        JSON.stringify({ ...valid, interrupted_thread_ids: ['outside'] }),
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
  it.each([
    { ...saved.root_goal, status: 'active' },
    { ...saved.root_goal, tokens_used: -1 },
    { ...saved.root_goal, thread_id: 'foreign' },
  ])('rejects invalid goal metadata before native restore', (root_goal) => {
    expect(() =>
      parseSessionState(JSON.stringify({ ...saved, root_goal })),
    ).toThrow();
  });
  it('rejects a foreign checklist root at opening', () => {
    expect(() =>
      parseSessionState(
        JSON.stringify({
          ...saved,
          root_checklist: {
            thread_id: 'foreign',
            turn_id: 'historical',
            explanation: null,
            plan: [],
          },
        }),
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
    'keeps native codec %i and rejects downgrade to an old reader',
    (codec) => {
      const saved = fromNativeCheckpoint(
        native(codec),
        identity,
        undefined,
        undefined,
        manual,
        {
          operation_tools: [lookup],
          default_tools: [],
        },
      );
      expect(saved.format_version).toBe(codec === 2 ? 9 : 11);
      expect(
        readCheckpointSelections(parseSessionState(JSON.stringify(saved))),
      ).toEqual({
        operation_tools: [lookup],
        default_tools: [],
      });
      // This is the exact version gate in the pre-selection reader, independently
      // of its permissive inner objects and outer catchall fields.
      const oldVersion = z.union([
        z.literal(2),
        z.literal(3),
        z.literal(4),
        z.literal(5),
        z.literal(6),
        z.literal(7),
      ]);
      expect(() => oldVersion.parse(saved.format_version)).toThrow();
      expect(() =>
        parseSessionState(
          JSON.stringify({ ...saved, format_version: codec === 2 ? 5 : 7 }),
        ),
      ).toThrow('selected checkpoint format');
      const payload = nativeCheckpoint(saved);
      expect(payload.format_version).toBe(codec);
      expect(payload).not.toHaveProperty('operation_tools');
      expect(payload).not.toHaveProperty('default_tools');
      expect(parseNativeCheckpoint(payload)).toMatchObject(native(codec));
      expect(() =>
        parseNativeCheckpoint({ ...payload, operation_tools: [lookup] }),
      ).toThrow('SDK envelope');
      expect(withOutputState(saved, identity)).toEqual(saved);
    },
  );

  it('preserves an omitted selection separately from explicit empty managed defaults', () => {
    const legacy = fromNativeCheckpoint(native(2), identity);
    expect(legacy.format_version).toBe(4);
    expect(readCheckpointSelections(legacy)).toEqual({});
    const empty = fromNativeCheckpoint(
      native(2),
      identity,
      undefined,
      undefined,
      undefined,
      { default_tools: [] },
    );
    expect(empty.format_version).toBe(8);
    expect(readCheckpointSelections(empty)).toEqual({ default_tools: [] });
    const vm = fromNativeCheckpoint(
      native(4),
      identity,
      undefined,
      undefined,
      undefined,
      { default_tools: [] },
    );
    expect(vm.format_version).toBe(10);
    expect(nativeCheckpoint(vm).format_version).toBe(4);
  });

  it('rejects duplicate references and operation metadata outside a manual checkpoint', () => {
    const saved = fromNativeCheckpoint(
      native(2),
      identity,
      undefined,
      undefined,
      manual,
      { operation_tools: [lookup] },
    );
    expect(() =>
      parseSessionState(
        JSON.stringify({ ...saved, operation_tools: [lookup, lookup] }),
      ),
    ).toThrow('Duplicate checkpoint tool reference');
    expect(() =>
      parseSessionState(
        JSON.stringify({
          ...fromNativeCheckpoint(native(2), identity),
          format_version: 8,
          operation_tools: [],
        }),
      ),
    ).toThrow('manual checkpoint');
  });

  it('round trips selected resource-only names and strips them before native restore', () => {
    const saved = fromNativeCheckpoint(
      native(2),
      identity,
      undefined,
      undefined,
      undefined,
      {
        default_resource_servers: {
          selected: ['resources'],
          resource_only: ['resources'],
        },
      },
    );
    expect(saved.format_version).toBe(8);
    expect(
      readCheckpointSelections(parseSessionState(JSON.stringify(saved))),
    ).toEqual({
      default_resource_servers: {
        selected: ['resources'],
        resource_only: ['resources'],
      },
    });
    const payload = nativeCheckpoint(saved);
    expect(payload).not.toHaveProperty('default_resource_servers');
    expect(() =>
      parseNativeCheckpoint({
        ...payload,
        default_resource_servers: {
          selected: ['resources'],
          resource_only: ['resources'],
        },
      }),
    ).toThrow('SDK envelope');
    expect(() =>
      parseSessionState(JSON.stringify({ ...saved, format_version: 4 })),
    ).toThrow('selected checkpoint format');
    expect(() =>
      parseSessionState(
        JSON.stringify({
          ...saved,
          default_resource_servers: {
            selected: ['resources', 'resources'],
            resource_only: [],
          },
        }),
      ),
    ).toThrow();
    for (const selection of [
      { selected: ['resources'], resource_only: ['resources', 'resources'] },
      { selected: [], resource_only: ['resources'] },
    ])
      expect(() =>
        parseSessionState(
          JSON.stringify({
            ...saved,
            default_resource_servers: selection,
          }),
        ),
      ).toThrow();
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

describe('resource-only checkpoint selection authority', () => {
  const current = new HttpMCP({
    name: 'resources',
    tools: [],
    url: 'https://current.invalid/mcp',
  });
  const toolBearing = new HttpMCP({
    name: 'tools',
    tools: ['lookup'],
    url: 'https://tools.invalid/mcp',
  });
  it('resolves credential-free names to current captured declarations and preserves deselection', () => {
    expect(
      checkpointResourceServers(
        { selected: ['resources', 'tools'], resource_only: ['resources'] },
        [current, toolBearing],
      ),
    ).toEqual([current, toolBearing]);
    expect(
      checkpointResourceServers(
        { selected: ['resources'], resource_only: ['resources'] },
        [current],
      )[0],
    ).toBe(current);
    expect(
      checkpointResourceServers({ selected: ['tools'], resource_only: [] }, [
        current,
        toolBearing,
      ]),
    ).toEqual([toolBearing]);
    expect(checkpointResourceServers(undefined, [current])).toEqual([current]);
    expect(checkpointResourceServers(undefined, [toolBearing])).toEqual([
      toolBearing,
    ]);
    expect(
      checkpointResourceServers({ selected: [], resource_only: [] }, [
        current,
        toolBearing,
      ]),
    ).toEqual([]);
  });
  it('projects a current tool-bearing declaration to zero tools', () => {
    const before = () => ({ action: 'allow' as const });
    const currentBinding = new HttpMCP({
      name: 'tools',
      tools: ['lookup'],
      url: 'https://current.invalid/mcp',
      bearerToken: 'synthetic-current-token',
      before,
    });
    const [narrowed] = checkpointResourceServers(
      { selected: ['tools'], resource_only: ['tools'] },
      [currentBinding],
    );
    expect(narrowed).not.toBe(currentBinding);
    expect(narrowed).toMatchObject({
      name: currentBinding.name,
      url: currentBinding.url,
      bearerToken: currentBinding.bearerToken,
      tools: [],
    });
    expect(narrowed.before).toBe(before);
    expect(currentBinding.tools).toEqual(['lookup']);
  });
  it('rejects names outside current ordinary declarations', () => {
    for (const [names, opening] of [
      [['missing'], [current]],
      [['codex_apps'], [new ChatGPTAppsMCP({ tools: [] })]],
    ] as const)
      expect(() =>
        checkpointResourceServers(
          { selected: names, resource_only: names },
          opening,
        ),
      ).toThrow('current ordinary declarations');
  });
});

describe('stored hosted prompt authority', () => {
  const reference = {
    id: 'pmpt_untrusted_saved_reference',
    variables: { value: 'saved-secret' },
  };
  const controls = {
    hosted_prompt: {
      reference,
      omit_model: true,
      omit_instructions: true,
      omit_tools: true,
    },
  };
  const row = {
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [] },
    metadata: {
      sdk_agent_profile: {
        profile_id: 'agent_0',
        epoch: 1,
        model: { model: 'gpt-5', request_controls: controls },
      },
    },
  };
  const checkpoint = (history: object[], descendants: object[] = []) => ({
    format_version: 2,
    codex_revision: CODEX_REVISION,
    source_session_id: 'root',
    root_metadata: {},
    history,
    descendants,
  });
  it.each(['root', 'active child', 'closed child', 'thread settings'] as const)(
    'rejects a hosted prompt reference in %s checkpoint controls before native restore',
    (where) => {
      const state =
        where === 'root'
          ? checkpoint([row])
          : where === 'thread settings'
            ? checkpoint([
                {
                  type: 'event_msg',
                  payload: {
                    type: 'thread_settings_applied',
                    thread_settings: {
                      model: 'gpt-5',
                      request_controls: controls,
                    },
                  },
                },
              ])
            : checkpoint(
                [],
                [
                  {
                    status: where === 'active child' ? 'active' : 'closed',
                    thread_id: 'child',
                    parent_thread_id: 'root',
                    metadata: {},
                    history: [row],
                    ...(where === 'closed child' ? { closed_at: 1 } : {}),
                  },
                ],
              );
      expect(() => parseSessionState(JSON.stringify(state))).toThrow();
      expect(() => parseNativeCheckpoint(state)).toThrow();
    },
  );
  it('keeps declaration presence and ordinary payload data without restoring a reference', () => {
    const safe = structuredClone(row);
    delete (
      safe.metadata.sdk_agent_profile.model.request_controls.hosted_prompt as {
        reference?: unknown;
      }
    ).reference;
    const state = checkpoint([
      safe,
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'data',
          output: JSON.stringify(row),
        },
      },
    ]);
    expect(parseSessionState(JSON.stringify(state)).history).toHaveLength(2);
  });
});

it('rejects saved prompt authority in compacted metadata before native restore', () => {
  const checkpoint = {
    format_version: 2,
    codex_revision: CODEX_REVISION,
    source_session_id: 'root',
    root_metadata: {},
    history: [
      {
        type: 'compacted',
        payload: {
          message: 'summary',
          replacement_history: [],
          replacement_history_metadata: [
            {
              sdk_agent_profile: {
                profile_id: 'agent_0',
                epoch: 1,
                model: {
                  model: 'gpt-5',
                  request_controls: {
                    hosted_prompt: { reference: { id: 'pmpt_saved' } },
                  },
                },
              },
            },
          ],
        },
      },
    ],
  };
  expect(() => parseSessionState(JSON.stringify(checkpoint))).toThrow();
  expect(() => parseNativeCheckpoint(checkpoint)).toThrow();
});
