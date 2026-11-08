import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, captureAgentProfiles } from '../src/runtime/public-agent';
import { captureProfileRuntimes } from '../src/runtime/agent-profiles';
import { captureTools, tool, type ToolCatalog } from '../src/runtime/tools';
import { Session } from '../src/runtime/session';
import { HttpMCP } from '../src/runtime/mcp';
import type { SessionState } from '../src/runtime/state';
import type { Engine, NativeThread } from '../src/runtime/binding';

// Controlled native receipts test SDK binding/identity policy, not native execution.
function fixture({
  structured = false,
  shared = false,
  matchingSpecs = false,
  graphEnabled = true,
  restoredMcp = false,
  restoredEmptyDefaults = false,
}: {
  structured?: boolean;
  shared?: boolean;
  matchingSpecs?: boolean;
  graphEnabled?: boolean;
  restoredMcp?: boolean;
  restoredEmptyDefaults?: boolean;
} = {}) {
  const first = tool({
    name: 'lookup',
    description: matchingSpecs ? 'lookup' : 'A lookup',
    parameters: z.object({}),
    execute: () => 'A',
  });
  const second = shared
    ? first
    : tool({
        name: 'lookup',
        description: matchingSpecs ? 'lookup' : 'B lookup',
        parameters: z.object({}),
        execute: () => 'B',
      });
  const b = new Agent({
    ...(structured ? { outputType: z.string() } : {}),
    name: 'B',
    instructions: 'B instructions',
    tools: [second],
    handoffs: [() => a],
  });
  const a: Agent = new Agent({
    ...(structured ? { outputType: z.string() } : {}),
    name: 'A',
    instructions: 'A instructions',
    tools: [
      first,
      ...(restoredMcp
        ? [
            new HttpMCP({
              name: 'records',
              url: 'http://127.0.0.1:1/mcp',
              tools: ['lookup'],
            }),
          ]
        : []),
    ],
    handoffs: [b],
  });
  const graph = captureProfileRuntimes(
    captureAgentProfiles(a),
    captureTools([first]),
    a.instructions,
  );
  let waiting = Promise.withResolvers<string[]>();
  let reading = false;
  const queued: string[][] = [];
  const emit = (
    id: string,
    type: string,
    fields: Record<string, unknown> = {},
  ) => {
    const batch = [JSON.stringify({ id, msg: { type, ...fields } })];
    if (reading) {
      reading = false;
      waiting.resolve(batch);
      waiting = Promise.withResolvers<string[]>();
    } else queued.push(batch);
  };
  let active = { profile_id: 'agent_0', epoch: 1 };
  let currentGeneration = '1';
  const native = {
    id: 'root',
    _next_session_events: () => {
      if (queued.length) return Promise.resolve(queued.shift()!);
      reading = true;
      return waiting.promise;
    },
    _submit: vi.fn(async () =>
      JSON.stringify({ status: 'started', turn_id: 'ordinary' }),
    ),
    _replace_tools: vi.fn(async (generation: string) => {
      currentGeneration = generation;
      active = { ...active, epoch: active.epoch + 1 };
      return generation;
    }),
    _configure_manual_tools: vi.fn(),
    _enable_native_mcp_results: vi.fn(),
    _next_native_mcp_result: async () => 'null',
    _revoke_native_mcp_results: vi.fn(),
    _enable_native_interception: vi.fn(),
    _configure_native_interception: vi.fn(),
    _next_native_interception: async () => 'null',
    _revoke_native_interception: vi.fn(),
    _finish_native_interception_reader: vi.fn(),
    _replace_mcp_servers: vi.fn(
      async (
        _config: string,
        _policies: string | undefined,
        _rules: unknown,
        _generation: unknown,
        _specs: unknown,
        boundary: string,
      ) => {
        emit(boundary, 'sdk_mcp_publication_boundary');
        return JSON.stringify({
          result: {
            publication: 'published',
            ready: true,
            policy_generation: '0',
            servers: {
              records: {
                accepted: true,
                ready: true,
                status: 'disabled',
                tools: [],
              },
            },
          },
        });
      },
    ),
    _submit_realtime_tools: vi.fn(async () =>
      JSON.stringify({ status: 'started', turn_id: 'native-batch' }),
    ),
    _finish_child_event_reader: vi.fn(),
    _stop_sampling_for_close: vi.fn(),
    _close_report: async () => {
      emit('', 'shutdown_complete');
      return null;
    },
    _configure_agent_profiles: vi.fn(async () =>
      JSON.stringify({
        active,
        catalogs: { agent_0: '1', agent_1: '2' },
        generation_high_water: restoredMcp ? '3' : '2',
        active_catalog: {
          generation: restoredMcp ? '3' : '1',
          specs: JSON.parse(graph.profiles.get('agent_0')!.catalog.specsJson),
        },
      }),
    ),
    _active_agent_profile: vi.fn(async () => JSON.stringify(active)),
    _activate_agent_profile: vi.fn(async (id: string, previous: string) => {
      expect(JSON.parse(previous)).toEqual(active);
      active = { profile_id: id, epoch: active.epoch + 1 };
      currentGeneration = id === 'agent_0' ? '1' : '2';
      return JSON.stringify(active);
    }),
    call: vi.fn(async (operation: string) => {
      if (operation !== 'realtime_tool_selection_sdk')
        throw new Error(`Unexpected operation ${operation}`);
      return JSON.stringify({
        selection_id: `source-${active.profile_id}-${active.epoch}`,
        profile_receipt: active,
        catalog_generation: currentGeneration,
      });
    }),
  };
  const session = new Session<string, undefined>(
    { _close_report: async () => null } as unknown as Engine,
    native as unknown as NativeThread,
    graph.profiles.get('agent_0')!.catalog,
    {
      applicationAgent: a,
      output: graph.profiles.get('agent_0')!.output,
      agentGraph: graphEnabled
        ? {
            ...graph,
            fingerprint: 'fixture',
            ...(restoredMcp
              ? { restoredSource: { profile_id: 'agent_0', epoch: '1' } }
              : {}),
          }
        : undefined,
    },
    { instructions: a.instructions },
    restoredMcp
      ? ({
          format_version: 8,
          default_resource_servers: { selected: [], resource_only: [] },
          ...(restoredEmptyDefaults ? { default_tools: [] } : {}),
        } as unknown as SessionState)
      : null,
  );
  const controlled = session as unknown as {
    sourceCatalog(
      message: Record<string, unknown>,
      generation: string,
    ): ToolCatalog;
    captureSelection(options: { tools: readonly (typeof first)[] }): unknown;
    profileOperationNames(
      selection: unknown,
      event: { msg: Record<string, unknown> },
      catalog: ToolCatalog,
    ): unknown;
  };
  return {
    a,
    b,
    first,
    second,
    session,
    native,
    controlled,
    emit,
    commitDestination: () => {
      active = { profile_id: 'agent_1', epoch: active.epoch + 1 };
    },
  };
}

it('uses authoritative active receipts while retaining old source catalogs and original objects', async () => {
  const f = fixture();
  await f.session._start();
  try {
    expect(await f.session.getActiveAgent()).toBe(f.a);
    const old = { profile_id: 'agent_0', profile_epoch: '1' };
    const original = f.controlled.sourceCatalog(old, '1');
    const ceiling = f.controlled.captureSelection({ tools: [f.first] });
    await f.session.update({ agent: f.b });
    expect(await f.session.getActiveAgent()).toBe(f.b);
    const sourceB = { profile_id: 'agent_1', profile_epoch: '2' };
    const destination = f.controlled.sourceCatalog(sourceB, '2');
    expect(JSON.parse(destination.specsJson)[0].description).toBe('B lookup');
    expect(f.controlled.sourceCatalog(old, '1')).toBe(original);
    expect(
      f.controlled.profileOperationNames(
        ceiling,
        { msg: sourceB },
        destination,
      ),
    ).toEqual([]);
    expect(() => f.controlled.sourceCatalog({}, '2')).toThrow('missing');
    expect(() => f.controlled.sourceCatalog(sourceB, '1')).toThrow(
      'source catalog',
    );
    await expect(f.session._realtimeFunctionTools([f.first])).rejects.toThrow(
      'not admitted',
    );
    const narrowed = await f.session._realtimeFunctionTools([f.first], {
      allowMissing: true,
    });
    expect(narrowed.tools).toEqual([]);
    const selected = await f.session._realtimeFunctionTools([f.second]);
    expect(selected.selectionId).toBe('source-agent_1-2');
    expect(selected.tools[0]).toMatchObject({
      name: 'lookup',
      description: 'B lookup',
    });
    await expect(
      f.session.update({ agent: new Agent({ instructions: 'foreign' }) }),
    ).rejects.toThrow('not admitted');
    await f.session.update({ agent: f.a });
    expect(await f.session.getActiveAgent()).toBe(f.a);
    expect(
      f.controlled.profileOperationNames(
        ceiling,
        { msg: { profile_id: 'agent_0', profile_epoch: '3' } },
        original,
      ),
    ).toEqual([{ namespace: 'functions', name: 'lookup' }]);
  } finally {
    await f.session.close();
  }
});

it('retains the selection snapshot key instead of looking it up after identity validation', async () => {
  const f = fixture();
  await f.session._start();
  try {
    const selected = await f.session._realtimeFunctionTools([f.first]);
    await f.session.update({ agent: f.b });
    expect(selected.selectionId).toBe('source-agent_0-1');
    expect(selected.tools[0]).toHaveProperty('description', 'A lookup');
    expect(f.native.call).toHaveBeenCalledTimes(1);
  } finally {
    await f.session.close();
  }
});

it('refreshes native tool-batch profile bindings without validating a fabricated text answer', async () => {
  const f = fixture({ structured: true });
  await f.session._start();
  try {
    const turn = await f.session._submitRealtimeTools(
      'voice-generation',
      'response-A',
      ['call-A'],
    );
    f.commitDestination();
    f.emit('native-batch', 'task_complete', { last_agent_message: '' });
    const result = await turn.wait();
    expect(result.finalOutput).toBe('');
    expect(await f.session.getActiveAgent()).toBe(f.b);
    expect(() =>
      f.controlled.captureSelection({ tools: [f.second] }),
    ).not.toThrow();
    expect(() => f.controlled.captureSelection({ tools: [f.first] })).toThrow(
      'not admitted',
    );
  } finally {
    await f.session.close();
  }
});

it.each([false, true])(
  'rebinds operation identity to the fresh graph supplied by the application (shared=%s)',
  async (shared) => {
    const f = fixture({ shared, matchingSpecs: true });
    await f.session._start();
    try {
      const ceiling = f.controlled.captureSelection({ tools: [f.first] });
      await f.session.update({ agent: f.b });
      const message = { profile_id: 'agent_1', profile_epoch: '2' };
      const source = f.controlled.sourceCatalog(message, '2');
      expect(
        f.controlled.profileOperationNames(ceiling, { msg: message }, source),
      ).toEqual(shared ? [{ namespace: 'functions', name: 'lookup' }] : []);
    } finally {
      await f.session.close();
    }
  },
);

it('acknowledges its own publication epoch without resetting bindings at later settlement', async () => {
  const f = fixture();
  await f.session._start();
  try {
    const replacement = tool({
      name: 'lookup',
      description: 'replacement',
      parameters: z.object({}),
      execute: () => 'replacement',
    });
    await f.session.update({ tools: [replacement] });
    expect(() =>
      f.controlled.captureSelection({ tools: [replacement] }),
    ).not.toThrow();
    const turn = await f.session.submit('ordinary turn');
    f.emit('ordinary', 'task_complete', { last_agent_message: 'accepted' });
    expect((await turn.wait()).finalOutput).toBe('accepted');
    expect(() =>
      f.controlled.captureSelection({ tools: [replacement] }),
    ).not.toThrow();
    expect(
      (await f.session._realtimeFunctionTools([replacement])).tools[0],
    ).toHaveProperty('description', 'replacement');
    await f.session.update({ agent: f.a });
    expect(() =>
      f.controlled.captureSelection({ tools: [f.first] }),
    ).not.toThrow();
    expect(() =>
      f.controlled.captureSelection({ tools: [replacement] }),
    ).toThrow('not admitted');
  } finally {
    await f.session.close();
  }
});

it('rejects a stale original object after same-name graph tool replacement before submission', async () => {
  const f = fixture({ matchingSpecs: true });
  await f.session._start();
  try {
    await f.session.update({ tools: [f.second] });
    await expect(
      f.session.submit('only the original A capability', { tools: [f.first] }),
    ).rejects.toThrow('not admitted');
    expect(f.native._submit).not.toHaveBeenCalled();
  } finally {
    await f.session.close();
  }
});

it('preserves mono Session historical selector compatibility after replacement', async () => {
  const f = fixture({ graphEnabled: false, matchingSpecs: true });
  await f.session._start();
  try {
    await f.session.update({ tools: [f.second] });
    const turn = await f.session.submit('existing named capability', {
      tools: [f.first],
    });
    f.emit('ordinary', 'task_complete', { last_agent_message: 'accepted' });
    expect((await turn.wait()).finalOutput).toBe('accepted');
  } finally {
    await f.session.close();
  }
});

it('publishes an empty restored graph MCP selection before profile configuration', async () => {
  const f = fixture({ restoredMcp: true });
  await f.session._start();
  try {
    expect(f.native._replace_mcp_servers).toHaveBeenCalledTimes(1);
    expect(
      f.native._replace_mcp_servers.mock.invocationCallOrder[0],
    ).toBeLessThan(
      f.native._configure_agent_profiles.mock.invocationCallOrder[0],
    );
    expect(
      (f.session as unknown as { mcpGeneration: bigint }).mcpGeneration,
    ).toBe(3n);
  } finally {
    await f.session.close();
  }
});

it('restores ordinary default slots before the first profile receipt is configured', async () => {
  const f = fixture({ restoredMcp: true, restoredEmptyDefaults: true });
  await f.session._start();
  try {
    expect(f.native._replace_tools).toHaveBeenCalled();
    expect(await f.session.getActiveAgent()).toBe(f.a);
  } finally {
    await f.session.close();
  }
});
