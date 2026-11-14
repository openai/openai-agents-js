import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, tool, type Completed } from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());
async function provider(server: ModelServer, source: string) {
  return new NativeProvider({
    baseUrl: `http://127.0.0.1:${await server.port()}/v1`,
    apiKey: `synthetic-nested-items-${source}`,
    supportsWebsockets: false,
  });
}
it.each([false, true])(
  'retains detached per-level items only when nested extraction requests them (%s)',
  async (returnItems) => {
    const sharedCall = 'same-provider-call';
    const rootModel = new ModelServer([
      [call('nested_child', { input: 'child' }, { callId: sharedCall })],
      [message('root complete')],
    ]);
    const childModel = new ModelServer([
      [call('nested_leaf', { input: 'leaf' }, { callId: sharedCall })],
      [message('child complete')],
    ]);
    const leafModel = new ModelServer([
      [call('leaf_effect', {}, { callId: sharedCall })],
      [message('leaf complete')],
    ]);
    await using rootProvider = await provider(rootModel, 'root');
    await using childProvider = await provider(childModel, 'child');
    await using leafProvider = await provider(leafModel, 'leaf');
    let effects = 0;
    const extracted: { source: string; result: Completed<string> }[] = [];
    const leaf = new Agent({
      name: 'Leaf',
      instructions: 'Use leaf_effect.',
      provider: leafProvider,
      model: 'gpt-5.5',
      tools: [
        tool({
          name: 'leaf_effect',
          parameters: z.object({}),
          execute: () => {
            effects++;
            return 'leaf effect output';
          },
        }),
      ],
    });
    const child = new Agent({
      name: 'Child',
      instructions: 'Use nested_leaf.',
      provider: childProvider,
      model: 'gpt-5.5',
      tools: [
        leaf.asTool({
          toolName: 'nested_leaf',
          ...(returnItems ? { returnItems } : {}),
          customOutputExtractor(result) {
            extracted.push({ source: 'leaf', result });
            return result.finalOutput;
          },
        }),
      ],
    });
    const root = new Agent({
      name: 'Root',
      instructions: 'Use nested_child.',
      provider: rootProvider,
      model: 'gpt-5.5',
      tools: [
        child.asTool({
          toolName: 'nested_child',
          ...(returnItems ? { returnItems } : {}),
          customOutputExtractor(result) {
            extracted.push({ source: 'child', result });
            return result.finalOutput;
          },
        }),
      ],
    });
    const result = await root.run('start', { returnItems: true });
    expect(result.finalOutput).toBe('root complete');
    expect(result.items?.map(({ item }) => item.type)).toEqual([
      'function_call',
      'function_call_output',
      'message',
    ]);
    expect(
      result.items
        ?.filter((entry) => entry.toolOrigin)
        .map((entry) => entry.toolOrigin),
    ).toEqual([
      { name: 'nested_child', role: 'Child' },
      { name: 'nested_child', role: 'Child' },
    ]);
    expect(extracted.map(({ source }) => source)).toEqual(['leaf', 'child']);
    for (const entry of extracted) {
      if (!returnItems) {
        expect(entry.result.items).toBeUndefined();
        continue;
      }
      expect(entry.result.items).toBeDefined();
      expect(entry.result.items?.map(({ item }) => item.type)).toEqual([
        'function_call',
        'function_call_output',
        'message',
      ]);
      const agent = entry.source === 'leaf' ? leaf : child;
      expect(entry.result.items?.every((item) => item.agent === agent)).toBe(
        true,
      );
      expect(
        entry.result.items?.every(
          ({ item }) => item.turnId === entry.result.turn.turnId,
        ),
      ).toBe(true);
      expect(
        entry.result.items
          ?.filter((item) => item.toolOrigin)
          .map((item) => item.toolOrigin),
      ).toEqual(
        entry.source === 'child'
          ? [
              { name: 'nested_leaf', role: 'Leaf' },
              { name: 'nested_leaf', role: 'Leaf' },
            ]
          : [],
      );
    }
    expect(result.runUsage.requests).toBe(6);
    expect(extracted.map(({ result }) => result.runUsage.requests)).toEqual([
      2, 4,
    ]);
    expect(effects).toBe(1);
    if (returnItems) {
      const detached = extracted.find(
        ({ source }) => source === 'child',
      )!.result;
      const original = JSON.stringify(
        detached.items!.map(({ item }) => item.data),
      );
      const replayModel = new ModelServer([
        [message('read child result')],
        [
          call(
            'nested_leaf',
            { input: 'replay cannot execute' },
            { callId: sharedCall },
          ),
        ],
      ]);
      await using replayProvider = await provider(replayModel, 'reader');
      const reader = new Agent({
        provider: replayProvider,
        model: 'gpt-5.5',
        instructions: 'Read imported data without old tool authority.',
        tools: [],
      });
      await using fresh = await reader.session();
      const empty = await fresh.historySnapshot();
      const items = (JSON.parse(original) as Record<string, unknown>[]).map(
        (item, index) => ({ ...item, id: `nested_import_${index}` }),
      );
      await fresh.transactHistory({
        expectedRevision: empty.revision,
        keep: 0,
        items,
      });
      expect(
        (await (await fresh.submit('Read the child result.')).wait())
          .finalOutput,
      ).toBe('read child result');
      const wire = JSON.stringify(replayModel.requests[0].input);
      expect(wire).toContain('child complete');
      expect(wire).toContain('leaf complete');
      expect(wire).not.toContain('root complete');
      const denied = await fresh.submit('Try a historical child name.', {
        toolNotFoundBehavior: 'raise_error',
      });
      await expect(denied.wait()).rejects.toThrow(
        /unsupported call|unknown|not available/i,
      );
      expect(effects).toBe(1);
      expect(JSON.stringify(detached.items!.map(({ item }) => item.data))).toBe(
        original,
      );
      replayModel.assertExhausted();
    }
    rootModel.assertExhausted();
    childModel.assertExhausted();
    leafModel.assertExhausted();
  },
  30_000,
);
