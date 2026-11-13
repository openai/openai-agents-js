import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { Agent, NativeProvider } from '../../src';
import { ModelServer, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it('identifies the JavaScript SDK and its package version on native model requests', async () => {
  const server = new ModelServer([[message('first')], [message('second')]]);
  const config = await server.config();
  const version = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ).version;
  // Repeated providers have been exercising the same process identity.
  for (const answer of ['first', 'second']) {
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-request-identity-key',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      instructions: 'Reply.',
      model: 'gpt-5',
      provider,
    });
    expect((await agent.run('Reply.')).finalOutput).toBe(answer);
  }
  server.assertExhausted();
  for (const headers of server.requestHeaders) {
    expect(headers.originator).toBe('openai_agents_js');
    expect(headers['user-agent']?.split(' ', 1)[0]).toBe(
      `openai_agents_js/${version}`,
    );
    expect(headers['user-agent']).not.toContain('codex_cli_rs/0.0.0');
  }
});
