import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, parseSessionState } from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

function transport(route: string) {
  return {
    extraHeaders: { 'x-profile-route': `${route}-header` },
    extraQuery: { profile: `${route}-query` },
  };
}

it.each(['saveState', 'fork'] as const)(
  'keeps Agent transport out of %s and restores the current Worker route',
  async (capture) => {
    const model = new ModelServer([
      [call('transfer_to_worker', {}, { callId: 'handoff' })],
      [message('worker answer')],
      [message('updated worker answer')],
      [message('restored worker answer')],
    ]);
    const routes: (string | null)[] = [];
    model.onRecord = (phase, detail) => {
      if (phase === 'MODEL_REQUEST') {
        const { path } = detail as { path: string };
        routes.push(
          new URL(path, 'http://loopback.invalid').searchParams.get('profile'),
        );
      }
    };
    const config = await model.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-profile-transport-fixture',
      supportsWebsockets: false,
    });
    function graph(prefix: string) {
      const worker = new Agent({
        name: 'Worker',
        instructions: 'Answer after the handoff.',
        model: 'gpt-5.5',
        modelSettings: transport(`${prefix}-worker`),
        provider,
      });
      return new Agent({
        name: 'Root',
        instructions: 'Hand off to Worker.',
        model: 'gpt-5.5',
        modelSettings: transport(`${prefix}-root`),
        handoffs: [worker],
        provider,
      });
    }

    await using initial = await graph('synthetic-source').session();
    expect((await (await initial.submit('Start.')).wait()).finalOutput).toBe(
      'worker answer',
    );
    await initial.update({
      modelSettings: transport('synthetic-source-update'),
    });
    expect(
      (await (await initial.submit('Use the update.')).wait()).finalOutput,
    ).toBe('updated worker answer');
    const checkpoint = await initial[capture]();
    const encoded = JSON.stringify(checkpoint);
    expect(encoded).not.toContain('synthetic-source');
    await initial.close();

    let restoredJson = encoded;
    if (capture === 'fork') {
      let modified = 0;
      restoredJson = JSON.stringify(checkpoint, (key, value: unknown) => {
        if (key !== 'sdk_agent_profile') return value;
        const profile = z
          .object({ model: z.record(z.string(), z.unknown()) })
          .passthrough()
          .parse(value);
        const controls = z
          .record(z.string(), z.unknown())
          .parse(profile.model.request_controls ?? {});
        controls.request_transport = {
          headers: { 'x-profile-route': 'synthetic-stored-header' },
          query: { profile: 'synthetic-stored-query' },
        };
        profile.model.request_controls = controls;
        modified += 1;
        return profile;
      });
      expect(modified).toBeGreaterThan(0);
    }
    await using restored = await graph('synthetic-destination').session({
      state: parseSessionState(restoredJson),
    });
    expect(
      (await (await restored.submit('Continue.')).wait()).finalOutput,
    ).toBe('restored worker answer');
    expect(JSON.stringify(await restored.saveState())).not.toContain(
      'synthetic-destination',
    );
    expect(
      model.requestHeaders.map((headers) => headers['x-profile-route']),
    ).toEqual([
      'synthetic-source-root-header',
      'synthetic-source-worker-header',
      'synthetic-source-update-header',
      'synthetic-destination-worker-header',
    ]);
    expect(routes).toEqual([
      'synthetic-source-root-query',
      'synthetic-source-worker-query',
      'synthetic-source-update-query',
      'synthetic-destination-worker-query',
    ]);
    model.assertExhausted();
  },
  30000,
);
