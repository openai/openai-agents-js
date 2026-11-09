import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, ToolOutput, tool } from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
afterEach(() => ModelServer.closeAll());
it('keeps remote user and tool images on actual requests and restore without fetching', async () => {
  const fetches: string[] = [];
  const images = createServer((request, response) => {
    fetches.push(request.url ?? '');
    response.writeHead(500).end('No image fetch is authorized by this fixture');
  });
  images.listen(0, '127.0.0.1');
  await once(images, 'listening');
  try {
    const address = images.address() as { port: number };
    const imageUrl = `http://127.0.0.1:${address.port}/image.png?opaque=preserved`;
    const model = new ModelServer([
      [call('picture', {}, { callId: 'remote-image-call' })],
      [message('accepted')],
      [message('restored')],
    ]);
    const config = await model.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-remote-image',
      supportsWebsockets: false,
    });
    const effects: string[] = [];
    const agent = new Agent({
      model: 'gpt-5',
      instructions: 'Use picture once.',
      provider,
      tools: [
        tool({
          name: 'picture',
          parameters: z.object({}),
          execute: () => {
            effects.push('once');
            return new ToolOutput([
              { type: 'inputImage', imageUrl, detail: 'high' },
            ]);
          },
        }),
      ],
    });
    const part = {
      type: 'input_image' as const,
      image_url: imageUrl,
      detail: 'high' as const,
    };
    let state;
    {
      await using session = await agent.session();
      expect(
        (await (await session.submit({ role: 'user', content: [part] })).wait())
          .finalOutput,
      ).toBe('accepted');
      state = await session.saveState();
    }
    {
      await using restored = await agent.session({ state });
      expect(
        (
          await (
            await restored.submit('Continue without calling picture.')
          ).wait()
        ).finalOutput,
      ).toBe('restored');
    }
    expect(model.requests[0].input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.arrayContaining([part]),
        }),
      ]),
    );
    for (const request of model.requests.slice(1)) {
      expect(request.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.arrayContaining([part]),
          }),
        ]),
      );
      expect(request.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'function_call_output',
            call_id: 'remote-image-call',
            output: [part],
          }),
        ]),
      );
    }
    expect(model.requests).toHaveLength(3);
    expect(effects).toEqual(['once']);
    expect(fetches).toEqual([]);
    model.assertExhausted();
  } finally {
    await new Promise<void>((resolve, reject) =>
      images.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 30_000);
