import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeError,
  NativeProvider,
  realtimeHandoff,
  tool,
  toolRef,
} from '../src';
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
        expect(request.model).toBe('gpt-5.5');
        expect(request.max_output_tokens).toBe(41);
        expect(request.metadata).toEqual({ source: 'A' });
        expect(request.tool_choice).toBe('required');
        expect(functionNames(request)).toEqual(['transfer_to_b']);
        return [
          call('transfer_to_b', {}, { callId: 'profile-controls-handoff' }),
        ];
      },
      (request) => {
        expect(request.model).toBe('gpt-5.5');
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
        model: 'gpt-5.5',
        provider,
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
        model: 'gpt-5.5',
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

nativeIt.each(['root', 'destination', 'replacement', 'cleared'] as const)(
  'preserves captured terminal classification for %s',
  async (mode) => {
    const effects: string[] = [];
    const finish = (enabled: boolean) =>
      tool({
        name: 'finish',
        namespace: 'reports',
        parameters: z.object({}),
        finishTurn: enabled,
        execute: () => {
          effects.push('once');
          return 'tool finished';
        },
      });
    const expectedTerminal = mode !== 'cleared';
    const model = new ModelServer([
      ...(mode === 'destination'
        ? [[call('transfer_to_b', {}, { callId: 'profile-transfer' })]]
        : []),
      [call('finish', {}, { namespace: 'reports', callId: 'profile-finish' })],
      [message('ordinary continuation')],
    ]);
    try {
      const config = await model.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-profile-terminal',
        supportsWebsockets: false,
      });
      const target = new Agent({
        name: 'B',
        instructions: 'B',
        model: mode === 'destination' ? 'gpt-5.5' : 'gpt-5',
        provider,
        tools: mode === 'destination' ? [finish(true)] : [],
      });
      await using session = await new Agent({
        name: 'A',
        instructions: 'A',
        model: mode === 'destination' ? 'gpt-5.5' : 'gpt-5',
        provider,
        tools: mode === 'destination' ? [] : [finish(mode !== 'replacement')],
        handoffs: [target],
      }).session();
      if (mode === 'replacement' || mode === 'cleared')
        await session.update({ tools: [finish(mode === 'replacement')] });
      const result = await (await session.submit('Finish.')).wait();
      expect(result.finalOutput).toBe(
        expectedTerminal ? 'tool finished' : 'ordinary continuation',
      );
      if (expectedTerminal)
        expect(result.toolCall).toMatchObject({
          tool: { name: 'finish', namespace: 'reports' },
          callId: 'profile-finish',
          route: 'direct',
        });
      else expect(result.toolCall).toBeUndefined();
      expect(effects).toEqual(['once']);
      expect(model.requests).toHaveLength(
        (mode === 'destination' ? 2 : 1) + (expectedTerminal ? 0 : 1),
      );
    } finally {
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt(
  'applies sparse profile control updates and clears named choice/deadline explicitly',
  async () => {
    const model = new ModelServer([
      (request) => {
        expect(request.max_output_tokens).toBe(83);
        expect(request.temperature).toBe(0.2);
        expect(request.metadata).toEqual({ updated: 'yes' });
        expect(request.tool_choice).toBe('required');
        expect(functionNames(request)).toEqual(['new_tool']);
        return [message('updated')];
      },
      (request) => {
        expect(request).not.toHaveProperty('max_output_tokens');
        expect(request.temperature).toBe(0.2);
        expect(request.metadata).toEqual({ updated: 'yes' });
        expect(request.tool_choice ?? 'auto').toBe('auto');
        expect(functionNames(request)).toContain('old_tool');
        expect(functionNames(request)).toContain('new_tool');
        return [message('cleared')];
      },
    ]);
    try {
      const config = await model.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-profile-update',
        supportsWebsockets: false,
      });
      const target = new Agent({ name: 'B', instructions: 'B' });
      await using session = await new Agent({
        name: 'A',
        instructions: 'A',
        model: 'gpt-5',
        provider,
        handoffs: [target],
        tools: ['old_tool', 'new_tool'].map((name) =>
          tool({ name, parameters: z.object({}), execute: () => 'unused' }),
        ),
        modelSettings: {
          maxOutputTokens: 41,
          temperature: 0.2,
          invocationTimeoutMs: 10000,
          toolChoice: toolRef('old_tool'),
        },
      }).session();
      await session.update({
        modelSettings: {
          maxOutputTokens: 83,
          metadata: { updated: 'yes' },
          invocationTimeoutMs: 20000,
          toolChoice: toolRef('new_tool'),
        },
      });
      expect((await (await session.submit('First.')).wait()).finalOutput).toBe(
        'updated',
      );
      await session.update({
        modelSettings: {
          maxOutputTokens: null,
          invocationTimeoutMs: null,
          toolChoice: 'auto',
        },
      });
      expect((await (await session.submit('Second.')).wait()).finalOutput).toBe(
        'cleared',
      );
      const snapshots = (await session.saveState()).history.flatMap((row) => {
        const payload = row.payload;
        if (
          row.type !== 'event_msg' ||
          !payload ||
          typeof payload !== 'object' ||
          Array.isArray(payload) ||
          payload.type !== 'thread_settings_applied'
        )
          return [];
        return [payload.thread_settings as JsonObject];
      });
      expect(
        snapshots.some((settings) => settings.invocation_timeout_ms === 20000),
      ).toBe(true);
      expect(snapshots.at(-1)?.invocation_timeout_ms ?? null).toBeNull();
      model.assertExhausted();
    } finally {
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt(
  'enforces a deadline updated on the active captured profile',
  async () => {
    const model = new ModelServer([
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return [message('too late')];
      },
    ]);
    try {
      const config = await model.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-profile-updated-deadline',
        supportsWebsockets: false,
      });
      const target = new Agent({ name: 'B', instructions: 'B' });
      await using session = await new Agent({
        name: 'A',
        instructions: 'A',
        model: 'gpt-5',
        provider,
        handoffs: [target],
        modelSettings: { invocationTimeoutMs: 10000 },
      }).session();
      await session.update({ modelSettings: { invocationTimeoutMs: 300 } });
      const turn = await session.submit('Wait.');
      const error = await turn.wait().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(NativeError);
      expect(error).toMatchObject({
        code: 'model_invocation_deadline_exceeded',
      });
    } finally {
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt(
  'keeps handoff callbacks outside Code Mode while preserving direct handoffs',
  async () => {
    const effects: string[] = [];
    const model = new ModelServer([
      [
        {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'nested-handoffs',
          input:
            'text(await tools.lookup({})); try { await tools.route_b({}); } catch (error) { text(String(error)); } try { await tools.route_c({}); } catch (error) { text(String(error)); }',
        },
      ],
      () => {
        expect(effects).toEqual(['lookup']);
        return [call('route_b', {}, { callId: 'direct-handoff' })];
      },
      [message('done')],
    ]);
    try {
      const config = await model.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-profile-code-mode',
        supportsWebsockets: false,
      });
      const b = new Agent({
        name: 'B',
        instructions: 'Answer.',
        programmaticToolCalling: true,
      });
      const c = new Agent({
        name: 'C',
        instructions: 'Answer.',
        programmaticToolCalling: true,
      });
      await using session = await new Agent({
        name: 'A',
        instructions: 'Use lookup, then hand off.',
        provider,
        programmaticToolCalling: true,
        tools: [
          tool({
            name: 'lookup',
            parameters: z.object({}),
            execute: () => {
              effects.push('lookup');
              return 'lookup';
            },
          }),
        ],
        handoffs: [
          realtimeHandoff(b, {
            name: 'route_b',
            onHandoff: () => {
              effects.push('B');
            },
          }),
          realtimeHandoff(c, {
            name: 'route_c',
            onHandoff: () => {
              effects.push('C');
            },
          }),
        ],
      }).session();
      expect((await (await session.submit('run')).wait()).finalOutput).toBe(
        'done',
      );
      expect(effects).toEqual(['lookup', 'B']);
      expect(await session.getActiveAgent()).toBe(b);
      model.assertExhausted();
    } finally {
      await ModelServer.closeAll();
    }
  },
  35_000,
);
