// @ts-expect-error TypeScript does not know about the CSS module
import './style.css';
import {
  connectButton,
  disconnectButton,
  log,
  muteButton,
  setButtonStates,
} from './utils';

import { z } from 'zod';
import { RealtimeAgent, RealtimeSession, tool } from '@openai/agents-realtime';

const getWeather = tool({
  name: 'getWeather',
  description: 'Get the weather for a given city',
  parameters: z.object({
    city: z.string(),
  }),
  execute: async ({ city }) => {
    return `The weather in ${city} is sunny`;
  },
});

const weatherAgent = new RealtimeAgent({
  name: 'Weather Agent',
  instructions: 'You are a weather expert.',
  handoffDescription: 'You can handoff to the weather agent if you need to.',
  tools: [getWeather],
});

const agent = new RealtimeAgent({
  name: 'Greeter',
  instructions:
    'You are a greeter. Always greet the user with a "top of the morning"',
  handoffs: [weatherAgent],
});

weatherAgent.handoffs.push(agent);

const session = new RealtimeSession(agent);

session.on('transport_event', (event) => {
  // this logs the events coming directly from the Realtime API server
  log(event);
});

connectButton.addEventListener('click', async () => {
  const apiKey = prompt(
    'Enter ephemeral API key. Run `pnpm -F realtime-demo generate-token` to get a token.',
  );
  if (!apiKey) {
    return;
  }
  await session.connect({
    apiKey,
  });
  setButtonStates('unmuted');
});

disconnectButton.addEventListener('click', () => {
  session.close();
  setButtonStates('disconnected');
});

muteButton.addEventListener('click', () => {
  const newMutedState = !session.muted;
  session.mute(newMutedState);
  setButtonStates(newMutedState ? 'muted' : 'unmuted');
});
