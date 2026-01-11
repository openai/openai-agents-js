import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  Agent,
  type AgentInputItem,
  MemorySession,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type ResponseStreamEvent,
  Usage,
  protocol,
  run,
  setDefaultModelProvider,
  tool,
} from '../src';
import { FakeModelProvider } from './stubs';

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

describe('MemorySession HITL scenario', () => {
  beforeAll(() => {
    setDefaultModelProvider(new FakeModelProvider());
  });

  it('persists approvals, rehydration, and rejections across tools', async () => {
    executeCounts.clear();
    const session = new MemorySession();
    const sessionId = await session.getSessionId();
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

    let rehydrated: MemorySession | undefined;

    try {
      const first = await runScenarioStep(session, model, steps[0]);
      expectCounts(first.items, 1);
      expectStepOutput(first.items, first.approvalItem, steps[0]);

      rehydrated = new MemorySession({ sessionId, initialItems: first.items });
      const second = await runScenarioStep(rehydrated, model, steps[1]);
      expectCounts(second.items, 2);
      expectStepOutput(second.items, second.approvalItem, steps[1]);

      const third = await runScenarioStep(rehydrated, model, steps[2]);
      expectCounts(third.items, 3);
      expectStepOutput(third.items, third.approvalItem, steps[2]);

      expect(executeCounts.get(TOOL_ECHO)).toBe(1);
      expect(executeCounts.get(TOOL_NOTE)).toBe(1);
    } finally {
      await (rehydrated ?? session).clearSession();
    }
  });
});

async function runScenarioStep(
  session: MemorySession,
  model: ScenarioModel,
  step: ScenarioStep,
): Promise<{
  approvalItem: protocol.FunctionCallItem;
  items: AgentInputItem[];
}> {
  const agent = new Agent({
    name: `MemorySession ${step.label}`,
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
    items: await session.getItems(),
  };
}

function expectCounts(items: AgentInputItem[], turn: number): void {
  expect(countUserMessages(items)).toBe(turn);
  expect(countFunctionCalls(items)).toBe(turn);
  expect(countFunctionResults(items)).toBe(turn);
}

function expectStepOutput(
  items: AgentInputItem[],
  approvalItem: protocol.FunctionCallItem,
  step: ScenarioStep,
): void {
  const lastUser = getLastUserText(items);
  expect(lastUser).toBe(step.message);

  const lastCall = findLastFunctionCall(items);
  const lastResult = findLastFunctionCallResult(items);
  expect(lastCall?.name).toBe(step.toolName);
  expect(lastResult?.name).toBe(step.toolName);
  expect(lastCall?.callId).toBe(approvalItem.callId);
  expect(lastResult?.callId).toBe(approvalItem.callId);
  expect(extractToolOutputText(lastResult)).toBe(step.expectedOutput);
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

function countUserMessages(items: AgentInputItem[]): number {
  return items.filter((item) => item.type === 'message' && item.role === 'user')
    .length;
}

function countFunctionCalls(items: AgentInputItem[]): number {
  return items.filter(isFunctionCallItem).length;
}

function countFunctionResults(items: AgentInputItem[]): number {
  return items.filter(isFunctionCallResultItem).length;
}

function findLastFunctionCall(
  items: AgentInputItem[],
): protocol.FunctionCallItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (isFunctionCallItem(item)) {
      return item;
    }
  }
  return undefined;
}

function findLastFunctionCallResult(
  items: AgentInputItem[],
): protocol.FunctionCallResultItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (isFunctionCallResultItem(item)) {
      return item;
    }
  }
  return undefined;
}

function isFunctionCallItem(
  item: AgentInputItem,
): item is protocol.FunctionCallItem {
  return item.type === 'function_call';
}

function isFunctionCallResultItem(
  item: AgentInputItem,
): item is protocol.FunctionCallResultItem {
  return item.type === 'function_call_result';
}

function getLastUserText(items: AgentInputItem[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type === 'message' && item.role === 'user') {
      if (typeof item.content === 'string') {
        return item.content;
      }
      if (Array.isArray(item.content)) {
        return item.content
          .map((part) => (part.type === 'input_text' ? part.text : ''))
          .filter(Boolean)
          .join('');
      }
    }
  }
  return undefined;
}

function extractToolOutputText(
  resultItem: protocol.FunctionCallResultItem | undefined,
): string | undefined {
  if (!resultItem) {
    return undefined;
  }

  const output = resultItem.output;
  if (typeof output === 'string') {
    return output;
  }
  if (Array.isArray(output)) {
    const textItem = output.find(isInputText);
    return textItem?.text;
  }
  if (output && typeof output === 'object' && 'type' in output) {
    if (isToolOutputText(output)) {
      return output.text;
    }
  }
  return undefined;
}

function isInputText(
  entry: protocol.ToolCallStructuredOutput,
): entry is protocol.InputText {
  return entry.type === 'input_text';
}

function isToolOutputText(
  output: protocol.ToolCallOutputContent,
): output is protocol.ToolOutputText {
  return output.type === 'text';
}
