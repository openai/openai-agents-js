import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  Agent,
  type AgentInputItem,
  type Model,
  type Session,
  OpenAIConversationsSession,
  run,
  tool,
} from '@openai/agents';
import { z } from 'zod';

import { FileSession } from './sessions';

const TOOL_ECHO = 'approved_echo';
const TOOL_NOTE = 'approved_note';
const REJECTION_OUTPUT = 'Tool execution was not approved.';
const USER_MESSAGES = [
  'Fetch profile for customer 104.',
  'Update note for customer 104.',
  'Delete note for customer 104.',
];

const TOOL_OUTPUTS: Record<string, (message: string) => string> = {
  [TOOL_ECHO]: (message) => `approved:${message}`,
  [TOOL_NOTE]: (message) => `approved_note:${message}`,
};

const approvalEchoTool = tool({
  name: TOOL_ECHO,
  description: 'Echoes back the provided query after approval.',
  parameters: z.object({ query: z.string() }),
  async execute({ query }: { query: string }) {
    return `approved:${query}`;
  },
});

approvalEchoTool.needsApproval = async () => true;

const approvalNoteTool = tool({
  name: TOOL_NOTE,
  description: 'Records the provided query after approval.',
  parameters: z.object({ query: z.string() }),
  async execute({ query }: { query: string }) {
    return `approved_note:${query}`;
  },
});

approvalNoteTool.needsApproval = async () => true;

type ApprovalAction = 'approve' | 'reject';
type ScenarioStep = {
  name: string;
  message: string;
  toolName: string;
  approval: ApprovalAction;
  expectedOutput: string;
};

async function runScenario(
  session: Session,
  label: string,
  step: ScenarioStep,
  options: { model?: string | Model } = {},
): Promise<void> {
  const agent = new Agent({
    name: `${label} HITL scenario`,
    instructions:
      `You must call ${step.toolName} exactly once before responding.` +
      ` Pass the user input as the "query" argument.`,
    tools: [approvalEchoTool, approvalNoteTool],
    model: options.model,
    modelSettings: { toolChoice: step.toolName },
    toolUseBehavior: 'stop_on_first_tool',
  });

  let result = await run(agent, step.message, { session });
  if (result.interruptions.length === 0) {
    throw new Error(`[${label}] expected at least one tool approval.`);
  }

  while (result.interruptions.length > 0) {
    for (const interruption of result.interruptions) {
      if (step.approval === 'reject') {
        result.state.reject(interruption);
      } else {
        result.state.approve(interruption);
      }
    }
    result = await run(agent, result.state, { session });
  }

  if (!result.finalOutput) {
    throw new Error(`[${label}] expected a final output after approval.`);
  }
  if (result.finalOutput !== step.expectedOutput) {
    throw new Error(
      `[${label}] expected final output "${step.expectedOutput}" but got "${result.finalOutput}".`,
    );
  }

  const items = await session.getItems();
  const toolResults = items.filter(
    (item) => item.type === 'function_call_result',
  );
  const userMessages = items.filter(
    (item) => getUserText(item) === step.message,
  );
  const lastToolCall = findLastItem(items, isFunctionCall);
  const lastToolResult = findLastItem(items, isFunctionCallResult);

  if (toolResults.length === 0) {
    throw new Error(`[${label}] expected tool outputs in session history.`);
  }
  if (userMessages.length === 0) {
    throw new Error(`[${label}] expected user input in session history.`);
  }
  if (!lastToolCall) {
    throw new Error(`[${label}] expected a tool call in session history.`);
  }
  if (lastToolCall.name !== step.toolName) {
    throw new Error(
      `[${label}] expected tool call "${step.toolName}" but got "${lastToolCall.name}".`,
    );
  }
  if (!lastToolResult) {
    throw new Error(`[${label}] expected a tool result in session history.`);
  }
  const allowedResultNames = new Set([step.toolName, lastToolCall.callId]);
  if (!allowedResultNames.has(lastToolResult.name)) {
    throw new Error(
      `[${label}] expected tool result "${step.toolName}" but got "${lastToolResult.name}".`,
    );
  }
  if (lastToolResult.callId !== lastToolCall.callId) {
    throw new Error(
      `[${label}] expected tool result callId "${lastToolCall.callId}" but got "${lastToolResult.callId}".`,
    );
  }

  logSessionSummary(items, label);
  console.log(
    `[${label}] final output: ${result.finalOutput} (items: ${items.length})`,
  );
}

async function runFileSessionScenario(model?: string | Model): Promise<void> {
  const tmpRoot = path.resolve(process.cwd(), 'tmp');
  await mkdir(tmpRoot, { recursive: true });
  const tempDir = await mkdtemp(path.join(tmpRoot, 'hitl-scenario-'));
  const session = new FileSession({ dir: tempDir });
  const sessionId = await session.getSessionId();
  const sessionFile = path.join(tempDir, `${sessionId}.json`);
  let rehydratedSession: FileSession | undefined;

  console.log(`[FileSession] session id: ${sessionId}`);
  console.log(`[FileSession] file: ${sessionFile}`);
  console.log('[FileSession] cleanup: always');

  const steps: ScenarioStep[] = [
    {
      name: 'turn 1',
      message: USER_MESSAGES[0],
      toolName: TOOL_ECHO,
      approval: 'approve',
      expectedOutput: TOOL_OUTPUTS[TOOL_ECHO](USER_MESSAGES[0]),
    },
    {
      name: 'turn 2 (rehydrated)',
      message: USER_MESSAGES[1],
      toolName: TOOL_NOTE,
      approval: 'approve',
      expectedOutput: TOOL_OUTPUTS[TOOL_NOTE](USER_MESSAGES[1]),
    },
    {
      name: 'turn 3 (rejected)',
      message: USER_MESSAGES[2],
      toolName: TOOL_ECHO,
      approval: 'reject',
      expectedOutput: REJECTION_OUTPUT,
    },
  ];

  try {
    await runScenario(session, `FileSession ${steps[0].name}`, steps[0], {
      model,
    });
    rehydratedSession = new FileSession({ dir: tempDir, sessionId });
    console.log(`[FileSession] rehydrated session id: ${sessionId}`);
    await runScenario(
      rehydratedSession,
      `FileSession ${steps[1].name}`,
      steps[1],
      { model },
    );
    await runScenario(
      rehydratedSession,
      `FileSession ${steps[2].name}`,
      steps[2],
      { model },
    );
  } finally {
    await (rehydratedSession ?? session).clearSession();
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runOpenAISessionScenario(model?: string | Model): Promise<void> {
  const existingSessionId = process.env.OPENAI_SESSION_ID;
  const session = new OpenAIConversationsSession({
    conversationId: existingSessionId,
  });
  const sessionId = await session.getSessionId();
  const shouldKeep = Boolean(
    process.env.KEEP_OPENAI_SESSION || existingSessionId,
  );

  if (existingSessionId) {
    console.log(`[OpenAIConversationsSession] reuse session id: ${sessionId}`);
  } else {
    console.log(`[OpenAIConversationsSession] new session id: ${sessionId}`);
  }
  console.log(
    `[OpenAIConversationsSession] cleanup: ${shouldKeep ? 'skip' : 'delete'}`,
  );

  const steps: ScenarioStep[] = [
    {
      name: 'turn 1',
      message: USER_MESSAGES[0],
      toolName: TOOL_ECHO,
      approval: 'approve',
      expectedOutput: TOOL_OUTPUTS[TOOL_ECHO](USER_MESSAGES[0]),
    },
    {
      name: 'turn 2 (rehydrated)',
      message: USER_MESSAGES[1],
      toolName: TOOL_NOTE,
      approval: 'approve',
      expectedOutput: TOOL_OUTPUTS[TOOL_NOTE](USER_MESSAGES[1]),
    },
    {
      name: 'turn 3 (rejected)',
      message: USER_MESSAGES[2],
      toolName: TOOL_ECHO,
      approval: 'reject',
      expectedOutput: REJECTION_OUTPUT,
    },
  ];

  await runScenario(
    session,
    `OpenAIConversationsSession ${steps[0].name}`,
    steps[0],
    { model },
  );

  const rehydratedSession = new OpenAIConversationsSession({
    conversationId: sessionId,
  });
  console.log(
    `[OpenAIConversationsSession] rehydrated session id: ${sessionId}`,
  );
  await runScenario(
    rehydratedSession,
    `OpenAIConversationsSession ${steps[1].name}`,
    steps[1],
    { model },
  );
  await runScenario(
    rehydratedSession,
    `OpenAIConversationsSession ${steps[2].name}`,
    steps[2],
    { model },
  );
  if (shouldKeep) {
    console.log(`[OpenAIConversationsSession] kept session id: ${sessionId}`);
    return;
  }

  console.log(`[OpenAIConversationsSession] deleting session id: ${sessionId}`);
  if (!process.env.KEEP_OPENAI_SESSION) {
    await rehydratedSession.clearSession();
  }
}

function getUserText(item: AgentInputItem): string | undefined {
  if (item.type !== 'message' || item.role !== 'user') {
    return undefined;
  }

  const content = item.content as string | { type: string; text?: string }[];
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  return content
    .map((part) => (part.type === 'input_text' ? (part.text ?? '') : ''))
    .filter((text) => text.length > 0)
    .join('');
}

function logSessionSummary(items: AgentInputItem[], label: string): void {
  const typeCounts = new Map<string, number>();
  for (const item of items) {
    const type = typeof item.type === 'string' ? item.type : 'unknown';
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  }

  const typeSummary = Array.from(typeCounts.entries())
    .map(([type, count]) => `${type}=${count}`)
    .join(' ');

  console.log(
    `[${label}] session summary: items=${items.length}${
      typeSummary ? ` (${typeSummary})` : ''
    }`,
  );

  let userText: string | undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    userText = getUserText(items[index]);
    if (userText) {
      break;
    }
  }
  if (userText) {
    console.log(`[${label}] user: ${truncateText(userText)}`);
  }

  const toolCall = findLastItem(items, isFunctionCall);
  if (toolCall) {
    const args = truncateText(toolCall.arguments ?? '');
    const callId = toolCall.callId ? ` callId=${toolCall.callId}` : '';
    console.log(
      `[${label}] tool call: ${toolCall.name}${callId}${
        args ? ` args=${args}` : ''
      }`,
    );
  }

  const toolResult = findLastItem(items, isFunctionCallResult);
  if (toolResult) {
    const resolvedName = resolveToolResultName(toolResult, toolCall);
    const nameSuffix = resolvedName.fromCallId ? ' (via callId)' : '';
    const callId = toolResult.callId ? ` callId=${toolResult.callId}` : '';
    const output = truncateText(formatOutput(toolResult.output));
    console.log(
      `[${label}] tool result: ${resolvedName.name}${nameSuffix}${callId}${
        output ? ` output=${output}` : ''
      }`,
    );
  }
}

function isFunctionCall(
  item: AgentInputItem,
): item is AgentInputItem & { type: 'function_call' } {
  return item.type === 'function_call';
}

function isFunctionCallResult(
  item: AgentInputItem,
): item is AgentInputItem & { type: 'function_call_result' } {
  return item.type === 'function_call_result';
}

function resolveToolResultName(
  toolResult: AgentInputItem & { type: 'function_call_result' },
  toolCall: (AgentInputItem & { type: 'function_call' }) | undefined,
): { name: string; fromCallId: boolean } {
  if (toolCall && toolResult.name === toolResult.callId) {
    if (toolCall.callId === toolResult.callId) {
      return { name: toolCall.name, fromCallId: true };
    }
  }
  return { name: toolResult.name, fromCallId: false };
}

function findLastItem<T extends AgentInputItem>(
  items: AgentInputItem[],
  predicate: (item: AgentInputItem) => item is T,
): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (predicate(item)) {
      return item;
    }
  }
  return undefined;
}

function formatOutput(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }

  if (output === undefined) {
    return '';
  }

  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function truncateText(text: string, maxLength = 140): string {
  if (text.length <= maxLength) {
    return text;
  }
  const suffix = '...';
  if (maxLength <= suffix.length) {
    return suffix;
  }
  return `${text.slice(0, maxLength - suffix.length)}${suffix}`;
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      'OPENAI_API_KEY must be set to run the HITL session scenario.',
    );
    process.exit(1);
  }

  const modelOverride = process.env.HITL_MODEL ?? 'gpt-5.2';
  await runFileSessionScenario(modelOverride);
  await runOpenAISessionScenario(modelOverride);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
