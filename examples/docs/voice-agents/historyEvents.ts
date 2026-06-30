import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';

const agent = new RealtimeAgent({
  name: 'Assistant',
});

const session = new RealtimeSession(agent, {
  model: 'gpt-realtime-2',
  config: {
    audio: {
      input: {
        transcription: {
          model: 'gpt-4o-mini-transcribe',
        },
      },
    },
  },
  // Enable only when your app needs raw user audio in local history.
  historyStoreAudio: false,
});

session.on('history_updated', (history) => {
  console.log('Full conversation history:', history);
});

session.on('history_added', (item) => {
  console.log('New conversation item:', item);
});

// For raw Realtime API events, listen to the transport instead.
session.transport.on('*', (event) => {
  console.log('Raw transport event:', event);
});
