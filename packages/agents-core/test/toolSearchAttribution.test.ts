import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallModelInputFilterArgs, Session } from '../src';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Runner,
  MemorySession,
  RunState,
  attachClientToolSearchExecutor,
  handoff,
  tool,
} from '../src';
import { ScriptedModel } from '../src/testing';
import type * as protocol from '../src/types/protocol';

const search = (id = 'search'): protocol.ToolSearchOutputItem => ({
  type: 'tool_search_output',
  id,
  execution: 'server',
  status: 'completed',
  tools: [
    {
      type: 'function',
      name: 'lookup',
      defer_loading: true,
      parameters: { type: 'object', properties: {} },
    },
  ],
});
const call = (
  name = 'lookup',
  callId = 'lookup-call',
): protocol.FunctionCallItem => ({
  type: 'function_call',
  name,
  callId,
  arguments: '{}',
});
const done = (): protocol.AssistantMessageItem => ({
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text: 'done' }],
  status: 'completed',
});
function lookup(execute = vi.fn(async () => 'found')) {
  return tool({
    name: 'lookup',
    description: 'Look up a record.',
    parameters: z.object({}),
    deferLoading: true,
    execute,
  });
}
const searchTool = {
  type: 'hosted_tool',
  name: 'tool_search',
  providerData: { type: 'tool_search' },
} as const;
const runner = () => new Runner({ tracingDisabled: true });

async function finish(
  agent: Agent,
  input: string | protocol.ModelItem[],
  stream: boolean,
) {
  if (stream) {
    const result = await runner().run(agent, input, { stream: true });
    await result.completed;
    return result;
  }
  return runner().run(agent, input);
}

describe('tool-search Agent attribution', () => {
  it.each([false, true])(
    'does not load the receiving Agent through flattened history (stream: %s)',
    async (stream) => {
      const execute = vi.fn(async () => 'found');
      const b = new Agent({
        name: 'B',
        tools: [lookup(execute), searchTool],
        model: new ScriptedModel([[call()], [done()]]),
      });
      const a = new Agent({
        name: 'A',
        tools: [lookup(), searchTool],
        handoffs: [b],
        model: new ScriptedModel([
          [search(), call(handoff(b).toolName, 'handoff')],
        ]),
      });
      await expect(finish(a, 'start', stream)).rejects.toThrow(
        /before it was loaded via tool_search/,
      );
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'keeps each Agent search local across A-B-A (stream: %s)',
    async (stream) => {
      const aExecute = vi.fn(async () => 'A result');
      const bExecute = vi.fn(async () => 'B result');
      const aModel = new ScriptedModel([]);
      const a = new Agent({
        name: 'A',
        tools: [lookup(aExecute), searchTool],
        model: aModel,
      });
      const b = new Agent({
        name: 'B',
        tools: [lookup(bExecute), searchTool],
        handoffs: [a],
        model: new ScriptedModel([
          [search('B-search'), call('lookup', 'B-call')],
          [call(handoff(a).toolName, 'back')],
        ]),
      });
      a.handoffs = [b];
      aModel.enqueue(
        [search(), call('lookup', 'A-first')],
        [call(handoff(b).toolName, 'away')],
        [call('lookup', 'A-second')],
        [done()],
      );
      const result = await finish(a, 'start', stream);
      expect(result.finalOutput).toBe('done');
      expect(aExecute).toHaveBeenCalledTimes(2);
      expect(bExecute).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['json', 'session'] as const)(
    'preserves unique ownership through %s replay with reconstructed Agents',
    async (mode) => {
      const session = new MemorySession();
      const original = new Agent({
        name: 'A',
        tools: [lookup(), searchTool],
        model: new ScriptedModel([[search(), done()]]),
      });
      const first = await runner().run(original, 'start', { session });
      const history = JSON.parse(
        JSON.stringify(
          mode === 'json' ? first.history : await session.getItems(),
        ),
      );
      expect(
        history.find(
          (item: protocol.ModelItem) => item.type === 'tool_search_output',
        ).toolSearchAgentName,
      ).toBe('A');
      for (const name of ['A', 'B']) {
        const execute = vi.fn(async () => 'found');
        const agent = new Agent({
          name,
          tools: [lookup(execute), searchTool],
          model: new ScriptedModel([[call()], [done()]]),
        });
        const promise =
          mode === 'json'
            ? runner().run(agent, history)
            : runner().run(agent, 'again', {
                session: new MemorySession({ initialItems: history }),
              });
        if (name === 'A') {
          expect((await promise).finalOutput).toBe('done');
          expect(execute).toHaveBeenCalledTimes(1);
        } else {
          await expect(promise).rejects.toThrow(
            /before it was loaded via tool_search/,
          );
          expect(execute).not.toHaveBeenCalled();
        }
      }
    },
  );

  it('keeps unattributed history but requires a fresh search', async () => {
    const oldSearch = search();
    const model = new ScriptedModel([[call()]]);
    const execute = vi.fn(async () => 'found');
    const agent = new Agent({
      name: 'A',
      tools: [lookup(execute), searchTool],
      model,
    });
    await expect(runner().run(agent, [oldSearch])).rejects.toThrow(
      /before it was loaded via tool_search/,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(model.firstCall?.request.input).toContainEqual(oldSearch);
    model.enqueue([search('fresh'), call()], [done()]);
    expect((await runner().run(agent, [oldSearch])).finalOutput).toBe('done');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'distinguishes same-name Agents and leaves ambiguous raw history unscoped (stream: %s)',
    async (stream) => {
      const bExecute = vi.fn(async () => 'B result');
      const b = new Agent({
        name: 'Same',
        tools: [lookup(bExecute), searchTool],
        model: new ScriptedModel([[call()], [done()]]),
      });
      const a = new Agent({
        name: 'Same',
        tools: [lookup(), searchTool],
        handoffs: [b],
        model: new ScriptedModel([
          [search(), call(handoff(b).toolName, 'handoff')],
        ]),
      });
      await expect(finish(a, 'start', stream)).rejects.toThrow(
        /before it was loaded via tool_search/,
      );
      expect(bExecute).not.toHaveBeenCalled();
      a.model = new ScriptedModel([[search(), call()], [done()]]);
      const result = await finish(a, 'start', stream);
      const output = result.history.find(
        (item) => item.type === 'tool_search_output',
      );
      expect(output).not.toHaveProperty('toolSearchAgentName');
      const independent = new Agent({
        name: 'Same',
        tools: [lookup(bExecute), searchTool],
        model: new ScriptedModel([[call()]]),
      });
      await expect(
        runner().run(independent, JSON.parse(JSON.stringify(result.history))),
      ).rejects.toThrow(/before it was loaded via tool_search/);
    },
  );

  it.each([false, true])(
    'restores attributed RunItems through RunState (legacy: %s)',
    async (legacy) => {
      const execute = vi.fn(async () => 'found');
      const deferred = lookup(execute);
      deferred.needsApproval = async () => true;
      const a = new Agent({
        name: 'A',
        tools: [deferred, searchTool],
        model: new ScriptedModel([[search(), call()]]),
      });
      const paused = await runner().run(a, 'start');
      const json = JSON.parse(await paused.state.toString());
      if (legacy) {
        json.$schemaVersion = '1.19';
        delete json.currentResponseGeneratedItemOwnership;
        for (const item of json.generatedItems)
          delete item.rawItem.toolSearchAgentName;
      }
      const nextModel = new ScriptedModel([
        [call('lookup', 'second')],
        [done()],
      ]);
      const replacement = new Agent({
        name: 'A',
        tools: [lookup(execute), searchTool],
        model: nextModel,
      });
      const restored = await RunState.fromString(
        replacement,
        JSON.stringify(json),
      );
      restored.approve(restored.getInterruptions()[0]);
      const result = await runner().run(replacement, restored);
      expect(result.finalOutput).toBe('done');
      expect(execute).toHaveBeenCalledTimes(2);
      const restoredOutput = result.history.find(
        (item) => item.type === 'tool_search_output',
      );
      if (legacy) {
        expect(restoredOutput).not.toHaveProperty('toolSearchAgentName');
      } else {
        expect(restoredOutput).toMatchObject({ toolSearchAgentName: 'A' });
      }
    },
  );

  it.each(['hosted', 'built-in', 'custom'] as const)(
    'attributes accepted %s search output instead of trusting supplied ownership',
    async (mode) => {
      const execute = vi.fn(async () => 'found');
      const deferred = lookup(execute);
      const supplied = { ...search(), toolSearchAgentName: 'B' };
      const clientSearch =
        mode === 'custom'
          ? attachClientToolSearchExecutor(
              {
                ...searchTool,
                providerData: { type: 'tool_search', execution: 'client' },
              },
              async () => deferred,
            )
          : {
              ...searchTool,
              providerData: { type: 'tool_search', execution: 'client' },
            };
      const searchCall: protocol.ToolSearchCallItem = {
        type: 'tool_search_call',
        callId: 'search-call',
        execution: 'client',
        arguments: { paths: ['lookup'] },
      };
      const model = new ScriptedModel([
        [mode === 'hosted' ? supplied : searchCall],
        [call()],
        [done()],
      ]);
      const agent = new Agent({
        name: 'A',
        tools: [deferred, mode === 'hosted' ? searchTool : clientSearch],
        model,
      });
      const result = await runner().run(agent, 'start');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(
        result.history.find((item) => item.type === 'tool_search_output'),
      ).toMatchObject({ toolSearchAgentName: 'A' });
      expect(supplied.toolSearchAgentName).toBe('B');
    },
  );

  it.each(['filter', 'conversationId', 'previousResponseId'] as const)(
    'does not transfer discovery through %s',
    async (mode) => {
      const execute = vi.fn(async () => 'found');
      const b = new Agent({
        name: 'B',
        tools: [lookup(execute), searchTool],
        model: new ScriptedModel([[call()]]),
      });
      const a = new Agent({
        name: 'A',
        tools: [lookup(), searchTool],
        handoffs: [b],
        model: new ScriptedModel([
          [search(), call(handoff(b).toolName, 'handoff')],
        ]),
      });
      const options =
        mode === 'filter'
          ? {
              callModelInputFilter: ({ modelData }: CallModelInputFilterArgs) =>
                structuredClone(modelData),
            }
          : { [mode]: 'server-id' };
      await expect(runner().run(a, 'start', options)).rejects.toThrow(
        /before it was loaded via tool_search/,
      );
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it('preserves attribution through an application-owned disk Session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tool-search-session-'));
    const path = join(directory, 'history.json');
    // This backend exercises the public Session persistence boundary across reconstruction.
    const openSession = (): Session => ({
      getSessionId: async () => path,
      getItems: async (limit) => {
        const items = JSON.parse(await readFile(path, 'utf8'));
        return limit === undefined ? items : items.slice(-limit);
      },
      addItems: async (items) => {
        const previous = JSON.parse(await readFile(path, 'utf8'));
        await writeFile(path, JSON.stringify([...previous, ...items]));
      },
      popItem: async () => {
        const items = JSON.parse(await readFile(path, 'utf8'));
        const item = items.pop();
        await writeFile(path, JSON.stringify(items));
        return item;
      },
      clearSession: async () => {
        await writeFile(path, '[]');
      },
    });
    try {
      await writeFile(path, '[]');
      const first = new Agent({
        name: 'A',
        tools: [lookup(), searchTool],
        model: new ScriptedModel([[search(), done()]]),
      });
      await runner().run(first, 'start', { session: openSession() });
      const execute = vi.fn(async () => 'found');
      const second = new Agent({
        name: 'A',
        tools: [lookup(execute), searchTool],
        model: new ScriptedModel([[call()], [done()]]),
      });
      expect(
        (await runner().run(second, 'again', { session: openSession() }))
          .finalOutput,
      ).toBe('done');
      const other = new Agent({
        name: 'B',
        tools: [lookup(execute), searchTool],
        model: new ScriptedModel([[call('lookup', 'other')]]),
      });
      await expect(
        runner().run(other, 'again', { session: openSession() }),
      ).rejects.toThrow(/before it was loaded via tool_search/);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('honors replacement search outputs within one Agent', async () => {
    const execute = vi.fn(async () => 'found');
    const agent = new Agent({
      name: 'A',
      tools: [lookup(execute), searchTool],
      model: new ScriptedModel([[search(), done()]]),
    });
    const first = await runner().run(agent, 'start');
    agent.model = new ScriptedModel([[call()]]);
    const history = [
      ...first.history,
      { ...search(), tools: [], toolSearchAgentName: 'A' },
    ];
    await expect(runner().run(agent, history)).rejects.toThrow(
      /before it was loaded via tool_search/,
    );
    expect(execute).not.toHaveBeenCalled();
  });
  it('keeps same-name Agent ownership through approval restoration and handoff', async () => {
    const aExecute = vi.fn(async () => 'A result');
    const bExecute = vi.fn(async () => 'B result');
    const deferred = lookup(aExecute);
    deferred.needsApproval = async () => true;
    const b = new Agent({
      name: 'Same',
      tools: [lookup(bExecute), searchTool],
      model: new ScriptedModel([[call('lookup', 'B-call')]]),
    });
    const a = new Agent({
      name: 'Same',
      tools: [deferred, searchTool],
      handoffs: [b],
      model: new ScriptedModel([
        [search(), call()],
        [call(handoff(b).toolName, 'handoff')],
      ]),
    });
    const paused = await runner().run(a, 'start');
    const restored = await RunState.fromString(a, paused.state.toString());
    restored.approve(restored.getInterruptions()[0]);
    await expect(runner().run(a, restored)).rejects.toThrow(
      /before it was loaded via tool_search/,
    );
    expect(aExecute).toHaveBeenCalledTimes(1);
    expect(bExecute).not.toHaveBeenCalled();
  });
  it.each([
    ['conversationId', false],
    ['conversationId', true],
    ['previousResponseId', false],
    ['previousResponseId', true],
  ] as const)(
    'sends only new tool output after hosted search with %s (stream: %s)',
    async (mode, stream) => {
      const model = new ScriptedModel([[search(), call()], [done()]]);
      const agent = new Agent({
        name: 'A',
        tools: [lookup(), searchTool],
        model,
      });
      if (stream) {
        const result = await runner().run(agent, 'start', {
          [mode]: 'server-id',
          stream: true,
        });
        await result.completed;
      } else {
        await runner().run(agent, 'start', { [mode]: 'server-id' });
      }
      expect(model.calls[1].request.input).toEqual([
        expect.objectContaining({ type: 'function_call_result' }),
      ]);
    },
  );

  it.each(['conversationId', 'previousResponseId'] as const)(
    'does not replay hosted search after approval restoration with %s',
    async (mode) => {
      const deferred = lookup();
      deferred.needsApproval = async () => true;
      const model = new ScriptedModel([[search(), call()], [done()]]);
      const agent = new Agent({
        name: 'A',
        tools: [deferred, searchTool],
        model,
      });
      const paused = await runner().run(agent, 'start', {
        [mode]: 'server-id',
      });
      const restored = await RunState.fromString(
        agent,
        paused.state.toString(),
      );
      restored.approve(restored.getInterruptions()[0]);
      await runner().run(agent, restored);
      expect(model.calls[1].request.input).toEqual([
        expect.objectContaining({ type: 'function_call_result' }),
      ]);
    },
  );

  it('still sends newly generated client search output in server continuation', async () => {
    const searchCall: protocol.ToolSearchCallItem = {
      type: 'tool_search_call',
      callId: 'client-search',
      execution: 'client',
      arguments: { paths: ['lookup'] },
    };
    const model = new ScriptedModel([[searchCall], [call()], [done()]]);
    const agent = new Agent({
      name: 'A',
      tools: [
        lookup(),
        {
          ...searchTool,
          providerData: { type: 'tool_search', execution: 'client' },
        },
      ],
      model,
    });
    await runner().run(agent, 'start', { conversationId: 'server-id' });
    expect(model.calls[1].request.input).toEqual([
      expect.objectContaining({ type: 'tool_search_output' }),
    ]);
    expect(model.calls[2].request.input).toEqual([
      expect.objectContaining({ type: 'function_call_result' }),
    ]);
  });
});
