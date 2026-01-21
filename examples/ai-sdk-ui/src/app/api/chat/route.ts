import { run, type Agent } from '@openai/agents';
import { createAiSdkUiMessageStreamResponse } from '@openai/agents-extensions/ai-sdk-ui';
import type { UIMessage } from 'ai';

import { agent, customerSupportAgent } from './agents';
import { toAgentInput } from './shared';

const agentRegistry = new Map<string, Agent<any, any>>([
  [agent.name, agent],
  [customerSupportAgent.name, customerSupportAgent],
]);

type SessionEntry = {
  previousResponseId?: string;
  activeAgentName: string;
};

const sessionStore = new Map<string, SessionEntry>();

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const messages = Array.isArray(body?.messages)
    ? (body.messages as UIMessage[])
    : [];
  const sessionId =
    typeof body?.sessionId === 'string'
      ? body.sessionId
      : typeof body?.id === 'string'
        ? body.id
        : 'default';
  const lastUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === 'user');
  const input = lastUserMessage ? toAgentInput([lastUserMessage]) : [];

  if (input.length === 0) {
    return new Response('Missing messages.', { status: 400 });
  }

  let entry = sessionStore.get(sessionId);
  if (!entry) {
    entry = {
      activeAgentName: agent.name,
    };
    sessionStore.set(sessionId, entry);
  }

  const activeAgent = agentRegistry.get(entry.activeAgentName) ?? agent;

  try {
    const stream = await run(activeAgent, input, {
      stream: true,
      previousResponseId: entry.previousResponseId,
    });
    void stream.completed
      .then(() => {
        const nextAgentName =
          stream.currentAgent?.name ?? entry.activeAgentName;
        const lastResponseId =
          stream.lastResponseId ?? entry.previousResponseId;
        sessionStore.set(sessionId, {
          ...entry,
          activeAgentName: nextAgentName,
          previousResponseId: lastResponseId,
        });
      })
      .catch(() => {});

    return createAiSdkUiMessageStreamResponse(stream);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'The request failed with an unexpected error.';
    return new Response(message, { status: 500 });
  }
}
