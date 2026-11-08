import { expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, tool, toolRef } from '../src';
import type { JsonObject } from '../src/runtime/binding';
import { ModelServer, call, message } from './native/fixtures/model-server';

function functionNames(request: JsonObject): string[] {
  const names: string[] = [];
  function visit(value: unknown) {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (item.type === 'namespace') visit(item.tools);
      else if (item.type === 'function') names.push(item.name);
    }
  }
  visit(request.tools);
  return names;
}

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');

nativeIt.each([false, true])(
  'keeps idle defaults separate from an explicit operation ceiling across handoff (explicit=%s)',
  async (explicit) => {
    const effects: string[] = [];
    const source = tool({
      name: 'source_lookup',
      parameters: z.object({}),
      execute: () => 'A',
    });
    const unused = tool({
      name: 'source_unused',
      parameters: z.object({}),
      execute: () => 'unused',
    });
    const destination = tool({
      name: 'destination_lookup',
      parameters: z.object({}),
      execute: () => {
        effects.push('B');
        return 'B result';
      },
    });
    const model = new ModelServer([
      (request) => {
        expect(functionNames(request)).toContain('source_lookup');
        expect(functionNames(request)).not.toContain('source_unused');
        expect(functionNames(request)).toContain('transfer_to_b');
        return [call('transfer_to_b', {}, { callId: 'handoff' })];
      },
      (request) => {
        expect(functionNames(request)).not.toContain('source_lookup');
        if (explicit) {
          expect(functionNames(request)).not.toContain('destination_lookup');
          return [message('done')];
        }
        expect(functionNames(request)).toContain('destination_lookup');
        return [call('destination_lookup', {}, { callId: 'destination' })];
      },
      ...(explicit ? [] : [[message('done')]]),
    ]);
    try {
      const config = await model.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-profile-defaults',
        supportsWebsockets: false,
      });
      const target = new Agent({
        name: 'B',
        instructions: 'Use B tools.',
        tools: [destination],
      });
      await using session = await new Agent({
        name: 'A',
        instructions: 'Transfer to B.',
        tools: [source, unused],
        handoffs: [target],
        provider,
      }).session();
      await session.update({ tools: [source] });
      const turn = await session.submit(
        'Handle this with B.',
        explicit ? { tools: [source, toolRef('transfer_to_b')] } : undefined,
      );
      expect((await turn.wait()).finalOutput).toBe('done');
      expect(await session.getActiveAgent()).toBe(target);
      expect(effects).toEqual(explicit ? [] : ['B']);
    } finally {
      await ModelServer.closeAll();
    }
  },
  30000,
);
