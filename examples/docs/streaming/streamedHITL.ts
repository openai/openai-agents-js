import { createInterface } from 'node:readline/promises';
import { Agent, run, tool } from '@openai/agents';
import { z } from 'zod';

const getWeather = tool({
  name: 'get_weather',
  description: 'Read a simulated forecast for this approval example.',
  parameters: z.object({ city: z.string() }),
  needsApproval: true,
  execute: async ({ city }) => {
    console.log(`\n[tool] Reading the simulated forecast for ${city}.`);
    return { city, forecast: 'Sunny (simulated)', temperature_c: 20 };
  },
});

const agent = new Agent({
  name: 'Weather assistant',
  instructions:
    'Call get_weather exactly once for the requested city. Explain that its forecast is simulated. If approval is rejected, explain that no forecast was retrieved and do not retry.',
  tools: [getWeather],
  modelSettings: { toolChoice: 'required' },
});

// Pass --approve or --reject for a noninteractive decision; otherwise answer in Node.
const [decision, ...extraArguments] = process.argv.slice(2);
if (
  extraArguments.length ||
  (decision && !['--approve', '--reject'].includes(decision))
) {
  throw new Error('Usage: streamedHITL.ts [--approve|--reject]');
}
const readline = decision
  ? undefined
  : createInterface({ input: process.stdin, output: process.stdout });

try {
  let stream = await run(
    agent,
    'Get the simulated forecast for San Francisco.',
    {
      stream: true,
    },
  );
  while (true) {
    for await (const text of stream.toTextStream({
      compatibleWithNodeStreams: true,
    })) {
      process.stdout.write(text);
    }
    await stream.completed;
    if (!stream.interruptions.length) break;

    const state = stream.state;
    for (const interruption of stream.interruptions) {
      console.log(
        `\nApproval required: ${interruption.name} ${interruption.arguments}`,
      );
      let approved = decision === '--approve';
      if (!decision && readline) {
        approved =
          (await readline.question('Approve this tool call? (y/N) '))
            .trim()
            .toLowerCase() === 'y';
      }
      if (approved) state.approve(interruption);
      else state.reject(interruption);
    }

    // Resume the paused run and consume its new streamed output.
    stream = await run(agent, state, { stream: true });
  }
  console.log('\nRun completed.');
} finally {
  readline?.close();
}
