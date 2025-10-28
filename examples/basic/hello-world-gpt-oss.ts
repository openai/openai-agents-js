import {
  Agent,
  OpenAIChatCompletionsModel,
  run,
  setTracingDisabled,
} from '@openai/agents';
import OpenAI from 'openai';

setTracingDisabled(true);

async function main() {
  // Note that using a custom outputType for an agent may not work well with gpt-oss models.
  // Consider going with the default "text" outputType.
  // See also: https://github.com/openai/openai-agents-python/issues/1414
  const agent = new Agent({
    name: 'gpt-oss Assistant',
    // This is an example of how to use gpt-oss with Ollama.
    // Refer to https://cookbook.openai.com/articles/gpt-oss/run-locally-ollama for more details.
    // If you prefer using LM Studio, refer to https://cookbook.openai.com/articles/gpt-oss/run-locally-lmstudio
    model: new OpenAIChatCompletionsModel(
      new OpenAI({
        baseURL: 'http://localhost:11434/v1',
        apiKey: 'ollama',
      }),
      'gpt-oss:20b',
    ),
    instructions: 'You answer questions concisely and to the point.',
    modelSettings: { reasoning: { effort: 'low' } },
  });

  const question = 'Tell me about recursion in programming.';
  const stream = await run(agent, question, { stream: true });
  for await (const event of stream.toTextStream()) {
    process.stdout.write(event);
  }
  console.log();

  // or non-streaming mode:
  // const result = await run(agent, question);
  // console.log(result.finalOutput);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
