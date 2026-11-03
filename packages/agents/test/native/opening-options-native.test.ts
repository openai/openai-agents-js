import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeError,
  NativeProvider,
  Runner,
  checklist,
  manualTool,
  tool,
  type ExecutorContext,
  type Session,
  type SessionOptions,
} from '@openai/agents';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
const sessions: Session[] = [];
const providers: NativeProvider[] = [];
let executor: Awaited<ReturnType<typeof startPublicExecutor>> | undefined;

async function providerFor(server: ModelServer, apiKey: string) {
  const config = await server.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey,
    supportsWebsockets: false,
  });
  providers.push(provider);
  return provider;
}

async function open(agent: Agent, options: SessionOptions = {}) {
  const session = await agent.session(options);
  sessions.push(session);
  return session;
}

afterEach(async () => {
  vi.restoreAllMocks();
  const closedSessions = await Promise.allSettled(
    sessions.splice(0).map((session) => session.close()),
  );
  const closedProviders = await Promise.allSettled(
    providers.splice(0).map((provider) => provider.close()),
  );
  const closedPeers = await Promise.allSettled([
    executor?.close(),
    ModelServer.closeAll(),
  ]);
  executor = undefined;
  const failures = [...closedSessions, ...closedProviders, ...closedPeers]
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length)
    throw new AggregateError(failures, 'Fixture cleanup failed');
});

describe('actual native opening overrides', () => {
  nativeIt(
    'routes the first request through opening options and preserves later Agent defaults',
    async () => {
      const defaults = new ModelServer([
        (request) => {
          expect(request.model).toBe('gpt-5');
          expect(request.reasoning).toMatchObject({
            effort: 'low',
            summary: 'concise',
          });
          expect(request.service_tier).toBe('flex');
          return [message('Agent defaults')];
        },
      ]);
      const openingReply = (request: Record<string, unknown>) => {
        expect(request.model).toBe('gpt-5.2');
        expect(request.reasoning).toMatchObject({
          effort: 'high',
          summary: 'concise',
        });
        expect(request.service_tier).not.toBe('flex');
        return [message('Opening options')];
      };
      const selected = new ModelServer([openingReply, openingReply]);
      const defaultProvider = await providerFor(
        defaults,
        'synthetic-default-key',
      );
      const openingProvider = await providerFor(
        selected,
        'synthetic-opening-key',
      );
      const agent = new Agent<undefined>({
        instructions: 'Answer.',
        provider: defaultProvider,
        model: 'gpt-5',
        modelSettings: {
          reasoningEffort: 'low',
          reasoningSummary: 'concise',
          serviceTier: 'flex',
        },
      });
      const options = {
        provider: openingProvider,
        model: 'gpt-5.2',
        modelSettings: {
          reasoningEffort: 'high',
          reasoningSummary: undefined,
          serviceTier: null,
        },
      };
      expect(
        (await agent.run('Use these opening options.', options)).finalOutput,
      ).toBe('Opening options');
      expect(defaults.requests).toHaveLength(0);
      expect(
        (await Runner.run(agent, 'Use them through Runner.', options))
          .finalOutput,
      ).toBe('Opening options');
      expect(
        selected.requestHeaders.map((headers) => headers.authorization),
      ).toEqual([
        'Bearer synthetic-opening-key',
        'Bearer synthetic-opening-key',
      ]);
      expect((await agent.run('Use the Agent defaults.')).finalOutput).toBe(
        'Agent defaults',
      );
      expect(agent.provider).toBe(defaultProvider);
      expect(agent.model).toBe('gpt-5');
      expect(agent.modelSettings).toEqual({
        reasoningEffort: 'low',
        reasoningSummary: 'concise',
        serviceTier: 'flex',
      });
      defaults.assertExhausted();
      selected.assertExhausted();
    },
    30_000,
  );

  nativeIt(
    'keeps concurrent openings independent when a sibling Session closes',
    async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const left = new ModelServer([
        (request) => {
          expect(request.model).toBe('gpt-5');
          expect(request.reasoning).toMatchObject({ effort: 'low' });
          return [message('Left finished')];
        },
        [message('Left provider reused')],
      ]);
      const right = new ModelServer([
        async (request) => {
          entered.resolve();
          expect(request.model).toBe('gpt-5.2');
          expect(request.reasoning).toMatchObject({ effort: 'high' });
          await release.promise;
          return [message('Right survived')];
        },
        [message('Right provider reused')],
      ]);
      const leftProvider = await providerFor(left, 'synthetic-left-key');
      const rightProvider = await providerFor(right, 'synthetic-right-key');
      const agent = new Agent<undefined>({
        instructions: 'Answer.',
        provider: leftProvider,
        model: 'gpt-5',
        modelSettings: { reasoningEffort: 'low' },
      });
      const first = await open(agent);
      const second = await open(agent, {
        provider: rightProvider,
        model: 'gpt-5.2',
        modelSettings: { reasoningEffort: 'high' },
      });
      try {
        const held = (await second.submit('Wait for the left Session.')).wait();
        void held.catch(() => undefined);
        await Promise.race([entered.promise, held]);
        expect(
          (await (await first.submit('Finish first.')).wait()).finalOutput,
        ).toBe('Left finished');
        await first.close();
        expect(right.requests).toHaveLength(1);
        await expect(rightProvider.close()).rejects.toThrow(
          'open or opening sessions',
        );
        release.resolve();
        expect((await held).finalOutput).toBe('Right survived');
        await second.close();
        expect((await agent.run('Reuse left.')).finalOutput).toBe(
          'Left provider reused',
        );
        expect(
          (await agent.run('Reuse right.', { provider: rightProvider }))
            .finalOutput,
        ).toBe('Right provider reused');
        expect(agent.provider).toBe(leftProvider);
        left.assertExhausted();
        right.assertExhausted();
      } finally {
        release.resolve();
      }
    },
    30_000,
  );

  nativeIt(
    'restores saved model settings with current provider credentials and rejects conflicting opening intent',
    async () => {
      const original = new ModelServer([[message('Saved answer')]]);
      const current = new ModelServer([
        (request) => {
          expect(request.model).toBe('gpt-5');
          expect(request.reasoning).toMatchObject({
            effort: 'low',
            summary: 'concise',
          });
          expect(request.service_tier).toBe('flex');
          expect(JSON.stringify(request.input)).toContain('Saved answer');
          return [message('Restored answer')];
        },
      ]);
      const oldProvider = await providerFor(
        original,
        'synthetic-old-restore-key',
      );
      const currentProvider = await providerFor(
        current,
        'synthetic-current-restore-key',
      );
      const source = await open(
        new Agent<undefined>({
          instructions: 'Answer.',
          provider: oldProvider,
          model: 'gpt-5',
          modelSettings: {
            reasoningEffort: 'low',
            reasoningSummary: 'concise',
            serviceTier: 'flex',
          },
        }),
      );
      await (await source.submit('Save this answer.')).wait();
      const state = await source.saveState();
      await source.close();
      const destinationAgent = new Agent<undefined>({
        instructions: 'Answer.',
        provider: oldProvider,
        model: 'gpt-5.2',
        modelSettings: {
          reasoningEffort: 'high',
          reasoningSummary: 'detailed',
          serviceTier: null,
        },
      });
      const acquire = vi.spyOn(currentProvider, '_acquire');
      for (const conflict of [{ model: 'gpt-5.2' }, { modelSettings: {} }]) {
        await expect(
          destinationAgent.session({
            state,
            provider: currentProvider,
            ...conflict,
          }),
        ).rejects.toThrow('cannot be used with state');
      }
      expect(acquire).not.toHaveBeenCalled();
      expect(current.requests).toHaveLength(0);
      const restored = await open(destinationAgent, {
        state,
        provider: currentProvider,
      });
      expect(restored.id).toBe(state.source_session_id);
      expect(
        (await (await restored.submit('Continue.')).wait()).finalOutput,
      ).toBe('Restored answer');
      expect(current.requestHeaders[0]?.authorization).toBe(
        'Bearer synthetic-current-restore-key',
      );
      original.assertExhausted();
      current.assertExhausted();
    },
    30_000,
  );

  nativeIt(
    'continues a restored manual turn on the current provider without replaying its completed effect',
    async () => {
      let effects = 0;
      const record = tool({
        name: 'record',
        parameters: z.object({}),
        execute() {
          effects++;
          return 'recorded-source-effect';
        },
      });
      const approval = manualTool({
        name: 'decision',
        description: 'Ask for approval.',
        parameters: z.object({}),
        result: z.string(),
      });
      const original = new ModelServer([
        [call('record', {}, { callId: 'record-before-pause' })],
        [call('decision', {}, { callId: 'pending-decision' })],
      ]);
      const current = new ModelServer([
        (request) => {
          expect(request.model).toBe('gpt-5');
          expect(request.reasoning).toMatchObject({ effort: 'low' });
          expect(JSON.stringify(request.input)).toContain(
            'recorded-source-effect',
          );
          expect(JSON.stringify(request.input)).toContain('approved');
          return [message('Manual continuation completed')];
        },
      ]);
      const oldProvider = await providerFor(
        original,
        'synthetic-old-manual-key',
      );
      const currentProvider = await providerFor(
        current,
        'synthetic-current-manual-key',
      );
      const sourceAgent = new Agent<undefined>({
        instructions: 'Record, then ask for approval.',
        provider: oldProvider,
        model: 'gpt-5',
        modelSettings: { reasoningEffort: 'low' },
        tools: [record, approval],
      });
      const source = await open(sourceAgent);
      await source.submit('Record once, then wait.');
      let originalRequest: ReturnType<typeof approval.match>;
      for await (const event of source.events()) {
        originalRequest = approval.match(event);
        if (originalRequest) break;
      }
      if (!originalRequest)
        throw new Error('Expected a pending source decision');
      const state = await source.suspend();
      await source.close();
      expect(effects).toBe(1);
      const destinationAgent = new Agent<undefined>({
        instructions: sourceAgent.instructions,
        provider: oldProvider,
        model: 'gpt-5.2',
        modelSettings: { reasoningEffort: 'high' },
        tools: [record, approval],
      });
      const restored = await open(destinationAgent, {
        state,
        provider: currentProvider,
      });
      let resumed = false;
      for await (const event of restored.events()) {
        const request = approval.match(event);
        if (!request) continue;
        expect(request).not.toBe(originalRequest);
        expect(
          (await (await restored.submit(request.reply('approved'))).wait())
            .finalOutput,
        ).toBe('Manual continuation completed');
        resumed = true;
        break;
      }
      expect(resumed).toBe(true);
      expect(effects).toBe(1);
      expect(current.requestHeaders[0]?.authorization).toBe(
        'Bearer synthetic-current-manual-key',
      );
      original.assertExhausted();
      current.assertExhausted();
    },
    30_000,
  );

  nativeIt.each([
    { defaultModel: undefined, checkpointKind: 'save' },
    { defaultModel: 'unusable-agent-default', checkpointKind: 'save' },
    { defaultModel: undefined, checkpointKind: 'fork' },
    { defaultModel: 'unusable-agent-default', checkpointKind: 'fork' },
  ])(
    'restores an opening-only NativeAgents model from $checkpointKind with Agent default $defaultModel',
    async ({ defaultModel, checkpointKind }) => {
      executor = await startPublicExecutor();
      const plan = [{ step: 'Continue after restore', status: 'in_progress' }];
      const server = new ModelServer([
        (request) => {
          expect(request.model).toBe('gpt-5.5');
          expect(request.reasoning).toMatchObject({
            effort: 'low',
            summary: 'concise',
          });
          expect(request.service_tier).toBe('flex');
          return [call('update_plan', { plan }, { callId: 'opening-plan' })];
        },
        [message('NativeAgents opening completed')],
      ]);
      const provider = await providerFor(server, 'synthetic-native-agents-key');
      const current = new ModelServer([
        (request) => {
          expect(request.model).toBe('gpt-5.5');
          expect(request.reasoning).toMatchObject({
            effort: 'low',
            summary: 'concise',
          });
          expect(request.service_tier).toBe('flex');
          expect(JSON.stringify(request.input)).toContain(
            'NativeAgents opening completed',
          );
          return [
            call('exec_command', { cmd: 'pwd' }, { callId: 'restored-cwd' }),
          ];
        },
        [message('NativeAgents restored on current provider')],
      ]);
      const currentProvider = await providerFor(
        current,
        'synthetic-native-agents-current-key',
      );
      const agent = new Agent<undefined>({
        instructions: 'Answer without starting child work.',
        provider,
        model: defaultModel,
        tools: [new NativeAgents(), checklist()],
      });
      const session = await open(agent, {
        model: 'gpt-5.5',
        modelSettings: {
          reasoningEffort: 'low',
          reasoningSummary: 'concise',
          serviceTier: 'flex',
        },
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
      });
      expect(
        (await (await session.submit('Give one answer.')).wait()).finalOutput,
      ).toBe('NativeAgents opening completed');
      await expect(session.update({ model: 'gpt-5' })).rejects.toThrow(
        'cannot change after the Session opens',
      );
      expect(agent.model).toBe(defaultModel);
      expect(agent.modelSettings).toBeUndefined();
      const savedChecklist = await session.checklist();
      expect(savedChecklist?.plan).toEqual(plan);
      const state =
        checkpointKind === 'fork'
          ? await session.fork()
          : await session.saveState();
      if (checkpointKind === 'fork')
        expect(state.source_session_id).not.toBe(session.id);
      else expect(state.source_session_id).toBe(session.id);
      await session.close();
      expect(current.requests).toHaveLength(0);
      await executor.close();
      executor = await startPublicExecutor();
      const approval = vi.fn((_info: ExecutorContext<undefined>) => false);
      const environment = new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
        approval,
      });
      const acquire = vi.spyOn(currentProvider, '_acquire');
      for (const conflict of [{ model: 'gpt-5.5' }, { modelSettings: {} }]) {
        await expect(
          open(agent, {
            state,
            provider: currentProvider,
            environment,
            ...conflict,
          }),
        ).rejects.toThrow('cannot be used with state');
      }
      expect(acquire).not.toHaveBeenCalled();
      expect(current.requests).toHaveLength(0);
      const restored = await open(agent, {
        state,
        provider: currentProvider,
        environment,
      });
      expect(restored.id).toBe(state.source_session_id);
      expect(await restored.checklist()).toEqual({
        ...savedChecklist,
        threadId: restored.id,
      });
      expect(
        executor.requests.filter(
          (request) => request.method === 'process/start',
        ),
      ).toHaveLength(0);
      await expect(
        (await restored.submit('Check the current executor policy.')).wait(),
      ).rejects.toBeInstanceOf(NativeError);
      expect(approval).toHaveBeenCalledOnce();
      expect(approval.mock.calls[0]?.[0].agent).toBe(agent);
      expect(approval.mock.calls[0]?.[0].session).toBe(restored);
      expect(
        (
          await (
            await restored.submit('Continue without executing a command.')
          ).wait()
        ).finalOutput,
      ).toBe('NativeAgents restored on current provider');
      expect(
        current.requestHeaders.map((headers) => headers.authorization),
      ).toEqual([
        'Bearer synthetic-native-agents-current-key',
        'Bearer synthetic-native-agents-current-key',
      ]);
      expect(agent.provider).toBe(provider);
      expect(agent.model).toBe(defaultModel);
      expect(agent.modelSettings).toBeUndefined();
      expect(
        executor.requests.filter(
          (request) => request.method === 'process/start',
        ),
      ).toHaveLength(0);
      server.assertExhausted();
      current.assertExhausted();
    },
    45_000,
  );

  nativeIt.each([
    { label: 'history', patch: { history: [{}] }, beforeAcquire: false },
    {
      label: 'root metadata',
      patch: { root_metadata: {} },
      beforeAcquire: false,
    },
    {
      label: 'Core revision',
      patch: { codex_revision: 'wrong' },
      beforeAcquire: true,
    },
  ])(
    'rejects damaged persisted $label and releases opening resources',
    async ({ patch, beforeAcquire }) => {
      const original = new ModelServer([[message('Saved answer')]]);
      const current = new ModelServer([
        [message('Current provider remains usable')],
      ]);
      const provider = await providerFor(original, 'synthetic-original-key');
      const currentProvider = await providerFor(
        current,
        'synthetic-current-key',
      );
      const agent = new Agent({
        instructions: 'Answer.',
        provider,
        model: 'gpt-5',
      });
      const source = await open(agent);
      await (await source.submit('Save one answer.')).wait();
      const state = await source.saveState();
      await source.close();
      const acquire = vi.spyOn(currentProvider, '_acquire');
      // Persisted state is an external JSON boundary, including damaged data.
      const damaged = JSON.parse(JSON.stringify({ ...state, ...patch }));
      await expect(
        open(agent, { state: damaged, provider: currentProvider }),
      ).rejects.toThrow();
      if (beforeAcquire) expect(acquire).not.toHaveBeenCalled();
      expect(current.requests).toHaveLength(0);
      const restored = await open(agent, { state, provider: currentProvider });
      expect(
        (await (await restored.submit('Use the current provider.')).wait())
          .finalOutput,
      ).toBe('Current provider remains usable');
      expect(agent.provider).toBe(provider);
      original.assertExhausted();
      current.assertExhausted();
    },
    30_000,
  );
});
