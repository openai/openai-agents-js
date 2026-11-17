import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  MemorySession,
  Runner,
  RunState,
  handoff,
  tool,
  type AgentInputItem,
} from '@openai/agents-core';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
} from '@openai/agents-core/testing';
import { OpenAIResponsesCompactionSession } from '../src';
import { getInputItems } from '../src/openaiResponsesModel';

const retainedUser = {
  type: 'message',
  id: 'msg_retained_user',
  role: 'user',
  content: [{ type: 'input_text', text: 'Retained user prefix.' }],
} as const;
const retainedAssistant = assistantMessage('Retained assistant prefix.', {
  id: 'msg_retained_assistant',
});
const compaction = {
  type: 'compaction',
  id: 'cmp_standalone',
  encrypted_content: 'opaque-standalone-ciphertext',
} as const;

async function compactedSession() {
  const underlying = new MemorySession({
    initialItems: [
      {
        type: 'message',
        role: 'user',
        content: 'Old input selected out by the compact endpoint.',
      },
    ],
  });
  const compact = vi.fn(async () => ({
    output: [structuredClone(retainedUser), retainedAssistant, compaction],
    usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
  }));
  const session = new OpenAIResponsesCompactionSession({
    underlyingSession: underlying,
    client: { responses: { compact } } as any,
    compactionMode: 'input',
    shouldTriggerCompaction: () => false,
  });
  await session.runCompaction({ force: true });
  return { session, underlying, compact };
}

test.each([false, true])(
  'replays the actual standalone returned window through Runner and wire conversion (stream=%s)',
  async (stream) => {
    const { session } = await compactedSession();
    const stored = await session.getItems();
    const model = new ScriptedModel([[assistantMessage('Done.')]]);
    const runner = new Runner({ tracingDisabled: true });
    const agent = new Agent({ name: 'Reader', model });
    const result = stream
      ? await runner.run(agent, 'Continue.', { session, stream: true })
      : await runner.run(agent, 'Continue.', { session });
    if ('completed' in result) await result.completed;
    expect(model.calls[0].request.input).toEqual([
      ...stored,
      { type: 'message', role: 'user', content: 'Continue.' },
    ]);
    const wire = getInputItems(model.calls[0].request.input);
    expect(wire[0]).toMatchObject({
      id: retainedUser.id,
      role: 'user',
      content: retainedUser.content,
    });
    expect(wire[2]).toEqual(compaction);
    expect(JSON.stringify(wire)).not.toContain(
      'standaloneCompactionRetainedItemIds',
    );
  },
);

test('preserves the retained window through stored JSON and approval RunState rehydration', async () => {
  const { session } = await compactedSession();
  const history = JSON.parse(
    JSON.stringify(await session.getItems()),
  ) as AgentInputItem[];
  const restoredStore = new MemorySession({ initialItems: history });
  const execute = vi.fn(async () => 'Approved.');
  const model = new ScriptedModel([
    [functionCall('approve', '{}', { callId: 'approved-call' })],
    [assistantMessage('Done.')],
  ]);
  const agent = new Agent({
    name: 'Approval',
    model,
    tools: [
      tool({
        name: 'approve',
        description: 'Request approval.',
        parameters: z.object({}),
        needsApproval: true,
        execute,
      }),
    ],
  });
  const runner = new Runner({ tracingDisabled: true });
  const paused = await runner.run(agent, 'Continue.', {
    session: restoredStore,
  });
  const state = await RunState.fromString(agent, paused.state.toString());
  state.approve(state.getInterruptions()[0]);
  const result = await runner.run(agent, state, { session: restoredStore });
  expect(result.finalOutput).toBe('Done.');
  expect(execute).toHaveBeenCalledOnce();
  expect(model.calls[1].request.input.slice(0, 3)).toEqual(history);
  expect(
    JSON.stringify(getInputItems(model.calls[1].request.input)),
  ).not.toContain('standaloneCompactionRetainedItemIds');
});

function filtered(items: AgentInputItem[]) {
  return items
    .filter((item) => item.id !== retainedAssistant.id)
    .map((item) =>
      item.id === retainedUser.id
        ? ({
            ...item,
            content: [
              {
                type: 'input_text' as const,
                text: 'Filtered retained prefix.',
              },
            ],
          } as AgentInputItem)
        : item,
    );
}

test('keeps current filtered copies without reviving removed retained input', async () => {
  const { session } = await compactedSession();
  const model = new ScriptedModel([[assistantMessage('Done.')]]);
  await new Runner({ tracingDisabled: true }).run(
    new Agent({ name: 'Filtered', model }),
    'Continue.',
    {
      session,
      callModelInputFilter: ({ modelData }) => ({
        ...modelData,
        input: filtered(modelData.input),
      }),
    },
  );
  expect(JSON.stringify(model.calls[0].request.input)).toContain(
    'Filtered retained prefix.',
  );
  expect(JSON.stringify(model.calls[0].request.input)).not.toContain(
    'Retained user prefix.',
  );
  expect(JSON.stringify(model.calls[0].request.input)).not.toContain(
    'Retained assistant prefix.',
  );
});

test('respects a handoff input filter that edits and removes retained window members', async () => {
  const { session } = await compactedSession();
  const targetModel = new ScriptedModel([[assistantMessage('Transferred.')]]);
  const target = new Agent({ name: 'Target', model: targetModel });
  const transfer = handoff(target, {
    inputFilter: (data) => ({
      ...data,
      inputHistory:
        typeof data.inputHistory === 'string'
          ? data.inputHistory
          : filtered([...data.inputHistory]),
    }),
  });
  const source = new Agent({
    name: 'Source',
    model: new ScriptedModel([
      [functionCall(transfer.toolName, '{}', { callId: 'transfer-call' })],
    ]),
    handoffs: [transfer],
  });
  await new Runner({ tracingDisabled: true }).run(source, 'Continue.', {
    session,
  });
  expect(JSON.stringify(targetModel.calls[0].request.input)).toContain(
    'Filtered retained prefix.',
  );
  expect(JSON.stringify(targetModel.calls[0].request.input)).not.toContain(
    'Retained user prefix.',
  );
  expect(JSON.stringify(targetModel.calls[0].request.input)).not.toContain(
    'Retained assistant prefix.',
  );
});

test('preserves original session history when standalone retained items lack IDs', async () => {
  const initial: AgentInputItem[] = [
    { type: 'message', role: 'user', content: 'Original history.' },
  ];
  const underlying = new MemorySession({ initialItems: initial });
  const session = new OpenAIResponsesCompactionSession({
    underlyingSession: underlying,
    client: {
      responses: {
        compact: vi.fn(async () => ({
          output: [
            {
              type: 'message',
              role: 'user',
              content: [
                { type: 'input_text', text: 'ID-less retained prefix.' },
              ],
            },
            compaction,
          ],
        })),
      },
    } as any,
  });
  await expect(session.runCompaction({ force: true })).rejects.toThrow(
    'retained item without an ID',
  );
  expect(await underlying.getItems()).toEqual(initial);
});
