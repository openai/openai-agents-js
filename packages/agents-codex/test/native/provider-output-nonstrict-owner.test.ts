import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, type OutputSpec } from '../../src';
import { ModelServer, message } from './fixtures/model-server';
afterEach(() => ModelServer.closeAll());
it('sends provider-native strict false while preserving optional JSON fields and local validation', async () => {
  const server = new ModelServer([[message('{}')]]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-nonstrict-output',
    supportsWebsockets: false,
  });
  const output = {
    mode: 'native',
    schema: z.object({ label: z.string().optional() }),
    strict: false,
  } satisfies OutputSpec<{ label?: string }>;
  const result = await new Agent({
    model: 'fixture-nonstrict-output',
    instructions: 'Return JSON.',
    provider,
    outputType: output,
  }).run('Reply.');
  expect(result.finalOutput).toEqual({});
  expect(server.requests).toHaveLength(1);
  const text = server.requests[0].text as {
    format: { strict: boolean; schema: { required?: string[] } };
  };
  expect(text.format.strict).toBe(false);
  expect(text.format.schema.required ?? []).not.toContain('label');
  server.assertExhausted();
});
