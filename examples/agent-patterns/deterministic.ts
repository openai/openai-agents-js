import { Agent, run, withTrace } from '@openai/agents';
import { z } from 'zod';
import readline from 'node:readline/promises';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Define the agents
const storyOutlineAgent = new Agent({
  name: 'story_outline_agent',
  instructions:
    "Generate a very short story outline based on the user's input.",
});

const outlineCheckerAgent = new Agent({
  name: 'outline_checker_agent',
  instructions:
    'Read the given story outline, and judge the quality. Also, determine if it is a scifi story.',
  outputType: z.object({
    good_quality: z.boolean(),
    is_scifi: z.boolean(),
  }),
});

const storyAgent = new Agent({
  name: 'story_agent',
  instructions: 'Write a short story based on the given outline.',
});

async function main() {
  const inputPrompt = await rl.question('What kind of story do you want? ');

  if (!inputPrompt) {
    throw new Error('No input prompt provided');
  }

  await withTrace('Deterministic story flow', async () => {
    // 1. Generate an outline
    const outlineResult = await run(storyOutlineAgent, inputPrompt);

    if (!outlineResult.finalOutput) {
      throw new Error('No outline result');
    }

    console.log('Outline generated');

    // 2. Check the outline
    const outlineCheckerResult = await run(
      outlineCheckerAgent,
      outlineResult.finalOutput,
    );

    const checkerOutput = outlineCheckerResult.finalOutput;
    if (!checkerOutput) {
      throw new Error('No checker output');
    }

    // 3. Add a gate to stop if the outline is not good quality or not a scifi story
    if (!checkerOutput.good_quality) {
      console.log('Outline is not good quality, so we stop here.');
      return;
    }

    if (!checkerOutput.is_scifi) {
      console.log('Outline is not a scifi story, so we stop here.');
      return;
    }

    console.log(
      'Outline is good quality and a scifi story, so we continue to write the story.',
    );

    // 4. Write the story
    const storyResult = await run(storyAgent, outlineResult.finalOutput);
    console.log(`Story: ${storyResult.finalOutput}`);
  });

  rl.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
