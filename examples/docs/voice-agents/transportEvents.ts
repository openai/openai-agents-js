import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';

const agent = new RealtimeAgent({
  name: 'Greeter',
  instructions: 'Greet the user with cheer and answer questions.',
});

const session = new RealtimeSession(agent, {
  model: 'gpt-realtime',
});

session.transport.on('*', (event) => {
  // JSON parsed version of the event received on the connection
});

// Send any valid event as JSON. For example triggering a new response
session.transport.sendEvent({
  type: 'response.create',
  // ...
});
