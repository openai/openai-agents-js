import { demoAccessResponse } from '@/app/lib/demoAccess';
import { Agent, run } from '@openai/agents/classic';
import { createAiSdkTextStreamResponse } from '@openai/agents-extensions/ai-sdk-ui';
import type { UIMessage } from 'ai';

import { toAgentInput } from '@/app/lib/messageConverters';
import {
  findSession,
  getOwnerId,
  readLimitedJson,
  reserveModelRun,
} from '@/app/lib/session';

const textAgent = new Agent({
  name: 'Sky Guide',
  model: 'gpt-5.4',
  modelSettings: {
    reasoning: { effort: 'high', summary: 'auto' },
    text: { verbosity: 'medium' },
  },
  instructions:
    'You are a friendly astronomy guide. Keep responses concise and helpful.',
});

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

  const reservation = reserveModelRun(sessionId, entry);
  if ('status' in reservation) {
    return new Response('Conversation unavailable.', {
      status: reservation.status,
    });
  }
  const stream = await run(textAgent, input, {
    stream: true,
    conversationId: entry.conversationId,
  }).catch((error: unknown) => {
    reservation.release();
    throw error;
  });
  void stream.completed.finally(reservation.release).catch(() => {});
  return createAiSdkTextStreamResponse(stream);
}
