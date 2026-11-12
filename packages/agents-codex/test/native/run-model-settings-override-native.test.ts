import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  InteractionRequired,
  NativeProvider,
  manualTool,
  toolRef,
  type ModelResponse,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
const catalog =
  process.env.OPENAI_AGENTS_NATIVE_TESTS === '1'
    ? (
        JSON.parse(
          readFileSync(
            new URL(
              '../../native/.upstream/reviewed-codex/codex-rs/models-manager/models.json',
              import.meta.url,
            ),
            'utf8',
          ),
        ) as {
          models: {
            slug: string;
            supported_in_api: boolean;
            use_responses_lite?: boolean;
            multi_agent_version?: string;
          }[];
        }
      ).models
    : [];
const standardModel = catalog.find(
  (model) => model.supported_in_api && !model.use_responses_lite,
)?.slug;
const names = catalog
  .filter((model) => model.supported_in_api && model.multi_agent_version)
  .map((model) => model.slug);
if (
  process.env.OPENAI_AGENTS_NATIVE_TESTS === '1' &&
  (!standardModel || names.length < 3)
)
  throw new Error(
    'Expected standard Responses and three native orchestration catalog models',
  );
const initialModel = standardModel!;
const forcedModel = standardModel!;
const [initialAgentModel, forcedAgentModel, childDefault] = names as [
  string,
  string,
  string,
];
afterEach(() => ModelServer.closeAll());
const completed = (output: readonly JsonObject[]): ModelResponse => ({
  output,
  usage: { input_tokens: 1, output_tokens: 1 },
});

nativeIt(
  'retains named-tool release after a checkpoint with run-forced reset enabled',
  async () => {
    const lookup = manualTool({
      name: 'lookup',
      description: 'Retrieve.',
      parameters: z.object({}),
      result: z.string(),
    });
    const server = new ModelServer([
      [call('lookup', {}, { callId: 'lookup' })],
      [message('done')],
      [message('done')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-forced-reset',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      model: forcedModel,
      instructions: 'Use lookup.',
      tools: [lookup],
      provider,
      modelSettings: { toolChoice: 'auto', resetToolChoice: false },
    });
    await using original = await agent.session();
    const turn = await original.submit('lookup', {
      modelSettingsOverride: {
        toolChoice: toolRef('lookup'),
        resetToolChoice: true,
      },
    });
    const completion = turn.wait().catch((error: unknown) => error);
    await turn.wait({ until: 'manual_tool' });
    const state = JSON.parse(JSON.stringify(await original.suspend()));
    expect(await completion).toBeInstanceOf(InteractionRequired);
    await original.close();
    await using restored = await agent.session({ state });
    const pending = await restored.wait({ until: 'manual_tool' });
    if (!('requests' in pending))
      throw new Error('Expected a restored manual request');
    const request = lookup.match(pending.requests[0]);
    if (!request) throw new Error('Expected the captured lookup tool');
    await restored.respond(request.reply('accepted'));
    expect((await restored.restoredTurn!.wait()).finalOutput).toBe('done');
    await (await restored.submit('default')).wait();
    expect(
      server.requests.map((request) => request.tool_choice ?? 'auto'),
    ).toEqual(['required', 'auto', 'auto']);
    server.assertExhausted();
  },
);

nativeIt(
  'keeps a child retry policy after its parent result and a later root with another policy',
  async () => {
    const executor = await startPublicExecutor();
    const childEntered = Promise.withResolvers<void>();
    const releaseChild = Promise.withResolvers<void>();
    let rootId: string | undefined;
    let roots = 0;
    let children = 0;
    const server = new ModelServer(
      Array.from({ length: 5 }, () => async (body: JsonObject) => {
        const metadata = body.client_metadata as Record<string, string>;
        const id = String(
          JSON.parse(metadata['x-codex-turn-metadata']).thread_id,
        );
        rootId ??= id;
        if (id !== rootId) {
          children++;
          if (children === 1) {
            childEntered.resolve();
            await releaseChild.promise;
            return {
              status: 503,
              body: JSON.stringify({
                error: { message: 'synthetic retry', type: 'server_error' },
              }),
            };
          }
          return [message('child done')];
        }
        roots++;
        if (roots === 1)
          return [
            call(
              'spawn_agent',
              {
                task_name: 'research',
                message: 'Answer.',
                agent_type: 'research',
              },
              { namespace: 'collaboration', callId: 'spawn' },
            ),
          ];
        if (roots === 2) {
          await childEntered.promise;
          return [message('parent done')];
        }
        releaseChild.resolve();
        return [message('later root done')];
      }),
    );
    const config = await server.config();
    try {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          '--stack-size=16384',
          '--expose-gc',
          '--import',
          'tsx',
          fileURLToPath(
            new URL(
              './fixtures/run-model-settings-override-child-policy.ts',
              import.meta.url,
            ),
          ),
          JSON.stringify({
            baseUrl: (config['model_providers.fixture'] as { base_url: string })
              .base_url,
            initial: initialAgentModel,
            forced: forcedAgentModel,
            childDefault,
            executorUrl: executor.url,
            cwd: executor.cwd,
            headers: executor.headers,
          }),
        ],
        { env: process.env, timeout: 25_000 },
      );
      expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({
        firstCalls: 1,
        secondCalls: 0,
        output: 'child done',
      });
      expect(children).toBe(2);
      expect(roots).toBe(3);
      server.assertExhausted();
    } finally {
      releaseChild.resolve();
      await executor.close();
    }
  },
  30_000,
);

nativeIt(
  'captures one-shot forced settings before opening and preserves later defaults',
  async () => {
    const seen: JsonObject[] = [];
    await using provider = new NativeProvider({
      modelBackend: {
        complete(request) {
          seen.push(request.body);
          return completed([message('done')]);
        },
      },
    });
    const agent = new Agent({
      model: forcedModel,
      provider,
      instructions: 'Answer.',
      modelSettings: { maxOutputTokens: 10, metadata: { source: 'default' } },
    });
    const force = { maxOutputTokens: 33, metadata: { source: 'forced' } };
    const pending = agent.run('forced', { modelSettingsOverride: force });
    force.maxOutputTokens = 44;
    force.metadata.source = 'changed';
    expect((await pending).finalOutput).toBe('done');
    await agent.run('default');
    expect(
      seen.map(({ max_output_tokens, metadata }) => ({
        max_output_tokens,
        metadata,
      })),
    ).toEqual([
      { max_output_tokens: 33, metadata: { source: 'forced' } },
      { max_output_tokens: 10, metadata: { source: 'default' } },
    ]);
  },
);

nativeIt(
  'uses the captured run retry policy instead of the profile policy',
  async () => {
    const forcedPolicy = vi.fn((_context: unknown) => ({
      retry: true,
      delayMs: 0,
    }));
    const profilePolicy = vi.fn((_context: unknown) => ({ retry: false }));
    const failure = Object.assign(new Error('retryable'), {
      status: 503,
      code: 'server_error',
    });
    let attempts = 0;
    await using provider = new NativeProvider({
      modelBackend: {
        getRetryAdvice: () => ({ suggested: true }),
        complete() {
          attempts++;
          if (attempts !== 2) throw failure;
          return completed([message('done')]);
        },
      },
    });
    const agent = new Agent({
      model: forcedModel,
      provider,
      instructions: 'Answer.',
      modelSettings: { retry: { maxRetries: 1, policy: profilePolicy } },
    });
    expect(
      (
        await agent.run('forced', {
          modelSettingsOverride: {
            retry: { maxRetries: 1, policy: forcedPolicy },
          },
        })
      ).finalOutput,
    ).toBe('done');
    expect(forcedPolicy).toHaveBeenCalledOnce();
    expect(profilePolicy).not.toHaveBeenCalled();
    await expect(agent.run('default')).rejects.toBe(failure);
    expect(profilePolicy).toHaveBeenCalledOnce();
    expect(forcedPolicy).toHaveBeenCalledOnce();
    expect(attempts).toBe(3);
  },
);

nativeIt(
  'refuses a manual checkpoint for an unbound executable run retry policy',
  async () => {
    const lookup = manualTool({
      name: 'lookup',
      description: 'Retrieve.',
      parameters: z.object({}),
      result: z.string(),
    });
    await using provider = new NativeProvider({
      modelBackend: {
        complete: () => completed([call('lookup', {}, { callId: 'lookup' })]),
      },
    });
    await using session = await new Agent({
      model: forcedModel,
      provider,
      instructions: 'Use lookup.',
      tools: [lookup],
    }).session();
    const turn = await session.submit('lookup', {
      modelSettingsOverride: {
        retry: { maxRetries: 1, policy: () => ({ retry: true }) },
      },
    });
    const completion = turn.wait().catch((error: unknown) => error);
    await turn.wait({ until: 'manual_tool' });
    await expect(session.suspend()).rejects.toThrow(
      'executable run-local retry policy',
    );
    await session.close();
    await completion;
  },
);

nativeIt(
  'forces an explicit child role while later roots and children retain their declarations',
  async () => {
    const executor = await startPublicExecutor();
    let rootId: string | undefined;
    let rootRequests = 0;
    const childSeen = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    const seen: { child: boolean; phase: number; body: JsonObject }[] = [];
    const server = new ModelServer(
      Array.from({ length: 6 }, () => async (body: JsonObject) => {
        const metadata = body.client_metadata as Record<string, string>;
        const id = String(
          JSON.parse(metadata['x-codex-turn-metadata']).thread_id,
        );
        rootId ??= id;
        const child = id !== rootId;
        if (!child) rootRequests++;
        const phase = Math.floor((rootRequests - 1) / 2);
        seen.push({ child, phase, body });
        if (child) {
          childSeen[phase].resolve();
          return [message('child done')];
        }
        if (rootRequests % 2 === 1)
          return [
            call(
              'spawn_agent',
              {
                task_name: `research_${phase}`,
                message: 'Answer.',
                agent_type: 'research',
              },
              { namespace: 'collaboration', callId: `spawn-${phase}` },
            ),
          ];
        await childSeen[phase].promise;
        return [message('root done')];
      }),
    );
    const config = await server.config();
    try {
      await promisify(execFile)(
        process.execPath,
        [
          '--stack-size=16384',
          '--import',
          'tsx',
          fileURLToPath(
            new URL(
              './fixtures/run-model-settings-override-child.ts',
              import.meta.url,
            ),
          ),
          JSON.stringify({
            baseUrl: (config['model_providers.fixture'] as { base_url: string })
              .base_url,
            initial: initialAgentModel,
            forced: forcedAgentModel,
            childDefault,
            executorUrl: executor.url,
            cwd: executor.cwd,
            headers: executor.headers,
          }),
        ],
        { env: process.env, timeout: 25_000 },
      );
      expect(seen).toHaveLength(6);
      for (const { child, phase, body } of seen) {
        expect(body.model).toBe(
          phase === 0
            ? forcedAgentModel
            : child
              ? childDefault
              : initialAgentModel,
        );
        expect(body.reasoning).toMatchObject({
          effort: phase === 0 ? 'medium' : child ? 'high' : 'low',
        });
        expect(body.service_tier).toBe(phase === 0 ? undefined : 'flex');
      }
      expect(seen.filter(({ child }) => child)).toHaveLength(2);
      server.assertExhausted();
    } finally {
      await executor.close();
    }
  },
  30_000,
);

nativeIt(
  'forces captured settings through handoff and return while preserving profile defaults',
  async () => {
    const seen: JsonObject[] = [];
    await using provider = new NativeProvider({
      baseUrl: 'https://example.invalid/v1',
      supportsWebsockets: false,
      modelBackend: {
        complete(request) {
          seen.push(request.body);
          return completed(
            seen.length === 1
              ? [call('transfer_to_target', {}, { callId: 'to-target' })]
              : seen.length === 2
                ? [call('transfer_to_root', {}, { callId: 'to-root' })]
                : [message('done')],
          );
        },
      },
    });
    const root = new Agent({
      name: 'Root',
      model: initialModel,
      instructions: 'Transfer and return.',
      provider,
      modelSettings: {
        reasoningEffort: 'low',
        reasoningSummary: 'concise',
        maxOutputTokens: 10,
        metadata: { source: 'root' },
      },
    });
    const target = new Agent({
      name: 'Target',
      model: forcedModel,
      instructions: 'Return to Root.',
      handoffs: [root],
      modelSettings: {
        reasoningEffort: 'high',
        reasoningSummary: 'detailed',
        maxOutputTokens: 20,
        metadata: { source: 'target' },
      },
    });
    root.handoffs = [target];
    await using session = await root.session();
    const options = {
      modelOverride: forcedModel,
      modelSettingsOverride: {
        reasoningEffort: 'medium',
        maxOutputTokens: 33,
        metadata: null,
      },
    };
    expect(
      (await (await session.submit('transfer', options)).wait()).finalOutput,
    ).toBe('done');
    expect(seen.map((request) => request.model)).toEqual([
      forcedModel,
      forcedModel,
      forcedModel,
    ]);
    expect(seen.map((request) => request.max_output_tokens)).toEqual([
      33, 33, 33,
    ]);
    expect(seen.map((request) => request.reasoning)).toEqual([
      expect.objectContaining({ effort: 'medium', summary: 'concise' }),
      expect.objectContaining({ effort: 'medium', summary: 'detailed' }),
      expect.objectContaining({ effort: 'medium', summary: 'concise' }),
    ]);
    expect(seen.map((request) => request.metadata)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    await (await session.submit('another run')).wait();
    expect(seen.at(-1)).toMatchObject({
      model: initialModel,
      max_output_tokens: 10,
      reasoning: { effort: 'low' },
      metadata: { source: 'root' },
    });
    expect(root.modelSettings?.maxOutputTokens).toBe(10);
    expect(target.modelSettings?.maxOutputTokens).toBe(20);
  },
  30_000,
);

nativeIt(
  'retains forced settings through a manual checkpoint without changing later roots',
  async () => {
    const lookup = manualTool({
      name: 'lookup',
      description: 'Retrieve a record.',
      parameters: z.object({}),
      result: z.string(),
    });
    const seen: JsonObject[] = [];
    const policy = vi.fn((_context: unknown) => ({ retry: true, delayMs: 0 }));
    await using provider = new NativeProvider({
      baseUrl: 'https://example.invalid/v1',
      supportsWebsockets: false,
      modelBackend: {
        getRetryAdvice: () => ({ suggested: true }),
        complete(request) {
          seen.push(request.body);
          if (seen.length === 2)
            throw Object.assign(new Error('restored attempt'), {
              status: 503,
              code: 'server_error',
            });
          return completed(
            seen.length === 1
              ? [call('lookup', {}, { callId: 'lookup' })]
              : [message('done')],
          );
        },
      },
    });
    const agent = new Agent({
      model: initialModel,
      instructions: 'Use lookup.',
      tools: [lookup],
      provider,
      modelSettings: {
        reasoningEffort: 'low',
        maxOutputTokens: 10,
        retry: { maxRetries: 0, policy },
      },
    });
    await using original = await agent.session();
    const options = {
      modelOverride: forcedModel,
      modelSettingsOverride: {
        reasoningEffort: 'medium',
        maxOutputTokens: 33,
        retry: { maxRetries: 1 },
      },
    };
    const turn = await original.submit('lookup', options);
    const completion = turn.wait().catch((error: unknown) => error);
    await turn.wait({ until: 'manual_tool' });
    const state = JSON.parse(JSON.stringify(await original.suspend()));
    expect(await completion).toBeInstanceOf(InteractionRequired);
    await original.close();
    await using restored = await agent.session({ state });
    for await (const event of restored.events()) {
      if (event.type !== 'action_requested') continue;
      await restored.respond(event.reply('accepted'));
      break;
    }
    expect((await restored.restoredTurn!.wait()).finalOutput).toBe('done');
    await (await restored.submit('new default run')).wait();
    expect(seen.map((request) => request.max_output_tokens)).toEqual([
      33, 33, 33, 10,
    ]);
    expect(seen.map((request) => request.reasoning)).toEqual([
      ...Array.from({ length: 3 }, () =>
        expect.objectContaining({ effort: 'medium' }),
      ),
      expect.objectContaining({ effort: 'low' }),
    ]);
    expect(policy).toHaveBeenCalledOnce();
    expect(policy.mock.calls[0][0]).toMatchObject({ threadId: restored.id });
  },
  30_000,
);
