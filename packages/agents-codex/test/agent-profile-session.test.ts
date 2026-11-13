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
  terminal = false,
}: {
  structured?: boolean;
  shared?: boolean;
  matchingSpecs?: boolean;
  graphEnabled?: boolean;
  restoredMcp?: boolean;
  restoredEmptyDefaults?: boolean;
  terminal?: boolean;
} = {}) {
  const rootOutput = vi.fn((value: string) => `A:${value}`);
  const targetOutput = vi.fn((value: string) => `B:${value}`);
  const first = tool({
    name: 'lookup',
    description: matchingSpecs ? 'lookup' : 'A lookup',
    finishTurn: terminal,
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
    ...(terminal
      ? {
          outputType: {
            mode: 'prompted' as const,
            schema: z.string().transform(targetOutput),
          },
        }
      : structured
        ? { outputType: z.string() }
        : {}),
    name: 'B',
    instructions: 'B instructions',
    tools: [second],
    handoffs: [() => a],
  });
  const a: Agent = new Agent({
    ...(terminal
      ? {
          outputType: {
            mode: 'prompted' as const,
            schema: z.string().transform(rootOutput),
          },
        }
      : structured
        ? { outputType: z.string() }
        : {}),
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
    _configure_tool_completion: vi.fn(),
    _check_tool_completion: vi.fn(() => true),
    _reply_tool_completion: vi.fn((_wire: string) => true),
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
    _update_model_settings: vi.fn(async () => true),
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
    rootOutput,
    targetOutput,
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

it('attaches a second response to the same actual native tools root', async () => {
  const f = fixture();
  await f.session._start();
  try {
    const first = await f.session._submitRealtimeTools('voice', 'A', ['a']);
    f.native._submit_realtime_tools.mockImplementation(
      async (...args: unknown[]) => {
        expect(JSON.parse(args[0] as string)).toMatchObject({
          expected_root_turn_id: 'native-batch',
          response_id: 'B',
        });
        return JSON.stringify({
          status: 'attached',
          root_turn_id: 'native-batch',
        });
      },
    );
    const second = await f.session._submitRealtimeTools('voice', 'B', ['b']);
    expect(second).toBe(first);
    f.emit('native-batch', 'task_complete', { last_agent_message: '' });
    await first.wait();
  } finally {
    await f.session.close();
  }
});

it.each(['not_idle', 'superseded'])(
  'passively joins exact prior root on %s before starting a new batch root',
  async (reason) => {
    const f = fixture();
    await f.session._start();
    try {
      const first = await f.session._submitRealtimeTools('voice', 'A', ['a']);
      f.native._submit_realtime_tools
        .mockResolvedValueOnce(
          JSON.stringify({ status: 'not_submitted', reason: { type: reason } }),
        )
        .mockResolvedValueOnce(
          JSON.stringify({ status: 'started', turn_id: 'next-root' }),
        );
      const pending = f.session._submitRealtimeTools('voice', 'B', ['b']);
      await vi.waitFor(() =>
        expect(f.native._submit_realtime_tools).toHaveBeenCalledTimes(2),
      );
      f.emit('native-batch', 'task_complete', {
        last_agent_message: 'A accepted',
      });
      expect((await first.wait()).finalOutput).toBe('A accepted');
      const second = await pending;
      expect(second).not.toBe(first);
      expect(f.native._submit_realtime_tools).toHaveBeenCalledTimes(3);
      f.emit('next-root', 'task_complete', { last_agent_message: '' });
      await second.wait();
    } finally {
      await f.session.close();
    }
  },
);

it('does not attach voice tools to an ordinary caller root', async () => {
  const f = fixture();
  await f.session._start();
  try {
    const ordinary = await f.session.submit('caller work');
    await expect(
      f.session._submitRealtimeTools('voice', 'A', ['a']),
    ).rejects.toThrow();
    expect(f.native._submit_realtime_tools).not.toHaveBeenCalled();
    f.emit('ordinary', 'task_complete', {
      last_agent_message: 'caller accepted',
    });
    expect((await ordinary.wait()).finalOutput).toBe('caller accepted');
  } finally {
    await f.session.close();
  }
});

it('cancels only a passive retry wait without restarting its retired batch', async () => {
  const f = fixture();
  await f.session._start();
  try {
    const first = await f.session._submitRealtimeTools('voice', 'A', ['a']);
    f.native._submit_realtime_tools.mockResolvedValueOnce(
      JSON.stringify({ status: 'not_submitted', reason: { type: 'not_idle' } }),
    );
    const stop = new AbortController();
    const pending = f.session._submitRealtimeTools(
      'voice',
      'B',
      ['b'],
      stop.signal,
    );
    await vi.waitFor(() =>
      expect(f.native._submit_realtime_tools).toHaveBeenCalledTimes(2),
    );
    const reason = new Error('B retired');
    stop.abort(reason);
    await expect(pending).rejects.toBe(reason);
    f.emit('native-batch', 'task_complete', {
      last_agent_message: 'A accepted',
    });
    expect((await first.wait()).finalOutput).toBe('A accepted');
    expect(f.native._submit_realtime_tools).toHaveBeenCalledTimes(2);
  } finally {
    await f.session.close();
  }
});

// Controlled native receipts verify SDK source policy, not native execution.
it.each([
  ['before proposal', false],
  ['before proposal', true],
  ['before acknowledgement', false],
  ['before acknowledgement', true],
] as const)(
  'retains terminal source policy across another profile (%s, override=%s)',
  async (changeAt, override) => {
    const f = fixture({ terminal: true });
    const validateOverride = vi.fn((value: string) => `override:${value}`);
    await f.session._start();
    try {
      const turn = await f.session.submit(
        'finish',
        override
          ? {
              outputType: {
                mode: 'prompted' as const,
                schema: z.string().transform(validateOverride),
              },
            }
          : {},
      );
      const changeProfile = () => {
        f.commitDestination();
        (
          f.session as unknown as { adoptProfile(receipt: unknown): void }
        ).adoptProfile({ profile_id: 'agent_1', epoch: '2' });
      };
      if (changeAt === 'before proposal') changeProfile();
      f.emit('ordinary', '_sdk_tool_completion', {
        thread: 'root',
        instance: null,
        turn_id: 'ordinary',
        generation: '1',
        request_id: '17',
        native_step: 'step',
        slot: 0,
        tool: { name: 'lookup', namespace: null },
        call_id: 'terminal-call',
        output: '"accepted"',
        model: 'fixture-native-model',
        continuation_count: 0,
        profile_id: 'agent_0',
        profile_epoch: '1',
      });
      await vi.waitFor(() =>
        expect(f.native._reply_tool_completion).toHaveBeenCalledTimes(1),
      );
      const expected = `${override ? 'override' : 'A'}:accepted`;
      const reply = JSON.parse(
        f.native._reply_tool_completion.mock.calls[0][0],
      );
      expect(reply).toMatchObject({
        thread: 'root',
        turn_id: 'ordinary',
        generation: '1',
        request_id: '17',
        native_step: 'step',
        final_output: expected,
      });
      expect(f.rootOutput).toHaveBeenCalledTimes(override ? 0 : 1);
      expect(f.targetOutput).not.toHaveBeenCalled();
      expect(validateOverride).toHaveBeenCalledTimes(override ? 1 : 0);
      if (changeAt === 'before acknowledgement') changeProfile();
      f.emit('ordinary', 'task_complete', {
        tool_completion: {
          call_id: 'terminal-call',
          name: 'lookup',
          namespace: null,
          final_output: expected,
        },
      });
      expect((await turn.wait()).finalOutput).toBe(expected);
      expect(f.rootOutput).toHaveBeenCalledTimes(override ? 0 : 1);
      expect(f.targetOutput).not.toHaveBeenCalled();
    } finally {
      await f.session.close();
    }
  },
);

it('settles an exact failed terminal attempt after the active profile changes', async () => {
  const f = fixture({ terminal: true });
  await f.session._start();
  try {
    const turn = await f.session.submit('finish');
    f.emit('ordinary', '_sdk_tool_completion', {
      thread: 'root',
      instance: null,
      turn_id: 'ordinary',
      generation: '1',
      request_id: '17',
      native_step: 'step',
      slot: 0,
      tool: { name: 'lookup', namespace: null },
      call_id: 'terminal-call',
      output: '"accepted"',
      model: 'fixture-native-model',
      continuation_count: 0,
      profile_id: 'agent_0',
      profile_epoch: '1',
    });
    await vi.waitFor(() =>
      expect(f.native._reply_tool_completion).toHaveBeenCalledTimes(1),
    );
    f.commitDestination();
    (
      f.session as unknown as { adoptProfile(receipt: unknown): void }
    ).adoptProfile({ profile_id: 'agent_1', epoch: '2' });
    f.emit('ordinary', '_sdk_tool_completion_failed', {
      thread: 'root',
      instance: null,
      turn_id: 'ordinary',
      generation: '1',
      request_id: '17',
      native_step: 'step',
    });
    await expect(turn.wait()).rejects.toThrow('before durable publication');
    expect(f.rootOutput).toHaveBeenCalledTimes(1);
    expect(f.targetOutput).not.toHaveBeenCalled();
  } finally {
    await f.session.close();
  }
});

it('keeps the previous catalog usable after idle candidate capture fails', async () => {
  const f = fixture({ graphEnabled: false });
  await f.session._start();
  try {
    const replacement = tool({
      name: 'lookup',
      parameters: z.object({}),
      execute: () => 'replacement',
    });
    await expect(
      f.session.update({ tools: [replacement, replacement] }),
    ).rejects.toThrow('Duplicate tool');
    expect(f.native._replace_tools).not.toHaveBeenCalled();
    expect(() =>
      f.controlled.captureSelection({ tools: [f.first] }),
    ).not.toThrow();
    const turn = await f.session.submit('previous catalog', {
      tools: [f.first],
    });
    f.emit('ordinary', 'task_complete', { last_agent_message: 'accepted' });
    expect((await turn.wait()).finalOutput).toBe('accepted');
  } finally {
    await f.session.close();
  }
});

it('retains omitted current bindings while publishing empty idle defaults', async () => {
  const f = fixture({ graphEnabled: false });
  await f.session._start();
  try {
    await f.session.update({ tools: [] });
    const publication = f.native._replace_tools.mock
      .calls[0] as unknown as string[];
    expect(JSON.parse(publication[1])).toEqual(
      JSON.parse(captureTools([f.first]).specsJson),
    );
    expect(JSON.parse(publication[2])).toEqual([]);
    const turn = await f.session.submit('explicit retained capability', {
      tools: [f.first],
    });
    f.emit('ordinary', 'task_complete', { last_agent_message: 'accepted' });
    expect((await turn.wait()).finalOutput).toBe('accepted');
  } finally {
    await f.session.close();
  }
});
