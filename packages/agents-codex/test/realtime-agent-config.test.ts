import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  captureAgentProfiles,
  captureRealtimeAgentGraph,
} from '../src/runtime/public-agent';
import { captureTools, invokeFunctionTool, tool } from '../src/runtime/tools';
import { captureProfileRuntimes } from '../src/runtime/agent-profiles';
import {
  hasRealtimeAgentConfiguration,
  realtimeHandoff,
  resolveRealtimeAgentConfiguration,
} from '../src/runtime/realtime-agent-config';

const fn = (name: string) => ({
  name,
  description: name,
  parameters: { type: 'object' },
});
const selection = {
  selection_id: 'exact',
  function_tools: [fn('allowed'), fn('hidden')],
};

it('captures voice defaults independently of text instructions and caller mutation', async () => {
  const prompt = { id: 'pmpt_one', variables: { name: 'original' } };
  const original = new Agent<{ name: string }>({
    instructions: 'backend',
    realtime: {
      instructions: async ({ context }) =>
        `voice ${(context as { name: string }).name}`,
      prompt,
      toolEnabled: async (_context, tool) => tool.name === 'allowed',
    },
  });
  prompt.variables.name = 'changed';
  const declaration = captureAgentProfiles(original)[0].declaration;
  original.realtime = { instructions: 'mutated' };
  const result = await resolveRealtimeAgentConfiguration({
    declaration,
    agent: original,
    context: { name: 'Ada' },
    selection,
  });
  expect(original.instructions).toBe('backend');
  expect(result.instructions).toBe('voice Ada');
  expect(result.tools.map((tool) => tool.name)).toEqual(['allowed']);
  expect(result.settings.prompt).toMatchObject({
    id: 'pmpt_one',
    variables: { name: 'original' },
  });
  expect(result.selectionId).toBe('exact');
  expect(result.tools[0]).toMatchObject({ inputSchema: { type: 'object' } });
  expect(result.tools[0]).not.toHaveProperty('parameters');
});

it('keeps explicit instructions and prompt ahead of defaults and rejects foreign tool schemas', async () => {
  const instructions = vi.fn(() => 'default');
  const agent = new Agent({
    instructions: 'backend',
    realtime: { instructions, prompt: { id: 'default' } },
  });
  const result = await resolveRealtimeAgentConfiguration({
    declaration: agent,
    agent,
    context: undefined,
    selection,
    instructions: 'explicit',
    settings: { prompt: null },
    selectedTools: [
      {
        parameters: { type: 'object' },
        description: 'allowed',
        name: 'allowed',
      },
    ],
  });
  expect(result.instructions).toBe('explicit');
  expect(result.settings.prompt).toBeNull();
  expect(instructions).not.toHaveBeenCalled();
  await expect(
    resolveRealtimeAgentConfiguration({
      declaration: agent,
      agent,
      context: undefined,
      selection,
      selectedTools: [{ ...fn('allowed'), description: 'foreign' }],
    }),
  ).rejects.toThrow('unadmitted');
});

it('rejects invalid async configuration results and observes configuration cancellation', async () => {
  const agent = new Agent({
    instructions: 'backend',
    realtime: { instructions: (() => 42) as never },
  });
  await expect(
    resolveRealtimeAgentConfiguration({
      declaration: agent,
      agent,
      context: undefined,
      selection,
    }),
  ).rejects.toThrow('return a string');
  agent.realtime = { toolEnabled: (() => 'yes') as never };
  await expect(
    resolveRealtimeAgentConfiguration({
      declaration: agent,
      agent,
      context: undefined,
      selection,
    }),
  ).rejects.toThrow('return a boolean');
  const abort = new AbortController();
  agent.realtime = {
    instructions: async ({ signal }) => {
      expect(signal).toBe(abort.signal);
      abort.abort();
      return 'late';
    },
  };
  await expect(
    resolveRealtimeAgentConfiguration({
      declaration: agent,
      agent,
      context: undefined,
      selection,
      signal: abort.signal,
    }),
  ).rejects.toThrow();
});

it('captures named structured handoffs and exact callback slots without changing inherited handoffs', async () => {
  const target = new Agent({ name: 'Support', instructions: 'support' });
  const callback = vi.fn();
  const custom = realtimeHandoff(target, {
    name: 'ask_support',
    description: 'Escalate with a reason',
    parameters: z.object({ reason: z.string() }).strict(),
    onHandoff: callback,
  });
  const existing = tool({
    name: 'lookup',
    parameters: z.object({}),
    execute: () => '',
  });
  const source = new Agent({
    name: 'Source',
    instructions: 'source',
    tools: [existing],
    handoffs: [custom],
  });
  const profiles = captureAgentProfiles(source);
  expect(profiles[0].handoffs).toEqual({ ask_support: 'agent_1' });
  expect(profiles[0].handoffCallbacks).toEqual({ ask_support: 1 });
  const graph = captureProfileRuntimes(
    profiles,
    captureTools([existing]),
    'source',
  );
  expect(graph.roster[0].handoff_callbacks).toEqual({ ask_support: 1 });
  const captured = graph.profiles.get('agent_0')!.catalog.tools[1];
  const context = {
    context: { account: 'A' },
    signal: new AbortController().signal,
    callId: 'exact',
    turnId: 'turn',
    threadId: 'thread',
    submission: {
      sessionId: 's',
      childId: 'c',
      instanceId: '1',
      turnId: 'turn',
      submissionId: 'i',
    },
  };
  await expect(
    invokeFunctionTool(captured as never, { reason: 42 }, context, vi.fn()),
  ).rejects.toThrow();
  expect(callback).not.toHaveBeenCalled();
  await invokeFunctionTool(
    captured as never,
    { reason: 'billing' },
    context,
    vi.fn(),
  );
  expect(callback).toHaveBeenCalledWith(
    { context: context.context, agent: source },
    { reason: 'billing' },
  );
  expect(source.handoffs).toEqual([custom]);
});

it('filters custom handoff enablement even without Agent voice defaults', async () => {
  const target = new Agent({ name: 'Target', instructions: 'target' });
  const handoff = realtimeHandoff(target, {
    name: 'disabled',
    isEnabled: false,
  });
  const source = new Agent({ instructions: 'source', handoffs: [handoff] });
  expect(hasRealtimeAgentConfiguration(source)).toBe(true);
  const result = await resolveRealtimeAgentConfiguration({
    declaration: source,
    agent: source,
    context: undefined,
    selection: { selection_id: 'exact', function_tools: [fn('disabled')] },
  });
  expect(result.tools).toEqual([]);
});

it('admits a fresh graph with unique native IDs while preserving fixed Session constraints', () => {
  const opening = new Agent({ instructions: 'opening' });
  const candidate = new Agent({
    instructions: 'candidate',
    realtime: { instructions: 'voice' },
  });
  const graph = captureRealtimeAgentGraph(opening, candidate, 'voice_exact_');
  expect(graph.rootId).toBe('voice_exact_0');
  expect(graph.profiles.get('voice_exact_0')!.profile.agent).toBe(candidate);
  expect(
    graph.profiles.get('voice_exact_0')!.profile.declaration.provider,
  ).toBe(opening.provider);
  expect(() =>
    captureRealtimeAgentGraph(
      opening,
      new Agent({ instructions: 'changed', programmaticToolCalling: true }),
      'bad_',
    ),
  ).toThrow('fixed');
});

it('resolves startup defaults before the first native write and binds the exact accepted source', async () => {
  const { createNativeRealtimeOwner } = await import('../src/runtime/realtime');
  const ready = Promise.withResolvers<void>();
  const agent = new Agent<{ account: string }>({
    instructions: 'backend',
    realtime: {
      instructions: async ({ context, signal }) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        await ready.promise;
        return `voice ${(context as { account: string }).account}`;
      },
      prompt: { id: 'prompt_native' },
      toolEnabled: (_context, declaration) => declaration.name === 'allowed',
    },
  });
  const session = {
    _checkVoiceOperation() {},
    _checkVoiceAdapterOperation() {},
    _prepareRealtimeMcp: async () => {},
    _hasRealtimeAgentConfiguration: () => true,
    _realtimeConfigurationSource: () => ({
      declaration: agent,
      agent,
      context: { account: 'account-A' },
    }),
    _realtimeSourceSnapshot: async () => ({
      ...selection,
      profile_receipt: null,
    }),
    _runVoiceCallback: <T>(callback: () => T) => callback(),
    _realtimeEventSource: () => ({ agent, context: { account: 'account' } }),
    _realtimeGuardrailSource: () => ({
      agent,
      context: { account: 'account-A' },
    }),
  };
  let generation = '';
  const native = vi.fn(
    async (operation: string, params: Record<string, any>) => {
      generation = params.generation;
      if (operation.endsWith('_prepare_sdk')) return { generation };
      if (operation.endsWith('_activate_sdk'))
        owner._ingest({
          id: generation,
          msg: { type: 'realtime_conversation_started' },
        } as never);
      if (operation.endsWith('_close_sdk'))
        owner._ingest({
          id: generation,
          msg: { type: 'realtime_conversation_closed' },
        } as never);
      return null;
    },
  );
  const owner = createNativeRealtimeOwner(
    session as never,
    native as never,
    () => {},
    {},
    async () => {},
  );
  const starting = owner._start();
  await vi.waitFor(() => expect(session._realtimeSourceSnapshot).toBeDefined());
  expect(native).not.toHaveBeenCalled();
  ready.resolve();
  await starting;
  const prepare = native.mock.calls.find(([operation]) =>
    operation.endsWith('_prepare_sdk'),
  )![1];
  expect(prepare.params.prompt).toBe('voice account-A');
  expect(prepare.settings.prompt).toEqual({ id: 'prompt_native' });
  expect(
    prepare.function_tools.map(
      (definition: { name: string }) => definition.name,
    ),
  ).toEqual(['allowed']);
  expect(prepare.expected_selection_id).toBe('exact');
  await owner.close();
});
