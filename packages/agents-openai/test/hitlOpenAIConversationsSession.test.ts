import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  Agent,
  RunState,
  type ModelRequest,
  type ModelProvider,
  Usage,
  protocol,
  run,
  setDefaultModelProvider,
  tool,
} from '@openai/agents-core';
import { ScriptedModel, modelResponder } from '@openai/agents-core/testing';

import { OpenAIConversationsSession } from '../src';

const TOOL_ECHO = 'approved_echo';
const TOOL_NOTE = 'approved_note';
const REJECTION_OUTPUT = 'Tool execution was not approved.';
const USER_MESSAGES = [
  'Fetch profile for customer 104.',
  'Update note for customer 104.',
  'Delete note for customer 104.',
];

const executeCounts = new Map<string, number>();

const approvalEchoTool = tool({
  name: TOOL_ECHO,
  description: 'Echoes back the provided query after approval.',
  parameters: z.object({ query: z.string() }),
  async execute({ query }: { query: string }) {
    executeCounts.set(TOOL_ECHO, (executeCounts.get(TOOL_ECHO) ?? 0) + 1);
    return `approved:${query}`;
  },
});

approvalEchoTool.needsApproval = async () => true;

const approvalNoteTool = tool({
  name: TOOL_NOTE,
  description: 'Records the provided query after approval.',
  parameters: z.object({ query: z.string() }),
  async execute({ query }: { query: string }) {
    executeCounts.set(TOOL_NOTE, (executeCounts.get(TOOL_NOTE) ?? 0) + 1);
    return `approved_note:${query}`;
  },
});

approvalNoteTool.needsApproval = async () => true;

type ScenarioStep = {
  label: string;
  message: string;
  toolName: string;
  approval: 'approve' | 'reject';
  expectedOutput: string;
};

function createScenarioModel(): ScriptedModel {
  return new ScriptedModel(
    USER_MESSAGES.map(() =>
      modelResponder((call) => {
        const request = call.request;
        const toolName =
          typeof request.modelSettings.toolChoice === 'string'
            ? request.modelSettings.toolChoice
            : TOOL_ECHO;
        const callId = `call_${call.index}`;
        const query = extractUserMessage(request.input);
        const toolCall: protocol.FunctionCallItem = {
          id: `fc_${callId}`,
          type: 'function_call',
          name: toolName,
          callId,
          status: 'completed',
          arguments: JSON.stringify({ query }),
          providerData: {},
        };

        return { usage: new Usage(), output: [toolCall] };
      }),
    ),
  );
}

describe('OpenAIConversationsSession HITL scenario', () => {
  beforeAll(() => {
    const provider: ModelProvider = {
      getModel() {
        return createScenarioModel();
      },
    };
    setDefaultModelProvider(provider);
  });

  it('recovers the selected file URL after a conversation append loses its acknowledgement', async () => {
    const url = 'https://example.com/report.pdf';
    const file = tool({
      name: 'file',
      description: 'Returns a report.',
      parameters: z.object({}),
      execute: vi.fn(async () => ({ type: 'file' as const, file: url })),
    });
    const approve = tool({
      name: 'approve',
      description: 'Requires approval.',
      parameters: z.object({}),
      needsApproval: true,
      execute: vi.fn(async () => 'approved'),
    });
    const model = new ScriptedModel([
      [file, approve].map(({ name }) => ({
        type: 'function_call' as const,
        name,
        callId: name,
        arguments: '{}',
        status: 'completed' as const,
      })),
    ]);
    const agent = new Agent({
      name: 'Report',
      model,
      tools: [file, approve],
      toolUseBehavior: 'stop_on_first_tool',
    });
    const history: Array<Record<string, any>> = [];
    const create = vi.fn(
      async (_id: string, { items }: { items: typeof history }) => {
        for (const item of items) {
          history.push({
            ...item,
            id: `item_${history.length}`,
            ...(item.role === 'user'
              ? {
                  type: 'message',
                  content: [{ type: 'input_text', text: item.content }],
                }
              : {}),
          });
        }
        if (
          items.some(
            (item) =>
              item.type === 'function_call_output' &&
              item.call_id === 'approve',
          )
        )
          throw new Error('Acknowledgement lost');
      },
    );
    let failRead = false;
    const list = () => {
      if (failRead) {
        failRead = false;
        throw new Error('Read interrupted');
      }
      return history.slice();
    };
    const session = new OpenAIConversationsSession({
      conversationId: 'conv-report',
      client: { conversations: { items: { create, list } } } as any,
    });
    const first = await run(agent, 'Run both tools.', { session });
    expect(await session.getItems()).toContainEqual(
      expect.objectContaining({
        type: 'function_call_result',
        callId: 'file',
        output: [{ type: 'input_file', file: { url } }],
      }),
    );
    first.state.approve(first.interruptions[0]!);
    failRead = true;
    await expect(run(agent, first.state, { session })).rejects.toThrow(
      'Read interrupted',
    );
    const snapshot = first.state.toString();
    expect(JSON.parse(snapshot).pendingSessionWrite.phase).toBe('prepared');
    const writes = create.mock.calls.length;
    const tampered = snapshot.split(url).join('https://example.com/other.pdf');
    await expect(
      run(agent, await RunState.fromString(agent, tampered), { session }),
    ).rejects.toThrow(/verified against the saved Session result/);
    expect(create).toHaveBeenCalledTimes(writes);
    const restored = await RunState.fromString(agent, snapshot);
    await expect(run(agent, restored, { session })).rejects.toThrow(
      'Acknowledgement lost',
    );
    const result = await run(agent, restored, { session });
    expect(result.finalOutput).toBe(
      '{"type":"file","file":"https://example.com/report.pdf"}',
    );
    expect(create).toHaveBeenCalledTimes(writes + 1);
    expect(model.calls).toHaveLength(1);
  });

  it('refuses to replay approved work when only the first conversation batch was saved', async () => {
    const execute = vi.fn(async () => 'approved');
    const approvedTool = tool({
      name: 'approve_item',
      description: 'Approves an item.',
      parameters: z.object({}),
      needsApproval: true,
      execute,
    });
    const model = new ScriptedModel([
      modelResponder(() => ({
        usage: new Usage(),
        output: Array.from({ length: 21 }, (_, index) => ({
          type: 'function_call' as const,
          name: approvedTool.name,
          callId: `call_${index}`,
          arguments: '{}',
          status: 'completed' as const,
        })),
      })),
    ]);
    const agent = new Agent({
      name: 'Batch approval',
      model,
      tools: [approvedTool],
    });
    const history: Array<Record<string, any>> = [];
    const create = vi.fn(
      async (_id: string, { items }: { items: typeof history }) => {
        if (history.some((item) => item.type === 'function_call_output')) {
          throw new Error('Next conversation batch rejected');
        }
        for (const item of items) {
          history.push({
            ...item,
            id: `item_${history.length}`,
            ...(item.role === 'user'
              ? {
                  type: 'message',
                  content:
                    typeof item.content === 'string'
                      ? [{ type: 'input_text', text: item.content }]
                      : item.content,
                }
              : {}),
          });
        }
      },
    );
    const session = new OpenAIConversationsSession({
      conversationId: 'conv-approvals',
      client: {
        conversations: { items: { create, list: () => history.slice() } },
      } as any,
    });
    const first = await run(agent, 'Approve these items', { session });
    expect(first.interruptions).toHaveLength(21);
    for (const approval of first.interruptions) first.state.approve(approval);
    await expect(run(agent, first.state, { session })).rejects.toThrow(
      'Next conversation batch rejected',
    );
    const writes = create.mock.calls.length;
    expect(
      history.filter((item) => item.type === 'function_call_output'),
    ).toHaveLength(20);
    await expect(run(agent, first.state, { session })).rejects.toThrow(
      'cannot be reconciled safely',
    );
    expect(create).toHaveBeenCalledTimes(writes);
    expect(execute).toHaveBeenCalledTimes(21);
    expect(model.calls).toHaveLength(1);
  });

  it('persists approvals, rehydration, and rejections across tools', async () => {
    const storedItems: Array<Record<string, any>> = [];
    const createItems = vi.fn(
      async (_conversationId: string, payload: { items: any[] }) => {
        storedItems.push(...payload.items);
        return {};
      },
    );
    const listItems = vi.fn(() => ({
      // eslint-disable-next-line require-yield -- empty iterator is intentional.
      async *[Symbol.asyncIterator]() {
        return;
      },
    }));
    const client = {
      conversations: {
        items: {
          create: createItems,
          list: listItems,
          delete: vi.fn(),
        },
        create: vi.fn(),
        delete: vi.fn(),
      },
    } as any;

    const session = new OpenAIConversationsSession({
      conversationId: 'conv_test',
      client,
    });
    const rehydratedSession = new OpenAIConversationsSession({
      conversationId: 'conv_test',
      client,
    });

    const model = createScenarioModel();
    const steps: ScenarioStep[] = [
      {
        label: 'turn 1',
        message: USER_MESSAGES[0],
        toolName: TOOL_ECHO,
        approval: 'approve',
        expectedOutput: `approved:${USER_MESSAGES[0]}`,
      },
      {
        label: 'turn 2 (rehydrated)',
        message: USER_MESSAGES[1],
        toolName: TOOL_NOTE,
        approval: 'approve',
        expectedOutput: `approved_note:${USER_MESSAGES[1]}`,
      },
      {
        label: 'turn 3 (rejected)',
        message: USER_MESSAGES[2],
        toolName: TOOL_ECHO,
        approval: 'reject',
        expectedOutput: REJECTION_OUTPUT,
      },
    ];

    let offset = 0;
    const first = await runScenarioStep(session, model, steps[0]);
    const firstItems = storedItems.slice(offset);
    offset = storedItems.length;
    expectStepItems(firstItems, steps[0], first.approvalItem);

    const second = await runScenarioStep(rehydratedSession, model, steps[1]);
    const secondItems = storedItems.slice(offset);
    offset = storedItems.length;
    expectStepItems(secondItems, steps[1], second.approvalItem);

    const third = await runScenarioStep(rehydratedSession, model, steps[2]);
    const thirdItems = storedItems.slice(offset);
    expectStepItems(thirdItems, steps[2], third.approvalItem);

    expect(executeCounts.get(TOOL_ECHO)).toBe(1);
    expect(executeCounts.get(TOOL_NOTE)).toBe(1);
  });
});

async function runScenarioStep(
  session: OpenAIConversationsSession,
  model: ScriptedModel,
  step: ScenarioStep,
): Promise<{ approvalItem: protocol.FunctionCallItem }> {
  const agent = new Agent({
    name: `OpenAIConversationsSession ${step.label}`,
    instructions: `Always call ${step.toolName} before responding.`,
    model,
    tools: [approvalEchoTool, approvalNoteTool],
    modelSettings: { toolChoice: step.toolName },
    toolUseBehavior: 'stop_on_first_tool',
  });

  const firstRun = await run(agent, step.message, { session });
  expect(firstRun.interruptions).toHaveLength(1);
  const approval = firstRun.interruptions[0];
  if (step.approval === 'reject') {
    firstRun.state.reject(approval);
  } else {
    firstRun.state.approve(approval);
  }

  const resumed = await run(agent, firstRun.state, { session });
  expect(resumed.interruptions).toHaveLength(0);
  expect(resumed.finalOutput).toBe(step.expectedOutput);

  return {
    approvalItem: approval.rawItem as protocol.FunctionCallItem,
  };
}

function expectStepItems(
  items: Array<Record<string, any>>,
  step: ScenarioStep,
  approvalItem: protocol.FunctionCallItem,
): void {
  const userItems = items.filter((item) => item.role === 'user');
  const functionCalls = items.filter((item) => item.type === 'function_call');
  const functionOutputs = items.filter(
    (item) => item.type === 'function_call_output',
  );

  expect(userItems).toHaveLength(1);
  expect(functionCalls).toHaveLength(1);
  expect(functionOutputs).toHaveLength(1);

  expect(extractUserText(userItems[0])).toBe(step.message);
  expect(functionCalls[0]?.name).toBe(step.toolName);
  expect(functionCalls[0]?.call_id).toBe(approvalItem.callId);
  expect(functionOutputs[0]?.call_id).toBe(approvalItem.callId);
  expect(extractOutputText(functionOutputs[0])).toBe(step.expectedOutput);
}

function extractUserMessage(input: ModelRequest['input']): string {
  if (typeof input === 'string') {
    return input;
  }

  const items = input ?? [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type === 'message' && item.role === 'user') {
      if (typeof item.content === 'string') {
        return item.content;
      }
      if (Array.isArray(item.content)) {
        const text = item.content
          .map((part) => (part.type === 'input_text' ? part.text : ''))
          .join('');
        if (text) {
          return text;
        }
      }
    }
  }

  return '';
}

function extractUserText(item: Record<string, any>): string {
  if (typeof item?.content === 'string') {
    return item.content;
  }
  if (Array.isArray(item?.content)) {
    return item.content
      .map((part: { type?: string; text?: string }) =>
        part.type === 'input_text' ? (part.text ?? '') : '',
      )
      .join('');
  }
  return '';
}

function extractOutputText(item: Record<string, any> | undefined): string {
  if (!item) {
    return '';
  }
  const output = item.output;
  if (typeof output === 'string') {
    return output;
  }
  if (Array.isArray(output)) {
    const textItem = output.find(
      (entry: { type?: string; text?: string }) => entry.type === 'input_text',
    );
    return textItem?.text ?? '';
  }
  return '';
}
