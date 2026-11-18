import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, hostedMcp, manualTool, tool } from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { readCheckpointSelections } from '../../src/runtime/state';
import { ModelServer, call, message } from './fixtures/model-server';

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-idle-tools',
    supportsWebsockets: false,
  });
}

function declarations(request: JsonObject): JsonObject[] {
  return (request.tools as JsonObject[]).filter(
    (entry) => entry.type === 'function',
  );
}

afterEach(() => ModelServer.closeAll());

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'idle checkpoint tools',
  () => {
    it.each([
      'description',
      'strict',
      'schema',
      'addition',
      'removal',
      'callback',
    ])(
      'uses current local functions after %s changes and retains historical effects',
      async (change) => {
        const originalEffect = vi.fn(() => 'original-result');
        const currentEffect = vi.fn(() => 'current-result');
        const original = tool({
          name: 'lookup',
          description: 'Original lookup.',
          strict: true,
          parameters: z.object({ key: z.string() }),
          execute: originalEffect,
        });
        const current =
          change === 'schema'
            ? tool({
                name: 'lookup',
                description: 'Original lookup.',
                strict: true,
                parameters: z.object({ value: z.number() }),
                execute: currentEffect,
              })
            : tool({
                name: 'lookup',
                description:
                  change === 'description'
                    ? 'Current lookup.'
                    : 'Original lookup.',
                strict: change !== 'strict',
                parameters: z.object({ key: z.string() }),
                execute: currentEffect,
              });
        const added = tool({
          name: 'added',
          parameters: z.object({}),
          execute: currentEffect,
        });
        const currentTools =
          change === 'removal'
            ? []
            : change === 'addition'
              ? [current, added]
              : [current];
        const server = new ModelServer([
          [call('lookup', { key: 'saved' }, { callId: 'saved-effect' })],
          [message('saved answer')],
          ...(change === 'removal'
            ? []
            : [
                [
                  call(
                    change === 'addition' ? 'added' : 'lookup',
                    change === 'schema'
                      ? { value: 7 }
                      : change === 'addition'
                        ? {}
                        : { key: 'fresh' },
                    { callId: 'current-effect' },
                  ),
                ],
              ]),
          [message('current answer')],
          [message('restored twice')],
        ]);
        await using provider = await providerFor(server);
        const config = {
          instructions: 'Use the available tools.',
          model: 'gpt-5',
          provider,
        };
        await using source = await new Agent({
          ...config,
          tools: [original],
        }).session();
        await (await source.submit('remember this conversation')).wait();
        const saved = await source.saveState();
        const supplied = JSON.stringify(saved);
        await source.close();
        const changed = new Agent({ ...config, tools: currentTools });
        await using restored = await changed.session({ state: saved });
        expect(restored.id).toBe(saved.source_session_id);
        expect(
          (await (await restored.submit('continue')).wait()).finalOutput,
        ).toBe('current answer');
        const savedAgain = await restored.saveState();
        expect(JSON.stringify(saved)).toBe(supplied);
        for (const item of saved.history.filter(
          (entry) => entry.type === 'response_item',
        ))
          expect(savedAgain.history).toContainEqual(item);
        const specs = declarations(server.requests[2]);
        expect(specs.map((entry) => entry.name)).toEqual(
          currentTools.map((entry) => entry.name),
        );
        if (change === 'description')
          expect(specs[0].description).toBe('Current lookup.');
        if (change === 'strict') expect(specs[0].strict ?? false).toBe(false);
        if (change === 'schema')
          expect((specs[0].parameters as JsonObject).properties).toHaveProperty(
            'value',
          );
        expect(JSON.stringify(server.requests[2].input)).toContain(
          'original-result',
        );
        expect(originalEffect).toHaveBeenCalledTimes(1);
        expect(currentEffect).toHaveBeenCalledTimes(
          change === 'removal' ? 0 : 1,
        );
        await restored.close();
        await using twice = await changed.session({ state: savedAgain });
        expect((await (await twice.submit('again')).wait()).finalOutput).toBe(
          'restored twice',
        );
        expect((await twice.saveState()).managed_tool_specs).toEqual(
          savedAgain.managed_tool_specs,
        );
        server.assertExhausted();
      },
      30_000,
    );

    it.each([false, true])(
      'retains explicit selections when all selected tools have been removed: %s',
      async (allRemoved) => {
        const make = (name: string, description = name) =>
          tool({
            name,
            description,
            parameters: z.object({}),
            execute: () => name,
          });
        const a = make('a'),
          b = make('b'),
          retired = make('retired'),
          excluded = make('excluded');
        const server = new ModelServer([[message('selected')]]);
        await using provider = await providerFor(server);
        const config = {
          instructions: 'Use selected tools.',
          model: 'gpt-5',
          provider,
        };
        await using source = await new Agent({
          ...config,
          tools: [a, b, retired, excluded],
        }).session();
        await source.update({
          tools: allRemoved ? [retired] : [b, retired, a],
        });
        const saved = await source.saveState();
        await source.close();
        const changed = new Agent({
          ...config,
          tools: [make('a', 'new'), make('added'), make('b', 'new'), excluded],
        });
        await using restored = await changed.session({ state: saved });
        await (await restored.submit('use defaults')).wait();
        expect(
          declarations(server.requests[0]).map((entry) => entry.name),
        ).toEqual(allRemoved ? [] : ['b', 'a']);
        expect(
          readCheckpointSelections(await restored.saveState()).default_tools,
        ).toEqual(
          allRemoved
            ? []
            : [
                { name: 'b', namespace: 'functions' },
                { name: 'a', namespace: 'functions' },
              ],
        );
        const forged = structuredClone(saved);
        Object.assign(forged, {
          default_tools: [{ name: 'never-admitted', namespace: 'functions' }],
        });
        await expect(changed.session({ state: forged })).rejects.toThrow(
          'matching current declarations',
        );
        server.assertExhausted();
      },
      30_000,
    );

    it('keeps fork lineage strict after restoring and saving the fork again', async () => {
      const original = tool({
        name: 'lookup',
        parameters: z.object({}),
        execute: () => 'original',
      });
      const changed = tool({
        name: 'lookup',
        description: 'Changed.',
        parameters: z.object({}),
        execute: () => 'current',
      });
      const server = new ModelServer([]);
      await using provider = await providerFor(server);
      const config = { instructions: 'Answer.', model: 'gpt-5', provider };
      const agent = new Agent({ ...config, tools: [original] });
      await using source = await agent.session();
      const fork = await source.fork();
      const changedAgent = new Agent({ ...config, tools: [changed] });
      await expect(changedAgent.session({ state: fork })).rejects.toThrow(
        'matching managed tools',
      );
      await using restored = await agent.session({ state: fork });
      const savedAgain = await restored.saveState();
      await restored.close();
      await expect(changedAgent.session({ state: savedAgain })).rejects.toThrow(
        'matching managed tools',
      );
      expect(server.requests).toHaveLength(0);
    }, 30_000);

    it.each(['hosted', 'namespace'])(
      'keeps a mixed %s catalog on exact declaration matching',
      async (kind) => {
        const lookup = tool({
          name: 'lookup',
          parameters: z.object({}),
          execute: () => 'original',
        });
        const boundary =
          kind === 'hosted'
            ? hostedMcp({ serverLabel: 'boundary' })
            : tool({
                name: 'boundary',
                namespace: 'qualified',
                parameters: z.object({}),
                execute: () => 'boundary',
              });
        const server = new ModelServer([]);
        await using provider = await providerFor(server);
        const config = { instructions: 'Answer.', model: 'gpt-5', provider };
        await using source = await new Agent({
          ...config,
          tools: [lookup, boundary],
        }).session();
        const saved = await source.saveState();
        await source.close();
        await expect(
          new Agent({ ...config, tools: [] }).session({ state: saved }),
        ).rejects.toThrow('matching managed tools');
        expect(server.requests).toHaveLength(0);
      },
      30_000,
    );

    it('keeps a producing Agent graph on its existing restore boundary', async () => {
      const lookup = tool({
        name: 'lookup',
        parameters: z.object({}),
        execute: () => 'original',
      });
      const server = new ModelServer([[message('graph answer')]]);
      await using provider = await providerFor(server);
      const target = new Agent({
        name: 'target',
        instructions: 'Target.',
        model: 'gpt-5.5',
      });
      const config = {
        name: 'root',
        instructions: 'Answer.',
        model: 'gpt-5.5',
        provider,
      };
      const agent = new Agent({
        ...config,
        tools: [lookup],
        handoffs: [target],
      });
      await using source = await agent.session();
      await (await source.submit('answer')).wait();
      const saved = await source.saveState();
      await source.close();
      await expect(
        new Agent({ ...config, tools: [] }).session({ state: saved }),
      ).rejects.toThrow();
      expect(server.requests).toHaveLength(1);
      server.assertExhausted();
    }, 30_000);

    it('keeps pending manual declarations exact before publishing another request', async () => {
      const lookup = manualTool({
        name: 'lookup',
        description: 'Original.',
        parameters: z.object({}),
        result: z.string(),
      });
      const server = new ModelServer([
        [call('lookup', {}, { callId: 'pending' })],
      ]);
      await using provider = await providerFor(server);
      const config = { instructions: 'Read.', model: 'gpt-5', provider };
      await using source = await new Agent({
        ...config,
        tools: [lookup],
      }).session();
      await source.submit('read');
      for await (const event of source.events()) {
        if (lookup.match(event)) break;
      }
      const saved = await source.suspend();
      await source.close();
      const changed = manualTool({
        name: 'lookup',
        description: 'Changed.',
        parameters: z.object({}),
        result: z.string(),
      });
      await expect(
        new Agent({ ...config, tools: [changed] }).session({ state: saved }),
      ).rejects.toThrow('matching pending tools');
      expect(server.requests).toHaveLength(1);
    }, 30_000);

    it('rejects unknown saved declaration authority before model dispatch', async () => {
      const lookup = tool({
        name: 'lookup',
        parameters: z.object({}),
        execute: () => 'current',
      });
      const server = new ModelServer([]);
      await using provider = await providerFor(server);
      const config = { instructions: 'Answer.', model: 'gpt-5', provider };
      await using source = await new Agent({
        ...config,
        tools: [lookup],
      }).session();
      const saved = await source.saveState();
      await source.close();
      const specs = saved.managed_tool_specs as JsonObject[];
      Object.assign(specs[0], {
        untrusted_authority: true,
      });
      await expect(
        new Agent({ ...config, tools: [] }).session({ state: saved }),
      ).rejects.toThrow('unknown fields');
      expect(server.requests).toHaveLength(0);
    }, 30_000);
  },
);
