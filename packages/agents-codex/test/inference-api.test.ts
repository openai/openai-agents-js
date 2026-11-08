import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  tool,
  type InferenceApi,
  type AgentOptions,
  type RunOptions,
  type SessionOptions,
} from '../src';
import * as PublicAgents from '../../agents/src';
import type { InferenceApi as PublicInferenceApi } from '../../agents/src';
import type { SessionSetup } from '../src/runtime/agent';
import {
  Session,
  type SessionOptions as CoreOptions,
} from '../src/runtime/session';
import { captureTools } from '../src/runtime/tools';
import type { Engine, NativeThread, JsonObject } from '../src/runtime/binding';
import { CODEX_REVISION, parseSessionState } from '../src/runtime/state';
import { prepareOutput } from '../src/runtime/output';

const fixture = vi.hoisted(() => ({ open: vi.fn(), run: vi.fn() }));
vi.mock('../src/runtime/binding', async (original) => ({
  ...(await original<typeof import('../src/runtime/binding')>()),
  binding: async () => ({
    _validate_python_tool_declarations() {},
    _agent_profiles_fingerprint: () => 'synthetic-profile-fingerprint',
  }),
}));
vi.mock('../src/runtime/agent', () => ({
  openSession: (...args: unknown[]) => fixture.open(...args),
  runOwnedSession: (...args: unknown[]) => fixture.run(...args),
}));
beforeEach(() => {
  fixture.open.mockReset();
  fixture.run.mockReset();
  fixture.open.mockImplementation(async (_setup, options) => ({
    close: options.onClose,
    [Symbol.asyncDispose]: options.onClose,
  }));
  fixture.run.mockImplementation(async (session) => {
    await session.close();
    return { finalOutput: 'fixture answer' };
  });
});
function providerConfig(index = 0): JsonObject {
  return (fixture.open.mock.calls[index][0] as SessionSetup).config[
    'model_providers.native_agent'
  ] as JsonObject;
}
function ordinaryState() {
  return parseSessionState(
    JSON.stringify({
      format_version: 2,
      codex_revision: CODEX_REVISION,
      source_session_id: 'saved-root',
      root_metadata: {},
      history: [],
      managed_tool_specs: [],
      agent_options: { model: 'saved-generation-model' },
    }),
  );
}
function coreSession() {
  return new Session(
    {} as Engine,
    { id: 'decisions-test' } as NativeThread,
    captureTools([]),
    { decisionsApi: {} } satisfies CoreOptions,
    {},
  );
}

describe('inference API selection', () => {
  it('keeps model a string and exports only the API type', () => {
    expectTypeOf<AgentOptions['model']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<InferenceApi>().toEqualTypeOf<PublicInferenceApi>();
    expectTypeOf<InferenceApi>().toEqualTypeOf<
      NonNullable<AgentOptions['api']>
    >();
    expectTypeOf<InferenceApi>().toEqualTypeOf<
      NonNullable<RunOptions['api']>
    >();
    expectTypeOf<InferenceApi>().toEqualTypeOf<
      NonNullable<SessionOptions['api']>
    >();
    expect(PublicAgents).not.toHaveProperty('Decisions');
    expect(PublicAgents).not.toHaveProperty('DecisionsOptions');
  });
  it('uses only API literals and keeps policies on the Agent declaration', () => {
    expectTypeOf<InferenceApi>().toEqualTypeOf<'responses' | 'decisions'>();
    expectTypeOf<AgentOptions['fallbackModel']>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<
      Extract<keyof RunOptions, 'fallbackModel' | 'minRouteProbability'>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof SessionOptions, 'fallbackModel' | 'minRouteProbability'>
    >().toEqualTypeOf<never>();
    expect(
      () =>
        new Agent({
          instructions: 'Choose.',
          api: { type: 'decisions' } as unknown as InferenceApi,
        }),
    ).toThrow('api must be');
  });
  it.each(['', '  '])('rejects empty fallback names %j', (fallback) => {
    expect(
      () =>
        new Agent({
          instructions: 'Choose.',
          api: 'decisions',
          fallbackModel: fallback,
        }),
    ).toThrow('non-empty');
  });
  it.each([NaN, Infinity, -0.1, 1.1])(
    'rejects invalid route probability %s',
    (minRouteProbability) => {
      expect(
        () =>
          new Agent({
            instructions: 'Choose.',
            api: 'decisions',
            minRouteProbability,
          }),
      ).toThrow('between 0 and 1');
    },
  );
  it.each([0, 1])(
    'accepts probability boundary %s',
    async (minRouteProbability) => {
      await using provider = new NativeProvider();
      const agent = new Agent({
        instructions: 'Choose.',
        provider,
        api: 'decisions',
        minRouteProbability,
      });
      expect(agent.minRouteProbability).toBe(minRouteProbability);
    },
  );
});

it.each([undefined, 'ordinary'])(
  'combines the explicit model and API selection into native configuration with fallback %s',
  async (fallback) => {
    await using provider = new NativeProvider({ apiKey: 'synthetic-key' });
    const agent = new Agent({
      instructions: 'Choose a route.',
      provider,
      model: 'default-model',
      fallbackModel: fallback,
      minRouteProbability: 0.8,
    });
    const session = await agent.session({
      model: 'classifier',
      api: 'decisions',
    });
    expect((fixture.open.mock.calls[0][0] as SessionSetup).model).toBe(
      fallback ?? 'classifier',
    );
    expect(providerConfig()).toMatchObject({
      wire_api: 'responses',
      supports_websockets: false,
      stream_max_retries: 0,
      decision_model: {
        model: 'classifier',
        ...(fallback === undefined ? {} : { fallback_model: fallback }),
        min_route_probability: 0.8,
      },
    });
    expect(fixture.open.mock.calls[0][1].decisionsApi).toMatchObject({
      minRouteProbability: 0.8,
    });
    await session.close();
  },
);

it('defaults to Responses and preserves ordinary string model configuration', async () => {
  await using provider = new NativeProvider({ apiKey: 'synthetic-key' });
  const agent = new Agent({
    instructions: 'Answer.',
    provider,
    model: 'ordinary',
  });
  expect(agent.api).toBe('responses');
  const session = await agent.session();
  expect((fixture.open.mock.calls[0][0] as SessionSetup).model).toBe(
    'ordinary',
  );
  expect(providerConfig()).not.toHaveProperty('decision_model');
  await session.close();
});

it('retains Decisions when only a Session or run model is overridden', async () => {
  await using provider = new NativeProvider({ apiKey: 'synthetic-key' });
  const agent = new Agent({
    instructions: 'Choose.',
    provider,
    model: 'default-classifier',
    api: 'decisions',
    fallbackModel: 'ordinary',
    minRouteProbability: 0.8,
  });
  const session = await agent.session({ model: 'session-classifier' });
  await agent.run('Choose.', { model: 'run-classifier' });
  expect(providerConfig(0).decision_model).toEqual({
    model: 'session-classifier',
    fallback_model: 'ordinary',
    min_route_probability: 0.8,
  });
  expect(providerConfig(1).decision_model).toEqual({
    model: 'run-classifier',
    fallback_model: 'ordinary',
    min_route_probability: 0.8,
  });
  expect(agent.model).toBe('default-classifier');
  await session.close();
});

it('captures Agent policies before opening suspension and ignores later changes', async () => {
  await using provider = new NativeProvider({ apiKey: 'synthetic-key' });
  const agent = new Agent({
    instructions: 'Choose.',
    provider,
    api: 'decisions',
    fallbackModel: 'original',
    minRouteProbability: 0.2,
  });
  const opening = agent.session();
  agent.fallbackModel = 'later';
  agent.minRouteProbability = 0.9;
  const session = await opening;
  expect(providerConfig().decision_model).toEqual({
    model: 'gpt-6-luna',
    fallback_model: 'original',
    min_route_probability: 0.2,
  });
  await session.close();
});

it.each([undefined, 'classifier'])(
  'captures API, model, and policies before an asynchronous run wrapper (model=%s)',
  async (model) => {
    await using provider = new NativeProvider({ apiKey: 'synthetic-key' });
    const agent = new Agent({
      instructions: 'Choose.',
      provider,
      api: 'decisions',
      model,
      fallbackModel: 'original',
      minRouteProbability: 0.2,
    });
    const original = agent.session.bind(agent);
    agent.session = async (...args) => {
      await Promise.resolve();
      return original(...args);
    };
    const running = agent.run('Choose.');
    agent.api = 'responses';
    agent.model = 'later-generation';
    agent.fallbackModel = 'later';
    agent.minRouteProbability = 0.9;
    await running;
    expect(providerConfig().decision_model).toEqual({
      model: model ?? 'gpt-6-luna',
      fallback_model: 'original',
      min_route_probability: 0.2,
    });
  },
);

it.each([
  ['responses', undefined, undefined, undefined, undefined],
  ['decisions', undefined, undefined, undefined, 'gpt-6-luna'],
  ['decisions', 'custom-selector', undefined, undefined, 'custom-selector'],
  ['responses', 'generation', 'decisions', undefined, 'gpt-6-luna'],
  ['decisions', 'selector', 'responses', undefined, undefined],
  ['decisions', 'selector', 'decisions', undefined, 'selector'],
  ['responses', 'generation', 'responses', undefined, 'generation'],
  [
    'responses',
    'generation',
    'decisions',
    'opening-selector',
    'opening-selector',
  ],
  [
    'decisions',
    'selector',
    'responses',
    'opening-generation',
    'opening-generation',
  ],
] as const)(
  'resolves API/model defaults: %s %s -> %s %s',
  async (api, model, openingApi, openingModel, expected) => {
    await using provider = new NativeProvider({ apiKey: 'synthetic-key' });
    const agent = new Agent({ instructions: 'Answer.', provider, api, model });
    const session = await agent.session({
      api: openingApi,
      model: openingModel,
    });
    expect((fixture.open.mock.calls[0][0] as SessionSetup).model).toBe(
      expected,
    );
    if ((openingApi ?? api) === 'decisions')
      expect(providerConfig().decision_model).toEqual({ model: expected });
    else expect(providerConfig()).not.toHaveProperty('decision_model');
    await session.close();
  },
);

it('ignores valid Decisions policies on Responses and uses them on a Decisions run', async () => {
  await using provider = new NativeProvider({ apiKey: 'synthetic-key' });
  const agent = new Agent({
    instructions: 'Answer.',
    provider,
    model: 'generation',
    fallbackModel: 'explicit-fallback',
    minRouteProbability: 0.7,
  });
  await agent.run('Answer.');
  expect(providerConfig()).not.toHaveProperty('decision_model');
  expect((fixture.open.mock.calls[0][0] as SessionSetup).model).toBe(
    'generation',
  );
  await agent.run('Choose.', { api: 'decisions' });
  expect(providerConfig(1).decision_model).toEqual({
    model: 'gpt-6-luna',
    fallback_model: 'explicit-fallback',
    min_route_probability: 0.7,
  });
});

it.each(['responses', 'decisions'] as const)(
  'validates scalar policies for %s and revalidates mutable defaults before acquisition',
  async (api) => {
    await using provider = new NativeProvider();
    expect(
      () =>
        new Agent({
          instructions: 'Answer.',
          provider,
          api,
          fallbackModel: ' ',
        }),
    ).toThrow('non-empty');
    expect(
      () =>
        new Agent({
          instructions: 'Answer.',
          provider,
          api,
          minRouteProbability: Infinity,
        }),
    ).toThrow('between 0 and 1');
    const agent = new Agent({ instructions: 'Answer.', provider, api });
    const acquire = vi.spyOn(provider, '_acquire');
    agent.minRouteProbability = NaN;
    await expect(agent.session()).rejects.toThrow('between 0 and 1');
    expect(acquire).not.toHaveBeenCalled();
  },
);

it('resets Decisions through explicit Responses on Session and run without changing Agent defaults', async () => {
  await using provider = new NativeProvider({ apiKey: 'synthetic-key' });
  const agent = new Agent({
    instructions: 'Answer.',
    provider,
    model: 'classifier',
    api: 'decisions',
    fallbackModel: 'ordinary',
  });
  const session = await agent.session({
    model: 'generation',
    api: 'responses',
  });
  await agent.run('Answer.', {
    model: 'other-generation',
    api: 'responses',
    returnState: true,
  });
  for (const index of [0, 1]) {
    expect(providerConfig(index)).not.toHaveProperty('decision_model');
    expect(fixture.open.mock.calls[index][1].decisionsApi).toBeUndefined();
  }
  expect((fixture.open.mock.calls[0][0] as SessionSetup).model).toBe(
    'generation',
  );
  expect((fixture.open.mock.calls[1][0] as SessionSetup).model).toBe(
    'other-generation',
  );
  expect(agent.api).toBe('decisions');
  await session.close();
});

it.each(['', '  '])(
  'rejects a blank explicit Decisions model before provider acquisition: %j',
  async (model) => {
    await using provider = new NativeProvider();
    const acquire = vi.spyOn(provider, '_acquire');
    await expect(
      new Agent({
        instructions: 'Choose.',
        provider,
        model,
        api: 'decisions',
      }).session(),
    ).rejects.toThrow('non-empty model');
    expect(acquire).not.toHaveBeenCalled();
  },
);

it('accepts an opening model when the Decisions Agent declaration omits it', async () => {
  await using provider = new NativeProvider();
  const session = await new Agent({
    instructions: 'Choose.',
    provider,
    api: 'decisions',
  }).session({ model: 'opening-classifier' });
  expect(providerConfig().decision_model).toEqual({
    model: 'opening-classifier',
  });
  await session.close();
});

it('rejects effective Decisions restore before acquisition but allows an explicit Responses reset', async () => {
  await using provider = new NativeProvider();
  const acquire = vi.spyOn(provider, '_acquire');
  const state = ordinaryState();
  const before = structuredClone(state);
  const agent = new Agent({
    instructions: 'Answer.',
    provider,
    model: 'classifier',
    api: 'decisions',
  });
  await expect(agent.session({ state })).rejects.toThrow('checkpoint restore');
  expect(acquire).not.toHaveBeenCalled();
  const session = await agent.session({ state, api: 'responses' });
  expect(providerConfig()).not.toHaveProperty('decision_model');
  expect(fixture.open.mock.calls[0][1].state.agent_options).toEqual(
    before.agent_options,
  );
  expect(state).toEqual(before);
  await expect(
    agent.session({ state, api: 'responses', model: 'replacement' }),
  ).rejects.toThrow('cannot be used with state');
  await session.close();
});

it.each([false, true])(
  'honors API selection from a captured session factory (explicit Decisions=%s)',
  async (injectApi) => {
    await using provider = new NativeProvider({ apiKey: 'synthetic-key' });
    const acquire = vi.spyOn(provider, '_acquire');
    const agent = new Agent({
      instructions: 'Answer.',
      provider,
      model: 'ordinary',
    });
    const open = agent.session.bind(agent);
    agent.session = (options = {}) =>
      open({
        ...options,
        ...(options.state && injectApi ? { api: 'decisions' as const } : {}),
      });
    const initial = await agent.session();
    const options = fixture.open.mock.calls[0][1] as CoreOptions;
    expect(options.deferredReopen).toEqual(expect.any(Function));
    // A captured opening must not inherit a later Agent API mutation.
    agent.api = 'decisions';
    const restoring = options.deferredReopen!(
      ordinaryState(),
      prepareOutput(undefined),
      false,
    );
    if (injectApi) {
      await expect(restoring).rejects.toThrow('checkpoint restore');
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(fixture.open).toHaveBeenCalledTimes(1);
    } else {
      const restored = await restoring;
      expect(providerConfig(1)).not.toHaveProperty('decision_model');
      expect(fixture.open.mock.calls[1][1].decisionsApi).toBeUndefined();
      await restored.close();
    }
    await initial.close();
  },
);

it('rejects unsupported tools and prompted output before acquiring a provider', async () => {
  await using provider = new NativeProvider();
  const acquire = vi.spyOn(provider, '_acquire');
  const deferred = tool({
    name: 'later',
    description: 'Deferred.',
    parameters: z.object({}),
    deferLoading: true,
    execute: () => 'done',
  });
  const declaration = {
    instructions: 'Choose.',
    model: 'classifier',
    api: 'decisions' as const,
    provider,
  };
  for (const agent of [
    new Agent({ ...declaration, tools: [deferred] }),
    new Agent({
      ...declaration,
      outputType: {
        mode: 'prompted',
        schema: z.object({ choice: z.enum(['a', 'b']) }),
      },
    }),
  ])
    await expect(agent.session()).rejects.toThrow('Decisions');
  expect(acquire).not.toHaveBeenCalled();
});

it('rejects login credentials and state return before acquiring a provider', async () => {
  await using provider = new NativeProvider({
    chatGPT: { accessToken: 'synthetic', accountId: 'synthetic' },
  });
  const acquire = vi.spyOn(provider, '_acquire');
  const agent = new Agent({
    instructions: 'Choose.',
    provider,
    model: 'classifier',
    api: 'decisions',
  });
  await expect(agent.session()).rejects.toThrow('ChatGPT');
  await expect(agent.run('Choose.', { returnState: true })).rejects.toThrow(
    'returnState',
  );
  expect(acquire).not.toHaveBeenCalled();
});

it('rejects Decisions handoffs but allows an explicit Responses opening', async () => {
  await using provider = new NativeProvider();
  const acquire = vi.spyOn(provider, '_acquire');
  const target = new Agent({ name: 'specialist', instructions: 'Answer.' });
  const agent = new Agent({
    instructions: 'Route.',
    api: 'decisions',
    provider,
    handoffs: [target],
  });
  const opening = agent.session();
  await opening.then(
    (session) => session.close(),
    () => {},
  );
  await expect(opening).rejects.toThrow('Decisions does not support handoffs');
  expect(acquire).not.toHaveBeenCalled();

  const session = await agent.session({ api: 'responses' });
  expect(providerConfig()).not.toHaveProperty('decision_model');
  expect(fixture.open.mock.calls[0][1].agentGraph).toBeDefined();
  expect(agent.api).toBe('decisions');
  await session.close();
});

it('rejects a Decisions opening override on a Responses handoff graph', async () => {
  await using provider = new NativeProvider();
  const acquire = vi.spyOn(provider, '_acquire');
  const target = new Agent({ name: 'specialist', instructions: 'Answer.' });
  const agent = new Agent({
    instructions: 'Route.',
    provider,
    handoffs: [target],
  });
  const opening = agent.session({ api: 'decisions' });
  await opening.then(
    (session) => session.close(),
    () => {},
  );
  await expect(opening).rejects.toThrow('Decisions does not support handoffs');
  expect(acquire).not.toHaveBeenCalled();
});

it('rejects a Decisions handoff target before validation or provider acquisition', async () => {
  await using provider = new NativeProvider();
  const acquire = vi.spyOn(provider, '_acquire');
  const target = new Agent({
    name: 'specialist',
    instructions: 'Choose.',
    api: 'decisions',
  });
  await target.validate();
  const agent = new Agent({
    instructions: 'Route.',
    provider,
    handoffs: [target],
  });
  await expect(agent.validate()).rejects.toThrow(
    'Decisions does not support handoffs',
  );
  const opening = agent.session();
  await opening.then(
    (session) => session.close(),
    () => {},
  );
  await expect(opening).rejects.toThrow('Decisions does not support handoffs');
  expect(acquire).not.toHaveBeenCalled();
});

it('rejects native Realtime before starting native work on a Decisions Session', async () => {
  await expect(coreSession().realtime()).rejects.toThrow(
    'Decisions does not support native Realtime',
  );
});

it('rejects model mutation, portable state, and model compaction without fallback', async () => {
  const session = coreSession();
  await expect(session.update({ model: 'ordinary' })).rejects.toThrow(
    'cannot change model',
  );
  await expect(session.saveState()).rejects.toThrow('portable state');
  await expect(session.fork()).rejects.toThrow('portable state');
  await expect(session.compact()).rejects.toThrow('explicit fallback');
});
it('rejects prompted per-turn output before native submission', async () => {
  await expect(
    coreSession().submit('Choose.', {
      outputType: {
        mode: 'prompted',
        schema: z.object({ choice: z.enum(['a', 'b']) }),
      },
    }),
  ).rejects.toThrow('plain or native output');
});
