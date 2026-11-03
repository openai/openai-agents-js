import { Agent, Runner } from '@openai/agents/classic';
import {
  assistantMessage,
  modelResponse,
  ScriptedModel,
} from '@openai/agents/classic/testing';

async function main() {
  const model = new ScriptedModel([
    modelResponse([assistantMessage('Hello from the classic runtime.')]),
  ]);
  const agent = new Agent({ name: 'assistant', model });
  const result = await new Runner({ tracingDisabled: true }).run(
    agent,
    'Hello',
  );
  console.log(result.finalOutput);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
