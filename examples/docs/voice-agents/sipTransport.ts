import OpenAI from 'openai';
import {
  OpenAIRealtimeSIP,
  RealtimeAgent,
  RealtimeSession,
  type RealtimeSessionOptions,
} from '@openai/agents/realtime';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
  webhookSecret: process.env.OPENAI_WEBHOOK_SECRET!,
});

const agent = new RealtimeAgent({
  name: 'Receptionist',
  instructions:
    'Welcome the caller, answer scheduling questions, and hand off if the caller requests a human.',
});

const sessionOptions: Partial<RealtimeSessionOptions> = {
  model: 'gpt-realtime',
  config: {
    audio: {
      input: {
        turnDetection: { type: 'semantic_vad', interruptResponse: true },
      },
    },
  },
};

export async function acceptIncomingCall(callId: string): Promise<void> {
  const initialConfig = await OpenAIRealtimeSIP.buildInitialConfig(
    agent,
    sessionOptions,
  );
  await openai.realtime.calls.accept(callId, initialConfig);
}

export async function attachRealtimeSession(
  callId: string,
): Promise<RealtimeSession> {
  const session = new RealtimeSession(agent, {
    transport: new OpenAIRealtimeSIP(),
    ...sessionOptions,
  });

  session.on('history_added', (item) => {
    console.log('Realtime update:', item.type);
  });

  await session.connect({
    apiKey: process.env.OPENAI_API_KEY!,
    callId,
  });

  return session;
}
