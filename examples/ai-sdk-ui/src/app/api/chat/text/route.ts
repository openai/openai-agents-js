import { Agent, run } from '@openai/agents';
import { createAiSdkTextStreamResponse } from '@openai/agents-extensions/ai-sdk-ui';
import type { UIMessage } from 'ai';

import { toAgentInput } from '@/app/lib/messageConverters';
import { findOrCreateSession } from '@/app/lib/session';

const textAgent = new Agent({
  name: 'Sky Guide',
  model: 'gpt-5.2',
  modelSettings: {
    reasoning: { effort: 'high', summary: 'auto' },
    text: { verbosity: 'medium' },
  },
  instructions:
    'You are a friendly astronomy guide. Keep responses concise and helpful.',
});

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

  const entry = await findOrCreateSession(sessionId);
  const stream = await run(textAgent, input, {
    stream: true,
    conversationId: entry.conversationId,
  });
  return createAiSdkTextStreamResponse(stream);
}
