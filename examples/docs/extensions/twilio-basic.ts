import { TwilioRealtimeTransportLayer } from '@openai/agents-extensions';
import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';

const agent = new RealtimeAgent({
  name: 'My Agent',
});

// Create a new transport mechanism that will bridge the connection between Twilio and
// the OpenAI Realtime API.
const twilioTransport = new TwilioRealtimeTransportLayer({
  // @ts-expect-error - websocketConnection comes from your Twilio server
  twilioWebSocket: websocketConnection,
});

const session = new RealtimeSession(agent, {
  // set your own transport
  transport: twilioTransport,
});
