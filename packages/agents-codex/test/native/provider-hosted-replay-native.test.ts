import { afterEach, expect, it, vi } from 'vitest';
import { Agent, NativeProvider } from '../../src';
import { ModelServer, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

for (const configured of [false, true]) {
  for (const kind of [
    'code_interpreter_call',
    'image_generation_call',
    'mcp_call',
  ]) {
    for (const phase of ['added', 'done', 'progress']) {
      it(`fences ${kind} ${phase} before ${configured ? 'configured' : 'default'} retry`, async () => {
        const item = {
          type: kind,
          id: 'provider-action',
          status: 'in_progress',
          name: 'mutate',
          server_label: 'remote',
          arguments: '{}',
        };
        const frames = [
          { type: 'response.created', response: { id: 'started' } },
          phase === 'progress'
            ? {
                type: `response.${kind}.in_progress`,
                item_id: item.id,
                output_index: 0,
              }
            : { type: `response.output_item.${phase}`, output_index: 0, item },
        ];
        const server = new ModelServer([
          {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
            body: frames
              .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
              .join(''),
          },
          [message('replayed')],
        ]);
        const config = await server.config();
        await using provider = new NativeProvider({
          baseUrl: (config['model_providers.fixture'] as { base_url: string })
            .base_url,
          apiKey: 'synthetic-hosted-retry',
          supportsWebsockets: false,
        });
        const policy = vi.fn(() => ({
          retry: true,
          delayMs: 0,
          approveUnsafeReplay: true,
        }));
        const agent = new Agent({
          model: 'gpt-5.5',
          instructions: 'Use the provider tool.',
          hostedPrompt: { id: 'pmpt_provider_tools' },
          provider,
          ...(configured
            ? {
                modelSettings: {
                  retry: {
                    maxRetries: 1,
                    backoff: { initialDelayMs: 0, jitter: false },
                    policy,
                  },
                },
              }
            : {}),
        });
        await expect(agent.run('run')).rejects.toThrow();
        expect(server.requests).toHaveLength(1);
        expect(policy).not.toHaveBeenCalled();
      }, 30_000);
    }
  }
  it.each(['none', 'file_search_call', 'web_search_call', 'reasoning'])(
    `retains ${configured ? 'configured' : 'default'} retry after %s without action evidence`,
    async (safeKind) => {
      const safeItem =
        safeKind === 'reasoning'
          ? { type: safeKind, id: 'read-only', summary: [] }
          : safeKind === 'web_search_call'
            ? {
                type: safeKind,
                id: 'read-only',
                status: 'completed',
                action: { type: 'search', query: 'A' },
              }
            : {
                type: safeKind,
                id: 'read-only',
                status: 'completed',
                results: [],
              };

      const server = new ModelServer([
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body:
            'data: {"type":"response.created","response":{"id":"before"}}\n\n' +
            (safeKind === 'none'
              ? ''
              : `data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: safeItem })}\n\n`),
        },
        [message('recovered')],
      ]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-hosted-retry',
        supportsWebsockets: false,
      });
      const agent = new Agent({
        model: 'gpt-5.5',
        instructions: 'Answer.',
        hostedPrompt: { id: 'pmpt_provider_tools' },
        provider,
        ...(configured
          ? {
              modelSettings: {
                retry: {
                  maxRetries: 1,
                  backoff: { initialDelayMs: 0, jitter: false },
                  policy: () => ({ retry: true, delayMs: 0 }),
                },
              },
            }
          : {}),
      });
      expect((await agent.run('run')).finalOutput).toBe('recovered');
      expect(server.requests).toHaveLength(2);
      server.assertExhausted();
    },
    30_000,
  );
}
