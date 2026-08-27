import { RealtimeAgent, tool } from '@openai/agents-realtime';
import { z } from 'zod';

export type VoiceContext = {
  ownerId: string;
};

const serverTimeParameters = z.object({});

const getServerTime = tool<typeof serverTimeParameters, VoiceContext>({
  name: 'get_server_time',
  description: 'Get the current time from the trusted application server.',
  parameters: serverTimeParameters,
  execute: async (_input, runContext) => {
    if (!runContext?.context.ownerId) {
      throw new Error('Missing authenticated voice-session context.');
    }
    return new Date().toISOString();
  },
});

export const voiceAgentConfiguration = {
  instructions: [
    'You are a concise and friendly voice assistant.',
    'All tools run on the trusted application server.',
    'Use get_server_time when the user asks for the current time.',
    'Do not claim access to private accounts or external systems.',
  ].join(' '),
  tools: [getServerTime],
};

export function createVoiceAgent(): RealtimeAgent<VoiceContext> {
  return new RealtimeAgent<VoiceContext>({
    name: 'Server-controlled voice assistant',
    ...voiceAgentConfiguration,
  });
}
