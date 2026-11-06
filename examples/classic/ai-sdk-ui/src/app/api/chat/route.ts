import { demoAccessResponse } from '@/app/lib/demoAccess';
import { run, type Agent } from '@openai/agents/classic';
import { createAiSdkUiMessageStreamResponse } from '@openai/agents-extensions/ai-sdk-ui';
import type { UIMessage } from 'ai';

import { agent, customerSupportAgent } from './agents';
import { toAgentInput } from '@/app/lib/messageConverters';
import {
  findSession,
  getOwnerId,
  readLimitedJson,
  reserveModelRun,
} from '@/app/lib/session';

const agentRegistry = new Map<string, Agent<any, any>>([
  [agent.name, agent],
  [customerSupportAgent.name, customerSupportAgent],
]);

export async function POST(req: Request) {
  const denied = demoAccessResponse(req.headers);
  if (denied) return denied;
  const parsed = await readLimitedJson(req);
  if ('status' in parsed) {
    return new Response('Invalid request.', { status: parsed.status });
  }
  const body = parsed.value as {
    messages?: unknown;
    sessionId?: unknown;
    id?: unknown;
  } | null;
  const messages = Array.isArray(body?.messages)
    ? (body.messages as UIMessage[])
    : [];
  const sessionId =
    typeof body?.sessionId === 'string'
      ? body.sessionId
      : typeof body?.id === 'string'
        ? body.id
        : undefined;
  if (!sessionId) {
    return new Response('Missing session ID.', { status: 400 });
  }
  const entry = findSession(sessionId, await getOwnerId(sessionId));
  if (!entry) {
    return new Response('Session not found.', { status: 404 });
  }

  const lastUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === 'user');
  const input = lastUserMessage ? toAgentInput([lastUserMessage]) : [];

  if (input.length === 0) {
    return new Response('Missing messages.', { status: 400 });
  }

  const activeAgentName = entry.activeAgentName ?? agent.name;
  const activeAgent = agentRegistry.get(activeAgentName) ?? agent;
  const reservation = reserveModelRun(sessionId, entry);
  if ('status' in reservation) {
    return new Response('Conversation unavailable.', {
      status: reservation.status,
    });
  }

  try {
    const stream = await run(activeAgent, input, {
      stream: true,
      conversationId: entry.conversationId,
    });
    void stream.completed
      .then(() => {
        entry.activeAgentName = stream.currentAgent?.name ?? activeAgentName;
      })
      .catch(() => {})
      .finally(reservation.release);

    return createAiSdkUiMessageStreamResponse(stream);
  } catch (error) {
    reservation.release();
    const message =
      error instanceof Error
        ? error.message
        : 'The request failed with an unexpected error.';
    return new Response(message, { status: 500 });
  }
}
