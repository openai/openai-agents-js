import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';

const agent = new RealtimeAgent({
  name: 'Greeter',
  instructions: 'Greet the user with cheer and answer questions.',
});

const guardedSession = new RealtimeSession(agent, {
  outputGuardrails: [/*...*/],
  outputGuardrailSettings: {
    debounceTextLength: 500, // run guardrail every 500 characters or set it to -1 to run it only at the end
  },
});
