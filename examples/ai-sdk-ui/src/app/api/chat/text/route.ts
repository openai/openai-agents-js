import { Agent, run } from '@openai/agents';
import { createAiSdkTextStreamResponse } from '@openai/agents-extensions/ai-sdk-ui';
import type { UIMessage } from 'ai';

import { toAgentInput } from '../shared';

type SessionEntry = {
  previousResponseId?: string;
};

const sessionStore = new Map<string, SessionEntry>();

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

  let entry = sessionStore.get(sessionId);
  if (!entry) {
    entry = {};
    sessionStore.set(sessionId, entry);
  }

  const stream = await run(textAgent, input, {
    stream: true,
    previousResponseId: entry.previousResponseId,
  });
  void stream.completed
    .then(() => {
      const lastResponseId = stream.lastResponseId ?? entry.previousResponseId;
      sessionStore.set(sessionId, {
        ...entry,
        previousResponseId: lastResponseId,
      });
    })
    .catch(() => {});
  return createAiSdkTextStreamResponse(stream);
}
