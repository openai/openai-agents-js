import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';

const agent = new RealtimeAgent({
  name: 'Assistant',
});

const session = new RealtimeSession(agent, {
  model: 'gpt-realtime-1.5',
});

const imageDataUrl = 'data:image/png;base64,...';

session.addImage(imageDataUrl, { triggerResponse: false });
session.sendMessage('Describe what is in this image.');
