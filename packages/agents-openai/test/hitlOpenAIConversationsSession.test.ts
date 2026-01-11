import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  Agent,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type ModelProvider,
  type ResponseStreamEvent,
  Usage,
  protocol,
  run,
  setDefaultModelProvider,
  tool,
} from '@openai/agents-core';

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

class ScenarioModel implements Model {
  #counter = 0;

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const toolName =
      typeof request.modelSettings.toolChoice === 'string'
        ? request.modelSettings.toolChoice
        : TOOL_ECHO;
    const callId = `call_${(this.#counter += 1)}`;
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

    return {
      usage: new Usage(),
      output: [toolCall],
    };
  }

  // eslint-disable-next-line require-yield -- this scenario does not stream.
  async *getStreamedResponse(
    _request: ModelRequest,
  ): AsyncIterable<ResponseStreamEvent> {
    throw new Error('Streaming is not supported in this scenario.');
  }
}

describe('OpenAIConversationsSession HITL scenario', () => {
  beforeAll(() => {
    const provider: ModelProvider = {
      getModel() {
        return new ScenarioModel();
      },
    };
    setDefaultModelProvider(provider);
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

    const model = new ScenarioModel();
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
  model: ScenarioModel,
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
