import { Agent, setTracingDisabled } from '@openai/agents/classic';
import {
  ScriptedModel,
  assistantMessage,
  modelStreamResponder,
} from '@openai/agents/classic/testing';
import { SDKRunner } from '@openai/agents/migration';

// This finite example uses the native loop and an in-process Model, without credentials.
setTracingDisabled(true);
const model = new ScriptedModel([
  modelStreamResponder(async function* () {
    yield { type: 'response_started' };
    yield { type: 'output_text_delta', delta: 'Tentative draft.' };
    yield {
      type: 'response_done',
      response: {
        id: 'example-model-response',
        usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: [assistantMessage('Accepted.')],
      },
    };
  }),
]);
const agent = new Agent({
  name: 'Streaming migration example',
  instructions: 'Return the accepted text.',
  model,
});

async function main() {
  const live = await SDKRunner.stream(agent, 'Hello.', {
    context: undefined,
    outputGuardrails: [
      {
        name: 'expected output',
        execute: async ({ agentOutput }) => ({
          tripwireTriggered: agentOutput !== 'Accepted.',
          outputInfo: 'checked',
        }),
      },
    ],
  });
  // Raw Model content is UNVALIDATED. Count events without displaying its text.
  const raw = (async () => {
    let count = 0;
    for await (const _event of live.unvalidatedRaw) count++;
    return count;
  })();
  void raw.catch(() => {});
  try {
    const result = await live.completed;
    // These SDK semantics are buffered until guards and physical cleanup pass.
    const semanticNames: string[] = [];
    for await (const event of live) {
      if (event.type === 'run_item_stream_event') {
        semanticNames.push(event.name);
      } else {
        console.log(JSON.stringify({ newAgent: event.agent.name }));
      }
    }
    console.log(
      JSON.stringify({
        finalOutput: result.finalOutput,
        semanticNames,
        unvalidatedEventCount: await raw,
      }),
    );
    model.assertComplete();
  } catch (error) {
    await Promise.allSettled([live.completed, raw]);
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
