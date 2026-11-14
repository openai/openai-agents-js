import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import {
  Agent,
  NativeProvider,
  imageGeneration,
  parseSessionState,
  toolRef,
  webSearch,
} from '../../src';
import { captureAgentProfiles } from '../../src/runtime/public-agent';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it('keeps exact ImageGeneration settings with its profile across hot selection, cold restore and return', async () => {
  const standalone = webSearch({ route: 'standalone' });
  const standaloneTarget = new Agent({
    name: 'standalone_target',
    instructions: 'Keep common standalone search.',
    tools: [standalone, imageGeneration({ quality: 'low' })],
  });
  const standaloneRoot = new Agent({
    instructions: 'Keep common standalone search.',
    tools: [standalone],
    handoffs: [standaloneTarget],
  });
  const captured = captureAgentProfiles(standaloneRoot);
  expect(
    captured.every((profile) => profile.scopedHostedSearch === undefined),
  ).toBe(true);
  expect(captured[1]!.scopedHostedImageGeneration).toHaveLength(1);

  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
  const image = (id: string) => ({
    type: 'image_generation_call',
    id,
    status: 'completed',
    result: png,
  });
  const server = new ModelServer([
    [call('transfer_to_target', {}, { callId: 'image-scope-out' })],
    [image('provider-image-hot'), message('target complete')],
    [image('provider-image-cold'), message('selected image complete')],
    [message('image omitted')],
    [call('transfer_to_source', {}, { callId: 'image-scope-back' })],
    [message('source complete')],
  ]);
  await using provider = new NativeProvider({
    baseUrl: `http://127.0.0.1:${await server.port()}/v1`,
    apiKey: 'synthetic-image-scope',
    supportsWebsockets: false,
  });
  const graph = (quality: 'low' | 'high') => {
    const target = new Agent({
      name: 'target',
      instructions: 'Target owns provider images.',
      tools: [
        imageGeneration({ quality, outputFormat: 'png', size: '1024x1024' }),
      ],
      handoffs: [() => source],
    });
    const source: Agent<undefined, unknown> = new Agent({
      name: 'source',
      instructions: 'Source has no image grant.',
      provider,
      model: 'gpt-5.5',
      tools: [],
      handoffs: [target],
    });
    return { source, target };
  };
  const { source, target } = graph('low');
  let state;
  {
    await using session = await source.session();
    expect((await (await session.submit('Transfer.')).wait()).finalOutput).toBe(
      'target complete',
    );
    expect(await session.getActiveAgent()).toBe(target);
    const serialized = JSON.stringify(await session.saveState());
    expect(serialized).toContain('provider-image-hot');
    state = parseSessionState(serialized, {
      expectedSha256: createHash('sha256').update(serialized).digest('hex'),
    });
  }
  const changed = graph('high');
  await expect(changed.source.session({ state })).rejects.toThrow(
    /declaration|captured|fingerprint|Agent/i,
  );
  expect(server.requests).toHaveLength(2);
  {
    await using restored = await source.session({ state });
    expect(await restored.getActiveAgent()).toBe(target);
    expect(
      (
        await (
          await restored.submit('Only the captured image tool.', {
            tools: [toolRef('image_generation')],
            modelSettingsOverride: { toolChoice: { type: 'image_generation' } },
          })
        ).wait()
      ).finalOutput,
    ).toBe('selected image complete');
    expect(
      (await (await restored.submit('Omit every tool.', { tools: [] })).wait())
        .finalOutput,
    ).toBe('image omitted');
    expect((await (await restored.submit('Return.')).wait()).finalOutput).toBe(
      'source complete',
    );
    expect(await restored.getActiveAgent()).toBe(source);
  }
  const offered = (request: JsonObject) =>
    (request.tools as JsonObject[]).filter(
      (tool) => tool.type === 'image_generation',
    );
  expect(server.requests).toHaveLength(6);
  for (const request of [
    server.requests[0]!,
    server.requests[3]!,
    server.requests[5]!,
  ])
    expect(offered(request)).toEqual([]);
  for (const request of [
    server.requests[1]!,
    server.requests[2]!,
    server.requests[4]!,
  ])
    expect(offered(request)).toEqual([
      {
        type: 'image_generation',
        quality: 'low',
        output_format: 'png',
        size: '1024x1024',
      },
    ]);
  expect(server.requests[2]!.tools).toHaveLength(1);
  expect(server.requests[2]!.tool_choice).toEqual({ type: 'image_generation' });
  expect(server.requests[3]!.tools).toEqual([]);
  server.assertExhausted();
}, 30000);
