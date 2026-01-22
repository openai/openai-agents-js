import { run, type Agent } from '@openai/agents';
import { createAiSdkUiMessageStreamResponse } from '@openai/agents-extensions/ai-sdk-ui';
import type { UIMessage } from 'ai';

import { agent, customerSupportAgent } from './agents';
import { toAgentInput } from '@/app/lib/messageConverters';
import { findOrCreateSession, saveSession } from '@/app/lib/session';

const agentRegistry = new Map<string, Agent<any, any>>([
  [agent.name, agent],
  [customerSupportAgent.name, customerSupportAgent],
]);

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

  const entry = await findOrCreateSession(sessionId, {
    activeAgentName: agent.name,
  });
  const activeAgentName = entry.activeAgentName ?? agent.name;
  const activeAgent = agentRegistry.get(activeAgentName) ?? agent;

  try {
    const stream = await run(activeAgent, input, {
      stream: true,
      conversationId: entry.conversationId,
    });
    void stream.completed
      .then(() => {
        const nextAgentName = stream.currentAgent?.name ?? activeAgentName;
        saveSession(sessionId, {
          ...entry,
          activeAgentName: nextAgentName,
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
