import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';

const agent = new RealtimeAgent({
  name: 'Greeter',
  instructions: 'Greet the user with cheer and answer questions.',
});

const session = new RealtimeSession(agent, {
  model: 'gpt-realtime-2',
});

session.transport.on('*', (event) => {
  // Event received from the underlying Realtime transport
});

// Send any valid client event, for example, to trigger a new response
session.transport.sendEvent({
  type: 'response.create',
  // ...
});
