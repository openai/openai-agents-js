import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Agent,
  Environment,
  InteractionRequired,
  NativeProvider,
  manualTool,
  tool,
  toolRef,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { isManualSessionState } from '../../src/runtime/state';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'retains an accepted transformed native result and typed manual subset without repeating its effect',
  async () => {
    const executor = await startPublicExecutor();
    try {
      const raw = 'synthetic-untransformed-selection-result';
      const encoded = Buffer.from(raw).toString('base64');
      const transformed = vi.fn((_info: unknown, value: unknown) => {
        expect(JSON.stringify(value)).toContain(raw);
        return { output: 'checked-native-result' };
      });
      const lookup = manualTool({
        name: 'lookup',
        description: 'Read a record.',
        parameters: z.strictObject({ key: z.string() }),
        result: z.string(),
      });
      const outputType = {
        mode: 'native' as const,
        schema: z.strictObject({ answer: z.string() }),
      };
      const server = new ModelServer([
        [
          call(
            'exec_command',
            {
              cmd: `printf effect >> effect.txt; printf '%s' '${encoded}' | base64 -d`,
            },
            { callId: 'native-effect' },
          ),
        ],
        [
          call('lookup', { key: 'A' }, { callId: 'native-manual-A' }),
          call('lookup', { key: 'B' }, { callId: 'native-manual-B' }),
        ],
        (request) => {
          expect(names(request)).toContain('exec_command');
          expect(names(request)).not.toContain('apply_patch');
          const outputs = (request.input as JsonObject[]).filter(
            (item) => item.type === 'function_call_output',
          );
          for (const id of [
            'native-effect',
            'native-manual-A',
            'native-manual-B',
          ])
            expect(outputs.filter((item) => item.call_id === id)).toHaveLength(
              1,
            );
          expect(
            outputs.find((item) => item.call_id === 'native-manual-A')!.output,
          ).toBe('accepted-A');
          expect(
            outputs.find((item) => item.call_id === 'native-manual-B')!.output,
          ).toBe('accepted-B');
          expect(JSON.stringify(outputs)).toContain('checked-native-result');
          expect(JSON.stringify(outputs)).not.toContain(raw);
          return [
            {
              type: 'custom_tool_call',
              name: 'apply_patch',
              call_id: 'excluded-patch',
              input:
                '*** Begin Patch\n*** Add File: forbidden.txt\n+must-not-exist\n*** End Patch',
            },
          ];
        },
        (request) => {
          const refused = (request.input as JsonObject[]).filter(
            (item) =>
              item.type === 'custom_tool_call_output' &&
              item.call_id === 'excluded-patch',
          );
          expect(refused).toHaveLength(1);
          expect(JSON.stringify(refused[0].output)).toContain(
            'unsupported custom tool call:',
          );
          expect(JSON.stringify(refused[0].output)).toContain('apply_patch');
          return [message('{"answer":"done"}')];
        },
      ]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-static-native-result',
        supportsWebsockets: false,
      });
      const environment = new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command', 'apply_patch'],
        transformResult: transformed,
      });
      const agent = new Agent({
        instructions: 'Run once and ask for both records.',
        model: 'gpt-5',
        provider,
        tools: [lookup],
        outputType,
      });
      await using source = await agent.session({ environment });
      const events = source.events()[Symbol.asyncIterator]();
      const turn = await source.submit('Run and read.', {
        tools: [lookup, toolRef('exec_command')],
      });
      const pending = [];
      try {
        while (pending.length < 2) {
          const next = await events.next();
          if (next.done) throw new Error('Expected pending manual calls');
          const request = lookup.match(next.value);
          if (request) pending.push(request);
        }
      } finally {
        await events.return?.();
      }
      const a = pending.find(
        (request) => request.callId === 'native-manual-A',
      )!;
      const b = pending.find(
        (request) => request.callId === 'native-manual-B',
      )!;
      const stale = b.reply('stale');
      await source.respond(a.reply('accepted-A'));
      const stopped = turn.wait().catch((error: unknown) => error);
      const state = await source.suspend();
      expect(await stopped).toBeInstanceOf(InteractionRequired);
      expect(state.kind).toBe('manual');
      expect(state.kind === 'manual' && state.operation_tools).toEqual([
        { name: 'lookup', namespace: 'functions' },
        { name: 'exec_command', namespace: 'functions' },
      ]);
      expect(JSON.stringify(state)).toContain('checked-native-result');
      expect(JSON.stringify(state)).not.toContain(raw);
      expect(await readFile(join(executor.cwd, 'effect.txt'), 'utf8')).toBe(
        'effect',
      );
      await source.close();
      await using restored = await agent.session({ state, environment });
      const currentEvents = restored.events()[Symbol.asyncIterator]();
      try {
        let current;
        for (;;) {
          const next = await currentEvents.next();
          if (next.done) throw new Error('Expected a fresh manual grant');
          const request = lookup.match(next.value);
          if (request) {
            current = request;
            break;
          }
        }
        expect(current.callId).toBe('native-manual-B');
        expect(current.turnId).toBe(turn.turnId);
        await expect(restored.respond(stale)).rejects.toThrow();
        await restored.respond(current.reply('accepted-B'));
        expect((await restored.wait()).finalOutput).toEqual({ answer: 'done' });
      } finally {
        await currentEvents.return?.();
      }
      expect(transformed).toHaveBeenCalledTimes(1);
      expect(await readFile(join(executor.cwd, 'effect.txt'), 'utf8')).toBe(
        'effect',
      );
      await expect(
        readFile(join(executor.cwd, 'forbidden.txt')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(
        executor.requests.filter(
          (request) => request.method === 'process/start',
        ),
      ).toHaveLength(1);
      const format = (server.requests[0].text as JsonObject).format;
      expect(format).toMatchObject({ type: 'json_schema', strict: true });
      for (const request of server.requests)
        expect((request.text as JsonObject).format).toEqual(format);
      server.assertExhausted();
    } finally {
      await executor.close();
    }
  },
  35_000,
);

function names(request: JsonObject) {
  const names: string[] = [];
  const add = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (entry.type === 'namespace') add(entry.tools);
      else if (entry.type === 'function' || entry.type === 'custom')
        names.push(entry.name);
    }
  };
  add(request.tools);
  if (Array.isArray(request.input))
    for (const item of request.input as JsonObject[])
      if (item.type === 'additional_tools') add(item.tools);
  return names.sort();
}

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'static selected checkpoint recovery',
  () => {
    it('restores a typed manual subset separately from defaults, retains transformed replies and never replays effects', async () => {
      let effects = 0;
      let excludedEffects = 0;
      const transform = vi.fn((value: number) => value * 10);
      const lookup = manualTool({
        name: 'lookup',
        description: 'Return a checked record.',
        parameters: z.object({ key: z.string() }),
        result: z.number().positive().transform(transform),
      });
      const record = tool({
        name: 'record',
        parameters: z.object({}),
        execute: () => {
          effects++;
          return 'committed-original';
        },
      });
      const excluded = tool({
        name: 'excluded',
        parameters: z.object({}),
        execute: () => {
          excludedEffects++;
          return 'must-not-run';
        },
      });
      const outputType = {
        mode: 'native' as const,
        schema: z.strictObject({ answer: z.string() }),
      };
      const server = new ModelServer([
        (request) => {
          expect(names(request)).toEqual(['lookup', 'record']);
          return [call('record', {}, { callId: 'original-effect' })];
        },
        [
          call('lookup', { key: 'A' }, { callId: 'manual-A' }),
          call('lookup', { key: 'B' }, { callId: 'manual-B' }),
        ],
        (request) => {
          expect(names(request)).toEqual(['lookup', 'record']);
          const outputs = (request.input as JsonObject[]).filter(
            (item) => item.type === 'function_call_output',
          );
          for (const id of ['original-effect', 'manual-A', 'manual-B'])
            expect(outputs.filter((item) => item.call_id === id)).toHaveLength(
              1,
            );
          expect(
            outputs.find((item) => item.call_id === 'manual-A')?.output,
          ).toBe('10');
          expect(
            outputs.find((item) => item.call_id === 'manual-B')?.output,
          ).toBe('20');
          return [call('excluded', {}, { callId: 'excluded-attempt' })];
        },
        [message('{"answer":"done"}')],
        (request) => {
          expect(names(request)).toEqual(['record']);
          return [message('{"answer":"defaults"}')];
        },
      ]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-static-selection',
        supportsWebsockets: false,
      });
      const declaration = {
        instructions:
          'Record once, ask for both records, and preserve checked results.',
        model: 'gpt-5',
        provider,
        tools: [record, lookup, excluded],
        outputType,
      };
      const agent = new Agent(declaration);
      await using source = await agent.session();
      // The selected manual tool is admitted but intentionally absent from defaults.
      await source.update({ tools: [record] });
      const turn = await source.submit('Read both.', {
        tools: [record, lookup],
      });
      const originalEvents = source.events()[Symbol.asyncIterator]();
      const requests = [];
      try {
        while (requests.length < 2) {
          const event = await originalEvents.next();
          if (event.done) throw new Error('Expected two held manual requests');
          const request = lookup.match(event.value);
          if (request) requests.push(request);
        }
      } finally {
        await originalEvents.return?.();
      }
      const a = requests.find((request) => request.callId === 'manual-A')!;
      const b = requests.find((request) => request.callId === 'manual-B')!;
      const stale = b.reply(2);
      await source.respond(a.reply(1));
      await expect
        .poll(() => source.checkpointStatus({ kind: 'manualWait' }), {
          timeout: 5000,
        })
        .toMatchObject({ status: 'ready' });
      const outcome = turn.wait().catch((error: unknown) => error);
      const saved = await source.suspend();
      expect(await outcome).toBeInstanceOf(InteractionRequired);
      expect(saved.kind).toBe('manual');
      expect(saved).toMatchObject({
        default_tools: [{ name: 'record', namespace: 'functions' }],
        operation_tools: [
          { name: 'record', namespace: 'functions' },
          { name: 'lookup', namespace: 'functions' },
        ],
      });
      if (!isManualSessionState(saved))
        throw new Error('Expected manual state');
      expect(
        saved.manual_continuation.pending_manual.map((call) => call.call_id),
      ).toEqual(['manual-B']);
      expect(transform).toHaveBeenCalledTimes(1);
      await source.close();

      await expect(
        new Agent({ ...declaration, tools: [lookup, excluded] }).session({
          state: saved,
        }),
      ).rejects.toThrow('matching current declarations');
      expect(server.requests).toHaveLength(2);
      expect(effects).toBe(1);
      expect(excludedEffects).toBe(0);

      await using restored = await agent.session({ state: saved });
      const events = restored.events()[Symbol.asyncIterator]();
      try {
        let current;
        for (;;) {
          const next = await events.next();
          if (next.done) throw new Error('Expected a fresh manual grant');
          const request = lookup.match(next.value);
          if (request) {
            current = request;
            break;
          }
        }
        expect(current.callId).toBe('manual-B');
        expect(current.turnId).toBe(turn.turnId);
        await expect(restored.respond(stale)).rejects.toThrow();
        expect(transform).toHaveBeenCalledTimes(1);
        await restored.respond(current.reply(2));
        expect((await restored.wait()).finalOutput).toEqual({ answer: 'done' });
        expect(transform).toHaveBeenCalledTimes(2);
        expect(effects).toBe(1);
        expect(excludedEffects).toBe(0);
        const idle = await restored.saveState();
        expect(idle.kind).toBe('idle');
        await restored.close();
        await using settled = await agent.session({ state: idle });
        expect(
          (await (await settled.submit('Use the persistent defaults.')).wait())
            .finalOutput,
        ).toEqual({ answer: 'defaults' });
        server.assertExhausted();
      } finally {
        await events.return?.();
      }
    }, 30_000);
  },
);
