import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, manualTool } from '../../src';
import { jsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it('delivers captured JSON transforms through live manual requests and completes their replies', async () => {
  const parse = vi.fn((value: string) => Number(value));
  const lookup = manualTool({
    name: 'lookup',
    description: 'Look up a value.',
    parameters: z.object({
      count: z.string().transform(parse),
      note: z.string().optional(),
      tags: z.array(z.string()).readonly(),
    }),
    result: z.string(),
  });
  const server = new ModelServer([
    [call('lookup', { count: '7', tags: ['a'] }, { callId: 'lookup' })],
    [message('done')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: jsonObject.parse(config['model_providers.fixture'])
      .base_url as string,
    apiKey: 'synthetic-json-manual',
    supportsWebsockets: false,
  });
  await using session = await new Agent({
    instructions: 'Use lookup once.',
    model: 'gpt-5',
    provider,
    tools: [lookup],
  }).session();
  const turn = await session.submit('Look up.');
  const batch = await turn.wait({ until: 'manual_tool' });
  if (!('requests' in batch)) throw new Error('Expected a manual request');
  const request = lookup.match(batch.requests[0]);
  if (!request) throw new Error('Expected lookup request');
  expect(request.arguments).toEqual({ count: 7, tags: ['a'] });
  expect(Object.hasOwn(request.arguments, 'note')).toBe(false);
  // The schema's readonly output stays readonly in types; each read is detached.
  const detached = request.arguments as { count: number; tags: string[] };
  detached.tags.push('changed');
  expect(request.arguments.tags).toEqual(['a']);
  expect(parse).toHaveBeenCalledTimes(1);
  await session.respond(request.reply('accepted'));
  expect((await turn.wait()).finalOutput).toBe('done');
  expect(parse).toHaveBeenCalledTimes(1);
  server.assertExhausted();
}, 20_000);
