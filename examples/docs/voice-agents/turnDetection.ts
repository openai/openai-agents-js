import { RealtimeSession } from '@openai/agents/realtime';
import { agent } from './agent';

const session = new RealtimeSession(agent, {
  model: 'gpt-realtime',
  config: {
    turnDetection: {
      type: 'semantic_vad',
      eagerness: 'medium',
      createResponse: true,
      interruptResponse: true,
    },
  },
});
