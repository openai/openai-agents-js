import { Agent, run, withTrace } from '@openai/agents';
import type { AgentInputItem } from '@openai/agents';
import { z } from 'zod';
import readline from 'node:readline/promises';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Define the agents
const storyOutlineGenerator = new Agent({
  name: 'story_outline_generator',
  instructions:
    "You generate a very short story outline based on the user's input. If there is any feedback provided, use it to improve the outline.",
});

const EvaluationFeedback = z.object({
  feedback: z.string(),
  score: z.enum(['pass', 'needs_improvement', 'fail']),
});

const evaluator = new Agent({
  name: 'evaluator',
  instructions:
    "You evaluate a story outline and decide if it's good enough to start writing the story. If it's not good enough, you provide feedback on what needs to be improved. Never give it a pass on the first try.",
  outputType: EvaluationFeedback,
});

async function main() {
  const inputPrompt = await rl.question(
    'What kind of story would you like to hear? ',
  );

  if (!inputPrompt) {
    throw new Error('No input prompt provided');
  }

  let inputItems: AgentInputItem[] = [{ content: inputPrompt, role: 'user' }];
  let latestOutline: string | undefined = undefined;

  await withTrace('LLM as a judge', async () => {
    let turns = 0;
    while (turns < 5) {
      const storyOutlineResult = await run(storyOutlineGenerator, inputItems);
      if (!storyOutlineResult.finalOutput) {
        throw new Error('No story outline');
      }
      inputItems = storyOutlineResult.history;
      latestOutline = storyOutlineResult.finalOutput;
      console.log('Story outline generated');

      const evaluatorResult = await run(evaluator, inputItems);
      const result = evaluatorResult.finalOutput;
      console.log(`Evaluator score: ${result?.score}`);

      if (result?.score === 'pass') {
        console.log('Story outline is good enough, exiting.');
        return;
      }
      console.log('Re-running with feedback');

      inputItems.push({
        content: `Feedback: ${result?.feedback}`,
        role: 'user',
      });
      turns++;
    }
  });
  console.log(`Final story outline: ${latestOutline}`);

  rl.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
