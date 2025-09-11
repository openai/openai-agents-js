import { PlivoRealtimeTransportLayer } from '@openai/agents-extensions';
import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';

const agent = new RealtimeAgent({
  name: 'My Agent',
});

// Create a new transport mechanism that will bridge the connection between Plivo and
// the OpenAI Realtime API.
const plivoTransport = new PlivoRealtimeTransportLayer({
  // @ts-expect-error - this is not defined
  plivoWebSocket: websocketConnection,
});

const session = new RealtimeSession(agent, {
  // set your own transport
  transport: plivoTransport,
});
