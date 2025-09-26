import { CloudflareRealtimeTransportLayer } from '@openai/agents-extensions';
import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';

const agent = new RealtimeAgent({
  name: 'My Agent',
});

// Create a transport that connects to OpenAI Realtime via Cloudflare/workerd's fetch-based upgrade.
const cfTransport = new CloudflareRealtimeTransportLayer({
  url: 'wss://api.openai.com/v1/realtime?model=gpt-realtime',
});

const session = new RealtimeSession(agent, {
  // Set your own transport.
  transport: cfTransport,
});
