import { z } from 'zod';
import { RealtimeAgent, RealtimeSession, tool } from '@openai/agents-realtime';

const getWeatherTool = tool({
  name: 'get_weather',
  description: 'Get the weather for a given city',
  parameters: z.object({ city: z.string() }),
  execute: async (input) => {
    return `The weather in ${input.city} is sunny`;
  },
});

const agent = new RealtimeAgent({
  name: 'Data agent',
  instructions: 'You are a data agent',
  tools: [getWeatherTool],
});

async function main() {
  // Intended to run in the browser
  const { apiKey } = await fetch('/path/to/ephemeral/key/generation').then(
    (resp) => resp.json(),
  );
  // Automatically configures audio input/output — start talking
  const session = new RealtimeSession(agent);
  await session.connect({ apiKey });
}

main().catch(console.error);
