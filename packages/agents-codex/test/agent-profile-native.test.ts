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
  if (Array.isArray(request.input)) {
    for (const item of request.input) {
      if (
        item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        item.type === 'additional_tools'
      )
        visit(item.tools);
    }
  }
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
        if (explicit) {
          expect(functionNames(request)).toContain('source_unused');
        } else {
          expect(functionNames(request)).not.toContain('source_unused');
        }
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
        explicit
          ? { tools: [source, unused, toolRef('transfer_to_b')] }
          : undefined,
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

nativeIt.each(['inherited', 'empty', 'nondefault'] as const)(
  'keeps profile defaults separate from an explicit beforeStep choice (%s)',
  async (selection) => {
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
    const model = new ModelServer([
      (request) => {
        const names = functionNames(request);
        expect(names.includes('source_lookup')).toBe(selection === 'inherited');
        expect(names.includes('source_unused')).toBe(
          selection === 'nondefault',
        );
        return [message('done')];
      },
    ]);
    try {
      const config = await model.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-profile-before-step',
        supportsWebsockets: false,
      });
      const target = new Agent({ name: 'B', instructions: 'Target profile.' });
      await using session = await new Agent({
        name: 'A',
        instructions: 'Source profile.',
        tools: [source, unused],
        handoffs: [target],
        provider,
      }).session();
      await session.update({ tools: [source] });
      const turn = await session.submit('Reply.', {
        beforeStep: () =>
          selection === 'inherited'
            ? undefined
            : selection === 'empty'
              ? []
              : [unused],
      });
      expect((await turn.wait()).finalOutput).toBe('done');
    } finally {
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt.each([false, true])(
  'replaces source model controls at handoff and persists the destination deadline (explicit=%s)',
  async (explicit) => {
    const model = new ModelServer([
      (request) => {
        expect(request.max_output_tokens).toBe(41);
        expect(request.metadata).toEqual({ source: 'A' });
        expect(request.tool_choice).toBe('required');
        expect(functionNames(request)).toEqual(['transfer_to_b']);
        return [
          call('transfer_to_b', {}, { callId: 'profile-controls-handoff' }),
        ];
      },
      (request) => {
        if (explicit) {
          expect(request.max_output_tokens).toBe(83);
          expect(request.top_p).toBe(0.75);
          expect(request.metadata).toEqual({ destination: 'B' });
          expect(request.tool_choice).toBe('none');
        } else {
          expect(request).not.toHaveProperty('max_output_tokens');
          expect(request).not.toHaveProperty('top_p');
          expect(request).not.toHaveProperty('metadata');
          expect(request.tool_choice ?? 'auto').toBe('auto');
        }
        return [message('destination finished')];
      },
    ]);
    try {
      const config = await model.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-profile-controls',
        supportsWebsockets: false,
      });
      const destination = new Agent({
        name: 'B',
        instructions: 'Answer after the handoff.',
        modelSettings: explicit
          ? {
              invocationTimeoutMs: 20000,
              maxOutputTokens: 83,
              topP: 0.75,
              metadata: { destination: 'B' },
              toolChoice: 'none',
            }
          : undefined,
      });
      await using session = await new Agent({
        name: 'A',
        instructions: 'Transfer to B.',
        model: 'fixture-unlisted-profile-controls',
        modelSettings: {
          invocationTimeoutMs: 10000,
          maxOutputTokens: 41,
          metadata: { source: 'A' },
          toolChoice: toolRef('transfer_to_b'),
        },
        handoffs: [destination],
        provider,
      }).session();
      expect(
        (await (await session.submit('Continue with B.')).wait()).finalOutput,
      ).toBe('destination finished');
      expect(await session.getActiveAgent()).toBe(destination);
      const state = await session.saveState();
      const snapshots = state.history.flatMap((row) => {
        const payload = row.payload;
        if (
          row.type !== 'event_msg' ||
          !payload ||
          typeof payload !== 'object' ||
          Array.isArray(payload) ||
          payload.type !== 'thread_settings_applied'
        )
          return [];
        const settings = payload.thread_settings;
        return settings &&
          typeof settings === 'object' &&
          !Array.isArray(settings)
          ? [settings]
          : [];
      });
      expect(snapshots.length).toBeGreaterThan(0);
      expect(snapshots.at(-1)?.invocation_timeout_ms ?? null).toBe(
        explicit ? 20000 : null,
      );
      model.assertExhausted();
    } finally {
      await ModelServer.closeAll();
    }
  },
  30000,
);
