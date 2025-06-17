import { z } from 'zod';
import { Agent, tool } from '@openai/agents';
import { agui } from '@openai/agents-extensions';

// Example tool
const weatherTool = tool({
  name: 'get_weather',
  description: 'Get the weather for a given city',
  parameters: z.object({ city: z.string() }),
  execute: async (input) => {
    // Simulate API call delay
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return `The weather in ${input.city} is sunny and 72°F`;
  },
});

// Create an agent
const weatherAgent = new Agent({
  name: 'Weather Assistant',
  instructions:
    'You are a helpful weather assistant. Use the weather tool to get current weather information.',
  tools: [weatherTool],
});

async function main() {
  console.log('🌟 AG-UI Demo - Basic Example');
  console.log('═══════════════════════════════\n');

  try {
    // Run agent with AG-UI streaming
    const result = await agui.runWithAGUI(
      weatherAgent,
      'What is the weather like in Tokyo?',
      {
        stream: true,
        agui: {
          thread_id: 'demo-thread-1',
          run_id: 'demo-run-1',
          includeRawEvents: false,
          includeStateSnapshots: true,
        },
      },
    );

    console.log('📡 Streaming AG-UI events:\n');

    // Consume AG-UI events
    for await (const event of result.toAGUIAsyncIterator()) {
      console.log(`🔔 ${event.type}:`, JSON.stringify(event, null, 2));
      console.log('');
    }

    // Wait for completion
    await result.completed;
    console.log('✅ Run completed successfully!');
    console.log('📊 Final output:', result.finalOutput);
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

main().catch(console.error);
