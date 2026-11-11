import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeProvider,
  manualTool,
  parseSessionState,
  tool,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

it('preserves settled child usage exactly once across its root manual checkpoint', async () => {
  let rootRequests = 0,
    childRequests = 0,
    effects = 0;
  const respond = (request: JsonObject) => {
    const meta = request.client_metadata as Record<string, string>;
    const { agent_name } = JSON.parse(meta['x-codex-turn-metadata']);
    if (agent_name === '/root') {
      rootRequests++;
      if (rootRequests === 1)
        return [
          call(
            'spawn_agent',
            { task_name: 'alpha', message: 'Use metered.' },
            { namespace: 'collaboration', callId: 'spawn' },
          ),
        ];
      if (rootRequests === 2)
        return [call('lookup', { key: 'A' }, { callId: 'root-manual' })];
      return [message('root complete')];
    }
    return ++childRequests === 1
      ? [call('metered', {}, { callId: 'child-meter' })]
      : [message('child complete')];
  };
  const server = new ModelServer(
    Array.from({ length: 5 }, () => respond),
    { input_tokens: 11, output_tokens: 3, total_tokens: 14 },
  );
  const metered = tool({
    name: 'metered',
    description: 'Report a measured child request.',
    parameters: z.object({}),
    execute(_args, context) {
      effects++;
      expect(context.submission.childId).toBeTruthy();
      context.reportUsage({
        inputTokens: 3,
        cachedInputTokens: 1,
        cacheWriteInputTokens: 0,
        outputTokens: 2,
        reasoningOutputTokens: 0,
        totalTokens: 5,
      });
      return 'known';
    },
  });
  const lookup = manualTool({
    name: 'lookup',
    description: 'Read a record.',
    parameters: z.object({ key: z.string() }),
    result: z.string(),
  });
  const executor = await startPublicExecutor();
  try {
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      instructions: 'Delegate then read lookup.',
      model: 'gpt-5.5',
      provider,
      tools: [new NativeAgents(), metered, lookup],
    });
    const environment = new Environment({
      url: executor.url,
      cwd: executor.cwd,
      headers: executor.headers,
      tools: ['exec_command', 'write_stdin', 'apply_patch'],
    });
    const source = await agent.session({ environment });
    const root = await source.submit('Begin');
    const boundary = await root.wait({ until: 'manual_tool' });
    if (!('requests' in boundary))
      throw new Error('Expected root manual boundary');
    const child = await vi.waitUntil(
      async () => {
        const rows = await Array.fromAsync(source.subagents());
        return rows[0]?.turn ?? false;
      },
      { timeout: 3000 },
    );
    const completed = await child.wait();
    expect(completed.runUsage).toMatchObject({ requests: 3, totalTokens: 33 });
    expect(root.runUsage).toMatchObject({ requests: 5, totalTokens: 61 });
    const saved = parseSessionState(JSON.stringify(await source.suspend()));
    await source.close();
    await using restored = await agent.session({ state: saved, environment });
    const continuation = restored.restoredTurn;
    if (!continuation) throw new Error('Expected continuation');
    const pending = await continuation.wait({ until: 'manual_tool' });
    if (!('requests' in pending))
      throw new Error('Expected restored manual boundary');
    const request = lookup.match(pending.requests[0]);
    if (!request) throw new Error('Expected exact manual request');
    await restored.respond(request.reply('answer'));
    const result = await continuation.wait();
    expect(result.runUsage).toMatchObject({ requests: 6, totalTokens: 75 });
    expect(effects).toBe(1);
    expect(completed.runUsage).toMatchObject({ requests: 3, totalTokens: 33 });
  } finally {
    await executor.close();
  }
}, 30000);
