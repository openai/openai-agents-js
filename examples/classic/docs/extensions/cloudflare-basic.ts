import { CloudflareRealtimeTransportLayer } from '@openai/agents-extensions';
import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';

// Call this from a Worker request handler with an application-owned API key.
export async function connectVoiceAgent(apiKey: string) {
  const agent = new RealtimeAgent({ name: 'My Agent' });
  const transport = new CloudflareRealtimeTransportLayer({
    url: 'wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1',
  });
  const session = new RealtimeSession(agent, { transport });

  await session.connect({ apiKey });
  return session;
}
