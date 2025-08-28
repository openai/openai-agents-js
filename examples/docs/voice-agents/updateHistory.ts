import { RealtimeSession, RealtimeAgent } from '@openai/agents/realtime';

const agent = new RealtimeAgent({
  name: 'Assistant',
});

const session = new RealtimeSession(agent, {
  model: 'gpt-realtime',
});

await session.connect({ apiKey: '<client-api-key>' });

// listening to the history_updated event
session.on('history_updated', (history) => {
  // returns the full history of the session
  console.log(history);
});

// Option 1: explicit setting
session.updateHistory([
  /* specific history */
]);

// Option 2: override based on current state like removing all agent messages
session.updateHistory((currentHistory) => {
  return currentHistory.filter(
    (item) => !(item.type === 'message' && item.role === 'assistant'),
  );
});
