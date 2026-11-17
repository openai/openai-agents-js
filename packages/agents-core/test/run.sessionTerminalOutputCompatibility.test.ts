import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  Agent,
  RunState,
  run,
  setTracingDisabled,
  tool,
  type AgentInputItem,
} from '../src';
import { mcpToFunctionTool, type CallToolResultContent } from '../src/mcp';
import { ScriptedModel } from '../src/testing';
import {
  createApprovalRun,
  functionToolCall,
  UncertainAppendSession,
} from './fixtures/sessionWriteRecovery';

describe('saved Session terminal output compatibility', () => {
  beforeAll(() => {
    setTracingDisabled(true);
  });

  const mcpBlocks = [
    { type: 'text', text: 'caption' },
    { type: 'image', data: 'aGk=', mimeType: 'image/png' },
  ] satisfies CallToolResultContent;
  it.each([
    {
      name: 'schema-backed JSON containing a serialized Buffer',
      outputSchema: {
        type: 'object' as const,
        properties: {
          payload: {
            type: 'object',
            properties: {
              type: { const: 'Buffer' },
              data: { type: 'array', items: { type: 'number' } },
            },
            required: ['type', 'data'],
            additionalProperties: false,
          },
        },
        required: ['payload'],
        additionalProperties: false as const,
      },
      output: { payload: { type: 'Buffer', data: [104, 105] } },
      stored: {
        type: 'text',
        text: '{"payload":{"type":"Buffer","data":[104,105]}}',
      },
      final: '{"payload":"[byte array 0x68 0x69 (2 bytes)]"}',
    },
    {
      name: 'single MCP block',
      mcpContent: [
        { type: 'text', text: 'done' },
      ] satisfies CallToolResultContent,
      output: { type: 'text', text: 'done' },
      stored: [{ type: 'input_text', text: 'done' }],
    },
    {
      name: 'generic single-element list',
      output: [{ type: 'text', text: 'done' }],
      stored: [{ type: 'input_text', text: 'done' }],
    },
    {
      name: 'structured text in a deferred append',
      deferAppend: true,
      output: { type: 'text', text: 'done' },
      stored: [{ type: 'input_text', text: 'done' }],
    },
    {
      name: 'inline file bytes',
      output: {
        type: 'file',
        file: {
          data: new Uint8Array([1, 2]),
          mediaType: 'text/plain',
          filename: 'notes.txt',
        },
      },
      stored: [
        {
          type: 'input_file',
          file: 'data:text/plain;base64,AQI=',
          filename: 'notes.txt',
        },
      ],
      final:
        '{"type":"file","file":{"data":"[byte array 0x01 0x02 (2 bytes)]","mediaType":"text/plain","filename":"notes.txt"}}',
    },
    {
      name: 'image without optional detail',
      output: { type: 'image', image: 'https://example.com/image.png' },
      stored: [{ type: 'input_image', image: 'https://example.com/image.png' }],
      droppedField: {
        type: 'image',
        image: 'https://example.com/image.png',
        detail: '',
      },
    },
    {
      name: 'file without optional filename',
      output: { type: 'file', file: { id: 'file_123' } },
      stored: [{ type: 'input_file', file: { id: 'file_123' } }],
      droppedField: { type: 'file', file: { id: 'file_123', filename: '' } },
    },
    {
      name: 'file URL projected by a Session without a comparison hook',
      output: { type: 'file', file: 'https://example.com/report.pdf' },
      stored: [
        { type: 'input_file', file: { url: 'https://example.com/report.pdf' } },
      ],
      droppedField: { type: 'file', file: 'https://example.com/other.pdf' },
    },
    {
      name: 'legacy file reference',
      output: { type: 'file', fileId: 'file_123', filename: 'report.pdf' },
      stored: [
        {
          type: 'input_file',
          file: { id: 'file_123' },
          filename: 'report.pdf',
        },
      ],
    },
    {
      name: 'MCP image with a MIME type',
      output: { type: 'image', mimeType: 'image/png', data: 'aGk=' },
      stored: [{ type: 'input_image', image: 'data:image/png;base64,aGk=' }],
      droppedField: {
        type: 'image',
        mimeType: 'image/jpeg',
        mediaType: 'image/png',
        data: 'aGk=',
      },
    },
    {
      name: 'multiple MCP content blocks',
      output: mcpBlocks,
      mcpContent: mcpBlocks,
      stored: [
        { type: 'input_text', text: 'caption' },
        { type: 'input_image', image: 'data:image/png;base64,aGk=' },
      ],
    },
  ])(
    'recovers the saved $name after a later append loses its acknowledgement',
    async (example) => {
      const { output, stored } = example;
      const execute = vi.fn(async () => output);
      const approved = vi.fn(async () => 'approved');
      const { agent } = createApprovalRun(approved, 'stop_on_first_tool');
      const callTool = vi.fn(async () => example.mcpContent ?? []);
      agent.tools.push(
        example.mcpContent
          ? mcpToFunctionTool(
              {
                name: 'first',
                inputSchema: {
                  type: 'object',
                  properties: {},
                  required: [],
                  additionalProperties: false,
                },
              },
              {
                name: 'structured-content-server',
                cacheToolsList: false,
                connect: async () => {},
                close: async () => {},
                listTools: async () => [],
                invalidateToolsCache: async () => {},
                callTool,
              },
              false,
            )
          : tool({
              name: 'first',
              description: 'Returns content.',
              parameters: z.object({}),
              outputSchema: example.outputSchema,
              execute,
            }),
      );
      const model = new ScriptedModel([
        [
          { ...functionToolCall('first-call'), name: 'first' },
          functionToolCall(),
        ],
      ]);
      agent.model = model;
      if (example.deferAppend)
        agent.outputGuardrails.push({
          name: 'defer selected output',
          execute: async () => ({
            tripwireTriggered: false,
            outputInfo: undefined,
          }),
        });
      class FileUrlSession extends UncertainAppendSession {
        override addItems(items: AgentInputItem[]) {
          const storedItems = structuredClone(items);
          for (const item of storedItems) {
            if (
              item.type !== 'function_call_result' ||
              !Array.isArray(item.output)
            )
              continue;
            for (const block of item.output) {
              if (
                block.type === 'input_file' &&
                typeof block.file === 'string' &&
                block.file.startsWith('https://')
              ) {
                block.file = { url: block.file };
              }
            }
          }
          return super.addItems(storedItems);
        }
      }
      const session = new FileUrlSession();
      const first = await run(agent, 'run both', { session });
      const expectedStored = expect.objectContaining({
        type: 'function_call_result',
        callId: 'first-call',
        output: stored,
      });
      if (example.deferAppend) {
        expect(await session.getItems()).not.toContainEqual(expectedStored);
      } else {
        expect(await session.getItems()).toContainEqual(expectedStored);
      }
      first.state.approve(first.interruptions[0]!);
      session.failNextAppend(example.deferAppend ? 'before' : 'after');
      await expect(run(agent, first.state, { session })).rejects.toThrow(
        example.deferAppend ? /before commit/ : /acknowledgement lost/,
      );
      const snapshot = first.state.toString();
      const history = await session.getItems();
      for (const replacement of [
        { type: 'text', text: 'changed' },
        { type: 'text', text: 'done', hidden: 'unbound' },
        ...(example.mcpContent?.length === 1 ? [[output]] : []),
        ...(example.outputSchema ? [output] : []),
        ...(example.droppedField ? [example.droppedField] : []),
      ]) {
        const changed = JSON.parse(snapshot);
        const producer = changed.pendingSessionWrite.terminalToolFinalization;
        const selected =
          changed.generatedItems[producer.selectedGeneratedItemIndex];
        selected.output = JSON.stringify(replacement);
        producer.finalOutput = selected.output;
        changed.currentStep.output = selected.output;
        const restored = await RunState.fromString(
          agent,
          JSON.stringify(changed),
        );
        await expect(run(agent, restored, { session })).rejects.toThrow(
          /verified against the saved Session result/,
        );
      }
      expect(await session.getItems()).toEqual(history);
      const restored = await RunState.fromString(agent, snapshot);
      const result = await run(agent, restored, { session });
      expect(result.finalOutput).toBe(
        'final' in example ? example.final : JSON.stringify(output),
      );
      if (example.deferAppend) {
        expect(
          (await session.getItems()).filter(
            (item) =>
              item.type === 'function_call_result' &&
              item.callId === 'first-call',
          ),
        ).toEqual([expectedStored]);
      } else {
        expect(await session.getItems()).toEqual(history);
      }
      expect(example.mcpContent ? callTool : execute).toHaveBeenCalledTimes(1);
      expect(approved).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
    },
  );

  it('checks the stored result when a Session rewrites a deferred append on retry', async () => {
    const { agent, execute: approved } = createApprovalRun(
      undefined,
      'stop_on_first_tool',
    );
    const execute = vi.fn(async () => ({
      type: 'text',
      text: 'done',
      providerData: { marker: 'not persisted' },
    }));
    agent.tools.push(
      tool({
        name: 'first',
        description: 'Return structured content.',
        parameters: z.object({}),
        execute,
      }),
    );
    agent.outputGuardrails.push({
      name: 'defer terminal results',
      execute: async () => ({
        tripwireTriggered: false,
        outputInfo: undefined,
      }),
    });
    const model = new ScriptedModel([
      [
        { ...functionToolCall('first-call'), name: 'first' },
        functionToolCall(),
      ],
    ]);
    agent.model = model;
    // Conversations stores input_text blocks with type and text only.
    class ModelVisibleSession extends UncertainAppendSession {
      override addItems(items: AgentInputItem[]) {
        const stored = structuredClone(items);
        for (const item of stored) {
          if (
            item.type === 'function_call_result' &&
            Array.isArray(item.output)
          ) {
            for (const block of item.output) {
              if (block.type === 'input_text') delete block.providerData;
            }
          }
        }
        return super.addItems(stored);
      }
    }
    const session = new ModelVisibleSession();
    const first = await run(agent, 'run both', { session });
    first.state.approve(first.interruptions[0]!);
    session.failNextAppend('before');
    await expect(run(agent, first.state, { session })).rejects.toThrow(
      /before commit/,
    );
    const restored = await RunState.fromString(agent, first.state.toString());
    await expect(run(agent, restored, { session })).rejects.toThrow(
      /verified against the saved Session result/,
    );
    expect(restored._pendingSessionWrite?.phase).toBe('compaction_pending');
    const writes = session.addCalls;
    await expect(run(agent, restored, { session })).rejects.toThrow(
      /verified against the saved Session result/,
    );
    expect(session.addCalls).toBe(writes);
    expect(await session.getItems()).toContainEqual(
      expect.objectContaining({
        type: 'function_call_result',
        callId: 'first-call',
        output: [{ type: 'input_text', text: 'done' }],
      }),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(approved).toHaveBeenCalledTimes(1);
    expect(model.calls).toHaveLength(1);
  });

  it('recovers indented JSON text after the tool gains an output schema', async () => {
    const text = '{\n  "receipt": "gated"\n}';
    const { agent, execute, model } = createApprovalRun(
      vi.fn(async () => text),
      'stop_on_first_tool',
    );
    const session = new UncertainAppendSession();
    const first = await run(agent, 'start', { session });
    first.state.approve(first.interruptions[0]!);
    session.failNextAppend('after');
    await expect(run(agent, first.state, { session })).rejects.toThrow(
      /acknowledgement lost/,
    );
    const checkpoint = first.state.toString();
    const history = await session.getItems();

    const replacement = vi.fn(async () => ({ receipt: 'new' }));
    const updated = agent.clone({
      tools: [
        tool({
          name: 'approval_tool',
          description: 'Returns a receipt after approval.',
          parameters: z.object({}),
          needsApproval: true,
          outputSchema: z.object({ receipt: z.string() }),
          execute: replacement,
        }),
      ],
    });
    const restored = await RunState.fromString(updated, checkpoint);
    expect((await run(updated, restored, { session })).finalOutput).toBe(text);
    expect(await session.getItems()).toEqual(history);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
    expect(model.calls).toHaveLength(1);
  });

  it.each(['live', 'restored'] as const)(
    'preserves the v0.21.0 terminal selection on a %s compaction retry',
    async (retry) => {
      // Captured after v0.21.0 committed the gated output and its Session lost the acknowledgement.
      const { snapshot, history } = JSON.parse(
        readFileSync(
          new URL(
            './fixtures/run-state/v0.21.0-split-terminal-append.json',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      const execute = vi.fn(async () => {
        throw new Error('Unexpected replay.');
      });
      const model = new ScriptedModel([]);
      const agent = new Agent({
        name: 'Released agent',
        model,
        toolUseBehavior: 'stop_on_first_tool',
        tools: ['immediate', 'gated'].map((name) =>
          tool({
            name,
            description: name,
            parameters: z.object({}),
            needsApproval: name === 'gated',
            // The stored plain-text result was committed before this schema was registered.
            outputSchema:
              name === 'gated' && retry === 'restored'
                ? z.object({ receipt: z.string() })
                : undefined,
            execute,
          }),
        ),
      });
      const session = new UncertainAppendSession();
      await session.addItems(history);
      const restored = await RunState.fromString(
        agent,
        JSON.stringify(snapshot),
      );
      session.failNextCompaction();
      await expect(run(agent, restored, { session })).rejects.toThrow(
        /input compaction rejected/,
      );
      expect(restored._pendingSessionWrite?.phase).toBe('compaction_pending');
      if (retry === 'restored') {
        const checkpoint = restored.toJSON();
        const gated = checkpoint.lastModelResponse!.output.find(
          (item) => item.type === 'function_call' && item.callId === 'gated',
        );
        if (gated?.type !== 'function_call')
          throw new Error('Missing fixture call.');
        gated.arguments = '{"changed":true}';
        await expect(
          RunState.fromString(agent, JSON.stringify(checkpoint)),
        ).rejects.toThrow(
          /pending Session (write|compaction terminal output) is invalid/,
        );
      }
      const state =
        retry === 'live'
          ? restored
          : await RunState.fromString(agent, restored.toString());
      if (retry === 'restored') {
        const missingResult = new UncertainAppendSession();
        await missingResult.addItems(history.slice(0, -1));
        await expect(
          run(agent, state, { session: missingResult }),
        ).rejects.toThrow(/verified against the saved Session result/);
        expect(missingResult.compactionArgs).toHaveLength(0);
        const differentResult = new UncertainAppendSession();
        const differentHistory = structuredClone(history);
        differentHistory.at(-1).output.text = 'different stored result';
        await differentResult.addItems(differentHistory);
        differentResult.prepareHistoryItemsForPersistenceComparison = (items) =>
          items.map((item) =>
            item.type === 'function_call_result'
              ? { ...item, output: '' }
              : item,
          );
        await expect(
          run(agent, state, { session: differentResult }),
        ).rejects.toThrow(/verified against the saved Session result/);
        expect(differentResult.compactionArgs).toHaveLength(0);
      }
      expect((await run(agent, state, { session })).finalOutput).toBe('gated');
      expect(session.compactionArgs).toHaveLength(2);
      expect(session.addCalls).toBe(1);
      expect(await session.getItems()).toEqual(history);
      expect(model.calls).toHaveLength(0);
      expect(execute).not.toHaveBeenCalled();
    },
  );
});
