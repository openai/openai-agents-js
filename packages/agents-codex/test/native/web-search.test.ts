import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  checklist,
  nativeGoals,
  NativeProvider,
  tool,
  webSearch,
  type WebSearch,
} from '../../src';
import { splitToolDeclarations } from '../../src/runtime/mcp';
import { Session as OwnedSession } from '../../src/runtime/session';
import { captureTools } from '../../src/runtime/tools';
import * as native from '../../src/runtime/binding';
import type { Engine, NativeThread } from '../../src/runtime/binding';
import type { ModelSettings, ProviderLease } from '../../src/runtime/provider';
import type { ThreadOptions } from '../../src/runtime/options';

const opening = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../../src/runtime/agent', () => ({
  openSession: opening.open,
  runOwnedSession: vi.fn(),
}));
vi.mock('../../src/runtime/binding', async (original) => ({
  ...(await original<typeof import('../../src/runtime/binding')>()),
  binding: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  opening.open.mockReset();
});

describe('captured native WebSearch', () => {
  it.each([1.5, -1, Number.NaN, Infinity, -Infinity, 2 ** 63, 2 ** 64])(
    'rejects an image count outside the native integer domain: %s',
    (maxResults) => {
      expect(() =>
        webSearch({ route: 'hosted', imageSettings: { maxResults } }),
      ).toThrow('non-negative integer');
    },
  );

  it.each([0, 1, Number.MAX_SAFE_INTEGER, 2 ** 62, 2 ** 63 - 1024])(
    'captures a supported integer image count: %s',
    (maxResults) => {
      expect(
        webSearch({ route: 'hosted', imageSettings: { maxResults } })
          .imageSettings,
      ).toEqual({ maxResults });
    },
  );

  it('rejects a structural image count before acquiring its provider', async () => {
    await using provider = new NativeProvider();
    const acquire = vi.spyOn(provider, '_acquire');
    await expect(
      new Agent({
        instructions: 'Act',
        provider,
        tools: [
          {
            ...webSearch({ route: 'hosted' }),
            imageSettings: { maxResults: 1.5 },
          },
        ],
      }).session(),
    ).rejects.toThrow('non-negative integer');
    expect(acquire).not.toHaveBeenCalled();
  });

  it('defaults to an immutable cached standalone opening declaration', () => {
    expect(webSearch()).toEqual({
      kind: 'web_search',
      mode: 'cached',
      route: 'standalone',
    });
    expect(Object.isFrozen(webSearch())).toBe(true);
    expect(splitToolDeclarations([]).webSearch).toBeUndefined();
    expect(() =>
      splitToolDeclarations([
        { ...webSearch(), allowedDomains: ['example.test'] } as WebSearch,
      ]),
    ).toThrow('Unsupported');
  });

  it('retains current search, Checklist and native goal declarations', () => {
    const declarations = splitToolDeclarations([
      checklist(),
      webSearch(),
      nativeGoals(),
    ]);
    expect(declarations.nativeGoals).toBe(true);
    expect(declarations.checklist).toBe(true);
    expect(declarations.webSearch).toEqual(webSearch());
    expect(declarations.tools).toEqual([]);
  });

  it('captures separate frozen lists and a location from a structural declaration', () => {
    const original = {
      ...webSearch({ route: 'hosted' }),
      allowedDomains: ['allowed.example.test'],
      blockedDomains: ['blocked.example.test'],
      location: { city: 'Chicago', timezone: 'America/Chicago' },
      searchContentTypes: ['image'] as ('text' | 'image')[],
      imageSettings: { maxResults: 3, caption: false },
    };
    const { webSearch: captured } = splitToolDeclarations([original]);
    original.allowedDomains[0] = 'other.test';
    original.blockedDomains.push('other.test');
    original.location.timezone = 'Etc/UTC';
    original.searchContentTypes[0] = 'text';
    original.imageSettings.caption = true;
    expect(captured).toEqual({
      kind: 'web_search',
      mode: 'cached',
      route: 'hosted',
      allowedDomains: ['allowed.example.test'],
      blockedDomains: ['blocked.example.test'],
      location: { city: 'Chicago', timezone: 'America/Chicago' },
      searchContentTypes: ['image'],
      imageSettings: { maxResults: 3, caption: false },
    });
    for (const value of [
      captured,
      captured!.allowedDomains,
      captured!.blockedDomains,
      captured!.location,
      captured!.searchContentTypes,
      captured!.imageSettings,
    ])
      expect(Object.isFrozen(value)).toBe(true);
  });

  it.each([
    { mode: 'disabled' },
    { mode: null },
    { route: 'automatic' },
    { allowedDomains: ['example.test'] },
    { searchContentTypes: ['image'] },
    { imageSettings: { caption: true } },
  ])(
    'refuses unsupported options without silently widening search: %j',
    (options) => {
      expect(() => webSearch(options as never)).toThrow(TypeError);
    },
  );

  it('rejects duplicate search and hosted callback collisions before binding or lease acquisition', async () => {
    const provider = new NativeProvider();
    const acquire = vi.spyOn(provider, '_acquire');
    const bind = vi.mocked(native.binding);
    bind.mockClear();
    await expect(
      new Agent({
        instructions: 'Act',
        provider,
        tools: [webSearch(), webSearch()],
      }).session(),
    ).rejects.toThrow('only once');
    const execute = vi.fn();
    const callback = tool({
      name: 'web_search',
      parameters: z.object({}),
      execute,
    });
    await expect(
      new Agent({
        instructions: 'Act',
        provider,
        tools: [webSearch({ route: 'hosted' }), callback],
      }).session(),
    ).rejects.toThrow('reserves');
    expect(acquire).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await provider.close();
  });

  it('validates hosted callback reservations before binding and preserves standalone callbacks', async () => {
    await using provider = new NativeProvider();
    const acquire = vi.spyOn(provider, '_acquire');
    const execute = vi.fn();
    const callback = tool({
      name: 'web_search',
      parameters: z.object({}),
      execute,
    });
    const check = vi.fn();
    const bind = vi.mocked(native.binding);
    bind.mockClear();
    bind.mockResolvedValueOnce({
      _validate_python_tool_declarations: check,
    } as unknown as Awaited<ReturnType<typeof native.binding>>);
    await expect(
      new Agent({
        instructions: 'Act',
        provider,
        tools: [webSearch({ route: 'hosted' }), callback],
      }).validate(),
    ).rejects.toThrow('reserves');
    expect(bind).not.toHaveBeenCalled();
    await expect(
      new Agent({
        instructions: 'Act',
        provider,
        tools: [webSearch(), callback],
      }).validate(),
    ).resolves.toBeUndefined();
    expect(check).toHaveBeenCalledOnce();
    expect(acquire).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['none', 'concrete', 'source'] as const)(
    'captures options and provider before asynchronous acquisition (%s)',
    async (environmentKind) => {
      let ready!: (value: Awaited<ReturnType<typeof native.binding>>) => void;
      vi.mocked(native.binding).mockReturnValueOnce(
        new Promise((resolve) => {
          ready = resolve;
        }),
      );
      const options = {
        kind: 'web_search' as const,
        mode: 'cached' as WebSearch['mode'],
        route: 'standalone' as WebSearch['route'],
      };
      const provider = new NativeProvider({ apiKey: 'synthetic-capture' });
      const release = vi.fn(async () => {});
      const lease: ProviderLease = {
        failedOpeningCleanup: undefined,
        websocketsAllowed: false,
        httpTransports: () => undefined,
        apiKey: 'synthetic-capture',
        config: {
          'model_providers.native_agent': {
            base_url: 'http://capture.invalid',
          },
        },
        open: vi.fn(async () => ({
          codex_home: '/captured/home',
          cwd: '/captured/work',
        })),
        release,
        openingSucceeded: vi.fn(),
        retainOpeningCleanup: vi.fn(),
        failOpening: async (error) => {
          await release();
          throw error;
        },
      };
      vi.spyOn(provider, '_acquire').mockReturnValue(lease);
      const settings: ModelSettings = { reasoningSummary: 'auto' };
      const agent = new Agent({
        instructions: 'Act',
        model: 'original-model',
        modelSettings: { reasoningEffort: 'low' },
        provider,
        tools: [options],
      });
      opening.open.mockImplementation(
        async (_setup, options, capturedLease) => ({
          close: async () => {
            await options.environmentOwner.dispose();
            await capturedLease.release();
          },
        }),
      );
      const replacement = new NativeProvider();
      vi.spyOn(replacement, '_acquire').mockReturnValue({ ...lease });
      const mutate = () => {
        options.mode = 'live';
        options.route = 'hosted';
        agent.tools = [];
        agent.provider = replacement;
        agent.instructions = 'Changed';
        agent.model = 'changed-model';
        agent.modelSettings!.reasoningEffort = 'high';
        settings.reasoningSummary = 'detailed';
      };
      const executor = new Environment({
        url: 'wss://executor.invalid',
        cwd: '/captured/work',
        tools: [],
      });
      const pending = agent.session({
        modelSettings: settings,
        environment:
          environmentKind === 'none'
            ? undefined
            : environmentKind === 'concrete'
              ? executor
              : async () => {
                  mutate();
                  return Environment.lease(executor, () => {});
                },
      });
      mutate();
      ready({
        _validate_python_tool_declarations: vi.fn(),
      } as unknown as Awaited<ReturnType<typeof native.binding>>);
      const session = await pending;
      try {
        const [setup, sessionOptions, capturedLease] =
          opening.open.mock.calls[0];
        expect(setup.instructions).toBe('Act');
        expect(setup.model).toBe('original-model');
        expect(setup.config.model_reasoning_effort).toBe('low');
        expect(setup.config.model_reasoning_summary).toBe('auto');
        expect(setup.config.web_search).toBe('cached');
        expect(setup.config['features.standalone_web_search']).toBe(true);
        expect(
          setup.config['features.code_mode'].direct_only_tool_namespaces,
        ).toContain('web');
        expect(
          setup.config['model_providers.native_agent']
            .supports_standalone_web_search,
        ).toBe(true);
        expect(setup.threadOptions.tool_policy.allowed_tools).toContainEqual({
          namespace: 'web',
          name: 'run',
        });
        expect(sessionOptions.webSearch).toEqual(webSearch());
        expect(capturedLease).toBe(lease);
      } finally {
        await session.close();
        await provider.close();
        await replacement.close();
      }
    },
  );

  it('refuses acquisition, removal or route changes on tool update and preserves ordinary updates', async () => {
    const replace = vi.fn(async (generation: string) => generation);
    const thread = {
      id: 'root',
      _replace_tools: replace,
      _configure_manual_tools: vi.fn(),
    } as unknown as NativeThread;
    const grant = webSearch({ route: 'hosted', location: { city: 'Chicago' } });
    const session = new OwnedSession(
      {} as Engine,
      thread,
      captureTools([]),
      { webSearch: grant },
      {} as ThreadOptions,
    );
    await expect(session.update({ tools: [] })).rejects.toThrow('retain');
    await expect(session.update({ tools: [webSearch()] })).rejects.toThrow(
      'retain',
    );
    await expect(
      session.update({
        tools: [webSearch({ route: 'hosted', location: { city: 'Seattle' } })],
      }),
    ).rejects.toThrow('retain');
    expect(replace).not.toHaveBeenCalled();
    await session.update({ tools: [grant] });
    expect(replace).toHaveBeenCalledTimes(1);
    const ungranted = new OwnedSession(
      {} as Engine,
      thread,
      captureTools([]),
      {},
      {} as ThreadOptions,
    );
    await expect(ungranted.update({ tools: [grant] })).rejects.toThrow(
      'retain',
    );
    expect(replace).toHaveBeenCalledTimes(1);
  });
});
